/** Response shapes. Field names are the API's own, and fields the API adds later pass straight through. */
export type Json = Record<string, unknown>;

export type SessionStatus = "starting" | "running" | "idle" | "human_control" | "awaiting_help" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "awaiting_human" | "completed" | "failed" | "cancelled";
export type HandbackOutcome = "done" | "not_done";

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

export interface Failure {
  category: string;
  retryable: boolean;
  message: string;
}

export interface Session extends Json {
  id: string;
  status: SessionStatus;
  controller: "agent" | "human";
  profile_id: string | null;
  current_url: string | null;
  page_title: string | null;
  agent_name: string | null;
  queued_commands: number;
  help_request: Json | null;
  error_message: string | null;
  config: Json;
  cdp_url: string;
  live_url: string;
  watch_url: string;
  always_on: boolean;
  last_handback: { outcome: HandbackOutcome | null; note: string | null; at: string } | null;
  failure: Failure | null;
}

export interface Profile extends Json {
  id: string;
  name: string;
  tags: string[];
  logged_in_sites: Json[];
  cookie_count: number;
}

export interface FetchResult extends Json {
  url: string;
  final_url: string;
  status: number;
  format: string;
  content: string;
  engine: string;
  title: string | null;
  links?: string[];
  metadata?: Json;
}

export interface SearchResponse extends Json {
  query: string;
  results: { title: string; url: string; snippet: string }[];
  provider: string;
}

export interface Capture extends Json {
  id: string;
  kind: "screenshot" | "pdf";
  file_id: string;
  url: string;
  name: string;
  mime: string;
  size: number;
  base64?: string;
}

export interface CrawlJob extends Json {
  id: string;
  url: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  progress: { done: number; total: number; failed: number };
  error: string | null;
  pages?: Json[];
  next_cursor?: string | number | null;
  link_check?: {
    checked: number;
    ok: number;
    unverified: number;
    blocked: number;
    truncated: boolean;
    broken: { url: string; found_on: string; status: number | null; error: string | null }[];
  } | null;
}

export interface AgentRun extends Json {
  id: string;
  task: string;
  status: RunStatus;
  session_id: string | null;
  model: string;
  max_steps: number;
  step_count: number;
  cost_usd: number;
  result: unknown;
  error: string | null;
  failure: Failure | null;
}

export interface StoredFile extends Json {
  id: string;
  name: string;
  mime: string;
  size_bytes: number;
  source: "upload" | "download" | "api" | "embed";
  status: "pending" | "ready";
  session_id: string | null;
  expires_at: string | null;
}

export interface UploadUrl extends Json {
  file_id: string;
  upload_url: string;
  method: string;
  headers: Record<string, string>;
  expires_at: string;
  curl: string;
  requires_complete: boolean;
}

export interface EmbedLink extends Json {
  id: string;
  url: string;
  expires_at: string | null;
  mode: "read_only" | "interactive" | "interactive_takeover";
}

export interface Webhook extends Json {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  secret?: string;
}

export interface Credential extends Json {
  id: string;
  name: string;
  domain: string;
  username: string;
  has_totp: boolean;
}

export interface HumanResult extends Json {
  status: "handed_back" | "timeout" | "stopped";
  note: string | null;
  outcome: HandbackOutcome | null;
}

export interface HelpRequest extends Json {
  request_id: string;
  status: string;
  session_id: string;
}
