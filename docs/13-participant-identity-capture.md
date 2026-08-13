# Participant Identity Capture — getting real names, on every platform

Speaker names are table stakes. Otter, Read.ai, and Fireflies all show "Nimal said X",
not "Speaker 2 said X". Per-person decision tracking — this product's differentiator
([09](09-participant-intelligence.md), [10](10-longitudinal-intelligence.md)) — is
worth nothing if the person is anonymous.

This document plans name capture across **every** supported platform, not just Zoom.

**Status update 2026-08-13 — Step 1–3 (Zoom RTMS Option A) implemented.**
`rtms_protocol.py` now carries the verified `EVENT_SUBSCRIPTION`/`EVENT_UPDATE`/
`RTMS_EVENT_TYPE` constants and a `build_event_subscription` message builder;
`rtms_client.py` subscribes to `PARTICIPANT_JOIN`/`PARTICIPANT_LEAVE`/
`ACTIVE_SPEAKER_CHANGE` on the signaling connection and now listens on it
*concurrently* with the media connection (the real structural gap this section
originally flagged — a live meeting previously stopped reading `signaling`
entirely once media started), converting events into `RosterEntry`/
`SpeakerLabelSpan` via a defensive `_EventTracker` that logs the raw payload on
an unrecognized shape rather than guessing field names. `rtms_webhook.py` feeds
the result through a newly-shared `app/capture/persist.py::persist_capture_artifacts`
(extracted from `worker.py`, which now delegates to it too, so Mode A1/A2 use one
persistence path, not two) — a live Zoom meeting now produces the same
`Participant`/`PlatformSpeakerLabel` rows Meet/Teams/Zoom-cloud already did.
Verified with 12 new/updated tests (491→503 passing), including an end-to-end
webhook test proving a `PARTICIPANT_JOIN` + two `ACTIVE_SPEAKER_CHANGE` events
land as real database rows, not just parsed in memory.

