"""Run a real session: python quickstart.py (with STEERPANE_API_TOKEN set, and STEERPANE_API_URL if needed)."""
from steerpane import Steerpane
from steerpane.playwright import connect

with Steerpane() as client:
    print("fast fetch:", client.fetch("https://example.com")["status"])

    session = client.sessions.create(initial_url="https://example.com", auto_close=True)
    print("session:", session["id"])
    try:
        client.sessions.wait_until_ready(session["id"])
        print("text:", client.actions.get_page_text(session["id"])["text"][:60])

        with connect(client, session, agent="quickstart") as browser:
            print("title over CDP:", browser.contexts[0].pages[0].title())

        stored = client.files.upload(b"hello", name="hello.txt", ttl_hours=1)
        print("file round trip:", client.files.download(stored["id"]))
        client.files.delete(stored["id"])
    finally:
        client.sessions.stop(session["id"])
        print("stopped")
