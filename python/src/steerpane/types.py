"""Response shapes, for editors and type checkers. These are plain dicts at runtime, so fields the API adds later simply pass through."""
from __future__ import annotations

from typing import Any, Generic, Literal, TypedDict, TypeVar

T = TypeVar("T")

SessionStatus = Literal["starting", "running", "idle", "human_control", "awaiting_help", "stopped", "error"]
RunStatus = Literal["queued", "running", "awaiting_human", "completed", "failed", "cancelled"]
HandbackOutcome = Literal["done", "not_done"]


class Page(TypedDict, Generic[T]):
    data: list[T]
    next_cursor: str | None


class Failure(TypedDict, total=False):
    category: str
    retryable: bool
    message: str


class Session(TypedDict, total=False):
    id: str
    org_id: str
    project_id: str | None
    profile_id: str | None
    profile_name: str | None
    status: SessionStatus
    controller: Literal["agent", "human"]
    agent_paused: bool
    agent_name: str | None
    connected_via: str | None
    current_url: str | None
    page_title: str | None
    region: str | None
    started_at: str | None
    ended_at: str | None
    action_count: int
    queued_commands: int
    help_request: dict[str, Any] | None
    error_message: str | None
    recording: bool
    config: dict[str, Any]
    cdp_url: str
    live_url: str
    watch_url: str
    always_on: bool
    restarting: bool
    restart_at: str | None
    last_handback: dict[str, Any] | None
    failure: Failure | None


class Profile(TypedDict, total=False):
    id: str
    name: str
    description: str | None
    tags: list[str]
    logged_in_sites: list[dict[str, Any]]
    cookie_count: int
    storage_bytes: int
    last_used_at: str | None
    created_at: str | None
    session_count: int


class FetchResult(TypedDict, total=False):
    id: str
    url: str
    final_url: str
    status: int
    format: str
    content: str
    engine: str
    title: str | None
    links: list[str]
    metadata: dict[str, Any]


class SearchResult(TypedDict, total=False):
    title: str
    url: str
    snippet: str


class SearchResponse(TypedDict, total=False):
    id: str
    query: str
    results: list[SearchResult]
    provider: str


class Capture(TypedDict, total=False):
    id: str
    kind: Literal["screenshot", "pdf"]
    file_id: str
    url: str
    name: str
    mime: str
    size: int
    page_url: str
    final_url: str
    title: str | None
    status: int | None
    base64: str


class CrawlJob(TypedDict, total=False):
    id: str
    url: str
    status: Literal["queued", "running", "completed", "failed", "cancelled"]
    progress: dict[str, int]
    error: str | None
    pages: list[dict[str, Any]]
    next_cursor: str | int | None
    link_check: dict[str, Any] | None


class AgentRun(TypedDict, total=False):
    id: str
    agent_id: str | None
    task: str
    status: RunStatus
    session_id: str | None
    profile_id: str | None
    model: str
    max_steps: int
    step_count: int
    tokens_in: int
    tokens_out: int
    cost_usd: float
    duration_sec: float | None
    result: Any
    error: str | None
    failure: Failure | None
    limits: dict[str, Any]


class StoredFile(TypedDict, total=False):
    id: str
    name: str
    mime: str
    size_bytes: int
    sha256: str
    source: Literal["upload", "download", "api", "embed"]
    status: Literal["pending", "ready"]
    session_id: str | None
    created_at: str
    expires_at: str | None
    content_url: str


class UploadUrl(TypedDict, total=False):
    file: StoredFile
    file_id: str
    upload_url: str
    method: str
    headers: dict[str, str]
    expires_at: str
    curl: str
    complete_url: str
    requires_complete: bool
    max_bytes: int


class EmbedLink(TypedDict, total=False):
    id: str
    url: str
    expires_at: str | None
    mode: Literal["read_only", "interactive", "interactive_takeover"]
    name: str
    session_id: str
    allowed_origins: list[str]
    revoked_at: str | None


class Webhook(TypedDict, total=False):
    id: str
    url: str
    events: list[str]
    enabled: bool
    secret: str


class Credential(TypedDict, total=False):
    id: str
    name: str
    domain: str
    username: str
    has_totp: bool


class HumanResult(TypedDict, total=False):
    status: Literal["handed_back", "timeout", "stopped"]
    note: str | None
    outcome: HandbackOutcome | None
