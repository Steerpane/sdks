#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { APIError, DEFAULT_BASE_URL, Steerpane, SteerpaneError, type AgentRun, type Session } from "@steerpane/sdk";
import { configPath, deleteConfig, readConfig, writeConfig } from "./config.js";
import { browserLogin, prompt } from "./login.js";

const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

const EXIT = { ok: 0, failed: 1, usage: 2, auth: 3, task_failed: 4 } as const;

const HELP = `steerpane ${VERSION}: remote browsers for AI agents

Usage: steerpane <command> [options]

  login                         Sign in with your browser, or paste an API token
    --paste-token               Paste an API token at a visible, hidden-input prompt
    --token-stdin               Read the token from stdin
    --no-browser                Print the browser sign-in link without opening it
    --api-url <url>             API to use from now on
  logout                        Delete the saved token
  whoami                        Show which API and token prefix are in use

  sessions list                 --status <s> --limit <n>
  sessions create               --url <u> --profile <id> --auto-close --timeout-min <n> --no-wait
  sessions get <id>
  sessions stop <id>
  sessions live <id>            Print the page where a person can watch and take over

  fetch <url>                   --mode fast|deep|auto --format markdown|html|raw
  run "<task>"                  --profile <id> --model <m> --max-steps <n> --max-cost-usd <n> --no-wait --timeout-s <n>

Every command takes --json, for machine-readable output on stdout and errors on stderr as
{"error": {"code", "message"}}. STEERPANE_API_TOKEN and STEERPANE_API_URL override the saved values.

Exit codes: 0 ok, 1 failed, 2 bad usage, 3 not logged in or token refused, 4 the run finished but failed.
`;

class UsageError extends Error {}

const GLOBAL_OPTIONS = { json: { type: "boolean" }, help: { type: "boolean", short: "h" } } as const satisfies ParseArgsConfig["options"];

