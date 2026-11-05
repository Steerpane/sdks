// Runs the built CLI as a subprocess. A small local server stands in for the API unless the test is marked live.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
const SECRET = "stp_live_0000000000000000secretsecret";
const dir = mkdtempSync(join(tmpdir(), "steerpane-cli-"));
let server, api;
const seen = [];
let deviceOutcome = "approved", polls = 0;

const SESSION = { id: "ses_1", status: "running", controller: "agent", current_url: "https://example.com/", watch_url: "http://app/sessions/ses_1", live_url: "ws://api/live", cdp_url: "ws://api/cdp" };

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const send = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      if (req.url === "/v1/oauth/device/code") {
        polls = 0;
        return send(200, { device_code: "device-secret", user_code: "BCDF-2345", verification_uri_complete: `${api}/oauth/authorize?user_code=BCDF-2345`, interval: 1, expires_in: 20 });
      }
      if (req.url === "/v1/oauth/token") {
        if (deviceOutcome === "denied") return send(400, { error: "access_denied" });
        if (polls++ === 0) return send(400, { error: "authorization_pending" });
        return send(200, { access_token: SECRET, token_type: "Bearer" });
      }
      if (req.headers.authorization !== `Bearer ${SECRET}`) return send(401, { error: { code: "unauthorized", message: "Bad token" } });
      if (req.url.startsWith("/v1/sessions?")) return send(200, { data: [SESSION], next_cursor: null });
      if (req.url === "/v1/sessions" && req.method === "POST") return send(201, { ...SESSION, status: "starting" });
      if (req.url === "/v1/sessions/ses_1") return send(200, SESSION);
      if (req.url === "/v1/sessions/ses_1/stop") return send(200, { ...SESSION, status: "stopped" });
      if (req.url === "/v1/sessions/nope") return send(404, { error: { code: "not_found", message: "Session not found" } });
      if (req.url === "/v1/fetch") return send(200, { status: 200, content: "# Hello" });
      if (req.url === "/v1/agents/runs") return send(201, { id: "run_1", status: "queued", session_id: "ses_1" });
      if (req.url === "/v1/agents/runs/run_1") return send(200, { id: "run_1", status: JSON.parse(seen.find((s) => s.url === "/v1/agents/runs" && s.method === "POST").body).task.includes("fail") ? "failed" : "completed", result: { a: 1 }, error: "Nope" });
      send(404, { error: { code: "not_found", message: req.url } });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  api = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

function cli(args, { stdin, env = {}, configDir = dir } = {}) {
  return new Promise((resolve) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("STEERPANE_")));
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...clean, STEERPANE_CONFIG_DIR: configDir, ...env } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin ?? "");
  });
}

test("login saves the token and never prints it", async () => {
  const r = await cli(["login", "--token-stdin", "--api-url", api], { stdin: `${SECRET}\n` });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!(r.stdout + r.stderr).includes(SECRET));
  const stored = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  assert.equal(stored.token, SECRET);
  if (process.platform !== "win32") assert.equal(statSync(join(dir, "config.json")).mode & 0o777, 0o600);
  const who = await cli(["whoami", "--json"]);
  assert.equal(who.code, 0);
  assert.ok(!(who.stdout + who.stderr).includes(SECRET));
  assert.equal(JSON.parse(who.stdout).token_prefix, SECRET.slice(0, 13));
});

test("browser login prints a link and confirmation code, polls, and saves only after approval", async (t) => {
  const other = mkdtempSync(join(tmpdir(), "steerpane-cli-device-"));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  deviceOutcome = "approved";
  const r = await cli(["login", "--no-browser", "--api-url", api], { configDir: other });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stderr.includes("BCDF-2345") && r.stderr.includes("Waiting for approval"));
  assert.ok(!(r.stdout + r.stderr).includes(SECRET));
  assert.ok(!(r.stdout + r.stderr).includes("device-secret"));
  assert.equal(JSON.parse(readFileSync(join(other, "config.json"), "utf8")).token, SECRET);
  assert.equal(polls, 2);
});

test("browser denial saves no token", async (t) => {
  const other = mkdtempSync(join(tmpdir(), "steerpane-cli-denied-"));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  deviceOutcome = "denied";
  const r = await cli(["login", "--no-browser", "--api-url", api], { configDir: other });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /denied in the browser/);
  assert.ok(!existsSync(join(other, "config.json")));
  deviceOutcome = "approved";
});

test("a bad token isn't saved", async () => {
  const other = mkdtempSync(join(tmpdir(), "steerpane-cli-"));
  const r = await cli(["login", "--token-stdin", "--api-url", api], { stdin: "stp_live_wrong", configDir: other });
  assert.equal(r.code, 3);
  assert.ok(!existsSync(join(other, "config.json")));
  assert.ok(!r.stderr.includes("stp_live_wrong"));
  rmSync(other, { recursive: true, force: true });
});

test("--token on the command line is refused", async () => {
  const r = await cli(["login", "--token", SECRET]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /shell history/);
});

