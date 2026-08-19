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
)
_DISMISS_TEXTS = ("Accept all", "Reject all", "I agree")


class GoogleMeetJoiner:
    platform = "meet"  # matches Meeting.platform / detect_conferencing's "meet"

    def __init__(self) -> None:
        self._session = PlaywrightSession()
        self._display_name = "VisualSprint Notetaker"
        self._state = JoinOutcome.FAILED

    @property
    def page(self):
        return self._session.page

    async def join(
        self, join_url: str, *, display_name: str = "VisualSprint Notetaker"
    ) -> JoinOutcome:
        self._display_name = display_name
        # Join as the configured signed-in Google account when a session is
        # available -- required for meetings hosted by personal @gmail
        # accounts, which refuse anonymous users outright (the "You can't join
        # this video call" screen). Falls back to anonymous guest-join when
        # unset (works only for Workspace-hosted meetings that allow guests).
        from app.config import get_settings

        await self._session.launch(
            display_name=display_name,
            storage_state_path=get_settings().bot_google_storage_state_path,
        )
        page = self._session.page
        try:
            await page.goto(join_url, timeout=_GOTO_TIMEOUT_MS, wait_until="load")

            # Wait for the pre-join screen to actually settle (name input or a
            # join button visible), dismissing any coach-marks/consent dialogs
            # that render in front of it along the way.
            ready = await self._wait_for_prejoin(page)
            if not ready:
                await self._save_debug_screenshot(page, "prejoin_never_ready")
                log.warning("bot.meet.join_failed", error="pre-join screen never became ready")
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
                    log.warning("bot.meet.join_failed", error="could not fill guest name field")
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
                    self._state = JoinOutcome.FAILED
                    return self._state
                self._state = JoinOutcome.LIVE
            elif await ask_btn.count() > 0:
                if not await self._click_when_stable(ask_btn):
                    await self._save_debug_screenshot(page, "ask_to_join_click_failed")
                    self._state = JoinOutcome.FAILED
                    return self._state
                self._state = JoinOutcome.IN_LOBBY
            else:
                await self._save_debug_screenshot(page, "no_join_button")
                log.warning("bot.meet.join_failed", error="no Join now / Ask to join button found")
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
        screen never settles within the timeout (sign-in wall, error page,
        meeting-not-found, etc.)."""
        import asyncio

        loop = asyncio.get_event_loop()
        started = loop.time()
        while loop.time() - started < _PREJOIN_READY_TIMEOUT_S:
            await self._dismiss_blocking_dialogs(page)
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
        return False

    async def _dismiss_blocking_dialogs(self, page) -> None:
        for label in _DISMISS_LABELS:
            try:
                btn = page.get_by_role("button", name=label)
                if await btn.count() > 0 and await btn.first.is_visible(timeout=300):
                    await btn.first.click(timeout=1500)
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
        if page is None or page.is_closed():
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
                # End of meeting: a positive end message, or the in-call
                # controls all gone (host ended / bot removed). Checked in
                # that order so a matched end-screen wins; the control-absence
                # fallback covers Meet end screens whose exact wording we don't
                # match, so finalize still fires instead of the bot capturing
                # silence until the 4h safety cap.
                for txt in (
                    "You left the meeting", "You've been removed", "call ended",
                    "Return to home screen", "meeting has ended", "You were removed",
                ):
                    try:
                        if await page.get_by_text(txt, exact=False).count() > 0:
                            self._state = JoinOutcome.ENDED
                            return self._state
                    except Exception:
                        pass
                if not await self._is_in_meeting(page):
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
