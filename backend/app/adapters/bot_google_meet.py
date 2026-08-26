"""Google Meet guest-bot join (docs/03-capture.md Mode B). Best-effort
against Meet's guest-join UI: enter a display name, force mic/camera off
inside the app so the bot never transmits its own audio, and click "Ask to
join" (or "Join now" when no lobby is configured). Selectors are text/label
based where possible -- Meet's DOM classes are obfuscated and change without
notice, but visible button text and aria-labels are comparatively stable.

Meet is a heavy client-rendered SPA: the pre-join screen's name input and
join button exist in the DOM before they are actually interactable, and Meet
re-renders (and *detaches*) those nodes during hydration. Checking
`count() > 0` and immediately `.fill()`/`.click()` therefore races the
framework -- the element resolves, then Meet swaps the node out mid-action
and Playwright times out with "element was detached from the DOM". Every
interaction here instead waits for the element to be genuinely visible and
retries across detach, and any failure captures a screenshot to blob storage
(a headless bot in a container is otherwise a black box -- there is no other
way to see *why* a join failed against Meet's live DOM).
"""

from __future__ import annotations

import re
from datetime import UTC, datetime

import structlog

from app.bot.browser import PlaywrightSession
from app.interfaces.meeting_bot import BotRosterEntry, JoinOutcome

log = structlog.get_logger()

# Meet cold-loads slowly in a fresh headless container; the pre-join screen
# can take 20s+ to become interactable. These are generous on purpose -- a
# too-short wait was a contributor to the historical join failures.
_GOTO_TIMEOUT_MS = 60_000
_PREJOIN_READY_TIMEOUT_S = 45.0
_ELEMENT_VISIBLE_TIMEOUT_MS = 8_000
_STABLE_ACTION_TRIES = 6

# Best-effort dismissables that sit in front of the pre-join screen: cookie
# consent, "Got it" coach-marks, "you can't use your camera" notices, etc.
# Clicked if present, ignored if not -- never fatal.
_DISMISS_LABELS = (
    "Dismiss",
    "Got it",
    "No thanks",
    "Continue",
    "Continue without microphone and camera",
    "Continue without microphone",
    "Join without an account",
    # Newer Meet UI variants (2024+): mic/camera consent overlays that
    # appear before or on the pre-join screen and must be dismissed first.
    "Continue anyway",
    "Use without microphone",
)
_DISMISS_TEXTS = ("Accept all", "Reject all", "I agree", "Accept")

# Texts that appear when Meet refuses anonymous join (personal @gmail meetings
# only allow signed-in Google accounts). Detecting these fast-fails instead of
# waiting out the full 45s _PREJOIN_READY_TIMEOUT_S.
_SIGN_IN_REQUIRED_TEXTS = (
    "You can't join this video call",
    "can't join this meeting",
    "To join, sign in",
    "Sign in to join",
    "join requires a Google Account",
    "only for Google account holders",
    "This call is for Google account holders",
)


