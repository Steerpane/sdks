# Steerpane Node SDK

A small typed client for [Steerpane](https://steerpane.app): remote Chromium sessions for AI agents, with saved logins and human takeover.

```bash
npm install @steerpane/sdk
npm install playwright-core   # only for the Playwright helper
```

Node 20 or newer, ESM. Create an API token in the dashboard, then set `STEERPANE_API_TOKEN`. Set `STEERPANE_API_URL` if your API isn't the one in `DEFAULT_BASE_URL`.

```ts
import { Steerpane } from "@steerpane/sdk";

const client = new Steerpane(); // or new Steerpane({ token: "stp_live_...", baseUrl: "https://..." })

const session = await client.sessions.create({ initial_url: "https://example.com", auto_close: true });
await client.sessions.waitUntilReady(session.id);

console.log((await client.actions.getPageText(session.id)).text.slice(0, 200));
await client.sessions.stop(session.id);
```

Method names are camelCase. Request and response fields are the API's own snake_case names, and fields the API adds later pass straight through.

## What's in it

| Attribute | Covers |
|---|---|
| `client.sessions` | create, get, list, stop, delete, keepalive, takeover, handback, help requests, `waitUntilReady`, `waitForHuman` |
| `client.actions` | Browser actions: `navigate`, `click`, `type`, `pressKey`, `snapshot`, `formFields`, `selectOption`, `getPageText`, `screenshot`, `execute`, `download`, `uploadFile`, `vaultFill`, or `run(sessionId, type, args)` for any other |
| `client.profiles` | create, list, get, update, delete, clone, verify logins, lock state, import cookies |
| `client.fetch`, `fetchBatch`, `search`, `screenshot`, `pdf`, `map`, `extract` | One call each, with no session to manage |
| `client.crawls` | Background crawls, `wait`, and `check_links` reports |
| `client.runs` | Hosted agent runs, using your own model key: create, get, list, messages, cancel, `wait` |
| `client.files` | File store: upload, list, get, download, delete, upload URLs |
| `client.embeds` | Embed links for takeover inside your product (Scale and Enterprise plans) |
| `client.webhooks`, `client.vault` | Webhook endpoints and stored logins |
| `client.mcp` | Any MCP tool by name, including MCP-only ones such as `act`, `observe` and `wait_for_code` |
| `client.request(method, path, options)` | Any other endpoint |

`client.paginate((page) => client.sessions.list({ ...page, status: "live" }))` walks every page with `for await`.

## Playwright over CDP

```ts
import { connectPlaywright, Steerpane } from "@steerpane/sdk";

const client = new Steerpane();
const session = await client.sessions.create({ initial_url: "https://example.com" });

const browser = await connectPlaywright(client, session, { agent: "my-script" });
const page = browser.contexts()[0].pages()[0];
console.log(await page.title());
await browser.close();

await client.sessions.stop(session.id);
```

The token is sent in a header, not the URL. `browser.close()` closes the connection and leaves the session running. While a person has control, input and navigation commands are held until they hand back.

## When a person is in control

A browser action made during a takeover is queued and throws `HumanInControlError`. Wait, then carry on:

```ts
import { HumanInControlError } from "@steerpane/sdk";

try {
  await client.actions.click(sessionId, "#next");
} catch (e) {
  if (!(e instanceof HumanInControlError)) throw e;
  const result = await client.sessions.waitForHuman(sessionId, { timeoutS: 60 });
  console.log(result.status, result.outcome, result.note);
}
```

Pass `{ waitS: 120 }` as the last argument to `actions.run` to hold the call instead of throwing. `outcome` is `done`, `not_done`, or null if the person didn't say. To read the answer after control is already back, pass the `request_id` from `sessions.requestHelp` to `waitForHuman`, or read the session's `last_handback`.

## Webhooks

```ts
import { constructEvent, WebhookSignatureError } from "@steerpane/sdk";

try {
  const event = constructEvent(rawBody, req.headers, process.env.WEBHOOK_SECRET!);
  // deliveries can repeat, so deduplicate on event.id
} catch (e) {
  if (e instanceof WebhookSignatureError) return res.status(400).end();
  throw e;
}
```

This rejects timestamps more than 5 minutes off, and accepts either secret during the 24 hours after a rotation. Use the raw body, not re-encoded JSON.

## Errors and retries

Every API error throws `APIError` with `status`, `code`, `message`, `details` and `retryAfter`. Branch on `code`.

GET and DELETE retry on 502, 503, 504, connection errors and `rate_limited`, twice by default (`maxRetries`). `sessions.create` and `runs.create` send an `Idempotency-Key`, so they retry safely too. Other POSTs retry only on `rate_limited`, which means they never ran. `quota_exceeded` is never retried.

The client refuses to send a token over plain `http://` except to localhost, unless you pass `allowInsecureHttp: true`.

## Licence

Apache-2.0. This package is only the client. The Steerpane service is separate and has its own terms.
