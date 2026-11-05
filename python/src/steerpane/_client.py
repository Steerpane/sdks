"""The synchronous client. `_async_client.py` is generated from this file by `scripts/gen_async.py`, so edit here and regenerate."""
from __future__ import annotations

import json
import os
import time
import uuid
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

import httpx

from ._version import __version__
from .errors import APIError, SteerpaneError, ToolError, from_response
from .types import AgentRun, Capture, Credential, CrawlJob, EmbedLink, FetchResult, HumanResult, Page, Profile, SearchResponse, Session, StoredFile, UploadUrl, Webhook

DEFAULT_BASE_URL = "https://api.steerpane.app"
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
ENDED_SESSION_STATUSES = {"stopped", "error"}
ENDED_RUN_STATUSES = {"completed", "failed", "cancelled"}
ENDED_CRAWL_STATUSES = {"completed", "failed", "cancelled"}
RETRY_STATUSES = {502, 503, 504}
MCP_PROTOCOL = "2025-06-18"
StrList = list[str]  # some resource classes have a `list` method, which would shadow the builtin in annotations
DictList = list[dict[str, Any]]


def _clean(values: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in values.items() if v is not None}


def _seg(value: str) -> str:
    """One URL path segment. An id from elsewhere can't walk to another route."""
    return quote(str(value), safe="")


def _retry_after(response: httpx.Response) -> float | None:
    try:
        return float(response.headers["retry-after"])
    except (KeyError, ValueError):
        return None


def _parse(response: httpx.Response) -> Any:
    if not response.content:
        return None
    if "json" in response.headers.get("content-type", ""):
        return response.json()
    return response.text


def _resolve_config(token: str | None, base_url: str | None, allow_insecure_http: bool) -> tuple[str, str]:
    token = token or os.environ.get("STEERPANE_API_TOKEN")
    if not token:
        raise SteerpaneError("No API token. Pass token= or set STEERPANE_API_TOKEN.")
    base = (base_url or os.environ.get("STEERPANE_API_URL") or DEFAULT_BASE_URL).rstrip("/")
    parts = urlsplit(base)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise SteerpaneError(f"Invalid API URL: {base!r}")
    if parts.scheme == "http" and parts.hostname not in LOCAL_HOSTS and not allow_insecure_http:
        raise SteerpaneError("Refusing to send an API token over plain http. Use https, or pass allow_insecure_http=True.")
    return token, base


