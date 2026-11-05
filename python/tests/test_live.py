"""Against a running API with real Chromium. Skipped unless STEERPANE_API_URL and STEERPANE_API_TOKEN are set (see sdks/README.md)."""
import base64
import http.server
import json
import os
import re
import threading

import pytest

from steerpane import APIError, AsyncSteerpane, HumanInControlError, Steerpane, ToolError, verify_signature

pytestmark = pytest.mark.live
LIVE = bool(os.environ.get("STEERPANE_API_URL") and os.environ.get("STEERPANE_API_TOKEN"))
skip = pytest.mark.skipif(not LIVE, reason="no local API configured")


@pytest.fixture
def client():
    with Steerpane() as c:
        yield c


@pytest.fixture
def session(client):
    s = client.sessions.create(initial_url="https://example.com", auto_close=False, record=False)
    client.sessions.wait_until_ready(s["id"])
    yield s
    client.sessions.stop(s["id"])
    client.sessions.delete(s["id"])


@skip
def test_every_sdk_route_exists_in_the_api(client):
    """The client is hand-written, so this is what stops it drifting from the API."""
    spec = client.request("GET", "/openapi.json")
    routes = {(m.upper(), re.sub(r"\{[^}]+\}", "{}", p)) for p, ops in spec["paths"].items() for m in ops}
    called = set()
    import httpx

    def handler(req):
        path = re.sub(r"/(ses|prf|run|fil|emb|whk|cred|crl|x)_x\b", "/{}", req.url.path)
        called.add((req.method, path))
        if path.endswith("/content"):
            return httpx.Response(200, content=b"x")
        return httpx.Response(200, json={"status": "completed", "data": [], "next_cursor": None})

    with Steerpane("t", base_url="https://api.test", http_client=httpx.Client(transport=httpx.MockTransport(handler))) as c:
        s, p, r, f, e, w, v, j = "ses_x", "prf_x", "run_x", "fil_x", "emb_x", "whk_x", "cred_x", "crl_x"
        c.sessions.list(); c.sessions.create(); c.sessions.get(s); c.sessions.stop(s); c.sessions.delete(s); c.sessions.keepalive(s)
        c.sessions.takeover(s); c.sessions.handback(s); c.sessions.request_help(s, reason="x"); c.sessions.wait_for_human(s, "x_x")
        c.sessions.events(s); c.sessions.files(s); c.sessions.zip_files(s)
        c.actions.navigate(s, "u")
        c.profiles.list(); c.profiles.get(p); c.profiles.create("n"); c.profiles.update(p, name="m"); c.profiles.delete(p); c.profiles.clone(p)
        c.profiles.verify(p); c.profiles.lock(p); c.profiles.import_cookies(p, [])
        c.runs.create("t"); c.runs.get(r); c.runs.list(); c.runs.messages(r); c.runs.cancel(r)
        c.files.upload(b"x"); c.files.create_upload_url("n"); c.files.list(); c.files.get(f); c.files.download(f); c.files.delete(f)
        c.embeds.create(s); c.embeds.list(); c.embeds.revoke(e)
        c.webhooks.list(); c.webhooks.create("u", []); c.webhooks.get(w); c.webhooks.delete(w); c.webhooks.send_test(w)
        c.vault.list(); c.vault.create(domain="d", username="u", password="p"); c.vault.delete(v)
        c.crawls.start("u"); c.crawls.get(j); c.crawls.cancel(j)
        c.fetch("u"); c.fetch_batch(["u"]); c.search("q"); c.screenshot("u"); c.pdf("u"); c.map("u"); c.extract(instruction="i", url="u")
    called = {(m, re.sub(r"/x_x\b", "/{}", p)) for m, p in called}
    missing = sorted(c for c in called if c not in routes)
    assert not missing, missing
    assert len(called) > 40


