/** Everything this package raises on purpose. */
export class SteerpaneError extends Error {
  override name = "SteerpaneError";
}

/** The API answered with an error. `code` is the stable value to branch on; `message` is written for people. */
export class APIError extends SteerpaneError {
  override name = "APIError";
  constructor(
    readonly status: number,
    readonly code: string,
    override readonly message: string,
    readonly details: Record<string, unknown> = {},
    readonly retryAfter: number | null = null,
  ) {
    super(message);
  }
}

/** 409 `human_in_control`. The command was queued; wait for the human with `sessions.waitForHuman`. */
export class HumanInControlError extends APIError {
  override name = "HumanInControlError";
}

/** An MCP tool answered with `isError`. `code` and `details` come from the same envelope as REST errors. */
export class ToolError extends SteerpaneError {
  override name = "ToolError";
  constructor(
    readonly tool: string,
    readonly code: string,
    override readonly message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function errorFromResponse(status: number, body: unknown, retryAfter: number | null): APIError {
  const envelope = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
  const err = (typeof envelope === "object" && envelope !== null ? envelope : {}) as { code?: unknown; message?: unknown; details?: unknown };
  const code = typeof err.code === "string" && err.code ? err.code : `http_${status}`;
  const message = String(err.message || (typeof body === "string" && body ? body : `HTTP ${status}`)).slice(0, 2000);
  const details = (err.details ?? {}) as Record<string, unknown>;
  const Cls = code === "human_in_control" ? HumanInControlError : APIError;
  return new Cls(status, code, message, details, retryAfter);
}