test("sessions create, list, get, live and stop", async () => {
  const created = JSON.parse((await cli(["sessions", "create", "--url", "https://example.com", "--auto-close", "--timeout-min", "5", "--json"])).stdout);
  assert.equal(created.status, "running");
  const sent = JSON.parse(seen.findLast((s) => s.method === "POST" && s.url === "/v1/sessions").body);
  assert.deepEqual(sent, { initial_url: "https://example.com", auto_close: true, timeout_min: 5 });
  assert.equal(JSON.parse((await cli(["sessions", "list", "--status", "live", "--json"])).stdout).data[0].id, "ses_1");
  assert.equal((await cli(["sessions", "live", "ses_1"])).stdout.trim(), SESSION.watch_url);
  assert.deepEqual(Object.keys(JSON.parse((await cli(["sessions", "live", "ses_1", "--json"])).stdout)), ["id", "status", "watch_url", "live_url", "cdp_url"]);
  assert.equal(JSON.parse((await cli(["sessions", "stop", "ses_1", "--json"])).stdout).status, "stopped");
});

test("errors are JSON on stderr with exit code 1", async () => {
  const r = await cli(["sessions", "get", "nope", "--json"]);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.equal(JSON.parse(r.stderr).error.code, "not_found");
});

test("fetch prints the content, or the whole result with --json", async () => {
  assert.equal((await cli(["fetch", "https://example.com"])).stdout.trim(), "# Hello");
  assert.equal(JSON.parse((await cli(["fetch", "https://example.com", "--json"])).stdout).status, 200);
});

test("run waits, prints the result, and exits 4 when it fails", async () => {
  const ok = await cli(["run", "say hi", "--max-steps", "3", "--json"]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout).result, { a: 1 });
  seen.length = 0;
  const failed = await cli(["run", "please fail", "--json"]);
  assert.equal(failed.code, 4);
  assert.equal(JSON.parse(failed.stdout).status, "failed");
  assert.equal(JSON.parse((await cli(["run", "x", "--no-wait", "--json"])).stdout).id, "run_1");
});

test("usage errors exit 2", async () => {
  assert.equal((await cli(["nonsense"])).code, 2);
  assert.equal((await cli(["sessions", "stop"])).code, 2);
  assert.equal((await cli(["sessions", "list", "--bogus"])).code, 2);
  assert.equal(JSON.parse((await cli(["fetch", "--json"])).stderr).error.code, "usage");
});

test("env vars win over the saved token", async () => {
  const r = await cli(["whoami", "--json"], { env: { STEERPANE_API_TOKEN: "stp_live_bad", STEERPANE_API_URL: api } });
  assert.equal(r.code, 3);
});

test("logout deletes the file, then commands say not logged in", async () => {
  assert.equal((await cli(["logout"])).code, 0);
  assert.ok(!existsSync(join(dir, "config.json")));
  const r = await cli(["sessions", "list", "--json"]);
  assert.equal(r.code, 3);
  assert.match(JSON.parse(r.stderr).error.message, /Not logged in/);
});

const LIVE = Boolean(process.env.STEERPANE_API_URL && process.env.STEERPANE_API_TOKEN);
test("against a real API: a browser session from start to stop", { skip: LIVE ? false : "no local API configured" }, async () => {
  const env = { STEERPANE_API_URL: process.env.STEERPANE_API_URL };
  const live = mkdtempSync(join(tmpdir(), "steerpane-cli-"));
  const opts = { env, configDir: live };
  const login = await cli(["login", "--token-stdin", "--json"], { ...opts, stdin: process.env.STEERPANE_API_TOKEN });
  assert.equal(login.code, 0, login.stderr);
  assert.ok(!(login.stdout + login.stderr).includes(process.env.STEERPANE_API_TOKEN));
  const made = JSON.parse((await cli(["sessions", "create", "--url", "https://example.com", "--auto-close", "--json"], opts)).stdout);
  try {
    assert.notEqual(made.status, "starting");
    assert.ok((await cli(["sessions", "list", "--status", "live"], opts)).stdout.includes(made.id));
    assert.match((await cli(["sessions", "live", made.id], opts)).stdout, new RegExp(`/sessions/${made.id}`));
    assert.match((await cli(["fetch", "https://example.com"], opts)).stdout, /documentation examples/);
  } finally {
    assert.equal(JSON.parse((await cli(["sessions", "stop", made.id, "--json"], opts)).stdout).status, "stopped");
    rmSync(live, { recursive: true, force: true });
  }
});

test("against a real API: run a task with the stub model", { skip: LIVE && process.env.STEERPANE_STUB_MODEL_URL ? false : "no stub model" }, async () => {
  const headers = { Authorization: `Bearer ${process.env.STEERPANE_API_TOKEN}`, "Content-Type": "application/json" };
  const base = process.env.STEERPANE_API_URL;
  const key = await (await fetch(`${base}/v1/model-keys`, { method: "POST", headers, body: JSON.stringify({ provider: "custom", label: "cli-stub", key: "stub-key-12345", base_url: process.env.STEERPANE_STUB_MODEL_URL }) })).json();
  try {
    const env = { STEERPANE_API_URL: base, STEERPANE_API_TOKEN: process.env.STEERPANE_API_TOKEN };
    const r = await cli(["run", "Read the page title", "--model", "stub-1", "--max-steps", "3", "--json"], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).result.from, "stub model");
  } finally {
    await fetch(`${base}/v1/model-keys/${key.id}`, { method: "DELETE", headers });
  }
});
