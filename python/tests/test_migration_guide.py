"""Each claim about Steerpane in the Browserbase guide (frontend/src/lib/agent-docs.ts), checked against a running API with real Chromium.
Uses plain HTTP and Playwright, exactly as the guide tells people to, not this SDK's helpers.
"""
import os
import time

import httpx
import pytest

LIVE = bool(os.environ.get("STEERPANE_API_URL") and os.environ.get("STEERPANE_API_TOKEN"))
pytestmark = [pytest.mark.live, pytest.mark.skipif(not LIVE, reason="no local API configured")]


@pytest.fixture
def api():
    with httpx.Client(base_url=os.environ.get("STEERPANE_API_URL", "http://x"), headers={"Authorization": f"Bearer {os.environ.get('STEERPANE_API_TOKEN', '')}"}, timeout=60) as c:
        yield c


def start(api, **body):
    r = api.post("/v1/sessions", json={"record": False, **body})
    assert r.status_code == 201, r.text
    session = r.json()
    for _ in range(120):
        if session["status"] != "starting":
            return session
        time.sleep(0.5)
        session = api.get(f"/v1/sessions/{session['id']}").json()
    raise AssertionError("never started")


def stop(api, session):
    api.post(f"/v1/sessions/{session['id']}/stop")
    api.delete(f"/v1/sessions/{session['id']}")


def test_the_change_section_runs_as_written(api):
    """The Playwright snippet: create, poll past `starting`, connect with a header, close, and the session is still running until stopped."""
    from playwright.sync_api import sync_playwright

    session = start(api, initial_url="https://example.com", timeout_min=15, viewport={"width": 1280, "height": 800})
    try:
        assert session["config"]["timeout_min"] == 15
        with sync_playwright() as p:
            browser = p.chromium.connect_over_cdp(session["cdp_url"], headers=dict(Authorization=api.headers["authorization"]))
            page = browser.contexts[0].pages[0]
            assert page.title() == "Example Domain"
            assert page.viewport_size is None or page.viewport_size["width"] == 1280
            assert page.evaluate("window.innerWidth") == 1280
            browser.close()
        assert api.get(f"/v1/sessions/{session['id']}").json()["status"] not in ("stopped", "error")

        # The ?access_token= form, and reconnecting after a disconnect.
        with sync_playwright() as p:
            browser = p.chromium.connect_over_cdp(f"{session['cdp_url']}?access_token={api.headers['authorization'].split()[1]}")
            assert browser.contexts[0].pages[0].title() == "Example Domain"
            browser.close()

        assert api.post(f"/v1/sessions/{session['id']}/stop").json()["status"] == "stopped"
    finally:
        stop(api, session)


def test_timeout_over_the_plan_cap_is_refused(api):
    r = api.post("/v1/sessions", json={"timeout_min": 100000})
    assert r.status_code == 400 and "timeout" in r.text.lower()


def test_idle_timeout_defaults_to_20(api):
    session = start(api, initial_url="https://example.com")
    try:
        assert session["config"]["idle_timeout_min"] == 20
    finally:
        stop(api, session)


def test_metadata_round_trip(api):
    session = start(api, metadata={"customer": "acme"})
    try:
        assert api.get(f"/v1/sessions/{session['id']}/meta").json()["metadata"] == {"customer": "acme"}
    finally:
        stop(api, session)


def test_allowed_domains_and_dialog_policy(api):
    session = start(api, initial_url="https://example.com", allowed_domains=["example.com"], dialog_policy="accept")
    try:
        assert session["config"]["dialog_policy"] == "accept"
        blocked = api.post(f"/v1/sessions/{session['id']}/actions", json={"type": "navigate", "url": "https://example.org/"})
        assert blocked.status_code == 403 and blocked.json()["error"]["code"] == "navigation_blocked"
    finally:
        stop(api, session)


def test_dialogs_are_dismissed_by_default(api):
    session = start(api, initial_url="https://example.com")
    try:
        result = api.post(f"/v1/sessions/{session['id']}/actions", json={"type": "execute", "code": "return confirm('ok?')"}).json()
        assert result["result"] is False
    finally:
        stop(api, session)


def test_profile_has_one_writer(api):
    profile = api.post("/v1/profiles", json={"name": "guide-lock"}).json()
    first = start(api, profile_id=profile["id"])
    try:
        second = api.post("/v1/sessions", json={"profile_id": profile["id"], "record": False})
        assert second.status_code == 409 and second.json()["error"]["code"] == "profile_locked"
        reader = start(api, profile_id=profile["id"], profile_mode="read_only")
        stop(api, reader)
    finally:
        stop(api, first)
        api.delete(f"/v1/profiles/{profile['id']}")


def test_captcha_solving_is_off_by_default(api):
    session = start(api, initial_url="https://example.com")
    try:
        assert session["config"].get("solve_captchas") is False
    finally:
        stop(api, session)


def test_cdp_input_is_held_during_a_takeover(api):
    """Over CDP, navigation waits for the handback. Over REST, the call says human_in_control."""
    import threading

    from playwright.sync_api import sync_playwright

    session = start(api, initial_url="https://example.com")
    try:
        with sync_playwright() as p:
            browser = p.chromium.connect_over_cdp(session["cdp_url"], headers=dict(Authorization=api.headers["authorization"]))
            cdp = browser.contexts[0].new_cdp_session(browser.contexts[0].pages[0])
            assert api.post(f"/v1/sessions/{session['id']}/takeover").status_code == 200
            rest = api.post(f"/v1/sessions/{session['id']}/actions", json={"type": "navigate", "url": "https://example.org/"})
            assert rest.status_code == 409 and rest.json()["error"]["code"] == "human_in_control"

            threading.Timer(2.0, lambda: httpx.post(f"{api.base_url}/v1/sessions/{session['id']}/handback", headers={"Authorization": api.headers["authorization"]}, json={"outcome": "done"})).start()
            started = time.monotonic()
            cdp.send("Runtime.evaluate", {"expression": "1 + 1"})
            assert time.monotonic() - started > 1.0, "the command should have waited for the handback"
            browser.close()
    finally:
        stop(api, session)


def test_public_regions_and_search_fetch_fields(api):
    regions = httpx.get(f"{api.base_url}/v1/platform/public").json()["allowed_regions"]
    assert isinstance(regions, list) and len(regions) == 1
    assert api.post("/v1/fetch", json={"url": "https://example.com", "format": "text"}).status_code == 400
    assert api.post("/v1/fetch", json={"url": "https://example.com", "format": "raw", "mode": "fast"}).status_code == 200


def test_error_shape(api):
    body = api.get("/v1/sessions/ses_nope").json()
    assert set(body["error"]) >= {"code", "message", "details"}
