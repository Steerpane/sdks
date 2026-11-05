# Steerpane CLI

Start and watch remote Chromium sessions, fetch pages and run agent tasks from a terminal or from another agent. Built on `@steerpane/sdk`.

```bash
npm install -g @steerpane/cli
steerpane login
```

Node 20 or newer. Sign in with your Steerpane account in the browser, or use an API token.

## Logging in

`steerpane login` shows two choices: continue in your browser, or paste an API token. Browser sign-in prints a confirmation code, opens Steerpane, and waits while you confirm the code, organization and permissions. An existing dashboard session is reused; otherwise sign in normally, including two-factor authentication. Nothing is granted until you click Authorize.

Use `steerpane login --no-browser` on a remote machine: open the printed link on any device. Use `steerpane login --paste-token` to go directly to a visible prompt with hidden input. On an older API that has no browser sign-in endpoint, use the token option.

In a script, pipe a token in with `--token-stdin`. There is no `--token` option, because a value on the command line ends up in your shell history. Use `--api-url <url>` if your API isn't the default.

```bash
printf '%s' "$MY_TOKEN" | steerpane login --token-stdin
```

The token is checked against the API, then saved in `config.json` in `~/.config/steerpane` (`%APPDATA%\steerpane` on Windows). The file is owner-only on Linux and macOS; on Windows it relies on your user profile's permissions. The CLI never prints the token: `steerpane whoami` shows only its prefix. `steerpane logout` deletes the file.

Browser sign-in creates a named, scoped credential that expires in 90 days. Revoke it in the dashboard's API tokens page; logging out locally does not revoke it. The Node and Python SDKs use their own `token` option or `STEERPANE_API_TOKEN`; they do not automatically read the CLI's saved credentials.

`STEERPANE_API_TOKEN` and `STEERPANE_API_URL` take priority over the file, which suits CI and agents.

## Commands

```bash
steerpane sessions create --url https://example.com --auto-close
steerpane sessions list --status live
steerpane sessions live ses_123      # prints the page where a person can watch and take over
steerpane sessions stop ses_123

steerpane fetch https://example.com --mode auto

steerpane run "Find the price of the first book on books.toscrape.com" --max-steps 10
```

`sessions create` waits for the browser unless you pass `--no-wait`. `run` uses your organization's model key and waits for the result unless you pass `--no-wait`.

## For agents

Add `--json` to any command. The result goes to stdout as one JSON object, with the API's own field names. Errors go to stderr as `{"error": {"code", "message"}}`.

| Exit code | Meaning |
|---|---|
| 0 | Done |
| 1 | The command failed |
| 2 | Bad usage |
| 3 | Not logged in, or the token was refused |
| 4 | The agent run finished but didn't succeed |

```bash
id=$(steerpane sessions create --url https://example.com --json | jq -r .id)
steerpane sessions stop "$id" --json
```

## Licence

Apache-2.0. This package is only the client. The Steerpane service is separate and has its own terms.
