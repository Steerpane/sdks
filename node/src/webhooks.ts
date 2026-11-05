/**
 * Check a webhook's `Conduit-Signature` header.
 *
 * The header is `t=<unix seconds>,v1=<hex>`, where the hex is HMAC-SHA256 of `<t>.<raw body>` with the endpoint's secret. For 24 hours after
 * a secret rotation it carries one `v1` per secret, and any match is good. Deliveries can repeat: deduplicate on the event's `id`.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { SteerpaneError } from "./errors.js";

export const SIGNATURE_HEADER = "Conduit-Signature";
export const DELIVERY_HEADER = "Conduit-Delivery";
const DEFAULT_TOLERANCE_S = 300;

export class WebhookSignatureError extends SteerpaneError {
  override name = "WebhookSignatureError";
}

export interface VerifyOptions {
  toleranceS?: number;
  /** Unix seconds; for tests. */
  now?: number;
}

/** True when `header` is a fresh, valid signature of `rawBody`. Pass the body as received, not re-encoded JSON. */
export function verifySignature(rawBody: string | Uint8Array, header: string | null | undefined, secret: string, options: VerifyOptions = {}): boolean {
  if (!header || !secret) return false;
  const pairs = header.split(",").map((p) => {
    const i = p.indexOf("=");
    return i < 0 ? ["", ""] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
  });
  const timestamp = pairs.find(([k]) => k === "t")?.[1];
  const signatures = pairs.filter(([k]) => k === "v1").map(([, v]) => v as string);
  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) return false;
  const now = options.now ?? Date.now() / 1000;
  if (Math.abs(now - Number(timestamp)) > (options.toleranceS ?? DEFAULT_TOLERANCE_S)) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest();
  return signatures.some((signature) => {
    const given = Buffer.from(signature, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** Check the signature and return the parsed event, or throw `WebhookSignatureError`. */
export function constructEvent<T = Record<string, unknown>>(rawBody: string | Uint8Array, header: string | null | undefined, secret: string, options: VerifyOptions = {}): T {
  if (!verifySignature(rawBody, header, secret, options)) throw new WebhookSignatureError("Webhook signature is missing, invalid or too old");
  return JSON.parse(typeof rawBody === "string" ? rawBody : Buffer.from(rawBody).toString("utf8")) as T;
}