class Actions:
    """Browser actions, `POST /v1/sessions/{id}/actions`. While a human holds control, acting calls raise `HumanInControlError` and queue."""

    def __init__(self, client: Steerpane) -> None:
        self._c = client

    def run(self, session_id: str, type: str, *, wait_s: float | None = None, **args: Any) -> dict[str, Any]:
        """Run any action type. `wait_s` holds the call until a takeover ends instead of raising, up to 600 seconds."""
        headers = {"Conduit-Wait": str(wait_s)} if wait_s is not None else None
        return self._c.request("POST", f"/v1/sessions/{_seg(session_id)}/actions", json={"type": type, **_clean(args)}, headers=headers,
                               timeout=max(self._c.timeout, (wait_s or 0) + 30))

    def navigate(self, session_id: str, url: str, **args: Any) -> dict[str, Any]:
        return self.run(session_id, "navigate", url=url, **args)

    def click(self, session_id: str, selector: str, **args: Any) -> dict[str, Any]:
        return self.run(session_id, "click", selector=selector, **args)

    def type(self, session_id: str, selector: str, text: str, **args: Any) -> dict[str, Any]:
        return self.run(session_id, "type", selector=selector, text=text, **args)

    def press_key(self, session_id: str, key: str, **args: Any) -> dict[str, Any]:
        return self.run(session_id, "press_key", key=key, **args)

    def select_option(self, session_id: str, selector: str, option: str, **args: Any) -> dict[str, Any]:
        return self.run(session_id, "select_option", selector=selector, option=option, **args)

    def scroll(self, session_id: str, **args: Any) -> dict[str, Any]:
        return self.run(session_id, "scroll", **args)

    def wait_for(self, session_id: str, **args: Any) -> dict[str, Any]:
        """Exactly one of `selector` (+ `state`), `text`, `url`, `load_state` or `ms`. `timeout_ms` defaults to 10000."""
        return self.run(session_id, "wait_for", **args)

    def snapshot(self, session_id: str, **args: Any) -> dict[str, Any]:
        return self.run(session_id, "snapshot", **args)

    def get_page_text(self, session_id: str, **args: Any) -> dict[str, Any]:
        return self.run(session_id, "get_page_text", **args)

    def element_state(self, session_id: str, selector: str, **args: Any) -> dict[str, Any]:
        return self.run(session_id, "element_state", selector=selector, **args)

    def form_fields(self, session_id: str, **args: Any) -> dict[str, Any]:
        return self.run(session_id, "form_fields", **args)

    def screenshot(self, session_id: str, **args: Any) -> dict[str, Any]:
        return self.run(session_id, "screenshot", **args)

    def execute(self, session_id: str, code: str, **args: Any) -> dict[str, Any]:
        """Run JavaScript in the page. `code` is a function body, so use `return` to get a value back as `result`."""
        return self.run(session_id, "execute", code=code, **args)

    def extract(self, session_id: str, instruction: str, **args: Any) -> dict[str, Any]:
        """Needs a model key on the organization."""
        return self.run(session_id, "extract", instruction=instruction, **args)

    def download(self, session_id: str, **args: Any) -> dict[str, Any]:
        return self.run(session_id, "download", **args)

    def upload_file(self, session_id: str, **args: Any) -> dict[str, Any]:
        return self.run(session_id, "upload_file", **args)

    def vault_fill(self, session_id: str, credential_id: str, **args: Any) -> dict[str, Any]:
        """Type a stored credential into the page. The secret never comes back. Refused off the credential's site."""
        return self.run(session_id, "vault_fill", credential_id=credential_id, **args)


class Sessions:
    def __init__(self, client: Steerpane) -> None:
        self._c = client

    def list(self, *, status: str | None = None, profile_id: str | None = None, q: str | None = None, project_id: str | None = None,
             limit: int | None = None, cursor: str | None = None) -> Page[Session]:
        return self._c.request("GET", "/v1/sessions", params=_clean({"status": status, "profile_id": profile_id, "q": q, "project_id": project_id, "limit": limit, "cursor": cursor}))

    def create(self, *, idempotency_key: str | None = None, **config: Any) -> Session:
        """Start a browser. `config` takes the session fields in the API docs, such as `initial_url`, `profile_id`, `auto_close`, `timeout_min`."""
        return self._c.request("POST", "/v1/sessions", json=_clean(config), headers={"Idempotency-Key": idempotency_key or str(uuid.uuid4())})

    def get(self, session_id: str) -> Session:
        return self._c.request("GET", f"/v1/sessions/{_seg(session_id)}")

    def wait_until_ready(self, session_id: str, *, timeout_s: float = 90, poll_s: float = 0.5) -> Session:
        """Wait for the browser to leave `starting`. Raises if it ends instead, or doesn't start in time."""
        deadline = time.monotonic() + timeout_s
        while True:
            session = self.get(session_id)
            status = session.get("status")
            if status in ENDED_SESSION_STATUSES:
                raise SteerpaneError(f"Session {session_id} ended before it was ready: {session.get('error_message') or status}")
            if status != "starting":
                return session
            if time.monotonic() >= deadline:
                raise SteerpaneError(f"Session {session_id} was still starting after {timeout_s:.0f} s")
            time.sleep(poll_s)

    def stop(self, session_id: str) -> Session:
        return self._c.request("POST", f"/v1/sessions/{_seg(session_id)}/stop")

    def delete(self, session_id: str) -> None:
        self._c.request("DELETE", f"/v1/sessions/{_seg(session_id)}")

    def keepalive(self, session_id: str) -> Session:
        return self._c.request("POST", f"/v1/sessions/{_seg(session_id)}/keepalive")

    def takeover(self, session_id: str) -> Session:
        return self._c.request("POST", f"/v1/sessions/{_seg(session_id)}/takeover")

    def handback(self, session_id: str, *, outcome: str | None = None, note: str | None = None) -> Session:
        """Give control back. `outcome` is `done` or `not_done`, and the waiting agent receives it with the note."""
        return self._c.request("POST", f"/v1/sessions/{_seg(session_id)}/handback", json=_clean({"outcome": outcome, "note": note}))

    def request_help(self, session_id: str, *, reason: str, message: str = "") -> dict[str, Any]:
        """Ask a person for help. The agent goes on hold, and `agent.human_help_requested` fires."""
        return self._c.request("POST", f"/v1/sessions/{_seg(session_id)}/help-requests", json={"reason": reason, "message": message})

    def wait_for_human(self, session_id: str, request_id: str = "latest", *, timeout_s: float = 30) -> HumanResult:
        """Long-poll until the human hands back. `status` is `handed_back`, `timeout` (call again) or `stopped`."""
        return self._c.request("GET", f"/v1/sessions/{_seg(session_id)}/help-requests/{_seg(request_id)}/wait", params={"timeout_s": timeout_s},
                               timeout=max(self._c.timeout, timeout_s + 30))

    def events(self, session_id: str, *, limit: int | None = None, cursor: str | None = None) -> Page[dict[str, Any]]:
        return self._c.request("GET", f"/v1/sessions/{_seg(session_id)}/events", params=_clean({"limit": limit, "cursor": cursor}))

    def files(self, session_id: str) -> Any:
        return self._c.request("GET", f"/v1/sessions/{_seg(session_id)}/files")

    def zip_files(self, session_id: str) -> dict[str, Any]:
        """Pack what the session downloaded into one ZIP in the file store."""
        return self._c.request("POST", f"/v1/sessions/{_seg(session_id)}/files/zip")


