// Run a real session: node quickstart.mjs (with STEERPANE_API_TOKEN set, and STEERPANE_API_URL if needed).
import { connectPlaywright, Steerpane } from "@steerpane/sdk";

const client = new Steerpane();
console.log("fast fetch:", (await client.fetch("https://example.com")).status);

const session = await client.sessions.create({ initial_url: "https://example.com", auto_close: true });
console.log("session:", session.id);
try {
  await client.sessions.waitUntilReady(session.id);
  console.log("text:", (await client.actions.getPageText(session.id)).text.slice(0, 60));

  const browser = await connectPlaywright(client, session, { agent: "quickstart" });
  console.log("title over CDP:", await browser.contexts()[0].pages()[0].title());
  await browser.close();

  const stored = await client.files.upload(new TextEncoder().encode("hello"), { name: "hello.txt", ttlHours: 1 });
  console.log("file round trip:", new TextDecoder().decode(await client.files.download(stored.id)));
  await client.files.delete(stored.id);
} finally {
  await client.sessions.stop(session.id);
  console.log("stopped");
}
