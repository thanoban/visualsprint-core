import { useRef, useEffect, useState } from "react";
import { z } from "zod";
import { Api, errorMessage } from "./api.js";
import { useCommand } from "./ui.js";
export const captureProcessingSchema = z.object({
  state: z.enum([
    "consent_pending",
    "ready",
    "disabled",
    "revoked",
    "configuration_error",
    "withdraw_requested",
  ]),
  intentVersion: z.number().int().positive(),
  consentId: z.string().uuid().nullable(),
  consentVersion: z.number().int().positive().nullable(),
  policyVersion: z.literal("english-text-v1"),
  transcriptRevision: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
});
type Processing = z.infer<typeof captureProcessingSchema>;
type Props = {
  api: Api;
  workspaceId: string;
  captureId: string;
  owner: boolean;
  processing: Processing | null | undefined;
  onChanged: () => void;
};
export function CaptureProcessingControls(props: Props) {
  return <Controls key={`${props.workspaceId}:${props.captureId}`} {...props} />;
}
function Controls({ api, workspaceId, captureId, owner, processing, onChanged }: Props) {
  const [confirmed, setConfirmed] = useState(false),
    enable = useCommand(),
    withdraw = useCommand(),
    abort = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    return () => controller.abort();
  }, [api]);
  const path = `${api.scope(workspaceId)}/captures/${captureId}/processing-consent`,
    state = processing?.state ?? (processing === null ? "disabled" : "unavailable");
  return (
    <section className="panel" aria-label="Automatic transcript processing">
      <h4>Automatic English transcript processing</h4>
      <p>
        Separate from capture and calendar consent. Analysis uses the configured AI provider and
        model budget after finalized text; it does not accept decisions, execute tasks or share the
        meeting.
      </p>
      <p role="status">
        Processing consent: {state.replaceAll("_", " ")}
        {processing?.errorCode ? ` · ${processing.errorCode}` : ""}.
      </p>
      {state === "consent_pending" ? (
        <p>
          Consent setup is pending. Dispatch is blocked until the request is resolved; this is not a
          ready worker or a completed summary.
        </p>
      ) : null}
      {state === "ready" ? (
        <p>
          Scoped consent is ready. Work still requires finalized transcript evidence and a
          configured processing worker; this is not proof that a summary exists.
        </p>
      ) : null}
      {state === "withdraw_requested" ? (
        <p>
          Withdrawal is recorded; processing and dispatch remain blocked while any in-flight grant
          creation is reconciled. Do not request a replacement.
        </p>
      ) : null}
      {state === "configuration_error" ? (
        <p>
          Processing setup needs an administrator correction. Requested processing has not silently
          switched to ordinary capture.
        </p>
      ) : null}
      {state === "revoked" ? (
        <p>
          Automatic processing permission is withdrawn. Ordinary capture may continue under its
          existing permission; stopping capture is a separate command. Existing transcript or
          reviewed data is not deleted by withdrawal. Withdrawal is permanent for this capture; use
          a new capture to opt in again.
        </p>
      ) : null}
      {state === "unavailable" ? (
        <p>
          Processing status is unavailable. No consent command is offered until current status is
          verified.
        </p>
      ) : null}
      {processing ? (
        <p>
          Intent revision {processing.intentVersion}; finalized transcript revision{" "}
          {processing.transcriptRevision}.
        </p>
      ) : null}
      {owner && processing === null ? (
        <>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              disabled={enable.busy}
            />
            I explicitly authorize automatic English transcript processing for this capture using
            the configured AI budget.
          </label>
          <button
            type="button"
            disabled={!confirmed || enable.busy}
            onClick={() =>
              void enable.run(
                { captureId, consent: true, policyVersion: "english-text-v1" },
                (key) =>
                  api.request(path, captureProcessingSchema, {
                    method: "POST",
                    key,
                    body: { consent: true, policyVersion: "english-text-v1" },
                    signal: abort.current.signal,
                  }),
                () => {
                  setConfirmed(false);
                  onChanged();
                },
              )
            }
          >
            Enable processing for this capture
          </button>
        </>
      ) : null}
      {owner &&
      processing &&
      ["consent_pending", "ready", "configuration_error"].includes(state) ? (
        <button
          type="button"
          disabled={withdraw.busy}
          onClick={() =>
            void withdraw.run(
              { captureId, expectedIntentVersion: processing.intentVersion },
              (key) =>
                api.request(`${path}/withdraw`, captureProcessingSchema, {
                  method: "POST",
                  key,
                  body: { expectedIntentVersion: processing.intentVersion },
                  signal: abort.current.signal,
                }),
              () => onChanged(),
            )
          }
        >
          Withdraw automatic processing
        </button>
      ) : null}
      {enable.error ? (
        <p role="alert">
          {errorMessage(enable.error)} No processing readiness is assumed from an unconfirmed
          response.
        </p>
      ) : null}
      {withdraw.error ? (
        <p role="alert">
          {errorMessage(withdraw.error)} Withdrawal is not confirmed; refresh the current intent
          before changing capture.
        </p>
      ) : null}
    </section>
  );
}