class Profiles:
    def __init__(self, client: Steerpane) -> None:
        self._c = client

    def list(self, *, tag: str | None = None, q: str | None = None, limit: int | None = None, cursor: str | None = None) -> Page[Profile]:
        return self._c.request("GET", "/v1/profiles", params=_clean({"tag": tag, "q": q, "limit": limit, "cursor": cursor}))

    def get(self, profile_id: str) -> Profile:
        return self._c.request("GET", f"/v1/profiles/{_seg(profile_id)}")

    def create(self, name: str, **fields: Any) -> Profile:
        return self._c.request("POST", "/v1/profiles", json={"name": name, **_clean(fields)})

    def update(self, profile_id: str, **fields: Any) -> Profile:
        return self._c.request("PATCH", f"/v1/profiles/{_seg(profile_id)}", json=fields)

    def delete(self, profile_id: str) -> None:
        self._c.request("DELETE", f"/v1/profiles/{_seg(profile_id)}")

    def clone(self, profile_id: str) -> Profile:
        return self._c.request("POST", f"/v1/profiles/{_seg(profile_id)}/clone")

    def verify(self, profile_id: str, *, domains: StrList | None = None) -> dict[str, Any]:
        """Really load each signed-in site with the profile's state, and report whether it is still signed in."""
        return self._c.request("POST", f"/v1/profiles/{_seg(profile_id)}/verify", json=_clean({"domains": domains}), timeout=max(self._c.timeout, 90))

    def lock(self, profile_id: str) -> dict[str, Any]:
        return self._c.request("GET", f"/v1/profiles/{_seg(profile_id)}/lock")

    def import_cookies(self, profile_id: str, cookies: DictList) -> dict[str, Any]:
        return self._c.request("POST", f"/v1/profiles/{_seg(profile_id)}/cookies/import", json={"cookies": cookies})


