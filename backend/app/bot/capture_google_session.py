"""One-time helper: capture a signed-in Google session for the Meet bot.

WHY THIS EXISTS
Google refuses ANONYMOUS (not-signed-in) users on meetings hosted by personal
@gmail accounts -- the "You can't join this video call" screen. The bot must
therefore join as a real signed-in Google account.

WHY THIS IS A TWO-STEP FLOW, NOT ONE
The obvious approach -- have Playwright open a browser and let a human log in
inside it -- does NOT work: Google detects that the browser was launched via
the Chrome DevTools Protocol (which Playwright always uses, even against a
real installed Chrome/Edge binary) and hard-blocks the login with "Couldn't
sign you in -- this browser or app may not be secure," regardless of which
channel or flags are used. This is deliberate anti-automation defense on
Google's side, not a bug in this script.

The workaround every Playwright/Selenium project uses: perform the login in a
browser that Google never sees as automated (a normal, human-launched Edge
window with a *dedicated* profile directory), close it, and then have
Playwright open that same profile via `launch_persistent_context` -- which
just re-uses the already-established session cookies. No login flow ever runs
inside automation, so Google has nothing to block.

USAGE
    cd backend
    .venv\\Scripts\\python -m app.bot.capture_google_session

It will:
  1. Print a command to launch a NORMAL (non-automated) Edge window with a
     dedicated profile directory (`.bot_edge_profile` next to this script,
     or a path you pass as the first argument).
  2. Wait for you to log into the bot's Google account in that window and
     close it.
  3. Open that same profile through Playwright (read-only from Google's
     perspective -- no login happens here) and export the session to
     `bot_google_session.json` (or a path you pass as the second argument).

Then store that file as a secret -- see the printed instructions at the end,
or .github/workflows/deploy.yml's bot-job deploy step.

IMPORTANT / honest limits:
- Use a DEDICATED throwaway Google account for the bot, never a real personal
  or work account -- the exported session is a long-lived credential.
- Google may still invalidate the session when the headless container reuses
  it from a new IP/region. If the bot later logs
  `bot.browser.launched ... signed_in=true` but still can't join, re-run this
  whole flow to refresh the session -- that is a fundamental fragility of
  browser-automation Meet capture, not a bug in this script.
"""

from __future__ import annotations

import asyncio
import subprocess
import sys
from pathlib import Path

_DEFAULT_PROFILE_DIR = Path(__file__).parent / ".bot_edge_profile"
_DEFAULT_OUT_PATH = "bot_google_session.json"


def _find_edge_exe() -> str | None:
    import shutil

    for candidate in (
        shutil.which("msedge"),
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ):
        if candidate and Path(candidate).exists():
            return candidate
    return None


def _kill_edge_for_profile(profile_dir: Path) -> None:
    """Force-close ONLY the Edge processes bound to this bot profile.

    Edge keeps a background process alive after its window closes (startup
    boost / background apps), and that process holds a lock on the profile
    dir -- so Playwright's step-2 launch fails with 'profile is already in
    use'. Matching on the profile path in each process's command line means
    the user's normal personal Edge (a different --user-data-dir) is left
    completely untouched. By the time the login window is closed, the
    persistent auth cookies are already flushed to disk, so force-killing a
    lingering background process does not lose the session."""
    ps = (
        "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | "
        f"Where-Object {{ $_.CommandLine -like '*{profile_dir}*' }} | "
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    )
    try:
        subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps],
            capture_output=True,
            timeout=20,
        )
    except Exception as exc:
        print(f"(could not auto-close lingering Edge for the bot profile: {exc})")


async def _capture(profile_dir: Path, out_path: str) -> None:
    from playwright.async_api import async_playwright

    profile_dir.mkdir(parents=True, exist_ok=True)
    edge_exe = _find_edge_exe()

    print("\n" + "=" * 72)
    print("  STEP 1 of 2 -- log in through a NORMAL (non-automated) Edge window.")
    print("  This is required: Google blocks logins inside any automation-")
    print("  controlled browser, even a real Edge/Chrome binary.")
    print("=" * 72)
    if edge_exe:
        print(f'\n  Opening: "{edge_exe}" --user-data-dir="{profile_dir}"\n')
        subprocess.Popen([edge_exe, f"--user-data-dir={profile_dir}", "https://accounts.google.com/"])
    else:
        print(
            "\n  Could not find msedge.exe automatically. Open a PowerShell window "
            "yourself and run:\n"
            f'    & "<path to msedge.exe>" --user-data-dir="{profile_dir}"\n'
        )
    print("  In that window:")
    print("   1. Sign in to the BOT's dedicated Google account.")
    print("   2. Complete any 2-step verification.")
    print("   3. Wait until you see the account home page (you're fully in).")
    print("   4. CLOSE that entire Edge window (all its tabs).")
    print("   5. Come back HERE and press Enter.\n")

    await asyncio.get_event_loop().run_in_executor(None, input)

    print("\n" + "=" * 72)
    print("  STEP 2 of 2 -- reading the now-authenticated session (no login")
    print("  happens here, so Google does not block this part).")
    print("=" * 72 + "\n")

    # Edge often leaves a background process holding the profile lock even
    # after the window is closed; release it (bot profile only) before
    # Playwright reopens the profile, or step 2 fails with 'profile in use'.
    print("  Releasing the bot profile lock (closing any lingering bot Edge)...")
    _kill_edge_for_profile(profile_dir)
    await asyncio.sleep(2.0)

    async with async_playwright() as p:
        launch_kwargs = dict(headless=False, args=["--lang=en-US"])
        if edge_exe:
            launch_kwargs["channel"] = "msedge"
        context = await p.chromium.launch_persistent_context(str(profile_dir), **launch_kwargs)
        page = context.pages[0] if context.pages else await context.new_page()
        await page.goto("https://myaccount.google.com/", wait_until="domcontentloaded", timeout=30_000)

        # Sanity check: if we land back on a sign-in page, the profile never
        # actually got authenticated (step 1 was skipped, closed too early,
        # or used the wrong profile dir) -- fail loudly rather than silently
        # exporting a useless anonymous session.
        signed_in = "myaccount.google.com" in page.url or "accounts.google.com/signin" not in page.url
        if not signed_in:
            print(
                "WARNING: this profile does not look signed in "
                f"(landed on {page.url}). Re-run this script and make sure "
                "step 1's login fully completes before closing that window."
            )

        await context.storage_state(path=out_path)
        await context.close()

    print(f"\nSaved session to: {out_path}  (signed_in check: {'OK' if signed_in else 'FAILED -- see warning above'})")
    print("\nNext:")
    print("  gcloud secrets create visualsprint-bot-google-session \\")
    print(f'    --project=visualsprint-agent --data-file="{out_path}"')
    print("(or `gcloud secrets versions add ...` to refresh an existing one).")


def main() -> None:
    profile_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else _DEFAULT_PROFILE_DIR
    out_path = sys.argv[2] if len(sys.argv) > 2 else _DEFAULT_OUT_PATH
    asyncio.run(_capture(profile_dir, out_path))


if __name__ == "__main__":
    main()
