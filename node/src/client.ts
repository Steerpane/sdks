import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { APIError, errorFromResponse, SteerpaneError, ToolError } from "./errors.js";
import type {
  AgentRun, Capture, Credential, CrawlJob, EmbedLink, FetchResult, HelpRequest, HumanResult, Json, Page, Profile, SearchResponse, Session, StoredFile, UploadUrl, Webhook,
} from "./types.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://api.steerpane.app";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const RETRY_STATUSES = new Set([502, 503, 504]);
const MCP_PROTOCOL = "2025-06-18";

export interface SteerpaneOptions {
  /** Falls back to `STEERPANE_API_TOKEN`. */
  token?: string;
  /** Falls back to `STEERPANE_API_URL`, then `DEFAULT_BASE_URL`. */
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Allow sending the token over plain http to a host that isn't local. */
  allowInsecureHttp?: boolean;
  /** Replace `fetch`, for tests. */
  fetch?: typeof fetch;
}

interface RequestOptions {
  json?: unknown;
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: FormData;
  timeoutMs?: number;
}

const seg = (value: string) => encodeURIComponent(String(value));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const clean = <T extends object>(values: T): T => Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined && v !== null)) as T;
const retryAfterOf = (res: Response): number | null => {
  const v = Number(res.headers.get("retry-after"));
  return res.headers.has("retry-after") && Number.isFinite(v) ? v : null;
};

async function parse(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  if ((res.headers.get("content-type") ?? "").includes("json")) return JSON.parse(text);
  return text;
}

/** Browser actions, `POST /v1/sessions/{id}/actions`. While a human holds control, acting calls throw `HumanInControlError` and queue. */
class Actions {
  constructor(private readonly c: Steerpane) {}

  /** Run any action type. `waitS` holds the call until a takeover ends instead of throwing, up to 600 seconds. */
  run<T = Json>(sessionId: string, type: string, args: Json = {}, options: { waitS?: number } = {}): Promise<T> {
    const headers: Record<string, string> = options.waitS === undefined ? {} : { "Steerpane-Wait": String(options.waitS) };
    return this.c.request<T>("POST", `/v1/sessions/${seg(sessionId)}/actions`, { json: { type, ...clean(args) }, headers, timeoutMs: Math.max(this.c.timeoutMs, ((options.waitS ?? 0) + 30) * 1000) });
  }
  navigate(sessionId: string, url: string, args: Json = {}) { return this.run(sessionId, "navigate", { url, ...args }); }
  click(sessionId: string, selector: string, args: Json = {}) { return this.run(sessionId, "click", { selector, ...args }); }
  type(sessionId: string, selector: string, text: string, args: Json = {}) { return this.run(sessionId, "type", { selector, text, ...args }); }
  pressKey(sessionId: string, key: string, args: Json = {}) { return this.run(sessionId, "press_key", { key, ...args }); }
  selectOption(sessionId: string, selector: string, option: string, args: Json = {}) { return this.run(sessionId, "select_option", { selector, option, ...args }); }
  scroll(sessionId: string, args: Json = {}) { return this.run(sessionId, "scroll", args); }
  /** Exactly one of `selector` (+ `state`), `text`, `url`, `load_state` or `ms`. `timeout_ms` defaults to 10000. */
  waitFor(sessionId: string, args: Json) { return this.run(sessionId, "wait_for", args); }
  snapshot(sessionId: string, args: Json = {}) { return this.run(sessionId, "snapshot", args); }
  getPageText(sessionId: string, args: Json = {}) { return this.run<{ text: string } & Json>(sessionId, "get_page_text", args); }
  elementState(sessionId: string, selector: string, args: Json = {}) { return this.run(sessionId, "element_state", { selector, ...args }); }
  formFields(sessionId: string, args: Json = {}) { return this.run<{ fields: Json[] } & Json>(sessionId, "form_fields", args); }
  screenshot(sessionId: string, args: Json = {}) { return this.run(sessionId, "screenshot", args); }
  /** Run JavaScript in the page. `code` is a function body, so use `return` to get a value back as `result`. */
  execute<R = unknown>(sessionId: string, code: string, args: Json = {}) { return this.run<{ result: R } & Json>(sessionId, "execute", { code, ...args }); }
  /** Needs a model key on the organization. */
  extract(sessionId: string, instruction: string, args: Json = {}) { return this.run(sessionId, "extract", { instruction, ...args }); }
  download(sessionId: string, args: Json = {}) { return this.run(sessionId, "download", args); }
  uploadFile(sessionId: string, args: Json = {}) { return this.run(sessionId, "upload_file", args); }
  /** Type a stored credential into the page. The secret never comes back. Refused off the credential's site. */
  vaultFill(sessionId: string, credentialId: string, args: Json = {}) { return this.run(sessionId, "vault_fill", { credential_id: credentialId, ...args }); }
}