class Runs:
    """Hosted agent runs. These use your organization's own model key."""

    def __init__(self, client: Steerpane) -> None:
        self._c = client

    def create(self, task: str, *, idempotency_key: str | None = None, **fields: Any) -> AgentRun:
        """`fields`: `profile_id`, `agent_id`, `model`, `max_steps`, `max_cost_usd`, `max_duration_s`, `result_schema`, `variables`, `project_id`."""
        return self._c.request("POST", "/v1/agents/runs", json={"task": task, **_clean(fields)}, headers={"Idempotency-Key": idempotency_key or str(uuid.uuid4())})

    def get(self, run_id: str) -> AgentRun:
        return self._c.request("GET", f"/v1/agents/runs/{_seg(run_id)}")

    def list(self, *, status: str | None = None, agent_id: str | None = None, project_id: str | None = None, limit: int | None = None, cursor: str | None = None) -> Page[AgentRun]:
        return self._c.request("GET", "/v1/agents/runs", params=_clean({"status": status, "agent_id": agent_id, "project_id": project_id, "limit": limit, "cursor": cursor}))

    def messages(self, run_id: str) -> Page[dict[str, Any]]:
        return self._c.request("GET", f"/v1/agents/runs/{_seg(run_id)}/messages")

    def cancel(self, run_id: str) -> AgentRun:
        return self._c.request("POST", f"/v1/agents/runs/{_seg(run_id)}/cancel")

    def wait(self, run_id: str, *, timeout_s: float = 600, poll_s: float = 2) -> AgentRun:
        """Poll until the run finishes. Returns the run whatever its outcome, so check `status`."""
        deadline = time.monotonic() + timeout_s
        while True:
            run = self.get(run_id)
            if run.get("status") in ENDED_RUN_STATUSES:
                return run
            if time.monotonic() >= deadline:
                raise SteerpaneError(f"Run {run_id} had not finished after {timeout_s:.0f} s (status {run.get('status')})")
            time.sleep(poll_s)


class Files:
    def __init__(self, client: Steerpane) -> None:
        self._c = client

    def upload(self, file: str | Path | bytes, *, name: str | None = None, mime: str | None = None, ttl_hours: int | None = None) -> StoredFile:
        """Store a file. The result's `id` goes straight into `actions.upload_file(session_id, file_id=...)`."""
        if isinstance(file, bytes):
            content, filename = file, name or "file"
        else:
            content, filename = Path(file).read_bytes(), name or Path(file).name
        form = _clean({"name": name, "ttl_hours": ttl_hours})
        return self._c.request("POST", "/v1/files", data={k: str(v) for k, v in form.items()},
                               files={"file": (filename, content, mime or "application/octet-stream")})

    def create_upload_url(self, name: str, *, mime: str | None = None, size_bytes: int | None = None, ttl_hours: int | None = None) -> UploadUrl:
        return self._c.request("POST", "/v1/files/uploads", json=_clean({"name": name, "mime": mime, "size_bytes": size_bytes, "ttl_hours": ttl_hours}))

    def list(self, *, source: str | None = None, session_id: str | None = None, q: str | None = None, limit: int | None = None, cursor: str | None = None) -> Page[StoredFile]:
        return self._c.request("GET", "/v1/files", params=_clean({"source": source, "session_id": session_id, "q": q, "limit": limit, "cursor": cursor}))

    def get(self, file_id: str) -> StoredFile:
        return self._c.request("GET", f"/v1/files/{_seg(file_id)}")

    def download(self, file_id: str) -> bytes:
        """The file's bytes. On S3 storage the API redirects to a presigned URL, which is fetched without your token."""
        return self._c.request_bytes(f"/v1/files/{_seg(file_id)}/content")

    def delete(self, file_id: str) -> None:
        self._c.request("DELETE", f"/v1/files/{_seg(file_id)}")


class Embeds:
    """Links that show a session inside your own product. Scale and Enterprise plans. The URL is a credential: keep it out of logs."""

    def __init__(self, client: Steerpane) -> None:
        self._c = client

    def create(self, session_id: str, *, allow_takeover: bool = False, allowed_origins: StrList | None = None, expires_in_min: int | None = 30,
               hide_toolbar: bool = False, show_control: bool = False, theme: str = "auto", end_user: dict[str, Any] | None = None, mode: str | None = None) -> EmbedLink:
        return self._c.request("POST", f"/v1/sessions/{_seg(session_id)}/embed", json=_clean({
            "allow_takeover": allow_takeover, "allowed_origins": allowed_origins, "expires_in_min": expires_in_min, "hide_toolbar": hide_toolbar,
            "show_control": show_control, "theme": theme, "end_user": end_user, "mode": mode}))

    def list(self, *, session_id: str | None = None, limit: int | None = None, cursor: str | None = None) -> Page[EmbedLink]:
        return self._c.request("GET", "/v1/embed-links", params=_clean({"session_id": session_id, "limit": limit, "cursor": cursor}))

    def revoke(self, link_id: str) -> EmbedLink:
        """Closes open iframes at once, and returns control to the agent if this link held it."""
        return self._c.request("POST", f"/v1/embed-links/{_seg(link_id)}/revoke")


