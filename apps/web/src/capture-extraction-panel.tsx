import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Api, ApiError, errorMessage } from "./api.js";
import {
  extractionMetadata,
  extractionDetail,
  validateExtractionScope,
  type ExtractionClaim,
} from "./capture-extraction-model.js";
import { useData } from "./ui.js";

export function CaptureExtractionPanel(props: {
  api: Api;
  workspaceId: string;
  meetingId: string;
  owner: boolean;
  onReview: (claim: ExtractionClaim, jobId: string, index: number) => void;
  onUnavailable: () => void;
}) {
  return props.owner ? (
    <OwnerPanel key={`${props.workspaceId}:${props.meetingId}`} {...props} />
  ) : null;
}
function OwnerPanel({
  api,
  workspaceId,
  meetingId,
  onReview,
  onUnavailable,
}: Parameters<typeof CaptureExtractionPanel>[0]) {
  const [revision, setRevision] = useState(0);
  const selectedId = useRef<string | null>(null);
  const base = `${api.scope(workspaceId)}/intelligence`;
  const data = useData(
    async (signal) => {
      try {
        // Bound the complete current-access read, not ten seconds per source/job.
        const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
        const list = await api.request(
          `${base}/meetings/${meetingId}/capture-extractions`,
          z.object({ jobs: z.array(extractionMetadata).max(100) }),
          { signal: requestSignal },
        );
        if (
          list.jobs.some((job) => job.meetingId !== meetingId) ||
          new Set(list.jobs.map((job) => job.id)).size !== list.jobs.length
        )
          throw new Error("EXTRACTION_SCOPE_MISMATCH");
        if (
          selectedId.current &&
          !list.jobs.some((job) => job.id === selectedId.current && job.status === "complete")
        ) {
          selectedId.current = null;
          if (!signal.aborted) onUnavailable();
        }
        // Sequential bounded reads avoid fan-out; metadata never substitutes for a current authorized result.
        const jobs = [];
        for (const job of list.jobs) {
          const detail =
            job.status === "complete"
              ? validateExtractionScope(
                  await api.request(`${base}/capture-extractions/${job.id}`, extractionDetail, {
                    signal: requestSignal,
                  }),
                  meetingId,
                )
              : { ...job, result: null };
          if (
            detail.id !== job.id ||
            detail.captureId !== job.captureId ||
            detail.transcriptRevision !== job.transcriptRevision
          )
            throw new Error("EXTRACTION_SCOPE_MISMATCH");
          jobs.push(detail);
        }
        return jobs;
      } catch (error) {
        if (!signal.aborted) onUnavailable();
        throw error;
      }
    },
    [api, base, meetingId, revision],
  );
  useEffect(() => {
    if (data.loading || data.error) return;
    const timer = setTimeout(() => setRevision((value) => value + 1), 10000);
    return () => clearTimeout(timer);
  }, [data.loading, data.error, revision]);
  return (
    <section aria-label="Automatic capture drafts">
      <h3>Automatic capture drafts</h3>
      <p>
        Private to the meeting owner. Processing consent being ready is not a completed summary.
        These are review-required drafts, not accepted facts or approved actions.
      </p>
      <button
        type="button"
        className="secondary"
        disabled={data.loading}
        onClick={() => {
          onUnavailable();
          setRevision((value) => value + 1);
        }}
      >
        Refresh automatic drafts
      </button>
      {data.loading ? <p role="status">Checking current automatic drafts…</p> : null}
      {data.error ? (
        <p
          role={
            data.error instanceof ApiError &&
            data.error.code === "CAPTURE_EXTRACTION_NOT_CONFIGURED"
              ? "status"
              : "alert"
          }
        >
          {data.error instanceof ApiError && data.error.code === "CAPTURE_EXTRACTION_NOT_CONFIGURED"
            ? "Automatic extraction is not enabled by the operator. Ordinary capture and manual summaries remain separate."
            : data.error instanceof ApiError && data.error.code === "SOURCE_CHANGED"
              ? "Source evidence changed. The old automatic draft was removed; wait for a current generation."
              : errorMessage(data.error)}{" "}
          No previous draft is shown after a failed current-access check.
        </p>
      ) : null}
      {!data.loading && !data.error && !data.value?.length ? (
        <p>
          No automatic extraction jobs yet. Finalized transcript, explicit owner consent and
          configured worker/model budget are required.
        </p>
      ) : null}
      {data.value?.map((job) => (
        <article className="panel" key={job.id} aria-label="Automatic extraction job">
          <p role="status">
            {job.status} · transcript revision {job.transcriptRevision}
          </p>
          <p>
            Capture {job.captureId} · draft {job.id}
          </p>
          {job.errorCode ? (
            <p>
              Processing did not complete ({job.errorCode}). Refresh checks status only; it does not
              start another paid model request.
            </p>
          ) : null}
          {job.status === "invalidated" ? (
            <p>Evidence changed; this draft cannot be reviewed.</p>
          ) : null}
          {job.result && job.status === "complete" ? (
            <>
              {job.result.partial ? (
                <p role="status">
                  Partial meeting evidence. Missing speech has not been reconstructed.
                </p>
              ) : null}
              {job.result.unsupported ? (
                <p>
                  {job.result.claims.length
                    ? "Some evidence did not support claims; supported excerpts below still require review."
                    : "No supported claims were found."}
                </p>
              ) : null}
              <ul>
                {job.result.claims.map((claim, index) => (
                  <li key={`${claim.citation.segmentId}:${index}`}>
                    <q>{claim.text}</q>
                    <p>
                      {claim.kind} proposal · segment {claim.citation.segmentId} · revision{" "}
                      {claim.citation.revision}
                    </p>
                    {claim.kind !== "discussion" ? (
                      <button
                        type="button"
                        onClick={() => {
                          selectedId.current = job.id;
                          onReview(claim, job.id, index);
                        }}
                      >
                        Review automatic {claim.kind}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </article>
      ))}
    </section>
  );
}
