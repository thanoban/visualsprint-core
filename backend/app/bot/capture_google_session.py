"""One-time helper: capture a signed-in Google session for the Meet bot.

WHY THIS EXISTS
Google refuses ANONYMOUS (not-signed-in) users on meetings hosted by personal
@gmail accounts -- the "You can't join this video call" screen. The bot must
therefore join as a real signed-in Google account. This script opens a normal,
visible Chrome window, lets a human log in to the *bot's* dedicated Google
account by hand (including any 2FA), and then saves that logged-in session
(cookies + localStorage) to a Playwright storage_state JSON. The bot
(app/bot/browser.py) loads that file to join as the signed-in account.

Run it on a machine with a display -- NOT in the headless container:

    cd backend
    python -m app.bot.capture_google_session

It writes ./bot_google_session.json by default (pass a path to change it).
Then store that file as a secret and point VS_BOT_GOOGLE_STORAGE_STATE_PATH at
the mounted path -- see the deploy notes in .github/workflows/deploy.yml.

IMPORTANT / honest limits:
- Use a DEDICATED throwaway Google account for the bot, never a real personal
  or work account -- the session it produces is a long-lived credential.
- `channel="chrome"` uses your real installed Chrome, which Google is far less
  likely to flag as automation than Playwright's bundled Chromium. If Google
  still shows "this browser may not be secure", finish the login in a normal
  Chrome tab first, then retry -- an already-trusted device is less likely to
  be challenged.
- Google may still invalidate the session when the headless container reuses
  it from a new IP/device. That is a fundamental fragility of this approach,
  not a bug in this script -- if the bot later logs
  `bot.browser.storage_state ... signed_in=true` but still can't join,
  re-run this script to refresh the session.
"""

from __future__ import annotations

import asyncio
import sys


async def _capture(out_path: str) -> None:
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        try:
            browser = await p.chromium.launch(channel="chrome", headless=False)
        except Exception:
            # No real Chrome installed -- fall back to bundled Chromium. More
            # likely to be flagged by Google, but better than nothing.
            print("(real Chrome not found; falling back to bundled Chromium)")
            browser = await p.chromium.launch(headless=False)

        context = await browser.new_context(locale="en-US")
        page = await context.new_page()
        await page.goto("https://accounts.google.com/")

        print("\n" + "=" * 68)
        print("  A Chrome window has opened. In it:")
        print("   1. Sign in to the BOT's dedicated Google account.")
        print("   2. Complete any 2-step verification.")
        print("   3. Wait until you see the account home page (you're fully in).")
        print("   4. Come back HERE and press Enter to save the session.")
        print("=" * 68 + "\n")

        # Block on real human input in this terminal -- simplest, most robust
        # signal that login (and any 2FA) is truly complete, with no fragile
        # URL/DOM sniffing that Google's flow changes regularly.
        await asyncio.get_event_loop().run_in_executor(None, input)

        await context.storage_state(path=out_path)
        await browser.close()

    print(f"\nSaved signed-in session to: {out_path}")
    print("Next: store it as a secret and mount it into the bot job --")
    print("  gcloud secrets create visualsprint-bot-google-session \\")
    print(f"    --project=visualsprint-agent --data-file={out_path}")
    print("(or `gcloud secrets versions add ...` to refresh an existing one),")
    print("then redeploy so the bot job mounts it (see deploy.yml).")


def main() -> None:
    out_path = sys.argv[1] if len(sys.argv) > 1 else "bot_google_session.json"
    asyncio.run(_capture(out_path))


if __name__ == "__main__":
    main()