class Sessions {
  constructor(private readonly c: Steerpane) {}

  list(params: { status?: string; profile_id?: string; q?: string; project_id?: string; limit?: number; cursor?: string | null } = {}) {
    return this.c.request<Page<Session>>("GET", "/v1/sessions", { params });
  }
  /** Start a browser. `config` takes the session fields in the API docs, such as `initial_url`, `profile_id`, `auto_close`, `timeout_min`. */
  create(config: Json = {}, options: { idempotencyKey?: string } = {}) {
    return this.c.request<Session>("POST", "/v1/sessions", { json: clean(config), headers: { "Idempotency-Key": options.idempotencyKey ?? crypto.randomUUID() } });
  }
  get(sessionId: string) { return this.c.request<Session>("GET", `/v1/sessions/${seg(sessionId)}`); }
  /** Wait for the browser to leave `starting`. Throws if it ends instead, or doesn't start in time. */
  async waitUntilReady(sessionId: string, options: { timeoutS?: number; pollS?: number } = {}): Promise<Session> {
    const timeoutS = options.timeoutS ?? 90;
    const deadline = Date.now() + timeoutS * 1000;
    for (;;) {
      const session = await this.get(sessionId);
      if (session.status === "stopped" || session.status === "error") throw new SteerpaneError(`Session ${sessionId} ended before it was ready: ${session.error_message ?? session.status}`);
      if (session.status !== "starting") return session;
      if (Date.now() >= deadline) throw new SteerpaneError(`Session ${sessionId} was still starting after ${timeoutS} s`);
      await sleep((options.pollS ?? 0.5) * 1000);
    }
  }
  stop(sessionId: string) { return this.c.request<Session>("POST", `/v1/sessions/${seg(sessionId)}/stop`); }
  async delete(sessionId: string): Promise<void> { await this.c.request("DELETE", `/v1/sessions/${seg(sessionId)}`); }
  keepalive(sessionId: string) { return this.c.request<Session>("POST", `/v1/sessions/${seg(sessionId)}/keepalive`); }
  takeover(sessionId: string) { return this.c.request<Session>("POST", `/v1/sessions/${seg(sessionId)}/takeover`); }
  /** Give control back. The waiting agent receives `outcome` and `note`. */
  handback(sessionId: string, input: { outcome?: "done" | "not_done"; note?: string } = {}) {
    return this.c.request<Session>("POST", `/v1/sessions/${seg(sessionId)}/handback`, { json: clean(input) });
  }
  /** Ask a person for help. The agent goes on hold, and `agent.human_help_requested` fires. */
  requestHelp(sessionId: string, input: { reason: string; message?: string }) {
    return this.c.request<HelpRequest>("POST", `/v1/sessions/${seg(sessionId)}/help-requests`, { json: { message: "", ...input } });
  }
  /** Long-poll until the human hands back. `status` is `handed_back`, `timeout` (call again) or `stopped`. */
  waitForHuman(sessionId: string, options: { requestId?: string; timeoutS?: number } = {}) {
    const timeoutS = options.timeoutS ?? 30;
    return this.c.request<HumanResult>("GET", `/v1/sessions/${seg(sessionId)}/help-requests/${seg(options.requestId ?? "latest")}/wait`, {
      params: { timeout_s: timeoutS }, timeoutMs: Math.max(this.c.timeoutMs, (timeoutS + 30) * 1000),
    });
  }
  events(sessionId: string, params: { limit?: number; cursor?: string | null } = {}) { return this.c.request<Page<Json>>("GET", `/v1/sessions/${seg(sessionId)}/events`, { params }); }
  files(sessionId: string) { return this.c.request<Json>("GET", `/v1/sessions/${seg(sessionId)}/files`); }
  /** Pack what the session downloaded into one ZIP in the file store. */
  zipFiles(sessionId: string) { return this.c.request<Json>("POST", `/v1/sessions/${seg(sessionId)}/files/zip`); }
}