function parse<O extends NonNullable<ParseArgsConfig["options"]>>(args: string[], options: O) {
  try {
    return parseArgs({ args, options: { ...GLOBAL_OPTIONS, ...options }, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

const num = (value: string | undefined, name: string): number | undefined => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new UsageError(`${name} must be a number`);
  return n;
};

function client(): Steerpane {
  const stored = readConfig();
  const token = process.env["STEERPANE_API_TOKEN"] ?? stored.token;
  if (!token) throw new SteerpaneError("Not logged in. Run `steerpane login`, or set STEERPANE_API_TOKEN.");
  return new Steerpane({ token, baseUrl: process.env["STEERPANE_API_URL"] ?? stored.api_url });
}

function emit(asJson: boolean, value: unknown, text: string): void {
  process.stdout.write(asJson ? `${JSON.stringify(value)}\n` : `${text}\n`);
}

function sessionLine(s: Session): string {
  return [s.id, s.status, s.controller, s.current_url ?? "-"].join("\t");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function login(args: string[]): Promise<number> {
  const { values } = parse(args, { "token-stdin": { type: "boolean" }, "paste-token": { type: "boolean" }, "no-browser": { type: "boolean" }, "api-url": { type: "string" }, token: { type: "string" } });
  if (values.token !== undefined) throw new UsageError("--token isn't accepted, because it would end up in your shell history. Use --token-stdin, or run `steerpane login` and paste it.");
  if ((values["token-stdin"] || values["paste-token"]) && values["no-browser"]) throw new UsageError("Choose token sign-in or browser sign-in, not both.");
  if (values["token-stdin"] && values["paste-token"]) throw new UsageError("Choose --token-stdin or --paste-token, not both.");
  const previous = readConfig();
  const apiUrl = (values["api-url"] ?? process.env["STEERPANE_API_URL"] ?? previous.api_url ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  // Validate HTTPS / loopback before sending any token or opening a returned link.
  new Steerpane({ token: "configuration-check", baseUrl: apiUrl });
  let token: string;
  if (values["token-stdin"]) token = await readStdin();
  else if (values["paste-token"]) token = await prompt("API token (input hidden): ", true);
  else {
    if (!values["no-browser"]) {
      if (!process.stdin.isTTY) throw new UsageError("Run this in a terminal, use --no-browser for a sign-in link, or --token-stdin to pipe an API token.");
      process.stderr.write("Sign in to Steerpane\n  1. Continue in your browser (default)\n  2. Paste an API token\n");
      const choice = await prompt("Choose [1]: ");
      if (choice && !["1", "2"].includes(choice)) throw new UsageError("Choose 1 for browser sign-in or 2 to paste a token.");
      token = choice === "2" ? await prompt("API token (input hidden): ", true) : await browserLogin(apiUrl, false);
    } else token = await browserLogin(apiUrl, true);
  }
  if (!token) throw new UsageError("No token given");
  process.stderr.write("Checking credentials…\n");
  await new Steerpane({ token, baseUrl: apiUrl }).sessions.list({ limit: 1 }); // refuses a bad token before saving it
  const path = writeConfig({ token, api_url: apiUrl });
  emit(Boolean(values.json), { ok: true, api_url: apiUrl, config: path }, `Logged in to ${apiUrl}. Token saved in ${path}.`);
  return EXIT.ok;
}

function logout(args: string[]): number {
  const { values } = parse(args, {});
  const removed = deleteConfig();
  emit(Boolean(values.json), { ok: true, removed }, removed ? "Logged out." : "Nothing to do: no saved token.");
  return EXIT.ok;
}

async function whoami(args: string[]): Promise<number> {
  const { values } = parse(args, {});
  const c = client();
  await c.sessions.list({ limit: 1 });
  const source = process.env["STEERPANE_API_TOKEN"] ? "STEERPANE_API_TOKEN" : configPath();
  const prefix = c.token.slice(0, 13);
  emit(Boolean(values.json), { api_url: c.baseUrl, token_prefix: prefix, source }, `API: ${c.baseUrl}\nToken: ${prefix}… (from ${source})`);
  return EXIT.ok;
}

async function sessions(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  switch (action) {
    case "list": {
      const { values } = parse(rest, { status: { type: "string" }, limit: { type: "string" } });
      const page = await client().sessions.list({ status: values.status, limit: num(values.limit, "--limit") });
      emit(Boolean(values.json), page, page.data.length ? page.data.map(sessionLine).join("\n") : "No sessions.");
      return EXIT.ok;
    }
    case "create": {
      const { values } = parse(rest, { url: { type: "string" }, profile: { type: "string" }, "auto-close": { type: "boolean" }, "timeout-min": { type: "string" }, "no-wait": { type: "boolean" } });
      const c = client();
      let session = await c.sessions.create({ initial_url: values.url, profile_id: values.profile, auto_close: values["auto-close"], timeout_min: num(values["timeout-min"], "--timeout-min") });
      if (!values["no-wait"]) session = await c.sessions.waitUntilReady(session.id);
      emit(Boolean(values.json), session, `${session.id}\t${session.status}\nWatch: ${session.watch_url}`);
      return EXIT.ok;
    }
    case "get":
    case "stop":
    case "live": {
      const { values, positionals } = parse(rest, {});
      const id = positionals[0];
      if (!id) throw new UsageError(`Usage: steerpane sessions ${action} <id>`);
      const c = client();
      if (action === "stop") {
        const s = await c.sessions.stop(id);
        emit(Boolean(values.json), s, `${s.id}\t${s.status}`);
      } else {
        const s = await c.sessions.get(id);
        if (action === "get") emit(Boolean(values.json), s, sessionLine(s));
        else emit(Boolean(values.json), { id: s.id, status: s.status, watch_url: s.watch_url, live_url: s.live_url, cdp_url: s.cdp_url }, s.watch_url);
      }
      return EXIT.ok;
    }
    default:
      throw new UsageError(`Usage: steerpane sessions list|create|get|stop|live`);
  }
}

async function fetchCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { mode: { type: "string" }, format: { type: "string" } });
  const url = positionals[0];
  if (!url) throw new UsageError("Usage: steerpane fetch <url> [--mode fast|deep|auto] [--format markdown|html|raw]");
  const result = await client().fetch(url, { mode: values.mode, format: values.format });
  emit(Boolean(values.json), result, result.content);
  return EXIT.ok;
}

async function run(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    profile: { type: "string" }, model: { type: "string" }, "max-steps": { type: "string" }, "max-cost-usd": { type: "string" }, "no-wait": { type: "boolean" }, "timeout-s": { type: "string" },
  });
  const task = positionals.join(" ").trim();
  if (!task) throw new UsageError('Usage: steerpane run "<task>"');
  const c = client();
  const started = await c.runs.create(task, {
    profile_id: values.profile, model: values.model, max_steps: num(values["max-steps"], "--max-steps"), max_cost_usd: num(values["max-cost-usd"], "--max-cost-usd"),
  });
  const asJson = Boolean(values.json);
  if (values["no-wait"]) {
    emit(asJson, started, `${started.id}\t${started.status}`);
    return EXIT.ok;
  }
  if (!asJson) process.stderr.write(`Run ${started.id} started. Watch it with: steerpane sessions live ${started.session_id}\n`);
  const done: AgentRun = await c.runs.wait(started.id, { timeoutS: num(values["timeout-s"], "--timeout-s") ?? 600 });
  const text = done.status === "completed" ? (typeof done.result === "string" ? done.result : JSON.stringify(done.result, null, 2)) : `${done.status}: ${done.error ?? ""}`;
  emit(asJson, done, text);
  return done.status === "completed" ? EXIT.ok : EXIT.task_failed;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined: case "help": case "--help": case "-h":
      process.stdout.write(HELP);
      return command === undefined ? EXIT.usage : EXIT.ok;
    case "--version": case "-v": case "version":
      process.stdout.write(`${VERSION}\n`);
      return EXIT.ok;
    case "login": return login(rest);
    case "logout": return logout(rest);
    case "whoami": return whoami(rest);
    case "sessions": return sessions(rest);
    case "fetch": return fetchCommand(rest);
    case "run": return run(rest);
    default:
      throw new UsageError(`Unknown command: ${command}. Run steerpane --help.`);
  }
}

function fail(asJson: boolean, code: string, message: string, details?: unknown): void {
  process.stderr.write(asJson ? `${JSON.stringify({ error: { code, message, ...(details ? { details } : {}) } })}\n` : `Error: ${message}\n`);
}

const argv = process.argv.slice(2);
const wantsJson = argv.includes("--json");
main(argv).then(
  (code) => { process.exitCode = code; },
  (e: unknown) => {
    if (e instanceof UsageError) {
      fail(wantsJson, "usage", e.message);
      process.exitCode = EXIT.usage;
    } else if (e instanceof APIError) {
      fail(wantsJson, e.code, e.message, e.details);
      process.exitCode = e.status === 401 ? EXIT.auth : EXIT.failed;
    } else if (e instanceof SteerpaneError) {
      fail(wantsJson, "client_error", e.message);
      process.exitCode = /Not logged in/.test(e.message) ? EXIT.auth : EXIT.failed;
    } else {
      fail(wantsJson, "failed", e instanceof Error ? e.message : String(e));
      process.exitCode = EXIT.failed;
    }
  },
);
