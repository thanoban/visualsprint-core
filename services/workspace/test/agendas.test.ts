import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AppError, type Actor } from "@visualsprint/platform";
import {
  AgendasService,
  createAgenda,
  updateAgenda,
  type AgendaDTO,
  type AgendaSnapshot,
  type AgendaStore,
} from "../src/application/agendas.js";
import { WorkspaceExportContext } from "../src/application/export-context.js";
import type { CommitmentsService } from "../src/application/commitments.js";
const actor: Actor = { workspaceId: randomUUID(), actorId: randomUUID(), sessionId: "agenda-unit" },
  meetingId = randomUUID();
const agenda: AgendaDTO = {
  id: randomUUID(),
  meetingId,
  title: "Reviewed next steps",
  body: "Discuss the revised offer.",
  version: 1,
  reviewed: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
const fixture = () => {
  let active = true,
    version = 1,
    reads = 0;
  const snapshot: AgendaSnapshot = { meetingVersion: 1, agendas: [agenda], accepted: [] };
  const authority = {
    async manageContext(a: Actor) {
      if (!active || a.actorId !== actor.actorId) throw new AppError("FORBIDDEN", 403);
      return { meetingId, ownerId: actor.actorId };
    },
    async meeting() {
      reads++;
      if (!active) throw new AppError("FORBIDDEN", 403);
      return { id: meetingId, ownerId: actor.actorId, version };
    },
  };
  const store: AgendaStore = {
    async command() {
      return agenda;
    },
    async snapshot() {
      return structuredClone(snapshot);
    },
  };
  return {
    authority,
    store,
    snapshot,
    get reads() {
      return reads;
    },
    set active(v: boolean) {
      active = v;
    },
    set version(v: number) {
      version = v;
    },
  };
};
test("agenda schemas require explicit human confirmation and reject draft/proposal metadata", () => {
  assert.throws(() => createAgenda.parse({ title: "x", body: "y", expectedMeetingVersion: 1 }));
  assert.throws(() =>
    createAgenda.parse({
      title: "x",
      body: "y",
      expectedMeetingVersion: 1,
      confirmed: true,
      generated: true,
    }),
  );
  assert.throws(() =>
    updateAgenda.parse({ title: "x", body: "y", expectedMeetingVersion: 1, confirmed: true }),
  );
  assert.throws(() =>
    createAgenda.parse({
      title: "x",
      body: " ".repeat(20),
      expectedMeetingVersion: 1,
      confirmed: true,
    }),
  );
  assert.equal(
    createAgenda.parse({ title: " x ", body: " y ", expectedMeetingVersion: 1, confirmed: true })
      .body,
    "y",
  );
});
test("normal actors only; operation-prefixed actors rejected even without grant property", async () => {
  const f = fixture(),
    service = new AgendasService(f.store, f.authority);
  for (const principal of [
    { ...actor, operationGrantId: randomUUID() },
    { ...actor, sessionId: `operation:${randomUUID()}` },
  ])
    await assert.rejects(service.list(principal, meetingId), /FORBIDDEN/);
  await assert.rejects(
    service.mutate({ ...actor, actorId: randomUUID() }, meetingId, randomUUID(), "create", {
      title: "x",
      body: "y",
      expectedMeetingVersion: 1,
      confirmed: true,
    }),
    /FORBIDDEN/,
  );
});
test("agenda read rejects changed meeting version and access revocation before publication", async () => {
  const f = fixture();
  f.snapshot.meetingVersion = 2;
  await assert.rejects(
    new AgendasService(f.store, f.authority).list(actor, meetingId),
    /AGENDA_CONTEXT_CHANGED/,
  );
  const g = fixture();
  g.store.snapshot = async () => {
    g.active = false;
    return g.snapshot;
  };
  await assert.rejects(
    new AgendasService(g.store, g.authority).list(actor, meetingId),
    /FORBIDDEN/,
  );
});
test("view permission alone never authorizes owner agenda writes when manage policy denies", async () => {
  const f = fixture();
  let writes = 0;
  f.authority.manageContext = async () => {
    throw new AppError("NOT_FOUND", 404);
  };
  f.store.command = async () => {
    writes++;
    return agenda;
  };
  await assert.rejects(
    new AgendasService(f.store, f.authority).mutate(actor, meetingId, randomUUID(), "create", {
      title: "x",
      body: "y",
      confirmed: true,
      expectedMeetingVersion: 1,
    }),
    /NOT_FOUND/,
  );
  assert.equal(writes, 0);
});
test("export context is exact, bounded and requests complete accepted lists", async () => {
  const f = fixture(),
    seen: boolean[] = [];
  const records: Pick<CommitmentsService, "list"> = {
    async list(_a, _k, _b, complete) {
      seen.push(complete === true);
      return [];
    },
  };
  const result = await new WorkspaceExportContext(f.authority, f.store, records).read(
    actor,
    meetingId,
  );
  assert.deepEqual(
    Object.keys(result).sort(),
    [
      "schemaVersion",
      "complete",
      "meetingId",
      "meetingVersion",
      "decisions",
      "commitments",
      "agendas",
    ].sort(),
  );
  assert.equal(result.complete, true);
  assert.deepEqual(result.agendas, [agenda]);
  assert.deepEqual(seen, [true, true]);
  assert.equal(f.reads, 2);
});
test("export refuses missing accepted rows, revision changes and operation identities", async () => {
  const f = fixture();
  f.snapshot.accepted = [{ id: randomUUID(), kind: "decision", version: 1 }];
  const records: Pick<CommitmentsService, "list"> = {
    async list() {
      return [];
    },
  };
  await assert.rejects(
    new WorkspaceExportContext(f.authority, f.store, records).read(actor, meetingId),
    /EXPORT_CONTEXT_CHANGED/,
  );
  const g = fixture();
  let calls = 0;
  g.store.snapshot = async () => ({ ...g.snapshot, meetingVersion: ++calls });
  await assert.rejects(
    new WorkspaceExportContext(g.authority, g.store, records).read(actor, meetingId),
    /EXPORT_CONTEXT_CHANGED/,
  );
  await assert.rejects(
    new WorkspaceExportContext(f.authority, f.store, records).read(
      { ...actor, sessionId: "operation:fake" },
      meetingId,
    ),
    /FORBIDDEN/,
  );
});
test("export never silently truncates oversized reviewed text", async () => {
  const f = fixture();
  f.snapshot.agendas = Array.from({ length: 100 }, (_, i) => ({
    ...agenda,
    id: randomUUID(),
    body: "x".repeat(32000),
    title: String(i),
  }));
  await assert.rejects(
    new WorkspaceExportContext(f.authority, f.store, {
      async list() {
        return [];
      },
    }).read(actor, meetingId),
    /EXPORT_CONTEXT_TOO_LARGE/,
  );
});
