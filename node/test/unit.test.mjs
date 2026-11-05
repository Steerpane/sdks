// No network: a fake fetch checks what the client sends and how it reacts.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { APIError, constructEvent, HumanInControlError, SIGNATURE_HEADER, Steerpane, SteerpaneError, ToolError, verifySignature, WebhookSignatureError } from "../dist/index.js";

const TOKEN = "stp_live_0123456789abcdef";
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const err = (status, code, details = {}, headers = {}) => json(status, { error: { code, message: "nope", details } }, headers);
const clientWith = (handler, extra = {}) => new Steerpane({ token: TOKEN, baseUrl: "https://api.test", fetch: handler, ...extra });

test("sends the token and returns parsed JSON", async () => {
  let seen;
  const c = clientWith(async (url, init) => { seen = { url, init }; return json(200, { id: "ses_1", status: "running" }); });
  assert.equal((await c.sessions.get("ses_1")).status, "running");
  assert.equal(seen.url, "https://api.test/v1/sessions/ses_1");
  assert.equal(seen.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.match(seen.init.headers["User-Agent"], /^steerpane-sdk-node\//);
});

test("ids can't walk to another route", async () => {
  let url;
  await clientWith(async (u) => { url = u; return json(200, {}); }).sessions.get("../tokens");
  assert.equal(url, "https://api.test/v1/sessions/..%2Ftokens");
});

test("error envelope and human in control", async () => {
  await assert.rejects(clientWith(async () => err(404, "not_found")).sessions.get("x"), (e) => e instanceof APIError && e.status === 404 && e.code === "not_found");
  await assert.rejects(clientWith(async () => err(409, "human_in_control", { position: 1 })).actions.click("s", "#a"), (e) => e instanceof HumanInControlError && e.details.position === 1);
  await assert.rejects(clientWith(async () => new Response("gone", { status: 404 })).sessions.get("x"), (e) => e.code === "http_404" && e.message === "gone");
});

test("actions body and wait header", async () => {
  let init;
  await clientWith(async (_u, i) => { init = i; return json(200, { ok: true }); }).actions.run("s", "click", { selector: "#a", frame: null }, { waitS: 30 });
  assert.deepEqual(JSON.parse(init.body), { type: "click", selector: "#a" });
  assert.equal(init.headers["Steerpane-Wait"], "30");
});

test("GET retries on 503 then succeeds", async () => {
  let calls = 0;
  const c = clientWith(async () => (++calls < 2 ? err(503, "unavailable") : json(200, { data: [] })));
  assert.deepEqual(await c.sessions.list(), { data: [] });
  assert.equal(calls, 2);
});

test("a plain POST isn't retried on 503", async () => {
  let calls = 0;
  await assert.rejects(clientWith(async () => { calls++; return err(503, "unavailable"); }).actions.navigate("s", "https://a.test"), APIError);
  assert.equal(calls, 1);
});

test("create retries with the same idempotency key", async () => {
  const keys = [];
  const c = clientWith(async (_u, i) => { keys.push(i.headers["Idempotency-Key"]); return keys.length === 1 ? err(502, "bad") : json(201, { id: "ses_1" }); });
  assert.equal((await c.sessions.create()).id, "ses_1");
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
});

test("rate_limited POST retries, quota_exceeded doesn't", async () => {
  let calls = 0;
  const limited = clientWith(async () => (++calls === 1 ? err(429, "rate_limited", {}, { "Retry-After": "0" }) : json(200, { ok: true })));
  assert.deepEqual(await limited.actions.navigate("s", "https://a.test"), { ok: true });
  assert.equal(calls, 2);
  let quota = 0;
  await assert.rejects(clientWith(async () => { quota++; return err(429, "quota_exceeded"); }).fetch("https://a.test"), (e) => e.code === "quota_exceeded");
  assert.equal(quota, 1);
});

test("refuses a token over plain http except to localhost", () => {
  assert.throws(() => new Steerpane({ token: TOKEN, baseUrl: "http://api.example.com" }), SteerpaneError);
  new Steerpane({ token: TOKEN, baseUrl: "http://127.0.0.1:9" });
  new Steerpane({ token: TOKEN, baseUrl: "http://api.example.com", allowInsecureHttp: true });
});

test("missing token", () => {
  const saved = process.env.STEERPANE_API_TOKEN;
  delete process.env.STEERPANE_API_TOKEN;
  try { assert.throws(() => new Steerpane(), /STEERPANE_API_TOKEN/); } finally { if (saved) process.env.STEERPANE_API_TOKEN = saved; }
});

test("logging the client doesn't print the token", async () => {
  const { inspect } = await import("node:util");
  const c = new Steerpane({ token: TOKEN, baseUrl: "https://api.test" });
  assert.ok(!inspect(c, { depth: 5 }).includes(TOKEN));
  assert.ok(!JSON.stringify(Object.keys(c)).includes("token"));
  assert.equal(c.token, TOKEN);
});

test("paginate walks every page", async () => {
  const c = clientWith(async (url) => json(200, url.includes("cursor=n") ? { data: [3], next_cursor: null } : { data: [1, 2], next_cursor: "n" }));
  const got = [];
  for await (const x of c.paginate((p) => c.sessions.list({ ...p, status: "live" }))) got.push(x);
  assert.deepEqual(got, [1, 2, 3]);
});

const mcpHandler = (toolResult) => async (_u, init) => {
  const msg = JSON.parse(init.body);
  if (msg.method === "initialize") return json(200, { jsonrpc: "2.0", id: msg.id, result: {} }, { "mcp-session-id": "mcp-1" });
  if (msg.id === undefined) { assert.equal(init.headers["Mcp-Session-Id"], "mcp-1"); return new Response(null, { status: 202 }); }
  const frame = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: toolResult });
  const progress = JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} });
  return new Response(`event: message\ndata: ${progress}\n\nevent: message\ndata: ${frame}\n\n`, { headers: { "content-type": "text/event-stream" } });
};