class GoogleMeetJoiner:
    platform = "meet"  # matches Meeting.platform / detect_conferencing's "meet"

    def __init__(self) -> None:
        self._session = PlaywrightSession()
        self._display_name = "VisualSprint Notetaker"
        self._state = JoinOutcome.FAILED
        # Set by the join flow to carry the specific reason for FAILED so that
        # runner.py can store it in BotSession.error instead of the generic
        # "join mechanics failed" string -- makes the UI actionable.
        self.error_detail: str | None = None
        # Stored at join() time so poll_status() can detect URL drift away
        # from the meeting room (Meet navigates to a lobby/home page on end).
        self._meeting_code: str | None = None
        self._join_url: str | None = None
        self._session_cleared: bool = False  # cleared once when session expires; never loop
        self.warning_detail: str | None = None

    @property
    def page(self):
        return self._session.page

    async def _handle_google_auth_redirect(self, page) -> bool:
        """After goto(), Google may redirect to accounts.google.com for account
        selection before returning to Meet. Works its way through the known
        interstitials and returns True once the URL is back on meet.google.com.
        Sets self.error_detail and returns False only on a truly unrecoverable
        wall (password prompt = session expired; 2FA prompt; CAPTCHA)."""
        import asyncio

        for attempt in range(15):
            url = page.url
            log.info("bot.meet.auth_redirect_check", url=url, attempt=attempt)

            if "meet.google.com" in url:
                return True

            if "accounts.google.com" in url:
                # Session has a password field → cookies are fully expired.
                # Rather than failing, clear the cookies and navigate directly
                # to the Meet URL for anonymous guest join. Works for Workspace
                # meetings; personal @gmail meetings will show a sign-in wall
                # which _wait_for_prejoin catches and reports correctly.
                try:
                    pw = page.locator("input[type='password']")
                    if await pw.count() > 0 and await pw.first.is_visible(timeout=500):
                        if self._session_cleared:
                            self.error_detail = (
                                "Google session expired — re-run "
                                "`python -m app.bot.capture_google_session` "
                                "and upload a new secret version"
                            )
                            log.warning("bot.meet.session_expired_password_prompt",
                                        hint=self.error_detail)
                            return False
                        log.warning(
                            "bot.meet.session_expired_password_prompt_anon_fallback",
                            hint="Google session expired (password prompt) — clearing "
                            "session and retrying as anonymous guest. Re-run "
                            "`python -m app.bot.capture_google_session` to restore.",
                        )
                        self.warning_detail = (
                            "The stored Google bot session expired before join. Refresh "
                            "the dedicated bot account session with "
                            "`python -m app.bot.capture_google_session` and upload a new "
                            "`visualsprint-bot-google-session` secret version."
                        )
                        self._session_cleared = True
                        await page.context.clear_cookies()
                        target = self._join_url or "https://meet.google.com/"
                        await page.goto(target, timeout=_GOTO_TIMEOUT_MS, wait_until="domcontentloaded")
                        await asyncio.sleep(2.0)
                        continue
                except Exception:
                    pass

                # Unrecoverable security / bot-detection walls
                for wall in ("Verify it's you", "2-Step Verification",
                             "Verify your identity", "This device isn't recognised",
                             "Couldn't sign you in"):
                    try:
                        if await page.get_by_text(wall, exact=False).count() > 0:
                            self.error_detail = (
                                f"Google blocked the bot session ({wall!r}). "
                                "Re-capture the session with "
                                "`python -m app.bot.capture_google_session`."
                            )
                            log.warning("bot.meet.auth_challenge",
                                        wall=wall, url=url,
                                        hint=self.error_detail)
                            return False
                    except Exception:
                        pass

                # Account chooser: click the first account tile.
                # Try all selector variants — Google's chooser UI varies by
                # region and account type.
                clicked = False
                for sel in ("[data-identifier]", "[data-email]",
                            "li[data-authuser]", ".wLBAL", ".daaWNd"):
                    try:
                        tile = page.locator(sel).first
                        if await tile.count() > 0 and await tile.is_visible(timeout=1000):
                            await tile.click(timeout=3000)
                            await asyncio.sleep(3.0)
                            clicked = True
                            break
                    except Exception:
                        pass

                # "Continue" / "Next" buttons (appear after tile click or as
                # standalone prompts before the redirect completes)
                if not clicked:
                    for btn_text in ("Continue", "Next", "Allow", "I agree",
                                     "Use another account"):
                        try:
                            btn = page.get_by_role("button", name=btn_text)
                            if await btn.count() > 0 and await btn.first.is_visible(timeout=800):
                                await btn.first.click(timeout=2000)
                                await asyncio.sleep(2.0)
                                break
                        except Exception:
                            pass

                await asyncio.sleep(1.5)
                continue

            # Any other non-Meet domain (CAPTCHA, google.com/sorry, etc.)
            log.warning("bot.meet.unexpected_redirect", url=url)
            await asyncio.sleep(2.0)

        self.error_detail = (
            "Google auth redirect did not resolve to Meet after 15 attempts — "
            "session is likely expired. Re-run "
            "`python -m app.bot.capture_google_session`."
        )
        return False

    async def join(
        self, join_url: str, *, display_name: str = "VisualSprint Notetaker"
    ) -> JoinOutcome:
        self._display_name = display_name
        self._join_url = join_url
        # Join as the configured signed-in Google account when a session is
        # available -- required for meetings hosted by personal @gmail
        # accounts, which refuse anonymous users outright (the "You can't join
        # this video call" screen). Falls back to anonymous guest-join when
        # unset (works only for Workspace-hosted meetings that allow guests).
        from app.config import get_settings

        # Extract the meeting room code (e.g. "abc-defg-hij") so poll_status
        # can detect URL drift when Meet navigates away on meeting end.
        m = re.search(r"meet\.google\.com/([a-z]{3}-[a-z]{4}-[a-z]{3})", join_url)
        self._meeting_code = m.group(1) if m else None

        await self._session.launch(
            display_name=display_name,
            storage_state_path=get_settings().bot_google_storage_state_path,
        )
        page = self._session.page
        try:
            await page.goto(join_url, timeout=_GOTO_TIMEOUT_MS, wait_until="load")

            # When launched with a stored Google session, Meet redirects to
            # accounts.google.com for account selection before the pre-join
            # screen. Handle that entire flow before looking for Meet UI.
            on_meet = await self._handle_google_auth_redirect(page)
            if not on_meet:
                await self._save_debug_screenshot(page, "auth_redirect_failed")
                log.warning("bot.meet.join_failed",
                            error=self.error_detail or "Google auth redirect did not resolve to Meet")
                self._state = JoinOutcome.FAILED
                return self._state

            # Wait for the pre-join screen to actually settle (name input or a
            # join button visible), dismissing any coach-marks/consent dialogs
            # that render in front of it along the way.
            ready = await self._wait_for_prejoin(page)
            if not ready:
                await self._save_debug_screenshot(page, "prejoin_never_ready")
                log.warning("bot.meet.join_failed",
                            error=self.error_detail or "pre-join screen never became ready")
                self._state = JoinOutcome.FAILED
                return self._state

            # Name (guest join). Absent when Meet already has an identity, so
            # a missing field is fine -- only a present-but-unfillable one is a
            # failure worth surfacing.
            name_input = self._name_input(page)
            if await name_input.count() > 0:
                filled = await self._fill_when_stable(name_input, display_name)
                if not filled:
                    await self._save_debug_screenshot(page, "name_fill_failed")
                    self.error_detail = "Could not fill guest name field — Meet DOM changed"
                    log.warning("bot.meet.join_failed", error=self.error_detail)
                    self._state = JoinOutcome.FAILED
                    return self._state

            # Mic/camera off inside the app so the bot never transmits. Purely
            # best-effort: labels vary and the device is already fake/silent.
            for label in ("Turn off microphone", "Turn off camera"):
                btn = page.get_by_label(label)
                try:
                    if await btn.count() > 0:
                        await btn.first.click(timeout=2000)
                except Exception:
                    pass

            join_btn = page.get_by_role("button", name=re.compile(r"^Join now$", re.I))
            ask_btn = page.get_by_role("button", name=re.compile(r"Ask to join", re.I))
            if await join_btn.count() > 0:
                if not await self._click_when_stable(join_btn):
                    await self._save_debug_screenshot(page, "join_now_click_failed")
                    self.error_detail = "Could not click Join now — Meet DOM changed"
                    self._state = JoinOutcome.FAILED
                    return self._state
                self._state = JoinOutcome.LIVE
            elif await ask_btn.count() > 0:
                if not await self._click_when_stable(ask_btn):
                    await self._save_debug_screenshot(page, "ask_to_join_click_failed")
                    self.error_detail = "Could not click Ask to join — Meet DOM changed"
                    self._state = JoinOutcome.FAILED
                    return self._state
                self._state = JoinOutcome.IN_LOBBY
            else:
                await self._save_debug_screenshot(page, "no_join_button")
                self.error_detail = "No Join now / Ask to join button found — session may be signed out"
                log.warning("bot.meet.join_failed", error=self.error_detail)
                self._state = JoinOutcome.FAILED
                return self._state

            if self._state == JoinOutcome.LIVE:
                await self._announce(page)
            log.info("bot.meet.join_outcome", outcome=str(self._state))
            return self._state
        except Exception as exc:
            await self._save_debug_screenshot(page, "join_exception")
            log.warning("bot.meet.join_failed", error=str(exc))
            self._state = JoinOutcome.FAILED
            return self._state

    # --- pre-join readiness / robust interactions ------------------------

    def _name_input(self, page):
        """Meet's guest name field, most-specific selector first: the
        placeholder, then the aria-label, then a bare text input as a last
        resort (the pre-join screen has only one)."""
        return page.locator(
            'input[placeholder="Your name"], input[aria-label="Your name"], '
            'input[type="text"]'
        ).first

    async def _wait_for_prejoin(self, page) -> bool:
        """Poll until the guest name field OR a join button is actually
        visible, dismissing blocking dialogs each pass. Returns False if the
        screen never settles within the timeout."""
        import asyncio

        loop = asyncio.get_event_loop()
        started = loop.time()
        while loop.time() - started < _PREJOIN_READY_TIMEOUT_S:
            # If Meet redirected away mid-load (session expiry can trigger a
            # second redirect after the initial goto() succeeds), re-run the
            # full auth handler.
            if "meet.google.com" not in page.url:
                log.warning("bot.meet.prejoin_redirected", url=page.url)
                recovered = await self._handle_google_auth_redirect(page)
                if not recovered:
                    return False
                continue

            await self._dismiss_blocking_dialogs(page)

            # Meet sometimes shows a sign-in overlay ON the meet.google.com
            # domain when the passive auth redirected back but the session
            # cookies were invalid. Don't fail immediately — clear the expired
            # session cookies and reload so Meet serves its anonymous guest UI.
            # This works for Workspace-hosted meetings (the majority of business
            # meetings). If the meeting also blocks anonymous users (personal
            # @gmail meetings), the existing sign-in-required wall detection
            # below will catch it and fail with the correct error message.
            try:
                signed_out = page.get_by_text("Signed out", exact=True)
                if await signed_out.count() > 0 and await signed_out.first.is_visible(timeout=300):
                    if self._session_cleared:
                        # Already tried the anonymous fallback; Meet is still
                        # showing "Signed out" — this meeting may require a
                        # signed-in account even for guests (unusual but real).
                        self.error_detail = (
                            "Google session expired (signed-out overlay on Meet) — "
                            "re-run `python -m app.bot.capture_google_session` "
                            "and upload a new secret version"
                        )
                        log.warning("bot.meet.session_expired_anon_also_blocked",
                                    hint=self.error_detail)
                        return False
                    log.warning(
                        "bot.meet.session_expired_trying_anonymous",
                        hint="Google session expired — clearing session and retrying as "
                        "anonymous guest. Re-run `python -m app.bot.capture_google_session` "
                        "to restore signed-in join for personal Gmail meetings.",
                    )
                    self.warning_detail = (
                        "The stored Google bot session expired before join. Refresh the "
                        "dedicated bot account session with "
                        "`python -m app.bot.capture_google_session` and upload a new "
                        "`visualsprint-bot-google-session` secret version."
                    )
                    # Clear expired Google cookies so the next navigation lands
                    # on Meet's anonymous pre-join screen instead of the sign-out
                    # overlay. One-shot: _session_cleared prevents looping if
                    # anonymous join is also blocked.
                    self._session_cleared = True
                    await page.context.clear_cookies()
                    await page.goto(
                        self._join_url or page.url,
                        timeout=_GOTO_TIMEOUT_MS,
                        wait_until="domcontentloaded",
                    )
                    await asyncio.sleep(2.0)
                    continue
            except Exception:
                pass

            # Detect sign-in-required walls (personal @gmail meetings block
            # anonymous users). Fast-fail instead of waiting out the 45s.
            for wall_text in _SIGN_IN_REQUIRED_TEXTS:
                try:
                    el = page.get_by_text(wall_text, exact=False)
                    if await el.count() > 0 and await el.first.is_visible(timeout=300):
                        self.error_detail = (
                            "Meeting requires a signed-in Google account — "
                            "re-run `python -m app.bot.capture_google_session` "
                            "and upload the JSON as Secret "
                            "`visualsprint-bot-google-session`"
                        )
                        log.warning("bot.meet.anonymous_blocked",
                                    text=wall_text, hint=self.error_detail)
                        return False
                except Exception:
                    pass

            try:
                if await self._name_input(page).is_visible(timeout=1000):
                    return True
            except Exception:
                pass
            for locator in (
                page.get_by_role("button", name=re.compile(r"^Join now$", re.I)),
                page.get_by_role("button", name=re.compile(r"Ask to join", re.I)),
            ):
                try:
                    if await locator.count() > 0 and await locator.first.is_visible(timeout=500):
                        return True
                except Exception:
                    pass
            await asyncio.sleep(1.5)

        if not self.error_detail:
            self.error_detail = (
                "Pre-join screen never became ready — possible causes: "
                "session expired, meeting URL invalid, or Meet UI changed"
            )
        return False

    async def _dismiss_blocking_dialogs(self, page) -> None:
        import asyncio

        for label in _DISMISS_LABELS:
            try:
                btn = page.get_by_role("button", name=label)
                if await btn.count() > 0 and await btn.first.is_visible(timeout=300):
                    await btn.first.click(timeout=1500)
                    if label == "Join without an account":
                        # Meet SPA needs time to transition to the name-input
                        # screen after this click — give it a generous buffer
                        # so the next iteration finds the pre-join UI ready.
                        await asyncio.sleep(3.0)
                    continue
            except Exception:
                pass
            # Some Meet UI variants render "Join without an account" as a link
            # (<a>) rather than a <button>. Try that as a fallback.
            if label == "Join without an account":
                try:
                    link = page.get_by_role("link", name=label)
                    if await link.count() > 0 and await link.first.is_visible(timeout=300):
                        await link.first.click(timeout=1500)
                        await asyncio.sleep(3.0)
                except Exception:
                    pass
        for text in _DISMISS_TEXTS:
            try:
                btn = page.get_by_text(text, exact=False)
                if await btn.count() > 0 and await btn.first.is_visible(timeout=300):
                    await btn.first.click(timeout=1500)
            except Exception:
                pass

    async def _fill_when_stable(self, locator, text: str) -> bool:
        """Fill a field that Meet may detach/re-render mid-action. Re-resolves
        the locator each attempt (Playwright locators are lazy, so this picks
        up a freshly-attached node), waits for it to be genuinely visible, and
        verifies the value stuck. Returns False only if every attempt failed."""
        import asyncio

        for attempt in range(_STABLE_ACTION_TRIES):
            try:
                await locator.wait_for(state="visible", timeout=_ELEMENT_VISIBLE_TIMEOUT_MS)
                await locator.click(timeout=2000)
                await locator.fill(text, timeout=3000)
                if (await locator.input_value()) == text:
                    return True
            except Exception as exc:
                log.info("bot.meet.fill_retry", attempt=attempt, error=str(exc))
                await asyncio.sleep(0.75)
        return False

    async def _click_when_stable(self, locator) -> bool:
        """Click a control that Meet may detach/re-render mid-action, with the
        same re-resolve-and-retry discipline as _fill_when_stable."""
        import asyncio

        for attempt in range(_STABLE_ACTION_TRIES):
            try:
                await locator.first.wait_for(
                    state="visible", timeout=_ELEMENT_VISIBLE_TIMEOUT_MS
                )
                await locator.first.click(timeout=3000)
                return True
            except Exception as exc:
                log.info("bot.meet.click_retry", attempt=attempt, error=str(exc))
                await asyncio.sleep(0.75)
        return False

    async def _save_debug_screenshot(self, page, reason: str) -> None:
        """Persist a full-page screenshot to blob storage so a failed join in
        a headless container is diagnosable at all. Entirely best-effort: a
        screenshot failure must never mask the underlying join failure."""
        try:
            if page is None or page.is_closed():
                return
            png = await page.screenshot(full_page=True)
        except Exception as exc:
            log.info("bot.meet.screenshot_skipped", reason=reason, error=str(exc))
            return
        try:
            from app.adapters.blobstore_s3 import get_blobstore

            ts = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
            key = f"bot-debug/meet-{reason}-{ts}.png"
            uri = await get_blobstore().put(key, png, content_type="image/png")
            log.warning("bot.meet.debug_screenshot_saved", reason=reason, uri=uri)
        except Exception as exc:
            log.info("bot.meet.screenshot_store_failed", reason=reason, error=str(exc))

    async def _announce(self, page) -> None:
        try:
            chat_btn = page.get_by_label("Chat with everyone")
            if await chat_btn.count() > 0:
                await chat_btn.first.click(timeout=2000)
                box = page.get_by_placeholder("Send a message")
                if await box.count() > 0:
                    await box.first.fill(
                        f"{self._display_name} is recording this meeting for VisualSprint "
                        "meeting notes."
                    )
                    await box.first.press("Enter")
        except Exception as exc:
            log.warning("bot.meet.announce_failed", error=str(exc))

    async def _is_in_meeting(self, page) -> bool:
        """Strong 'the bot is now inside the live meeting' signals. The red
        hang-up control is the most reliable -- it exists only in an active
        call and never on the lobby 'asking to be let in' screen -- with the
        People/Chat controls as backups across Meet UI variants. This is the
        gate the whole capture hangs on: the previous single `People` label
        check silently failed to detect admission, so the bot sat in the
        lobby state (capturing nothing) even after the host let it in."""
        candidates = (
            page.get_by_role("button", name=re.compile(r"Leave call", re.I)),
            page.get_by_label(re.compile(r"Leave call", re.I)),
            page.get_by_role("button", name=re.compile(r"^(People|Show everyone)$", re.I)),
            page.get_by_label(re.compile(r"^(People|Show everyone)$", re.I)),
            page.get_by_label("Chat with everyone"),
        )
        for loc in candidates:
            try:
                if await loc.count() > 0:
                    return True
            except Exception:
                pass
        return False

    async def poll_status(self) -> JoinOutcome:
        page = self._session.page
        # Closed page means Meet navigated away (crash, kick, or meeting end).
        # Treat as ENDED so _finalize_capture still runs -- not FAILED, which
        # would skip the finalize path and lose the captured audio.
        if page is None or page.is_closed():
            if self._state == JoinOutcome.LIVE:
                self._state = JoinOutcome.ENDED
                return self._state
            return JoinOutcome.FAILED
        try:
            if self._state == JoinOutcome.IN_LOBBY:
                if await self._is_in_meeting(page):
                    self._state = JoinOutcome.LIVE
                    log.info("bot.meet.join_outcome", outcome="live")
                    await self._announce(page)
                    return self._state
                for txt in ("removed you", "wasn't approved", "denied your request", "can't join"):
                    try:
                        if await page.get_by_text(txt, exact=False).count() > 0:
                            self._state = JoinOutcome.DENIED
                            return self._state
                    except Exception:
                        pass

            elif self._state == JoinOutcome.LIVE:
                # --- Signal 1: URL drift. ---
                # Meet navigates away from the room URL when the call ends
                # (to a lobby page, the home screen, or an end-call summary).
                # If our stored meeting code is no longer in the current URL,
                # the bot is off the call page -- treat as ended.
                current_url = page.url
                if self._meeting_code and self._meeting_code not in current_url:
                    log.info("bot.meet.end_detected", reason="url_drift", url=current_url)
                    self._state = JoinOutcome.ENDED
                    return self._state

                # --- Signal 2: End-screen text. ---
                # Google Meet's post-call screen shows different strings
                # depending on who ended and which Meet version is running.
                # Match any of these with a single pass.
                for txt in (
                    # Host ended the call
                    "The call has ended",
                    "This meeting has ended",
                    "The meeting has ended",
                    "call has ended",
                    "ended for everyone",
                    "Host ended the meeting",
                    # Bot was removed / left
                    "You left the meeting",
                    "You've been removed",
                    "You were removed",
                    "removed from the call",
                    # Generic end phrases across Meet UI generations
                    "call ended",
                    "meeting has ended",
                    "Return to home screen",
                    "left the call",
                    "Your meeting has ended",
                ):
                    try:
                        if await page.get_by_text(txt, exact=False).count() > 0:
                            log.info("bot.meet.end_detected", reason="end_text", text=txt)
                            self._state = JoinOutcome.ENDED
                            return self._state
                    except Exception:
                        pass

                # --- Signal 3: Rejoin button. ---
                # "Rejoin" only appears on the post-call summary / end screen,
                # never inside an active meeting.
                try:
                    rejoin = page.get_by_role("button", name=re.compile(r"Rejoin", re.I))
                    if await rejoin.count() > 0:
                        log.info("bot.meet.end_detected", reason="rejoin_button")
                        self._state = JoinOutcome.ENDED
                        return self._state
                except Exception:
                    pass

                # --- Signal 4: In-call controls gone. ---
                # Covers any Meet end-screen variant not caught above.
                if not await self._is_in_meeting(page):
                    log.info("bot.meet.end_detected", reason="controls_gone")
                    self._state = JoinOutcome.ENDED

            return self._state
        except Exception as exc:
            log.warning("bot.meet.poll_failed", error=str(exc))
            return self._state

    async def roster(self) -> list[BotRosterEntry]:
        page = self._session.page
        if page is None:
            return []
        try:
            for label in (
                page.get_by_role("button", name=re.compile(r"^(People|Show everyone)$", re.I)),
                page.get_by_label(re.compile(r"^(People|Show everyone)$", re.I)),
            ):
                try:
                    if await label.count() > 0:
                        await label.first.click(timeout=2000)
                        break
                except Exception:
                    pass
            names = await page.locator("[data-participant-id]").all_inner_texts()
            return [BotRosterEntry(display_name=n.strip()) for n in names if n.strip()]
        except Exception as exc:
            log.warning("bot.meet.roster_failed", error=str(exc))
            return []

    async def leave(self) -> None:
        await self._session.close()