class Profiles {
  constructor(private readonly c: Steerpane) {}
  list(params: { tag?: string; q?: string; limit?: number; cursor?: string | null } = {}) { return this.c.request<Page<Profile>>("GET", "/v1/profiles", { params }); }
  get(profileId: string) { return this.c.request<Profile>("GET", `/v1/profiles/${seg(profileId)}`); }
  create(name: string, fields: Json = {}) { return this.c.request<Profile>("POST", "/v1/profiles", { json: { name, ...clean(fields) } }); }
  update(profileId: string, fields: Json) { return this.c.request<Profile>("PATCH", `/v1/profiles/${seg(profileId)}`, { json: fields }); }
  async delete(profileId: string): Promise<void> { await this.c.request("DELETE", `/v1/profiles/${seg(profileId)}`); }
  clone(profileId: string) { return this.c.request<Profile>("POST", `/v1/profiles/${seg(profileId)}/clone`); }
  /** Really load each signed-in site with the profile's state, and report whether it is still signed in. */
  verify(profileId: string, input: { domains?: string[] } = {}) { return this.c.request<Json>("POST", `/v1/profiles/${seg(profileId)}/verify`, { json: clean(input), timeoutMs: Math.max(this.c.timeoutMs, 90_000) }); }
  lock(profileId: string) { return this.c.request<Json>("GET", `/v1/profiles/${seg(profileId)}/lock`); }
  importCookies(profileId: string, cookies: Json[]) { return this.c.request<{ imported: number }>("POST", `/v1/profiles/${seg(profileId)}/cookies/import`, { json: { cookies } }); }
}

/** Hosted agent runs. These use your organization's own model key. */
class Runs {
  constructor(private readonly c: Steerpane) {}
  /** `fields`: `profile_id`, `agent_id`, `model`, `max_steps`, `max_cost_usd`, `max_duration_s`, `result_schema`, `variables`, `project_id`. */
  create(task: string, fields: Json = {}, options: { idempotencyKey?: string } = {}) {
    return this.c.request<AgentRun>("POST", "/v1/agents/runs", { json: { task, ...clean(fields) }, headers: { "Idempotency-Key": options.idempotencyKey ?? crypto.randomUUID() } });
  }
  get(runId: string) { return this.c.request<AgentRun>("GET", `/v1/agents/runs/${seg(runId)}`); }
  list(params: { status?: string; agent_id?: string; project_id?: string; limit?: number; cursor?: string | null } = {}) { return this.c.request<Page<AgentRun>>("GET", "/v1/agents/runs", { params }); }
  messages(runId: string) { return this.c.request<Page<Json>>("GET", `/v1/agents/runs/${seg(runId)}/messages`); }
  cancel(runId: string) { return this.c.request<AgentRun>("POST", `/v1/agents/runs/${seg(runId)}/cancel`); }
  /** Poll until the run finishes. Returns the run whatever its outcome, so check `status`. */
  async wait(runId: string, options: { timeoutS?: number; pollS?: number } = {}): Promise<AgentRun> {
    const timeoutS = options.timeoutS ?? 600;
    const deadline = Date.now() + timeoutS * 1000;
    for (;;) {
      const run = await this.get(runId);
      if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") return run;
      if (Date.now() >= deadline) throw new SteerpaneError(`Run ${runId} had not finished after ${timeoutS} s (status ${run.status})`);
      await sleep((options.pollS ?? 2) * 1000);
    }
  }
}

class Files {
  constructor(private readonly c: Steerpane) {}
  /** Store a file: a path, or bytes with `name`. The result's `id` goes straight into `actions.uploadFile(sessionId, { file_id })`. */
  async upload(file: string | Uint8Array, options: { name?: string; mime?: string; ttlHours?: number } = {}): Promise<StoredFile> {
    const bytes = typeof file === "string" ? await readFile(file) : file;
    const filename = options.name ?? (typeof file === "string" ? basename(file) : "file");
    const form = new FormData();
    form.append("file", new Blob([bytes as Uint8Array<ArrayBuffer>], { type: options.mime ?? "application/octet-stream" }), filename);
    if (options.name) form.append("name", options.name);
    if (options.ttlHours !== undefined) form.append("ttl_hours", String(options.ttlHours));
    return this.c.request<StoredFile>("POST", "/v1/files", { body: form });
  }
  createUploadUrl(name: string, fields: { mime?: string; size_bytes?: number; ttl_hours?: number } = {}) { return this.c.request<UploadUrl>("POST", "/v1/files/uploads", { json: { name, ...clean(fields) } }); }
  list(params: { source?: string; session_id?: string; q?: string; limit?: number; cursor?: string | null } = {}) { return this.c.request<Page<StoredFile>>("GET", "/v1/files", { params }); }
  get(fileId: string) { return this.c.request<StoredFile>("GET", `/v1/files/${seg(fileId)}`); }
  /** The file's bytes. On S3 storage the API redirects to a presigned URL, which `fetch` follows without your token. */
  async download(fileId: string): Promise<Uint8Array> {
    const res = await this.c.rawRequest("GET", `/v1/files/${seg(fileId)}/content`);
    if (!res.ok) throw errorFromResponse(res.status, await parse(res), retryAfterOf(res));
    return new Uint8Array(await res.arrayBuffer());
  }
  async delete(fileId: string): Promise<void> { await this.c.request("DELETE", `/v1/files/${seg(fileId)}`); }
}