class Webhooks:
    """Endpoint management. To check a delivery's signature use `steerpane.webhooks.verify_signature`, which needs no client."""

    def __init__(self, client: Steerpane) -> None:
        self._c = client

    def list(self) -> Page[Webhook]:
        return self._c.request("GET", "/v1/webhooks")

    def create(self, url: str, events: StrList, **fields: Any) -> Webhook:
        return self._c.request("POST", "/v1/webhooks", json={"url": url, "events": events, **_clean(fields)})

    def get(self, webhook_id: str) -> Webhook:
        return self._c.request("GET", f"/v1/webhooks/{_seg(webhook_id)}")

    def delete(self, webhook_id: str) -> None:
        self._c.request("DELETE", f"/v1/webhooks/{_seg(webhook_id)}")

    def send_test(self, webhook_id: str, *, event: str | None = None) -> dict[str, Any]:
        return self._c.request("POST", f"/v1/webhooks/{_seg(webhook_id)}/test", json=_clean({"event": event}))


class Vault:
    """Stored logins. Passwords and TOTP secrets go in and never come back to an API token."""

    def __init__(self, client: Steerpane) -> None:
        self._c = client

    def list(self) -> Page[Credential]:
        return self._c.request("GET", "/v1/vault/credentials")

    def create(self, *, domain: str, username: str, password: str, name: str | None = None, totp_secret: str | None = None, **fields: Any) -> Credential:
        return self._c.request("POST", "/v1/vault/credentials", json=_clean({"domain": domain, "username": username, "password": password, "name": name, "totp_secret": totp_secret, **fields}))

    def delete(self, credential_id: str) -> None:
        self._c.request("DELETE", f"/v1/vault/credentials/{_seg(credential_id)}")


class Crawls:
    def __init__(self, client: Steerpane) -> None:
        self._c = client

    def start(self, url: str, **options: Any) -> CrawlJob:
        """`options`: `limit`, `max_depth`, `mode`, `formats`, `include_paths`, `exclude_paths`, `check_links`, `same_site`, ..."""
        return self._c.request("POST", "/v1/crawl", json={"url": url, **_clean(options)})

    def get(self, job_id: str, *, cursor: str | None = None, limit: int | None = None, include_content: bool | None = None) -> CrawlJob:
        params = _clean({"cursor": cursor, "limit": limit, "include_content": None if include_content is None else str(include_content).lower()})
        return self._c.request("GET", f"/v1/crawl/{_seg(job_id)}", params=params)

    def cancel(self, job_id: str) -> CrawlJob:
        return self._c.request("DELETE", f"/v1/crawl/{_seg(job_id)}")

    def wait(self, job_id: str, *, timeout_s: float = 300, poll_s: float = 2) -> CrawlJob:
        deadline = time.monotonic() + timeout_s
        while True:
            job = self.get(job_id, include_content=False)
            if job.get("status") in ENDED_CRAWL_STATUSES:
                return job
            if time.monotonic() >= deadline:
                raise SteerpaneError(f"Crawl {job_id} had not finished after {timeout_s:.0f} s")
            time.sleep(poll_s)