@skip
def test_session_actions_and_playwright(client, session):
    sid = session["id"]
    assert session["cdp_url"] and session["live_url"] and session["watch_url"].endswith(f"/sessions/{sid}")
    assert client.sessions.get(sid)["id"] == sid
    assert any(s["id"] == sid for s in client.paginate(client.sessions.list, status="live"))
    client.actions.navigate(sid, "https://example.com/")
    text = client.actions.get_page_text(sid)
    assert "documentation examples" in text["text"]
    snap = client.actions.snapshot(sid)
    assert snap
    assert client.actions.execute(sid, "return document.title")["result"] == "Example Domain"
    shot = client.actions.screenshot(sid, format="png")
    assert len(json.dumps(shot)) > 100

    pytest.importorskip("playwright")
    from steerpane.playwright import connect

    with connect(client, session, agent="sdk-test") as browser:
        page = browser.contexts[0].pages[0]
        assert page.title() == "Example Domain"
        assert page.evaluate("1 + 1") == 2
    assert client.sessions.get(sid)["status"] != "stopped"  # closing the connection leaves the session running


@skip
def test_takeover_queues_commands_and_handback_reports_outcome(client, session):
    sid = session["id"]
    client.actions.navigate(sid, "https://example.com/")
    request = client.sessions.request_help(sid, reason="confirmation", message="Check this")
    assert client.sessions.takeover(sid)["controller"] == "human"
    with pytest.raises(HumanInControlError):
        client.actions.navigate(sid, "https://example.org/")
    assert client.sessions.get(sid)["queued_commands"] == 1
    handed = client.sessions.handback(sid, outcome="done", note="All set")
    assert handed["last_handback"]["outcome"] == "done"
    result = client.sessions.wait_for_human(sid, request["request_id"], timeout_s=10)
    assert (result["status"], result["outcome"], result["note"]) == ("handed_back", "done", "All set")


@skip
def test_fetch_fast_with_links(client):
    result = client.fetch("https://example.com", format="markdown", formats=["links", "metadata"])
    assert result["status"] == 200 and "documentation examples" in result["content"]
    assert isinstance(result["links"], list) and result["metadata"]["title"] == "Example Domain"


@skip
def test_search_reports_a_clear_result_or_error(client):
    try:
        assert "results" in client.search("steerpane browser", limit=2)
    except APIError as e:  # no provider configured locally, or DuckDuckGo blocking
        assert e.code in ("search_unavailable",), e


@skip
def test_files_round_trip(client):
    made = client.files.upload(b"hello sdk", name="hello.txt", mime="text/plain", ttl_hours=1)
    try:
        assert made["size_bytes"] == 9 and client.files.get(made["id"])["name"] == "hello.txt"
        assert client.files.download(made["id"]) == b"hello sdk"
        assert any(f["id"] == made["id"] for f in client.files.list()["data"])
        upload = client.files.create_upload_url("x.txt", mime="text/plain", ttl_hours=1)
        assert upload["upload_url"] and upload["file_id"]
        client.files.delete(upload["file_id"])
    finally:
        client.files.delete(made["id"])
    with pytest.raises(APIError) as e:
        client.files.get(made["id"])
    assert e.value.status == 404


@skip
def test_profiles(client):
    p = client.profiles.create("sdk-test-profile", tags=["sdk"])
    try:
        assert client.profiles.get(p["id"])["name"] == "sdk-test-profile"
        assert client.profiles.update(p["id"], name="sdk-renamed")["name"] == "sdk-renamed"
        assert any(x["id"] == p["id"] for x in client.profiles.list(q="sdk-renamed")["data"])
        assert client.profiles.import_cookies(p["id"], [{"domain": ".example.com", "name": "a", "value": "b"}])["imported"] == 1
        assert "writer" in json.dumps(client.profiles.lock(p["id"])) or client.profiles.lock(p["id"]) is not None
    finally:
        client.profiles.delete(p["id"])


@skip
def test_embed_link_lifecycle(client, session):
    link = client.embeds.create(session["id"], allow_takeover=True, allowed_origins=["https://app.example.com"], expires_in_min=5)
    assert "token=emb_" in link["url"] and link["mode"] == "interactive_takeover"
    assert any(x["id"] == link["id"] for x in client.embeds.list(session_id=session["id"])["data"])
    assert client.embeds.revoke(link["id"])["revoked_at"]