/** Links that show a session inside your own product. Scale and Enterprise plans. The URL is a credential: keep it out of logs. */
class Embeds {
  constructor(private readonly c: Steerpane) {}
  create(sessionId: string, config: { allow_takeover?: boolean; allowed_origins?: string[]; expires_in_min?: number; hide_toolbar?: boolean; show_control?: boolean; theme?: string; end_user?: { id: string; name?: string }; mode?: string } = {}) {
    return this.c.request<EmbedLink>("POST", `/v1/sessions/${seg(sessionId)}/embed`, { json: { expires_in_min: 30, ...clean(config) } });
  }
  list(params: { session_id?: string; limit?: number; cursor?: string | null } = {}) { return this.c.request<Page<EmbedLink>>("GET", "/v1/embed-links", { params }); }
  /** Closes open iframes at once, and returns control to the agent if this link held it. */
  revoke(linkId: string) { return this.c.request<EmbedLink>("POST", `/v1/embed-links/${seg(linkId)}/revoke`); }
}

/** Endpoint management. To check a delivery's signature use `verifySignature`, which needs no client. */
class Webhooks {
  constructor(private readonly c: Steerpane) {}
  list() { return this.c.request<Page<Webhook>>("GET", "/v1/webhooks"); }
  create(url: string, events: string[], fields: Json = {}) { return this.c.request<Webhook>("POST", "/v1/webhooks", { json: { url, events, ...clean(fields) } }); }
  get(webhookId: string) { return this.c.request<Webhook>("GET", `/v1/webhooks/${seg(webhookId)}`); }
  async delete(webhookId: string): Promise<void> { await this.c.request("DELETE", `/v1/webhooks/${seg(webhookId)}`); }
  sendTest(webhookId: string, input: { event?: string } = {}) { return this.c.request<Json>("POST", `/v1/webhooks/${seg(webhookId)}/test`, { json: clean(input) }); }
}

/** Stored logins. Passwords and TOTP secrets go in and never come back to an API token. */
class Vault {
  constructor(private readonly c: Steerpane) {}
  list() { return this.c.request<Page<Credential>>("GET", "/v1/vault/credentials"); }
  create(input: { domain: string; username: string; password: string; name?: string; totp_secret?: string; profile_ids?: string[]; token_ids?: string[] }) { return this.c.request<Credential>("POST", "/v1/vault/credentials", { json: clean(input) }); }
  async delete(credentialId: string): Promise<void> { await this.c.request("DELETE", `/v1/vault/credentials/${seg(credentialId)}`); }
}

class Crawls {
  constructor(private readonly c: Steerpane) {}
  /** `options`: `limit`, `max_depth`, `mode`, `formats`, `include_paths`, `exclude_paths`, `check_links`, `same_site`, ... */
  start(url: string, options: Json = {}) { return this.c.request<CrawlJob>("POST", "/v1/crawl", { json: { url, ...clean(options) } }); }
  get(jobId: string, params: { cursor?: string | number | null; limit?: number; include_content?: boolean } = {}) { return this.c.request<CrawlJob>("GET", `/v1/crawl/${seg(jobId)}`, { params }); }
  cancel(jobId: string) { return this.c.request<CrawlJob>("DELETE", `/v1/crawl/${seg(jobId)}`); }
  async wait(jobId: string, options: { timeoutS?: number; pollS?: number } = {}): Promise<CrawlJob> {
    const timeoutS = options.timeoutS ?? 300;
    const deadline = Date.now() + timeoutS * 1000;
    for (;;) {
      const job = await this.get(jobId, { include_content: false });
      if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") return job;
      if (Date.now() >= deadline) throw new SteerpaneError(`Crawl ${jobId} had not finished after ${timeoutS} s`);
      await sleep((options.pollS ?? 2) * 1000);
    }
  }
}

