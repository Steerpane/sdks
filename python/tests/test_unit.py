"""No network: a fake transport checks what the client sends and how it reacts."""
import hashlib
import hmac
import json
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

from steerpane import APIError, AsyncSteerpane, HumanInControlError, Steerpane, SteerpaneError, ToolError, WebhookSignatureError, construct_event, verify_signature

TOKEN = "stp_live_0123456789abcdef"


def client_with(handler, **kw) -> Steerpane:
    return Steerpane(TOKEN, base_url="https://api.test", http_client=httpx.Client(transport=httpx.MockTransport(handler)), **kw)


def err(status, code, message="nope", headers=None, details=None):
    return httpx.Response(status, json={"error": {"code": code, "message": message, "details": details or {}}}, headers=headers)


def test_sends_token_and_returns_parsed_json():
    seen = {}

    def handler(req):
        seen.update(auth=req.headers["authorization"], ua=req.headers["user-agent"], url=str(req.url))
        return httpx.Response(200, json={"id": "ses_1", "status": "running"})

    assert client_with(handler).sessions.get("ses_1")["status"] == "running"
    assert seen["auth"] == f"Bearer {TOKEN}"
    assert seen["ua"].startswith("steerpane-sdk-python/")
    assert seen["url"] == "https://api.test/v1/sessions/ses_1"


def test_ids_cannot_walk_to_another_route():
    seen = {}

    def handler(req):
        seen["path"] = req.url.raw_path.decode()
        return httpx.Response(200, json={})

    client_with(handler).sessions.get("../tokens")
    assert seen["path"] == "/v1/sessions/..%2Ftokens"


def test_error_envelope_and_human_in_control():
    with pytest.raises(APIError) as e:
        client_with(lambda r: err(404, "not_found", "Session not found")).sessions.get("x")
    assert (e.value.status, e.value.code, e.value.message) == (404, "not_found", "Session not found")
    with pytest.raises(HumanInControlError) as e2:
        client_with(lambda r: err(409, "human_in_control", details={"position": 1})).actions.click("s", "#a")
    assert e2.value.details == {"position": 1}


def test_non_json_error_still_raises():
    with pytest.raises(APIError) as e:
        client_with(lambda r: httpx.Response(404, text="gone")).sessions.get("x")
    assert e.value.code == "http_404"


def test_actions_body_and_wait_header():
    seen = {}

    def handler(req):
        seen.update(body=json.loads(req.content), wait=req.headers.get("conduit-wait"))
        return httpx.Response(200, json={"ok": True})

    client_with(handler).actions.run("s", "click", wait_s=30, selector="#a", frame=None)
    assert seen == {"body": {"type": "click", "selector": "#a"}, "wait": "30"}


def test_get_retries_on_503_then_succeeds(monkeypatch):
    monkeypatch.setattr(time, "sleep", lambda s: None)
    calls = []

    def handler(req):
        calls.append(1)
        return err(503, "unavailable") if len(calls) < 3 else httpx.Response(200, json={"data": []})

    assert client_with(handler).sessions.list() == {"data": []}
    assert len(calls) == 3


def test_plain_post_is_not_retried_on_503(monkeypatch):
    monkeypatch.setattr(time, "sleep", lambda s: None)
    calls = []

    def handler(req):
        calls.append(1)
        return err(503, "unavailable")

    with pytest.raises(APIError):
        client_with(handler).actions.navigate("s", "https://example.com")
    assert len(calls) == 1


def test_create_retries_with_the_same_idempotency_key(monkeypatch):
    monkeypatch.setattr(time, "sleep", lambda s: None)
    keys = []

    def handler(req):
        keys.append(req.headers["idempotency-key"])
        return err(502, "bad_gateway") if len(keys) == 1 else httpx.Response(201, json={"id": "ses_1"})

    assert client_with(handler).sessions.create()["id"] == "ses_1"
    assert len(keys) == 2 and keys[0] == keys[1]


def test_rate_limited_post_retries_but_quota_does_not(monkeypatch):
    slept = []
    monkeypatch.setattr(time, "sleep", slept.append)
    calls = []

    def limited(req):
        calls.append(1)
        return err(429, "rate_limited", headers={"Retry-After": "7"}) if len(calls) == 1 else httpx.Response(200, json={"ok": True})

    assert client_with(limited).actions.navigate("s", "https://a.test") == {"ok": True}
    assert slept == [7.0]

    quota = []

    def over_quota(req):
        quota.append(1)
        return err(429, "quota_exceeded")

    with pytest.raises(APIError) as e:
        client_with(over_quota).fetch("https://a.test")
    assert e.value.code == "quota_exceeded" and len(quota) == 1


def test_download_follows_redirect_without_the_token():
    seen = []

    def handler(req):
        seen.append((req.url.host, req.headers.get("authorization")))
        if req.url.host == "api.test":
            return httpx.Response(307, headers={"location": "https://bucket.test/obj?sig=1"})
        return httpx.Response(200, content=b"bytes")

    assert client_with(handler).files.download("fil_1") == b"bytes"
    assert seen == [("api.test", f"Bearer {TOKEN}"), ("bucket.test", None)]


