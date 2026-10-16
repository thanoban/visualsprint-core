# Automatic capture drafts and explicit review

The production meeting editor mounts the owner-only automatic draft panel inside its
reviewed decisions/commitments section. Shared readers do not request the private
Intelligence extraction APIs and cannot use the review form.

The panel reads `GET /intelligence/meetings/{meetingId}/capture-extractions` and loads
completed jobs using `GET /intelligence/capture-extractions/{jobId}`. Metadata or a
ready processing consent never substitutes for the current authorized result read.
It validates meeting/capture scope, finalized transcript revision, source versions,
review-required state and actual segment citations before rendering text. React renders
all model text as text, never HTML. Partial evidence remains visibly partial.

Queued/running, failed, invalidated, disabled and unavailable states stay distinct.
Polling runs ten seconds after each successful scoped read, with no overlapping polls
and a ten-second total read deadline. Refresh and polling perform GET requests only;
they never consent, dispatch capture or start/retry a model call. Failed current reads
remove previous drafts and automatic review selections. Scope/ownership changes remount
the form, abort old reads and clear old text, citations, responsibility and dates.

The owner can select a decision/commitment excerpt, supply a title, correct its text,
optionally confirm a responsible member/date, then check the existing exact-statement
review checkbox. Until explicit confirmation no accepted-record mutation occurs.
Acceptance uses the existing human-reviewed-evidence command with `proposal: null`:
the native Workspace proposal verifier currently recognizes manual summary jobs only.
The UI does not send an extraction job ID pretending it is a manual proposal. It shows
the extraction job ID/claim index during review; accepted records preserve the actual
capture/segment/revision evidence but do not currently persist automatic job provenance.
Workspace revalidates current meeting authority, optimistic version and source citations
before accepting the human record. This does not claim model verification or execute an
external action. Existing reviewed records are not overwritten by new model drafts.

Controlled unit/browser fixtures cover exact citation generation, unsafe text rendering,
explicit review gating, stale/revoked access, configuration-disabled processing,
read-only polling, owner/reader separation and workspace/meeting switches. These are
not proof of live model, broker, provider or Azure operation; Docker is not required for
these browser fixtures. Signed service/owning-database integration remains a separate gate.
