"""Check a webhook's `Conduit-Signature` header.

The header is `t=<unix seconds>,v1=<hex>`, where the hex is HMAC-SHA256 of `<t>.<raw body>` with the endpoint's secret. For 24 hours after
a secret rotation it carries one `v1` per secret, and any match is good. Deliveries can repeat: deduplicate on the event's `id`.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any

from .errors import SteerpaneError

SIGNATURE_HEADER = "Conduit-Signature"
DELIVERY_HEADER = "Conduit-Delivery"
DEFAULT_TOLERANCE_S = 300


class WebhookSignatureError(SteerpaneError):
    """The signature is missing, wrong or too old. Answer the request with 400."""


def _as_bytes(value: bytes | str) -> bytes:
    return value.encode() if isinstance(value, str) else value


def verify_signature(raw_body: bytes | str, header: str | None, secret: str, *, tolerance_s: int = DEFAULT_TOLERANCE_S, now: float | None = None) -> bool:
    """True when `header` is a fresh, valid signature of `raw_body`. Pass the bytes as received, not re-encoded JSON."""
    if not header or not secret:
        return False
    pairs = [p.strip().split("=", 1) for p in header.split(",") if "=" in p]
    timestamp = next((v for k, v in pairs if k == "t"), None)
    signatures = [v for k, v in pairs if k == "v1"]
    if timestamp is None or not signatures:
        return False
    try:
        t = int(timestamp)
    except ValueError:
        return False
    if abs((time.time() if now is None else now) - t) > tolerance_s:
        return False
    expected = hmac.new(secret.encode(), timestamp.encode() + b"." + _as_bytes(raw_body), hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, s) for s in signatures)


def construct_event(raw_body: bytes | str, header: str | None, secret: str, *, tolerance_s: int = DEFAULT_TOLERANCE_S) -> dict[str, Any]:
    """Check the signature and return the parsed event, or raise `WebhookSignatureError`."""
    if not verify_signature(raw_body, header, secret, tolerance_s=tolerance_s):
        raise WebhookSignatureError("Webhook signature is missing, invalid or too old")
    event = json.loads(raw_body)
    if not isinstance(event, dict):
        raise WebhookSignatureError("Webhook body is not a JSON object")
    return event
