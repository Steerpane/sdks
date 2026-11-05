"""Connect Playwright to a Steerpane session over CDP. Needs `pip install "steerpane-sdk[playwright]"`.

The token travels in a header, never in the URL, so it stays out of proxy and server logs. Closing the connection leaves the session running:
stop it with `client.sessions.stop(id)` when you are finished.
"""
from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager, contextmanager
from typing import TYPE_CHECKING, Any
from urllib.parse import urlencode

from ._async_client import AsyncSteerpane
from ._client import Steerpane
from .errors import SteerpaneError

if TYPE_CHECKING:
    from playwright.async_api import Browser as AsyncBrowser
    from playwright.sync_api import Browser

_INSTALL_HINT = 'Playwright is not installed. Run: pip install "steerpane-sdk[playwright]" and then playwright install chromium'


def _cdp_endpoint(session: dict[str, Any], agent: str | None) -> str:
    url = session.get("cdp_url")
    if not url:
        raise SteerpaneError("This session has no cdp_url")
    return f"{url}?{urlencode({'agent': agent})}" if agent else url


@contextmanager
def connect(client: Steerpane, session: str | dict[str, Any], *, agent: str | None = None, timeout_ms: float = 30000) -> Iterator[Browser]:
    """`with connect(client, session) as browser:` waits for the browser to be ready. The open tab is `browser.contexts[0].pages[0]`."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as e:
        raise SteerpaneError(_INSTALL_HINT) from e
    session_id = session if isinstance(session, str) else session["id"]
    ready = client.sessions.wait_until_ready(session_id)
    with sync_playwright() as pw:
        browser = pw.chromium.connect_over_cdp(_cdp_endpoint(dict(ready), agent), headers={"Authorization": f"Bearer {client.token}"}, timeout=timeout_ms)
        try:
            yield browser
        finally:
            browser.close()


@asynccontextmanager
async def connect_async(client: AsyncSteerpane, session: str | dict[str, Any], *, agent: str | None = None, timeout_ms: float = 30000) -> AsyncIterator[AsyncBrowser]:
    """`async with connect_async(client, session) as browser:`, for `AsyncSteerpane`."""
    try:
        from playwright.async_api import async_playwright
    except ImportError as e:
        raise SteerpaneError(_INSTALL_HINT) from e
    session_id = session if isinstance(session, str) else session["id"]
    ready = await client.sessions.wait_until_ready(session_id)
    async with async_playwright() as pw:
        browser = await pw.chromium.connect_over_cdp(_cdp_endpoint(dict(ready), agent), headers={"Authorization": f"Bearer {client.token}"}, timeout=timeout_ms)
        try:
            yield browser
        finally:
            await browser.close()
