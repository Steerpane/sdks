# Steerpane SDKs and CLI

Clients for [Steerpane](https://steerpane.app), remote browsers for AI agents with a human one click away.

| Folder | Package | What |
|---|---|---|
| [`python/`](python) | `steerpane-sdk`, import `steerpane` | Python client, sync and async |
| [`node/`](node) | `@steerpane/sdk` | Node client (Node 20+, ESM) |
| [`cli/`](cli) | `@steerpane/cli`, command `steerpane` | Command line, built on the Node client |
| [`placeholders/`](placeholders) | `steerpane` | Name claims that point to the real packages |

Install with `pip install steerpane-sdk`. The npm packages are being published now.

Each client covers sessions, profiles, browser actions, fetch and search, agent runs, files, embed links and webhook signature checks, plus a helper that connects Playwright over CDP.

## Tests

Unit tests need no account. Live tests skip themselves unless `STEERPANE_API_URL` and `STEERPANE_API_TOKEN` are set; use a test account.

```bash
# Python
uv venv --python 3.12 && uv pip install -e "./python[playwright]" pytest pyright
.venv/bin/python -m pytest -q python/tests

# Node and CLI
npm ci && npm run build && npm test
```

Before publishing, `python scripts/publish_dry_run.py --out DIR` builds every package and lists exactly what would ship. See [`PUBLISHING.md`](PUBLISHING.md).

## Licence

Apache-2.0. This covers the code in this repo. The Steerpane platform itself isn't part of it.
