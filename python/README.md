# Steerpane Python SDK

A small typed client for [Steerpane](https://steerpane.app): remote Chromium sessions for AI agents, with saved logins and human takeover.

```bash
pip install steerpane-sdk                # the client
pip install "steerpane-sdk[playwright]"  # and the Playwright helper
```

Python 3.10 or newer. Create an API token in the dashboard, then set `STEERPANE_API_TOKEN`. Set `STEERPANE_API_URL` if your API isn't the default one in `steerpane.DEFAULT_BASE_URL`.

```python
from steerpane import Steerpane

client = Steerpane()  # or Steerpane(token="stp_live_...", base_url="https://...")

session = client.sessions.create(initial_url="https://example.com", auto_close=True)
client.sessions.wait_until_ready(session["id"])

print(client.actions.get_page_text(session["id"])["text"][:200])
client.sessions.stop(session["id"])
```

`AsyncSteerpane` has the same methods, awaited.

Results are plain dicts with `TypedDict` types, so your editor knows the fields and new API fields pass straight through. The field names are the API's own.

## What's in it

| Attribute | Covers |
|---|---|
| `client.sessions` | create, get, list, stop, delete, keepalive, takeover, handback, help requests, `wait_until_ready`, `wait_for_human` |
| `client.actions` | Browser actions: `navigate`, `click`, `type`, `press_key`, `snapshot`, `form_fields`, `select_option`, `get_page_text`, `screenshot`, `execute`, `download`, `upload_file`, `vault_fill`, or `run(session_id, type, **args)` for any other |
| `client.profiles` | create, list, get, update, delete, clone, verify logins, lock state, import cookies |
| `client.fetch`, `fetch_batch`, `search`, `screenshot`, `pdf`, `map`, `extract` | One call each, with no session to manage |
| `client.crawls` | Background crawls, `wait`, and `check_links` reports |
| `client.runs` | Hosted agent runs, using your own model key: create, get, list, messages, cancel, `wait` |
| `client.files` | File store: upload, list, get, download, delete, upload URLs |
| `client.embeds` | Embed links for takeover inside your product (Scale and Enterprise plans) |
| `client.webhooks`, `client.vault` | Webhook endpoints and stored logins |
| `client.mcp` | Any MCP tool by name, including MCP-only ones such as `act`, `observe` and `wait_for_code` |
| `client.request(method, path, ...)` | Any other endpoint |

Use `client.paginate(client.sessions.list, status="live")` to walk every page of a list.

## Playwright over CDP

```python
from steerpane import Steerpane
from steerpane.playwright import connect

client = Steerpane()
session = client.sessions.create(initial_url="https://example.com")

with connect(client, session, agent="my-script") as browser:
    page = browser.contexts[0].pages[0]
    print(page.title())

client.sessions.stop(session["id"])
```

The token is sent in a header, not the URL. Leaving the `with` block closes the connection and leaves the session running. While a person has control, input and navigation commands are held until they hand back.

## When a person is in control

A browser action made during a takeover is queued and raises `HumanInControlError`. Wait, then carry on:

```python
from steerpane import HumanInControlError

try:
    client.actions.click(session_id, "#next")
except HumanInControlError:
    result = client.sessions.wait_for_human(session_id, timeout_s=60)
    print(result["status"], result["outcome"], result["note"])
```

Pass `wait_s=120` to an action to hold the call instead of raising. `outcome` is `done`, `not_done`, or `None` if the person didn't say. To read the answer after control is already back, pass the id from `sessions.request_help` to `wait_for_human`, or read the session's `last_handback`.

## Webhooks

```python
from steerpane import construct_event, WebhookSignatureError

def handle(raw_body: bytes, headers) -> None:
    try:
        event = construct_event(raw_body, headers, WEBHOOK_SECRET)
    except WebhookSignatureError:
        return respond(400)
    ...  # deliveries can repeat, so deduplicate on event["id"]
```

This rejects timestamps more than 5 minutes off, and accepts either secret during the 24 hours after a rotation.

## Errors and retries

Every API error raises `APIError` with `status`, `code`, `message`, `details` and `retry_after`. Branch on `code`.

GET and DELETE retry on 502, 503, 504, connection errors and `rate_limited`, twice by default (`max_retries=`). `sessions.create` and `runs.create` send an `Idempotency-Key`, so they retry safely too. Other POSTs retry only on `rate_limited`, which means they never ran. `quota_exceeded` is never retried.

The client refuses to send a token over plain `http://` except to localhost, unless you pass `allow_insecure_http=True`.

## Licence

Apache-2.0. This package is only the client. The Steerpane service is separate and has its own terms.
