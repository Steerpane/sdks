// Against a running API with real Chromium. Skipped unless STEERPANE_API_URL and STEERPANE_API_TOKEN are set (see sdks/README.md).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { APIError, connectPlaywright, HumanInControlError, Steerpane, ToolError, verifySignature } from "../dist/index.js";

const LIVE = Boolean(process.env.STEERPANE_API_URL && process.env.STEERPANE_API_TOKEN);
const live = (name, fn) => test(name, { skip: LIVE ? false : "no local API configured" }, fn);

async function withSession(client, fn) {
  const session = await client.sessions.create({ initial_url: "https://example.com", record: false });
  try {
    await client.sessions.waitUntilReady(session.id);
    await fn(session);
  } finally {
    await client.sessions.stop(session.id);
    await client.sessions.delete(session.id);
  }
}

live("session, actions and Playwright", async () => {
  const client = new Steerpane();
  await withSession(client, async (session) => {
    assert.ok(session.watch_url.endsWith(`/sessions/${session.id}`));
    await client.actions.navigate(session.id, "https://example.com/");
    assert.match((await client.actions.getPageText(session.id)).text, /documentation examples/);
    assert.equal((await client.actions.execute(session.id, "return document.title")).result, "Example Domain");
    const found = [];
    for await (const s of client.paginate((p) => client.sessions.list({ ...p, status: "live" }))) found.push(s.id);
    assert.ok(found.includes(session.id));
    const browser = await connectPlaywright(client, session, { agent: "sdk-test" });
    assert.equal(await browser.contexts()[0].pages()[0].title(), "Example Domain");
    await browser.close();
    assert.notEqual((await client.sessions.get(session.id)).status, "stopped");
  });
});

live("takeover queues commands and handback reports the outcome", async () => {
  const client = new Steerpane();
  await withSession(client, async (session) => {
    const request = await client.sessions.requestHelp(session.id, { reason: "confirmation", message: "Check this" });
    assert.equal((await client.sessions.takeover(session.id)).controller, "human");
    await assert.rejects(client.actions.navigate(session.id, "https://example.org/"), HumanInControlError);
    await client.sessions.handback(session.id, { outcome: "not_done", note: "Stuck" });
    const result = await client.sessions.waitForHuman(session.id, { requestId: request.request_id, timeoutS: 10 });
    assert.deepEqual([result.status, result.outcome, result.note], ["handed_back", "not_done", "Stuck"]);
  });
});

live("fetch", async () => {
  const result = await new Steerpane().fetch("https://example.com", { formats: ["links", "metadata"] });
  assert.equal(result.status, 200);
  assert.match(result.content, /documentation examples/);
  assert.equal(result.metadata.title, "Example Domain");
});

live("files round trip", async () => {
  const client = new Steerpane();
  const made = await client.files.upload(new TextEncoder().encode("hello sdk"), { name: "hello.txt", mime: "text/plain", ttlHours: 1 });
  try {
    assert.equal(made.size_bytes, 9);
    assert.equal(new TextDecoder().decode(await client.files.download(made.id)), "hello sdk");
  } finally {
    await client.files.delete(made.id);
  }
  await assert.rejects(client.files.get(made.id), (e) => e instanceof APIError && e.status === 404);
});

live("profiles", async () => {
  const client = new Steerpane();
  const p = await client.profiles.create("sdk-node-profile", { tags: ["sdk"] });
  try {
    assert.equal((await client.profiles.update(p.id, { name: "sdk-node-renamed" })).name, "sdk-node-renamed");
    assert.equal((await client.profiles.importCookies(p.id, [{ domain: ".example.com", name: "a", value: "b" }])).imported, 1);
  } finally {
    await client.profiles.delete(p.id);
  }
});

live("embed link lifecycle", async () => {
  const client = new Steerpane();
  await withSession(client, async (session) => {
    const link = await client.embeds.create(session.id, { allow_takeover: true, allowed_origins: ["https://app.example.com"], expires_in_min: 5 });
    assert.equal(link.mode, "interactive_takeover");
    assert.match(link.url, /token=emb_/);
    assert.ok((await client.embeds.revoke(link.id)).revoked_at);
  });
});

live("a real webhook delivery passes the signature check", async () => {
  const client = new Steerpane();
  const received = {};
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { received.body = Buffer.concat(chunks); received.sig = req.headers["steerpane-signature"]; received.legacySig = req.headers["conduit-signature"]; received.headers = req.headers; res.end("ok"); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const hook = await client.webhooks.create(`http://127.0.0.1:${server.address().port}/hook`, ["session.started"]);
  try {
    const secret = hook.secret ?? (await client.webhooks.get(hook.id)).secret;
    await client.webhooks.sendTest(hook.id, { event: "session.started" });
    assert.ok(verifySignature(received.body, received.sig, secret));
    assert.equal(received.legacySig, received.sig);
    assert.ok(verifySignature(received.body, received.headers, secret));
    assert.ok(!verifySignature(received.body, received.sig, "whsec_wrong"));
  } finally {
    await client.webhooks.delete(hook.id);
    server.close();
  }
});

test("a hosted run finishes with the stub model", { skip: LIVE && process.env.STEERPANE_STUB_MODEL_URL ? false : "no stub model (templates/_testing/stub_model.py)" }, async () => {
  const client = new Steerpane();
  const key = await client.request("POST", "/v1/model-keys", { json: { provider: "custom", label: "sdk-stub", key: "stub-key-12345", base_url: process.env.STEERPANE_STUB_MODEL_URL } });
  try {
    const run = await client.runs.create("Read the page title", { model: "stub-1", max_steps: 3 });
    const done = await client.runs.wait(run.id, { timeoutS: 120, pollS: 1 });
    assert.equal(done.status, "completed", JSON.stringify(done));
    assert.equal(done.result.from, "stub model");
    assert.ok((await client.runs.messages(run.id)).data.length > 0);
  } finally {
    await client.request("DELETE", `/v1/model-keys/${key.id}`);
  }
});

live("MCP tools", async () => {
  const client = new Steerpane();
  const names = (await client.mcp.listTools()).map((t) => t.name);
  assert.ok(names.includes("search_tools") && names.includes("call_tool") && names.includes("fetch_page"));
  assert.match(JSON.stringify(await client.mcp.call("fetch_page", { url: "https://example.com" })), /documentation examples/);
  await assert.rejects(client.mcp.call("navigate", { session_id: "ses_doesnotexist", url: "https://example.com" }), ToolError);
});
