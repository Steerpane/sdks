/**
 * Connect Playwright to a Steerpane session over CDP. Needs `playwright` or `playwright-core` installed alongside this package.
 *
 * The token travels in a header, never in the URL, so it stays out of proxy and server logs. Closing the connection leaves the session
 * running: stop it with `client.sessions.stop(id)` when you are finished.
 */
import type { Browser } from "playwright-core";
import type { Steerpane } from "./client.js";
import { SteerpaneError } from "./errors.js";
import type { Session } from "./types.js";

export interface ConnectOptions {
  /** Shown as the agent's name in the dashboard. */
  agent?: string;
  timeoutMs?: number;
}

async function loadChromium(): Promise<typeof import("playwright-core").chromium> {
  for (const name of ["playwright-core", "playwright"]) {
    try {
      return (await import(name)).chromium;
    } catch (e) {
      if ((e as { code?: string }).code !== "ERR_MODULE_NOT_FOUND") throw e;
    }
  }
  throw new SteerpaneError("Playwright is not installed. Run: npm install playwright-core");
}

/** Waits for the browser to be ready and connects. The open tab is `browser.contexts()[0].pages()[0]`. */
export async function connectPlaywright(client: Steerpane, session: string | Pick<Session, "id">, options: ConnectOptions = {}): Promise<Browser> {
  const chromium = await loadChromium();
  const ready = await client.sessions.waitUntilReady(typeof session === "string" ? session : session.id);
  const url = options.agent ? `${ready.cdp_url}?agent=${encodeURIComponent(options.agent)}` : ready.cdp_url;
  return chromium.connectOverCDP(url, { headers: { Authorization: `Bearer ${client.token}` }, timeout: options.timeoutMs ?? 30_000 });
}
