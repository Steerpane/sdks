import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { SteerpaneError } from "@steerpane/sdk";

export async function prompt(message: string, hidden = false): Promise<string> {
  if (!process.stdin.isTTY) throw new SteerpaneError("Use --token-stdin to pipe a token, or --no-browser for a remote terminal.");
  const silent = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const rl = createInterface({ input: process.stdin, output: hidden ? silent : process.stderr, terminal: true });
  if (hidden) process.stderr.write(message);
  return new Promise((resolve, reject) => {
    let answered = false;
    rl.on("SIGINT", () => rl.close());
    rl.on("close", () => {
      if (!answered) reject(new SteerpaneError("Sign-in cancelled."));
    });
    rl.question(hidden ? "" : message, (answer) => {
      answered = true;
      rl.close();
      if (hidden) process.stderr.write("\n");
      resolve(answer.trim());
    });
  });
}

function openBrowser(uri: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", uri] : [uri];
  const child = spawn(command, args, { stdio: "ignore", detached: true, shell: false });
  child.on("error", () => process.stderr.write("Couldn't open a browser. Open the sign-in link above on any device.\n"));
  child.on("exit", (code) => { if (code) process.stderr.write("Open the sign-in link above in your browser to continue.\n"); });
  child.unref();
}

async function form(apiUrl: string, path: string, values: Record<string, string>): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await fetch(apiUrl + path, { method: "POST", body: new URLSearchParams(values), signal: AbortSignal.timeout(15000), redirect: "error" });
  } catch {
    throw new SteerpaneError(`Can't reach ${apiUrl}. Check the API URL and connection, then try again.`);
  }
  let data: Record<string, unknown>;
  try { data = await response.json() as Record<string, unknown>; }
  catch { throw new SteerpaneError("The API returned an invalid sign-in response."); }
  return { ok: response.ok, status: response.status, data };
}

export async function browserLogin(apiUrl: string, noBrowser: boolean): Promise<string> {
  const device = await form(apiUrl, "/v1/oauth/device/code", { client_id: "steerpane-cli" });
  if (!device.ok) {
    if (device.status === 404) throw new SteerpaneError("This API doesn't support browser sign-in yet. Use `steerpane login --paste-token`.");
    throw new SteerpaneError("Couldn't start browser sign-in. Try again, or use `steerpane login --paste-token`.");
  }
  const { device_code, user_code, verification_uri_complete, expires_in, interval } = device.data;
  if (typeof device_code !== "string" || typeof user_code !== "string" || typeof verification_uri_complete !== "string" || typeof expires_in !== "number" || expires_in <= 0 || typeof interval !== "number" || interval < 1) {
    throw new SteerpaneError("The API returned an invalid device sign-in response.");
  }
  const uri = new URL(verification_uri_complete);
  if (uri.protocol !== "https:" && !(uri.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(uri.hostname))) {
    throw new SteerpaneError("The API returned an insecure sign-in link.");
  }
  process.stderr.write(`\nOpen this link to sign in:\n${uri.href}\n\nConfirm code: ${user_code}\n`);
  if (!noBrowser) {
    process.stderr.write("Opening your browser…\n");
    openBrowser(uri.href);
  }
  process.stderr.write("Waiting for approval. Your existing dashboard session can be used.\nTo use an API token instead, cancel and run `steerpane login --paste-token`.\n");
  const deadline = Date.now() + Math.min(expires_in, 900) * 1000;
  let delay = interval * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, Math.max(0, deadline - Date.now()))));
    if (Date.now() >= deadline) break;
    const poll = await form(apiUrl, "/v1/oauth/token", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: "steerpane-cli", device_code });
    if (poll.ok && typeof poll.data.access_token === "string") return poll.data.access_token;
    if (poll.data.error === "authorization_pending") continue;
    if (poll.data.error === "slow_down") { delay += 5000; continue; }
    if (poll.data.error === "access_denied") throw new SteerpaneError("Sign-in was denied in the browser. No token was saved.");
    if (poll.data.error === "expired_token") break;
    throw new SteerpaneError("Browser sign-in failed. Start `steerpane login` again.");
  }
  throw new SteerpaneError("Sign-in expired. Run `steerpane login` to start again.");
}