interface McpResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: { type: string; text?: string }[];
  tools?: Json[];
}

/** Call MCP tools over the API's Streamable HTTP endpoint. A few tools are MCP only, such as `act`, `observe` and `wait_for_code`. */
class Mcp {
  private sessionId: string | null = null;
  private nextId = 0;
  constructor(private readonly c: Steerpane) {}

  private async post(method: string, params: Json, options: { notify?: boolean; timeoutMs?: number } = {}): Promise<McpResult | null> {
    const id = options.notify ? undefined : ++this.nextId;
    const headers: Record<string, string> = { Accept: "application/json, text/event-stream", "Mcp-Protocol-Version": MCP_PROTOCOL };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    const res = await this.c.rawRequest("POST", "/mcp", { json: { jsonrpc: "2.0", method, params, ...(id ? { id } : {}) }, headers, timeoutMs: options.timeoutMs });
    if (res.status >= 400) throw errorFromResponse(res.status, await parse(res), retryAfterOf(res));
    this.sessionId = res.headers.get("mcp-session-id") ?? this.sessionId;
    if (options.notify) return null;
    const text = await res.text();
    let reply: { id?: number; result?: McpResult; error?: { message?: string } } | undefined;
    if ((res.headers.get("content-type") ?? "").includes("event-stream")) {
      const frames = text.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean);
      reply = frames.map((f) => JSON.parse(f)).find((m) => m.id === id);
    } else {
      reply = JSON.parse(text);
    }
    if (!reply) throw new SteerpaneError(`MCP ${method}: the server sent no reply`);
    if (reply.error) throw new SteerpaneError(`MCP ${method}: ${reply.error.message}`);
    return reply.result ?? null;
  }

  private async ensureSession(): Promise<void> {
    if (this.sessionId) return;
    await this.post("initialize", { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: "steerpane-sdk-node", version: VERSION } });
    await this.post("notifications/initialized", {}, { notify: true });
  }

  /** The default list: core tools plus `search_tools` and `call_tool`. Any tool still runs by name with `call`. */
  async listTools(): Promise<Json[]> {
    await this.ensureSession();
    return (await this.post("tools/list", {}))?.tools ?? [];
  }

  /** Run a tool and return its JSON result. A tool failure throws `ToolError` with the API's error code. */
  async call<T = Json>(tool: string, args: Json = {}, options: { timeoutS?: number } = {}): Promise<T> {
    await this.ensureSession();
    const result = await this.post("tools/call", { name: tool, arguments: clean(args) }, { timeoutMs: (options.timeoutS ?? 120) * 1000 });
    const text = result?.content?.find((c) => c.type === "text")?.text;
    let payload: unknown = result?.structuredContent;
    if (payload === undefined && text) {
      try { payload = JSON.parse(text); } catch { payload = text; }
    }
    if (result?.isError) {
      const err = (payload as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | undefined)?.error;
      throw new ToolError(tool, err?.code ?? "tool_error", err?.message ?? text ?? "Tool failed", err?.details ?? {});
    }
    return payload as T;
  }
}

/** Client for the Steerpane API. */
export class Steerpane {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  /** The token, for helpers that need it. Not enumerable, so logging the client doesn't print it. */
  declare readonly token: string;
  private readonly fetchImpl: typeof fetch;

  readonly sessions = new Sessions(this);
  readonly actions = new Actions(this);
  readonly profiles = new Profiles(this);
  readonly runs = new Runs(this);
  readonly files = new Files(this);
  readonly embeds = new Embeds(this);
  readonly webhooks = new Webhooks(this);
  readonly vault = new Vault(this);
  readonly crawls = new Crawls(this);
  readonly mcp = new Mcp(this);