class Mcp:
    """Call MCP tools over the API's Streamable HTTP endpoint. A few tools are MCP only, such as `act`, `observe` and `wait_for_code`."""

    def __init__(self, client: Steerpane) -> None:
        self._c = client
        self._session_id: str | None = None
        self._next_id = 0

    def _post(self, method: str, params: dict[str, Any], *, notify: bool = False, timeout: float | None = None) -> Any:
        message: dict[str, Any] = {"jsonrpc": "2.0", "method": method, "params": params}
        if not notify:
            self._next_id += 1
            message["id"] = self._next_id
        headers = {"Accept": "application/json, text/event-stream", "Mcp-Protocol-Version": MCP_PROTOCOL}
        if self._session_id:
            headers["Mcp-Session-Id"] = self._session_id
        response = self._c.raw_request("POST", "/mcp", json=message, headers=headers, timeout=timeout)
        if response.status_code >= 400:
            raise from_response(response.status_code, _parse(response), _retry_after(response))
        self._session_id = response.headers.get("mcp-session-id") or self._session_id
        if notify:
            return None
        body = response.text
        if "event-stream" in response.headers.get("content-type", ""):
            frames = [line[5:].strip() for line in body.splitlines() if line.startswith("data:")]
            replies = [json.loads(f) for f in frames if f]
            reply = next((m for m in replies if m.get("id") == message["id"]), None)
        else:
            reply = json.loads(body)
        if not reply:
            raise SteerpaneError(f"MCP {method}: the server sent no reply")
        if reply.get("error"):
            raise SteerpaneError(f"MCP {method}: {reply['error'].get('message')}")
        return reply.get("result")

    def _ensure_session(self) -> None:
        if self._session_id:
            return
        self._post("initialize", {"protocolVersion": MCP_PROTOCOL, "capabilities": {}, "clientInfo": {"name": "steerpane-sdk-python", "version": __version__}})
        self._post("notifications/initialized", {}, notify=True)

    def list_tools(self) -> DictList:
        """The default list: core tools plus `search_tools` and `call_tool`. Any tool still runs by name with `call`."""
        self._ensure_session()
        return self._post("tools/list", {})["tools"]

    def call(self, tool: str, *, timeout_s: float = 120, **arguments: Any) -> Any:
        """Run a tool and return its JSON result. A tool failure raises `ToolError` with the API's error code."""
        self._ensure_session()
        result = self._post("tools/call", {"name": tool, "arguments": _clean(arguments)}, timeout=timeout_s)
        text = next((c.get("text") for c in result.get("content", []) if c.get("type") == "text"), None)
        try:
            payload = result.get("structuredContent") or (json.loads(text) if text else None)
        except ValueError:
            payload = text
        if result.get("isError"):
            err = payload.get("error", {}) if isinstance(payload, dict) else {}
            raise ToolError(tool, str(err.get("code") or "tool_error"), str(err.get("message") or text or "Tool failed"), err.get("details"))
        return payload