@skip
def test_real_webhook_delivery_passes_signature_check(client):
    received = {}

    class Receiver(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            received["body"] = self.rfile.read(int(self.headers["content-length"]))
            received["sig"] = self.headers["Steerpane-Signature"]
            received["legacy_sig"] = self.headers["Conduit-Signature"]
            received["headers"] = self.headers
            self.send_response(200)
            self.end_headers()

        def log_message(self, *a):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Receiver)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    hook = None
    try:
        try:
            hook = client.webhooks.create(f"http://127.0.0.1:{server.server_port}/hook", ["session.started"])
        except APIError as e:
            pytest.skip(f"this API refuses local webhook URLs: {e.message}")
        secret = hook.get("secret") or client.webhooks.get(hook["id"])["secret"]
        client.webhooks.send_test(hook["id"], event="session.started")
        assert verify_signature(received["body"], received["sig"], secret)
        assert received["legacy_sig"] == received["sig"]
        assert verify_signature(received["body"], received["headers"], secret)
        assert not verify_signature(received["body"], received["sig"], "whsec_wrong")
        assert json.loads(received["body"])["test"] is True
    finally:
        if hook:
            client.webhooks.delete(hook["id"])
        server.shutdown()


@skip
def test_mcp_tools(client):
    names = {t["name"] for t in client.mcp.list_tools()}
    assert {"search_tools", "call_tool", "fetch_page"} <= names
    page = client.mcp.call("fetch_page", url="https://example.com")
    assert "documentation examples" in json.dumps(page)
    with pytest.raises(ToolError):
        client.mcp.call("navigate", session_id="ses_doesnotexist", url="https://example.com")


@skip
def test_run_needs_a_model_key_or_starts(client):
    """Without a model key the API says so plainly. test_with_stub covers a run that finishes."""
    try:
        run = client.runs.create("Say hello", max_steps=1)
    except APIError as e:
        assert e.status in (400, 402, 403), e
        return
    client.runs.cancel(run["id"])
    assert client.runs.wait(run["id"], timeout_s=60)["status"] in ("cancelled", "failed", "completed")


@pytest.mark.skipif(not (LIVE and os.environ.get("STEERPANE_STUB_MODEL_URL")), reason="no stub model (templates/_testing/stub_model.py)")
def test_run_finishes_with_stub_model(client):
    key = client.request("POST", "/v1/model-keys", json={"provider": "custom", "label": "sdk-stub", "key": "stub-key-12345", "base_url": os.environ["STEERPANE_STUB_MODEL_URL"]})
    try:
        run = client.runs.create("Read the page title", model="stub-1", max_steps=3, browser_options='{"initial_url": "https://example.com"}')
        done = client.runs.wait(run["id"], timeout_s=120, poll_s=1)
        assert done["status"] == "completed", done
        assert done["result"]["from"] == "stub model"
        assert client.runs.messages(run["id"])["data"]
    finally:
        client.request("DELETE", f"/v1/model-keys/{key['id']}")


@skip
def test_base64_screenshot_one_call(client):
    cap = client.screenshot("https://example.com", **{"return": "base64"})
    assert base64.b64decode(cap["base64"])[:4] == b"\x89PNG"
    client.files.delete(cap["file_id"])


@skip
def test_async_client_against_the_api():
    import asyncio

    async def flow():
        async with AsyncSteerpane() as c:
            s = await c.sessions.create(initial_url="https://example.com", auto_close=True, record=False)
            try:
                await c.sessions.wait_until_ready(s["id"])
                assert "documentation examples" in (await c.actions.get_page_text(s["id"]))["text"]
                pytest.importorskip("playwright")
                from steerpane.playwright import connect_async

                async with connect_async(c, s) as browser:
                    assert await browser.contexts[0].pages[0].title() == "Example Domain"
            finally:
                await c.sessions.stop(s["id"])
                await c.sessions.delete(s["id"])

    asyncio.run(flow())