test("MCP call reads SSE and returns JSON", async () => {
  assert.deepEqual(await clientWith(mcpHandler({ content: [{ type: "text", text: '{"ok":true}' }] })).mcp.call("act", { session_id: "s" }), { ok: true });
});

test("MCP tool error throws", async () => {
  const body = { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code: "model_key_required", message: "Add a key" } }) }] };
  await assert.rejects(clientWith(mcpHandler(body)).mcp.call("act"), (e) => e instanceof ToolError && e.code === "model_key_required");
});

const sign = (body, secret, t) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

test("webhook signature", () => {
  const body = '{"id":"evt_1"}';
  const now = Math.floor(Date.now() / 1000);
  const good = sign(body, "whsec_a", now);
  assert.ok(verifySignature(body, good, "whsec_a"));
  assert.ok(verifySignature(Buffer.from(body), good, "whsec_a"));
  assert.ok(!verifySignature(body, good, "whsec_b"));
  assert.ok(!verifySignature(`${body} `, good, "whsec_a"));
  assert.ok(!verifySignature(body, null, "whsec_a"));
  assert.ok(!verifySignature(body, "garbage", "whsec_a"));
  assert.ok(!verifySignature(body, `t=abc,v1=${"a".repeat(64)}`, "whsec_a"));
  assert.ok(!verifySignature(body, sign(body, "whsec_a", now - 301), "whsec_a"));
  assert.ok(!verifySignature(body, sign(body, "whsec_a", now + 301), "whsec_a"));
});

test("signature during rotation accepts either secret", () => {
  const now = Math.floor(Date.now() / 1000);
  const header = `${sign("{}", "whsec_new", now)},${sign("{}", "whsec_old", now).split(",")[1]}`;
  assert.ok(verifySignature("{}", header, "whsec_old"));
  assert.ok(verifySignature("{}", header, "whsec_new"));
  assert.ok(!verifySignature("{}", header, "whsec_other"));
});

test("signature is read from a request's headers: new name first, then the old one", () => {
  const now = Math.floor(Date.now() / 1000);
  const body = '{"a":1}';
  const good = sign(body, "s", now);
  const bad = sign(body, "other", now);
  assert.ok(verifySignature(body, { "steerpane-signature": good }, "s"));
  assert.ok(verifySignature(body, { "Steerpane-Signature": good }, "s"));
  assert.ok(verifySignature(body, { "conduit-signature": good }, "s"));
  assert.ok(verifySignature(body, { "Conduit-Signature": good }, "s"));
  assert.ok(verifySignature(body, { "steerpane-signature": [good] }, "s"));
  assert.ok(verifySignature(body, new Headers({ "Steerpane-Signature": good }), "s"));
  assert.ok(verifySignature(body, new Headers({ "Conduit-Signature": good }), "s"));
  assert.ok(verifySignature(body, { "steerpane-signature": good, "conduit-signature": bad }, "s"));
  assert.ok(!verifySignature(body, { "steerpane-signature": bad, "conduit-signature": good }, "s"), "the new name wins when both are there");
  assert.ok(!verifySignature(body, new Headers({ "Steerpane-Signature": bad, "Conduit-Signature": good }), "s"));
  assert.ok(!verifySignature(body, {}, "s"));
  assert.ok(!verifySignature(body, new Headers(), "s"));
  assert.equal(constructEvent(body, { "conduit-signature": good }, "s").a, 1);
  assert.equal(SIGNATURE_HEADER, "Steerpane-Signature");
});

test("constructEvent", () => {
  const body = '{"id":"evt_1","type":"session.ended"}';
  const now = Math.floor(Date.now() / 1000);
  assert.equal(constructEvent(body, sign(body, "s", now), "s").type, "session.ended");
  assert.throws(() => constructEvent(body, sign(body, "s", now), "wrong"), WebhookSignatureError);
});

test("a signature made by the server's own signing code passes", () => {
  // from the server: signature_header(["whsec_vector"], '{"a":1}', 1700000000)
  const header = "t=1700000000,v1=5d485af0d9ddc3522d7a396ce60598f0d5fbb3bacdb1924001168092bc407c18";
  assert.ok(verifySignature('{"a":1}', header, "whsec_vector", { now: 1700000000 }));
  assert.ok(!verifySignature('{"a":2}', header, "whsec_vector", { now: 1700000000 }));
});
