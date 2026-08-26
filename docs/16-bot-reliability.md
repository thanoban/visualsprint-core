# Bot reliability correction — 2026-08-26

This document records the production investigation and permanent code/configuration
corrections for VisualSprint's Mode B meeting bot. It is intentionally specific:
the bot is a browser guest, so Google Meet and Teams host-access policies remain
platform controls rather than something VisualSprint can or should bypass.

## What the Cloud Run logs proved

The deployed `visualsprint-bot` job was healthy, had the Google storage-state
secret mounted, used the configured VPC connector, and ran with a 2 GiB memory
limit. The logs showed three independent failures:

1. Stored Google browser sessions can expire. The bot correctly falls back to
   anonymous join, but personal Gmail meetings reject anonymous guests.
2. A bot that reached a Meet lobby was sometimes denied by the organizer. The
   previous UI text, `never admitted from lobby`, obscured that this was a host
   policy decision, not a stuck worker.
3. Earlier successful bot recordings were persisted as concatenated WebM
   fragments. They are not one valid WebM file, so the worker repeatedly failed
   the transcribe stage. The worker also tried a gated pyannote diarization
   model and exceeded its 1 GiB service limit before the report stages ran.

## Corrections applied in code

- The bot writes each MediaRecorder WebM chunk to a concat manifest and has
  `ffmpeg` create one 16 kHz mono WAV. Conversion failure now stops the capture
  honestly; it never queues a guaranteed-to-fail transcript again.
- The bot saves only bounded, perceptually distinct screenshots, retaining the
  real capture time of each frame. The existing screen stage enriches those
  images with OCR/captioning and grounds them in the report.
- Meeting-lobby denials and timeouts now state the actionable host-control
  requirement. The instant-capture API/UI tells an organizer how to prepare a
  Google Meet or Teams meeting before the bot is dispatched.
- The production worker disables optional diarization until the Hugging Face
  model terms are accepted and the memory budget is intentionally raised. This
  preserves transcription, OCR, evidence, decisions, and reports; speaker
  attribution is shown as unknown rather than guessed.

## One-time Google Meet setup

Use a dedicated Google account for the bot. Set
`VS_BOT_GOOGLE_ACCOUNT_EMAIL` to that account address at deployment so the UI
can show the exact invite target. For each meeting that should auto-admit:

1. Invite that account in the calendar event, or set Meet access to **Everyone
   with the link** if your organization permits it.
2. Start the meeting as the organizer. If the meeting uses a lobby, allow the
   named **VisualSprint Notetaker** once; no browser bot can override a host's
   admission policy.
3. If Google revokes the browser session, refresh only the dedicated bot
   account's session with `python -m app.bot.capture_google_session` and upload
   the resulting JSON as a new `visualsprint-bot-google-session` secret version.

The existing Cloud Run VPC connector and Cloud NAT static address make bot job
egress stable across runs. They reduce avoidable session invalidation after a
successful cloud login, but Google still owns account-security decisions, so
no safe code change can promise that a browser cookie will never expire.

## Verification after deployment

For one short real Meet call, confirm these log events in order:

1. `bot.browser.launched signed_in=True`
2. `bot.meet.join_outcome outcome=live`
3. `bot.audio.started` and `bot.screen.started`
4. `bot.runner.audio_converted_to_wav`
5. `bot.runner.keyframes_uploaded`
6. worker stages `transcribe`, `screen`, `understand`, `verify`, and `report`
   complete for the new capture session.

Then open the report and confirm the transcript, screenshot evidence, and
evidence-grounded decisions are present. Existing failed WebM sessions cannot
be repaired reliably because their original browser chunks were not preserved
as a valid concat set; capture a new short meeting after deployment instead.

## Fast smoke-test mode

For low-time validation, do not change OAuth callback URLs or provider app
setup. Keep every provider pointed at the production backend URL and shorten
only the bot job runtime knobs:

```powershell
gcloud run jobs update visualsprint-bot `
  --project=visualsprint-agent `
  --region=us-west1 `
  --update-env-vars="VS_BOT_LOBBY_TIMEOUT_S=90,VS_BOT_SMOKE_CAPTURE_SECONDS=45"
```

That mode proves the critical live path quickly: join/admission, audio capture,
screen capture, WAV conversion, keyframe upload, CaptureSession creation, and
pipeline enqueue. After the smoke test, remove the cap for normal meetings:

```powershell
gcloud run jobs update visualsprint-bot `
  --project=visualsprint-agent `
  --region=us-west1 `
  --remove-env-vars="VS_BOT_LOBBY_TIMEOUT_S,VS_BOT_SMOKE_CAPTURE_SECONDS"
```