def test_refuses_token_over_plain_http_except_localhost():
    with pytest.raises(SteerpaneError):
        Steerpane(TOKEN, base_url="http://api.example.com")
    Steerpane(TOKEN, base_url="http://127.0.0.1:9")
    Steerpane(TOKEN, base_url="http://api.example.com", allow_insecure_http=True)


def test_missing_token(monkeypatch):
    monkeypatch.delenv("STEERPANE_API_TOKEN", raising=False)
    with pytest.raises(SteerpaneError, match="STEERPANE_API_TOKEN"):
        Steerpane()


def test_repr_hides_the_token():
    assert TOKEN not in repr(Steerpane(TOKEN, base_url="https://api.test"))


def test_paginate_walks_every_page():
    def handler(req):
        cur = req.url.params.get("cursor")
        return httpx.Response(200, json={"data": [1, 2], "next_cursor": "n"} if not cur else {"data": [3], "next_cursor": None})

    c = client_with(handler)
    assert list(c.paginate(c.sessions.list, status="live")) == [1, 2, 3]


def _mcp_handler(tool_result):
    def handler(req):
        msg = json.loads(req.content)
        if msg["method"] == "initialize":
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": msg["id"], "result": {}}, headers={"mcp-session-id": "mcp-1"})
        if "id" not in msg:
            assert req.headers["mcp-session-id"] == "mcp-1"
            return httpx.Response(202)
        frame = json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": tool_result})
        progress = json.dumps({"jsonrpc": "2.0", "method": "notifications/progress", "params": {}})
        return httpx.Response(200, text=f"event: message\ndata: {progress}\n\nevent: message\ndata: {frame}\n\n", headers={"content-type": "text/event-stream"})
    return handler


def test_mcp_call_reads_sse_and_returns_json():
    c = client_with(_mcp_handler({"content": [{"type": "text", "text": '{"ok": true}'}]}))
    assert c.mcp.call("act", session_id="s", instruction="x") == {"ok": True}


def test_mcp_tool_error_raises():
    body = {"isError": True, "content": [{"type": "text", "text": json.dumps({"error": {"code": "model_key_required", "message": "Add a key"}})}]}
    with pytest.raises(ToolError) as e:
        client_with(_mcp_handler(body)).mcp.call("act")
    assert e.value.code == "model_key_required"


def sign(body: bytes, secret: str, t: int) -> str:
    return f"t={t},v1=" + hmac.new(secret.encode(), f"{t}.".encode() + body, hashlib.sha256).hexdigest()


def test_webhook_signature():
    body, now = b'{"id":"evt_1"}', int(time.time())
    good = sign(body, "whsec_a", now)
    assert verify_signature(body, good, "whsec_a")
    assert verify_signature(body.decode(), good, "whsec_a")
    assert not verify_signature(body, good, "whsec_b")
    assert not verify_signature(body + b" ", good, "whsec_a")
    assert not verify_signature(body, None, "whsec_a")
    assert not verify_signature(body, "garbage", "whsec_a")
    assert not verify_signature(body, f"t=notanumber,v1={'a' * 64}", "whsec_a")
    assert not verify_signature(body, sign(body, "whsec_a", now - 301), "whsec_a")
    assert not verify_signature(body, sign(body, "whsec_a", now + 301), "whsec_a")


def test_webhook_signature_during_rotation_accepts_either_secret():
    body, now = b"{}", int(time.time())
    old = sign(body, "whsec_old", now).split(",")[1]
    header = sign(body, "whsec_new", now) + "," + old
    assert verify_signature(body, header, "whsec_old") and verify_signature(body, header, "whsec_new")
    assert not verify_signature(body, header, "whsec_other")


def test_a_signature_made_by_the_servers_own_signing_code_passes():
    # the server signs this way: signature_header(["whsec_vector"], '{"a":1}', 1700000000)
    header = "t=1700000000,v1=5d485af0d9ddc3522d7a396ce60598f0d5fbb3bacdb1924001168092bc407c18"
    assert verify_signature('{"a":1}', header, "whsec_vector", now=1700000000)
    assert not verify_signature('{"a":2}', header, "whsec_vector", now=1700000000)


def test_construct_event():
    body, now = b'{"id":"evt_1","type":"session.ended"}', int(time.time())
    assert construct_event(body, sign(body, "s", now), "s")["type"] == "session.ended"
    with pytest.raises(WebhookSignatureError):
        construct_event(body, sign(body, "s", now), "wrong")


async def _async_flow():
    def handler(req):
        return httpx.Response(200, json={"id": "ses_1", "status": "running", "data": []})

    async with AsyncSteerpane(TOKEN, base_url="https://api.test", http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler))) as c:
        assert (await c.sessions.wait_until_ready("ses_1"))["id"] == "ses_1"
        assert (await c.actions.get_page_text("ses_1"))["id"] == "ses_1"
        assert [x async for x in c.paginate(c.sessions.list)] == []


def test_async_client_runs():
    import asyncio

    asyncio.run(_async_flow())


def test_async_client_is_generated_from_the_sync_one():
    script = Path(__file__).resolve().parent.parent / "scripts" / "gen_async.py"
    assert subprocess.run([sys.executable, str(script), "--check"]).returncode == 0