class Steerpane:
    """Client for the Steerpane API.

    `token` falls back to `STEERPANE_API_TOKEN`, and `base_url` to `STEERPANE_API_URL`. Results are plain dicts, typed for your editor.
    """

    def __init__(self, token: str | None = None, *, base_url: str | None = None, timeout: float = 60, max_retries: int = 2,
                 allow_insecure_http: bool = False, http_client: httpx.Client | None = None) -> None:
        self.token, self.base_url = _resolve_config(token, base_url, allow_insecure_http)
        self.timeout = timeout
        self.max_retries = max_retries
        self._http = http_client or httpx.Client(follow_redirects=False)
        self.sessions = Sessions(self)
        self.actions = Actions(self)
        self.profiles = Profiles(self)
        self.runs = Runs(self)
        self.files = Files(self)
        self.embeds = Embeds(self)
        self.webhooks = Webhooks(self)
        self.vault = Vault(self)
        self.crawls = Crawls(self)
        self.mcp = Mcp(self)

    def __repr__(self) -> str:  # the token stays out of logs and tracebacks
        return f"{type(self).__name__}(base_url={self.base_url!r})"

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> Steerpane:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ---- transport

    def raw_request(self, method: str, path: str, *, json: Any = None, params: dict[str, Any] | None = None, headers: dict[str, str] | None = None,
                    data: dict[str, str] | None = None, files: Any = None, timeout: float | None = None) -> httpx.Response:
        """One HTTP call with your token and the retry rules. Doesn't raise on an error status."""
        merged = {"Authorization": f"Bearer {self.token}", "User-Agent": f"steerpane-sdk-python/{__version__}", **(headers or {})}
        idempotent = method in ("GET", "HEAD", "DELETE") or "Idempotency-Key" in merged
        attempt = 0
        while True:
            try:
                response = self._http.request(method, self.base_url + path, json=json, params=params, headers=merged, data=data, files=files, timeout=timeout or self.timeout)
            except httpx.TransportError:
                if not idempotent or attempt >= self.max_retries:
                    raise
                delay = 0.5 * 2**attempt
            else:
                rate_limited = response.status_code == 429 and _rate_limited(response)
                # A stored 429 replays under an Idempotency-Key, so a keyed POST isn't retried on it. A rate-limited request never ran.
                retryable = (idempotent and response.status_code in RETRY_STATUSES) or (rate_limited and "Idempotency-Key" not in merged)
                if not retryable or attempt >= self.max_retries:
                    return response
                delay = _retry_after(response) or 0.5 * 2**attempt
            attempt += 1
            time.sleep(min(delay, 30))

    def request(self, method: str, path: str, *, json: Any = None, params: dict[str, Any] | None = None, headers: dict[str, str] | None = None,
                data: dict[str, str] | None = None, files: Any = None, timeout: float | None = None) -> Any:
        """Call any endpoint, for what this client has no method for. Returns the parsed body, or raises `APIError`."""
        response = self.raw_request(method, path, json=json, params=params, headers=headers, data=data, files=files, timeout=timeout)
        if response.status_code >= 300:
            raise from_response(response.status_code, _parse(response), _retry_after(response))
        return _parse(response)

    def request_bytes(self, path: str) -> bytes:
        response = self.raw_request("GET", path)
        if response.is_redirect and response.headers.get("location"):
            response = self._http.request("GET", response.headers["location"], timeout=self.timeout)  # presigned: no token
        if response.status_code >= 300:
            raise from_response(response.status_code, _parse(response), _retry_after(response))
        return response.content

    def paginate(self, list_call: Callable[..., Any], **params: Any) -> Iterator[Any]:
        """Every item across pages: `for s in client.paginate(client.sessions.list, status="live")`."""
        cursor = params.pop("cursor", None)
        while True:
            page = list_call(cursor=cursor, **params)
            for item in page.get("data", []):
                yield item
            cursor = page.get("next_cursor")
            if not cursor:
                return

    # ---- one-call tools: no session to manage

    def fetch(self, url: str, *, format: str | None = None, mode: str | None = None, formats: StrList | None = None, **fields: Any) -> FetchResult:
        """Fetch a page without a browser session. `mode` is `fast`, `deep` or `auto`. The site's own status is in the result's `status`."""
        return self.request("POST", "/v1/fetch", json=_clean({"url": url, "format": format, "mode": mode, "formats": formats, **fields}))

    def fetch_batch(self, urls: StrList, **fields: Any) -> dict[str, Any]:
        return self.request("POST", "/v1/fetch/batch", json={"urls": urls, **_clean(fields)}, timeout=max(self.timeout, 180))

    def search(self, query: str, *, limit: int | None = None) -> SearchResponse:
        return self.request("POST", "/v1/search", json=_clean({"query": query, "limit": limit}))

    def screenshot(self, url: str, **options: Any) -> Capture:
        return self.request("POST", "/v1/screenshot", json={"url": url, **_clean(options)}, timeout=max(self.timeout, 120))

    def pdf(self, url: str, **options: Any) -> Capture:
        return self.request("POST", "/v1/pdf", json={"url": url, **_clean(options)}, timeout=max(self.timeout, 120))

    def map(self, url: str, **options: Any) -> dict[str, Any]:
        return self.request("POST", "/v1/map", json={"url": url, **_clean(options)}, timeout=max(self.timeout, 120))

    def extract(self, *, instruction: str, url: str | None = None, urls: StrList | None = None, schema: dict[str, Any] | None = None, **options: Any) -> dict[str, Any]:
        """Structured data from up to 10 URLs. Needs a model key on the organization."""
        return self.request("POST", "/v1/extract", json=_clean({"instruction": instruction, "url": url, "urls": urls, "schema": schema, **options}), timeout=max(self.timeout, 180))


def _rate_limited(response: httpx.Response) -> bool:
    """`rate_limited` clears by itself. `quota_exceeded` doesn't, so it isn't retried."""
    try:
        return response.json().get("error", {}).get("code") == "rate_limited"
    except ValueError:
        return False


__all__ = ["APIError", "DEFAULT_BASE_URL", "Steerpane"]