  constructor(options: SteerpaneOptions = {}) {
    const token = options.token ?? process.env["STEERPANE_API_TOKEN"];
    if (!token) throw new SteerpaneError("No API token. Pass token or set STEERPANE_API_TOKEN.");
    Object.defineProperty(this, "token", { value: token, enumerable: false });
    this.baseUrl = (options.baseUrl ?? process.env["STEERPANE_API_URL"] ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    let url: URL;
    try { url = new URL(this.baseUrl); } catch { throw new SteerpaneError(`Invalid API URL: ${this.baseUrl}`); }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new SteerpaneError(`Invalid API URL: ${this.baseUrl}`);
    if (url.protocol === "http:" && !LOCAL_HOSTS.has(url.hostname) && !options.allowInsecureHttp) {
      throw new SteerpaneError("Refusing to send an API token over plain http. Use https, or pass allowInsecureHttp: true.");
    }
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** One HTTP call with your token and the retry rules. Doesn't throw on an error status. */
  async rawRequest(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(options.params ?? {})) if (v !== undefined && v !== null) query.set(k, String(v));
    const url = this.baseUrl + path + (query.size ? `?${query}` : "");
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}`, "User-Agent": `steerpane-sdk-node/${VERSION}`, ...options.headers };
    if (options.json !== undefined) headers["Content-Type"] = "application/json";
    const body = options.body ?? (options.json !== undefined ? JSON.stringify(options.json) : undefined);
    const keyed = "Idempotency-Key" in headers;
    const idempotent = method === "GET" || method === "HEAD" || method === "DELETE" || keyed;
    for (let attempt = 0; ; attempt++) {
      let delay: number;
      try {
        const res = await this.fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs) });
        // A stored 429 replays under an Idempotency-Key, so a keyed POST isn't retried on it. A rate-limited request never ran.
        const rateLimited = res.status === 429 && !keyed && (await isRateLimited(res));
        if (!((idempotent && RETRY_STATUSES.has(res.status)) || rateLimited) || attempt >= this.maxRetries) return res;
        delay = retryAfterOf(res) ?? 0.5 * 2 ** attempt;
      } catch (e) {
        const timedOut = e instanceof Error && e.name === "TimeoutError";
        if (!idempotent || timedOut || attempt >= this.maxRetries) throw e;
        delay = 0.5 * 2 ** attempt;
      }
      await sleep(Math.min(delay, 30) * 1000);
    }
  }

  /** Call any endpoint, for what this client has no method for. Returns the parsed body, or throws `APIError`. */
  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const res = await this.rawRequest(method, path, options);
    const parsed = await parse(res);
    if (res.status >= 300) throw errorFromResponse(res.status, parsed, retryAfterOf(res));
    return parsed as T;
  }

  /** Every item across pages: `for await (const s of client.paginate((p) => client.sessions.list({ ...p, status: "live" })))`. */
  async *paginate<T>(listCall: (page: { cursor: string | null }) => Promise<Page<T>>): AsyncGenerator<T> {
    let cursor: string | null = null;
    do {
      const page: Page<T> = await listCall({ cursor });
      yield* page.data;
      cursor = page.next_cursor ?? null;
    } while (cursor);
  }

  /** Fetch a page without a browser session. `mode` is `fast`, `deep` or `auto`. The site's own status is in the result's `status`. */
  fetch(url: string, options: { format?: string; mode?: string; formats?: string[] } & Json = {}) { return this.request<FetchResult>("POST", "/v1/fetch", { json: { url, ...clean(options) } }); }
  fetchBatch(urls: string[], options: Json = {}) { return this.request<Json>("POST", "/v1/fetch/batch", { json: { urls, ...clean(options) }, timeoutMs: Math.max(this.timeoutMs, 180_000) }); }
  search(query: string, options: { limit?: number } = {}) { return this.request<SearchResponse>("POST", "/v1/search", { json: { query, ...clean(options) } }); }
  screenshot(url: string, options: Json = {}) { return this.request<Capture>("POST", "/v1/screenshot", { json: { url, ...clean(options) }, timeoutMs: Math.max(this.timeoutMs, 120_000) }); }
  pdf(url: string, options: Json = {}) { return this.request<Capture>("POST", "/v1/pdf", { json: { url, ...clean(options) }, timeoutMs: Math.max(this.timeoutMs, 120_000) }); }
  map(url: string, options: Json = {}) { return this.request<Json>("POST", "/v1/map", { json: { url, ...clean(options) }, timeoutMs: Math.max(this.timeoutMs, 120_000) }); }
  /** Structured data from up to 10 URLs. Needs a model key on the organization. */
  extract(input: { instruction: string; url?: string; urls?: string[]; schema?: Json } & Json) { return this.request<Json>("POST", "/v1/extract", { json: clean(input), timeoutMs: Math.max(this.timeoutMs, 180_000) }); }
}

async function isRateLimited(res: Response): Promise<boolean> {
  try {
    const body = (await res.clone().json()) as { error?: { code?: string } };
    return body.error?.code === "rate_limited";
  } catch {
    return false;
  }
}

export { APIError };
