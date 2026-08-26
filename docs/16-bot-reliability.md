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

## Permanent Google Meet access model

The deployed default is `VS_BOT_GOOGLE_JOIN_MODE=guest`. It deliberately does
**not** load a Google browser session, so there is no hourly cookie refresh or
user re-login. For every meeting that should be captured by the bot:

1. Use a Google Workspace Meet with guest access enabled and **no guest
   lobby** (for example, **Everyone with the link** where the Workspace policy
   permits it). Inviting an email address alone does not authorize the bot in
   guest mode because it intentionally does not sign in as that account.
2. If a meeting keeps a lobby, an organizer must allow **VisualSprint
   Notetaker** for that individual call. That is not unattended capture and no
   browser bot can override a host's admission policy.
3. For private personal-Gmail meetings, do not use a browser bot. They require
   an interactive Google account session, which Google may revoke. Use the
   official Meet recording/transcript capture path (Workspace OAuth + Meet and
   Drive permissions) or upload the recording instead.

`VS_BOT_GOOGLE_JOIN_MODE=session` is retained only as a legacy emergency/test
mode. It is not a production guarantee: Google owns browser-cookie lifetime,
and OAuth refresh tokens cannot refresh a browser login. Do not configure a
routine cookie-refresh job as a product workflow.

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
