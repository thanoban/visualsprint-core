# Capture processing authority foundation

This is the durable explicit-consent prerequisite, not an automatic AI extraction release.
The `capture.processing.ready.v1` producer and finalized-content consumer remain disabled.
No live Recall/model call is part of the local qualification.

## Request and runtime configuration

The existing capture POST accepts optional
`processing: { consent: true, policyVersion: 'english-text-v1' }`. Absence preserves
the existing capture-only command. Calendar operation principals cannot opt into processing.
The capture and pending intent commit together before quota admission or dispatch.
The API and capture worker must both set `CAPTURE_PROCESSING_ENABLED=true`; Account must
enable the same feature and trust the pinned Ingest signing key for ownership callbacks.
Ingest also needs the pinned Account public key; Workspace must trust the dedicated Ingest
and Intelligence callers for its metadata-only processing context. Signing secrets belong
in the configured secret manager, never the browser or checked-in environment examples.

Unconfigured inline opt-in fails before capture allocation. An unknown/unavailable grant
creation leaves a persisted `configuration_error` intent, not a capture-ready success.
Scheduled dispatch retries the durable intent and remains blocked until the grant is bound.
`ready` on the processing status means consent is bound, not that a summary exists.

## Public consent controls

Owner-only processing details are included on the individual capture GET. Other authorized
meeting readers receive `processing: null` and cannot manipulate the owner's grant.
POST `captures/:id/processing-consent` accepts the same affirmative policy body.
POST `captures/:id/processing-consent/withdraw` accepts `expectedIntentVersion`.
Both commands require an idempotency key. Withdrawal persists its fence before remote
cleanup. `withdraw_requested` is shown until Account confirms its permanent creation
tombstone, including when the grant ID is not yet known. A late creation acknowledgement
cannot revive the intent. Re-enabling the same withdrawn capture is unsupported; a new
capture requires new explicit consent.

Withdrawing AI processing does not stop capture. After confirmed withdrawal the original
capture-only consent may continue recording text. The existing stop command remains a
separate durable command. Deletion first installs Ingest's local barrier, then revokes
Account grants and marks intents revoked before acknowledging the Ingest participant.
Cleanup remains installed when new processing creation is disabled.

## Narrow evidence access

Only the pinned Intelligence caller can use the dedicated processing-evidence POST,
carrying the exact consent-bound operation actor, full grant proof and transcript revision.
Normal transcript/search/public APIs do not accept that operation principal.
Account current membership, grant/version/policy/owner, Workspace current ownership and
deletion barrier, and Ingest ready intent plus final complete/partial generation are checked
before and after each evidence page. Logout alone does not erase this separate consent;
membership, consent or deletion revocation does block it.

`transcriptRevision` is separate from the capture's operational version. Evidence edits,
coverage changes and first finalization advance it; lease/quota bookkeeping does not.
Pages contain at most 100 segments, use a stable timing/UUID cursor and preserve human
corrections. More than 10,000 segments or 2,000,000 UTF-8 text bytes fails explicitly rather
than returning a silently truncated transcript. Partial coverage is returned as data.

## Local qualification

Owning real PostgreSQL/HTTP tests cover stable generations, tenant RLS, exact live grant
bindings, logout/revocation, late consent acknowledgements, pending-withdrawal tombstones,
inline quota/dispatch barriers, owner-private status, deletion cleanup and byte bounds.
An exact signed transport regression verifies Workspace owner metadata uses body-free GET.
Existing Ingest regression tests still cover capture-only scheduling, ambiguous dispatch,
late transcript drain, stop/finalization, quotas and deleted-meeting rejection.

Production still requires real identity/key deployment, broker qualification, finalized
processing consumer and separate model admission, full-duration Meet/Zoom/Teams tests,
retention-policy verification and Azure operational qualification. A consent-ready state
is never advertised as live capture or generated-content proof.
