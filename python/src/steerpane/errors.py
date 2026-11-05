"""Errors raised by the client. The API's error envelope is `{"error": {"code", "message", "details"}}`."""
from __future__ import annotations

from typing import Any


class SteerpaneError(Exception):
    """Base class for everything this package raises on purpose."""


class APIError(SteerpaneError):
    """The API answered with an error. `code` is the stable value to branch on; `message` is written for people."""

    def __init__(self, status: int, code: str, message: str, details: Any = None, retry_after: float | None = None) -> None:
        super().__init__(f"{status} {code}: {message}")
        self.status = status
        self.code = code
        self.message = message
        self.details = details if details is not None else {}
        self.retry_after = retry_after


class HumanInControlError(APIError):
    """409 `human_in_control`. The command was queued; wait for the human with `sessions.wait_for_human`."""


class ToolError(SteerpaneError):
    """An MCP tool answered with `isError`. `code` and `details` come from the same envelope as REST errors."""

    def __init__(self, tool: str, code: str, message: str, details: Any = None) -> None:
        super().__init__(f"{tool}: {code}: {message}")
        self.tool = tool
        self.code = code
        self.message = message
        self.details = details if details is not None else {}


def from_response(status: int, body: Any, retry_after: float | None) -> APIError:
    err = body.get("error") if isinstance(body, dict) else None
    if not isinstance(err, dict):
        err = {}
    code = str(err.get("code") or f"http_{status}")
    message = str(err.get("message") or (body if isinstance(body, str) and body else f"HTTP {status}"))[:2000]
    cls = HumanInControlError if code == "human_in_control" else APIError
    return cls(status, code, message, err.get("details"), retry_after)
