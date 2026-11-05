# Steerpane SDKs and CLI

| Folder | Package | What |
|---|---|---|
| `python/` | `steerpane-sdk` on PyPI, import `steerpane` | Python client, sync and async |
| `node/` | `@steerpane/sdk` on npm | Node client |
| `cli/` | `@steerpane/cli` on npm, command `steerpane` | Command line, built on the Node client |
| `placeholders/` | `steerpane` on npm and PyPI | Name claims that point to the real packages |

The SDKs and CLI 0.1.0 were published on 2026-11-05. CLI 0.1.1 adds browser sign-in; check the registry before assuming a local version has been released. Publishing steps are in [`PUBLISHING.md`](PUBLISHING.md). These folders are the only part of the private repo meant to become public. They must contain no server code and no import from `backend/`, which `scripts/publish_dry_run.py` checks.

## Why hand-written and not generated

The API's OpenAPI document has 310 operations and none has a named response schema: every response is `object` with `additionalProperties: true`, and action bodies are free-form dicts. A generated client would be a large amount of code that returns `dict[str, Any]`. So these are small clients with hand-written types, and `python/tests/test_live.py › test_every_sdk_route_exists_in_the_api` compares every call they make with the live `/openapi.json`, so a renamed route fails a test. If the API gains real response schemas, generation becomes worth revisiting.

## Testing

Unit tests need nothing running. Live tests run only when `STEERPANE_API_URL` and `STEERPANE_API_TOKEN` are set, and use real Chromium through a local API.

Start a local API with its **own database** (a second instance on a shared database marks the first one's sessions as failed), for example:

```bash
docker exec conduit-dev-postgres psql -U conduit -d conduit_dev -c 'CREATE DATABASE steerpane_sdk'
cd backend
export STEERPANE_DATABASE_URL=postgresql+asyncpg://conduit:conduit@localhost:5434/steerpane_sdk STEERPANE_PUBLIC_URL=http://127.0.0.1:8791 STEERPANE_BROWSER_PROVIDER=local
uv run python -m app.seed
uv run uvicorn app.main:app --host 127.0.0.1 --port 8791 &
uv run python ../sdks/scripts/provision_local.py --api http://127.0.0.1:8791 --out /tmp/steerpane-local.env
set -a; . /tmp/steerpane-local.env; set +a
```

Then:

```bash
cd sdks/python && uv venv && uv pip install -e . pytest pyright playwright && .venv/bin/python -m pytest -q && .venv/bin/pyright src
cd sdks && npm install && npm run build && npm test
```

`python/src/steerpane/_async_client.py` is generated. After editing `_client.py`, run `python scripts/gen_async.py`; a test fails if you forget.

When the API changes, update the types in `python/src/steerpane/types.py` and `node/src/types.ts`, and keep the two clients' method lists the same.