**What's still unverified — stated plainly, not hidden by the above:** the exact
`EVENT_UPDATE` payload shape (which key holds a joining participant's name) is
not published in any source this session could reach — see the constants'
docstring in `rtms_protocol.py`. The message-type and event-type *numbers* are
pinned to Zoom's own reference implementation with the same rigor as every other
constant in that file; the payload *shape* is deliberately handled by
`_extract_participant`'s multi-candidate lookup plus a one-time warning log, so
the real shape gets learned from the first real production webhook rather than
assumed. Also unverified: whether `ACTIVE_SPEAKER_CHANGE` timing is precise
enough for good span boundaries (risk 3 below), and the whole thing needs an
actual live Zoom meeting to confirm end-to-end — everything above is proven
against a faithful fake, not yet against Zoom's real servers.

**Option B (per-participant audio streams), and platforms 2–4 below, remain design
only.**

## A locked assumption that is now false

CLAUDE.md requires that a new fact contradicting a prior decision be stated explicitly
with a source, rather than silently drifted around. This is one.

`app/capture/rtms_client.py`'s module docstring currently says:

> Zoom's per-participant binary framing (MEDIA_DATA_OPTION.AUDIO_MULTI_STREAMS) isn't
> documented in any public source, and guessing it would misrepresent identity-quality
> confidence rather than honestly degrade it

That was a defensible call when written. **It is no longer true.** Zoom now publicly
documents both participant identity and per-participant audio in RTMS:

- Each audio packet carries the speaking participant's identifier (`channel_id` /
  `user_id`); merged audio uses `user_id = 0`
  ([Handling media data](https://developers.zoom.us/docs/rtms/contact-center/media/))
- Participant metadata arrives at session start via events, and
  `PARTICIPANT_JOINED` (event type **3**) carries `user_id`, `user_name`, `timestamp`;
  `ACTIVE_SPEAKER_CHANGED` (type **2**) reports who is speaking
  ([Event reference](https://developers.zoom.us/docs/rtms/event-reference/))
- `data_opt` selects merged vs. separated audio streams

So the honest position is no longer "Zoom doesn't expose this" — it is "**Zoom exposes
this and our client ignores it**". `rtms_protocol.py` defines exactly one media
constant (`MEDIA_DATA_AUDIO = 14`) and `rtms_client.py` drops every message that isn't
audio or keep-alive. The docstring must be corrected as part of this work; leaving a
now-false justification in the code is worse than the missing feature.

## Where each platform actually stands

Verified by reading the adapters, not assumed:

| Platform | Mode | Name source | State |
|---|---|---|---|
| **Google Meet** | A2 | Meet API transcript entries → `SpeakerLabelSpan` (`meet_adapter.py:77-100`) | ✅ implemented |
| **Microsoft Teams** | A2 | WebVTT `<v Speaker Name>` voice tags (`teams_adapter.py:140-153`) | ✅ implemented |
| **Zoom cloud recording** | A2 | `participant_audio_files` (exact per-participant tracks) + `/report/meetings/{id}/participants` roster (`zoom_adapter.py`) | ✅ implemented — the strongest path we have |
| **Zoom live (RTMS)** | A1 | `PARTICIPANT_JOINED` + `ACTIVE_SPEAKER_CHANGED` events, or per-participant streams | ❌ **the gap** — Zoom provides it, we ignore it |
| **Manual upload** | D | none — no platform metadata exists | ⚠️ inherent limit; see below |

The persistence and resolution layers are **already built and shared**:
`worker.py:502` writes `artifacts.speaker_labels` into `PlatformSpeakerLabel`, and
`app/speakers/identity.py` runs the roster → voiceprint → unresolved ladder over it.

**This means the work is feeding that pipeline, not building it.** Every platform below
converges on the same `PlatformSpeakerLabel` rows and the same resolution ladder.

## Plan

### 1. Zoom RTMS live — close the real gap (highest value)

Two options. They are complementary, not alternatives.

**Option A — consume participant events (do this first).**
Extend `rtms_protocol.py` with the event constants and a parser for the signaling
channel's event messages, then in `rtms_client.py`:
- accumulate `PARTICIPANT_JOINED` → a roster of `(user_id, user_name)`
- accumulate `ACTIVE_SPEAKER_CHANGED` → time-ordered speaker spans
- convert both into `RosterEntry` + `SpeakerLabelSpan` on `CaptureArtifacts`

That is the exact shape Meet and Teams already produce, so it flows into
`PlatformSpeakerLabel` and the existing identity ladder with **no changes downstream**.
Low risk, no new dependency, no change to audio handling.

**Option B — request per-participant audio streams (bigger win, more work).**
Set `data_opt` to separated streams and key each incoming frame by its `user_id`,
writing one `AudioTrack` per participant with `participant` set — the same shape
`zoom_adapter.py` already produces for cloud recordings with
`participant_audio_files`.

The payoff is large: per-participant audio means attribution is **exact by
construction**, and the `diarize`/`identify` stages skip entirely (they already skip
when `AudioTrack.participant` is set). No clustering, no voiceprint threshold, no
"is this speaker 1 or 2" error class at all — for live Zoom, the hardest identity
problem simply disappears.

Sequencing: A is a small, safe win that also de-risks B (the roster from A is what
labels B's streams). Do A, ship it, then evaluate B against real meeting traffic.

**Must be verified before building, not assumed:**
- the exact wire shape of the event messages (Zoom's reference implementation,
  `github.com/zoom/rtms-mock-server-sample`, is the same source that grounded the
  existing protocol module — use it again, not memory)
- the `data_opt` numeric values for merged vs separated (the docs describe the field
  but the reference page did not give numeric mappings)
- whether `ACTIVE_SPEAKER_CHANGED` timing is precise enough to segment speech, or
  whether it only coarsely tracks the dominant speaker

### 2. Meet / Teams / Zoom-cloud — verify, don't rebuild

These three already produce speaker labels in code. What has **not** happened is an
end-to-end run against a real meeting. Required before claiming they work:
- confirm labels actually land in `PlatformSpeakerLabel` from a real captured meeting
- confirm the session-level roster sanity gate ([09](09-participant-intelligence.md))
  behaves — specifically, whether platform label timings share a clock with the audio
  file, since a constant offset would name every speaker confidently and wrongly
- confirm Zoom's `participant_audio_files` path triggers when a host enables
  per-participant recording

### 3. Manual upload (Mode D) — the one irreducible gap

An uploaded file carries no platform metadata; no amount of engineering invents a name
that was never recorded. The honest answer is the one already designed:
- speakers are separated but unnamed on first upload
- a human names them once via the correction UI
- that correction enrolls a voiceprint, so the **same person is recognised
  automatically in every later meeting**, live or uploaded

Worth stating plainly in the product UI rather than hiding: upload-only orgs get
one-time naming effort per person, then it compounds to zero.

### 4. Cross-platform identity

The payoff of routing every platform through one `PlatformSpeakerLabel` +
`Person.voiceprint` model: a person named once in Teams is recognised by voice in a
Zoom meeting. That already falls out of the existing design — it needs no new work
beyond feeding it, and it is a genuinely hard thing for a single-platform competitor
to match.

## Build order

| Step | Work | Depends | Status |
|---|---|---|---|
| 1 | Correct the false docstring in `rtms_client.py` | — | ✅ done |
| 2 | Verify RTMS event wire shapes against Zoom's reference implementation | — | ✅ done for message/event-type numbers; payload shape still unverified, see status note above |
| 3 | Option A: participant events → `RosterEntry` + `SpeakerLabelSpan` | 2 | ✅ done, tested; not yet confirmed against a real live meeting |
| 4 | End-to-end verification of Meet / Teams / Zoom-cloud label capture | — | not started |
| 5 | Roster/audio clock-offset check across all platforms | 3,4 | not started |
| 6 | Option B: per-participant RTMS streams → per-participant `AudioTrack` | 3 | not started |
| 7 | Product copy explaining the one-time naming step for uploads | — | not started |

Steps 1 and 4 need no vendor work and can start immediately. Step 6 is the largest
single accuracy win available anywhere in this system, and should not be attempted
before step 3 makes the roster available to label its streams.

## Risks

1. **Naming every speaker confidently wrong** via a roster/audio clock offset — the
   worst failure here, and why the session-level sanity gate in
   [09](09-participant-intelligence.md) exists. Applies to every platform, not just Zoom.
2. **Building on an assumed wire format.** The existing protocol module's strength is
   that it was verified against Zoom's own reference server. Anything added here must
   meet that same bar, or it will fail silently in production the way the hardcoded
   pipeline stage did.
3. **`ACTIVE_SPEAKER_CHANGED` being coarser than real speech turns** — it may mark
   dominant speaker rather than precise boundaries. If so, treat it as a labelling
   hint fused with diarization, not a replacement for it.
4. **Per-participant streams multiplying cost** — N participants means N audio streams
   to store and transcribe. Measure before enabling by default; it may warrant being
   opt-in per org.
