import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AppError, type Actor } from "@visualsprint/platform";
import { WorkspaceExportContext } from "../../services/workspace/src/application/export-context.js";
import type { AgendaSnapshot } from "../../services/workspace/src/application/agendas.js";
import type { CommitmentsService } from "../../services/workspace/src/application/commitments.js";
import { workspaceExportContext } from "../../services/reporting/src/application/reviewed-context.js";
import {
  render,
  evidenceFingerprint,
  type Evidence,
} from "../../services/reporting/src/domain/export.js";

// These fixtures qualify application/serialization contracts, not persistence,
// network identity, admission to a real meeting or production provider behavior.
function fixture() {
  const actor: Actor = {
    workspaceId: randomUUID(),
    actorId: randomUUID(),
    sessionId: "offline-contract",
  };
  const meetingId = randomUUID(),
    captureId = randomUUID(),
    segmentId = randomUUID();
  const timestamp = "2026-10-15T00:00:00.000Z";
  type Reviewed = Awaited<ReturnType<CommitmentsService["list"]>>[number];
  const commitment: Reviewed = {
    workspaceId: actor.workspaceId,
    id: randomUUID(),
    meetingId,
    createdBy: actor.actorId,
    reviewedBy: actor.actorId,
    kind: "commitment",
    title: "Send the revised proposal",
    text: "Send the revised proposal",
    ownerId: null,
    dueDate: null,
    state: "open",
    version: 1,
    sourceMeetingVersion: 1,
    citations: [{ captureId, segmentId, revision: 1, captureVersion: 2, coverage: "partial" }],
    sourceFingerprint: "a".repeat(64),
    sourcePartial: true,
    proposalRef: null,
    humanCorrected: false,
    statusSource: "human_review",
    createdAt: timestamp,
    updatedAt: timestamp,
    evidenceStatus: "current",
    humanReviewed: true,
  };
  const snapshot: AgendaSnapshot = {
    meetingVersion: 1,
    accepted: [{ id: commitment.id, kind: "commitment", version: 1 }],
    agendas: [
      {
        id: randomUUID(),
        meetingId,
        title: "Review the offer",
        body: "Confirm the customer constraints before promising a date.",
        version: 1,
        reviewed: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  };
  let active = true,
    reviseDuringRead = false;
  const context = new WorkspaceExportContext(
    {
      async meeting(a, id) {
        if (
          !active ||
          a.actorId !== actor.actorId ||
          a.workspaceId !== actor.workspaceId ||
          id !== meetingId
        )
          throw new AppError("FORBIDDEN", 403);
        return { id: meetingId, ownerId: actor.actorId, version: snapshot.meetingVersion };
      },
    },
    {
      async snapshot() {
        return structuredClone(snapshot);
      },
    },
    {
      async list(_actor, kind, _scope, requireComplete) {
        assert.equal(requireComplete, true);
        if (kind === "decision") return [];
        if (reviseDuringRead) snapshot.accepted[0]!.version++;
        return [structuredClone(commitment)];
      },
    },
  );
  return {
    actor,
    meetingId,
    captureId,
    segmentId,
    commitment,
    snapshot,
    context,
    revoke() {
      active = false;
    },
    changeDuringRead() {
      reviseDuringRead = true;
    },
  };
}
test("native Workspace export projection satisfies strict Reporting contract without leaking internal accepted metadata", async () => {
  const f = fixture();
  const reviewed = workspaceExportContext.parse(await f.context.read(f.actor, f.meetingId));
  assert.equal(reviewed.complete, true);
  assert.equal(reviewed.commitments[0]!.sourcePartial, true);
  assert.equal(reviewed.commitments[0]!.dueDate, null);
  assert.equal(reviewed.agendas[0]!.reviewed, true);
  assert.equal("sourceFingerprint" in reviewed.commitments[0]!, false);
  assert.equal("createdBy" in reviewed.commitments[0]!, false);
  const evidence: Evidence = {
    meetingId: f.meetingId,
    version: 1,
    title: "Customer call",
    notes: "Owner notes",
    reviewed,
    captures: [
      {
        id: f.captureId,
        version: 2,
        state: "partial",
        coverage: "known_gaps",
        segments: [
          {
            id: f.segmentId,
            revision: 1,
            startMs: 0,
            endMs: 1000,
            text: f.commitment.text,
            speakerLabel: null,
          },
        ],
      },
    ],
  };
  const artifact = JSON.parse(render(evidence, "json"));
  assert.equal(artifact.schemaVersion, 2);
  assert.equal(artifact.reviewed.commitments[0].id, f.commitment.id);
  assert.equal(artifact.reviewed.agendas[0].body, reviewed.agendas[0]!.body);
  assert.equal(artifact.externalTaskVerification, "not_included");
  assert.equal(artifact.generatedDrafts, "not_included");
  assert.match(render(evidence, "text"), /External status: unknown/);
  const changed = structuredClone(evidence);
  changed.reviewed.agendas[0]!.body = "Owner correction";
  assert.notEqual(evidenceFingerprint(changed), evidenceFingerprint(evidence));
});
test("access loss, operation grants and changed accepted snapshots cannot produce a complete export", async () => {
  const f = fixture();
  await assert.rejects(
    f.context.read({ ...f.actor, operationGrantId: randomUUID() }, f.meetingId),
    /FORBIDDEN/,
  );
  f.changeDuringRead();
  await assert.rejects(f.context.read(f.actor, f.meetingId), /EXPORT_CONTEXT_CHANGED/);
  f.revoke();
  await assert.rejects(f.context.read(f.actor, f.meetingId), /FORBIDDEN/);
});
test("Reporting rejects foreign reviewed records, unreviewed agendas and invented task-verification fields", async () => {
  const f = fixture(),
    context = await f.context.read(f.actor, f.meetingId);
  assert.equal(workspaceExportContext.safeParse({ ...context, complete: false }).success, false);
  assert.equal(
    workspaceExportContext.safeParse({
      ...context,
      agendas: context.agendas.map((row) => ({ ...row, reviewed: false })),
    }).success,
    false,
  );
  assert.equal(
    workspaceExportContext.safeParse({
      ...context,
      commitments: context.commitments.map((row) => ({ ...row, meetingId: randomUUID() })),
    }).success,
    false,
  );
  assert.equal(
    workspaceExportContext.safeParse({
      ...context,
      commitments: context.commitments.map((row) => ({ ...row, externallyVerified: true })),
    }).success,
    false,
  );
});
