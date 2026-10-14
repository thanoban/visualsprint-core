import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { generateKeyPair, exportJWK } from "jose";
import {
  databasePool,
  migrate,
  assertRuntimeRole,
  ServiceIdentity,
  serviceToken,
  type Actor,
} from "@visualsprint/platform";
import { PostgresAccount } from "../../src/infrastructure/store.js";
import { AccountService } from "../../src/application/account.js";
import { PostgresCaptureConsents } from "../../src/infrastructure/capture-consent-store.js";
import { CaptureConsentService } from "../../src/application/capture-consent.js";
import { accountApp } from "../../src/http/app.js";
const migration = databasePool(
  process.env.ACCOUNT_TEST_MIGRATION_URL ??
    "postgres://vs_account_migration:local-migration-only@127.0.0.1:55434/account",
  1,
);
const pool = databasePool(
  process.env.ACCOUNT_TEST_DATABASE_URL ??
    "postgres://vs_account_runtime:local-runtime-only@127.0.0.1:55434/account",
  3,
);
const account = new AccountService(new PostgresAccount(pool), "dev-cell"),
  repository = new PostgresCaptureConsents(pool);
before(async () => {
  await migrate(migration, fileURLToPath(new URL("../../migrations", import.meta.url)));
  await assertRuntimeRole(pool);
});
after(async () => {
  await pool.end();
  await migration.end();
});
async function fixture() {
  const identity = { subject: `user_${randomUUID().replaceAll("-", "")}`, sessionId: randomUUID() },
    memberIdentity = {
      subject: `user_${randomUUID().replaceAll("-", "")}`,
      sessionId: randomUUID(),
    };
  const owner = await account.me(identity),
    member = await account.me(memberIdentity),
    workspace = await account.createWorkspace(identity, randomUUID(), {
      name: "Narrow capture consent",
    });
  const admin: Actor = {
      workspaceId: workspace.id,
      actorId: owner.userId,
      sessionId: identity.sessionId,
    },
    actor: Actor = {
      workspaceId: workspace.id,
      actorId: member.userId,
      sessionId: memberIdentity.sessionId,
    };
  await account.changeMember(admin, randomUUID(), {
    userId: actor.actorId,
    active: true,
    expectedVersion: 0,
  });
  const captureId = randomUUID(),
    meetingId = randomUUID();
  let wrongOwner = false;
  const service = new CaptureConsentService(repository, {
    async read(_actor, id) {
      return {
        captureId: id,
        meetingId,
        ownerId: wrongOwner ? randomUUID() : actor.actorId,
        policyVersion: "english-text-v1",
        optedIn: true,
      };
    },
  });
  return {
    actor,
    admin,
    identity,
    memberIdentity,
    service,
    captureId,
    meetingId,
    set wrongOwner(value: boolean) {
      wrongOwner = value;
    },
  };
}
test("capture consent requires explicit current owned context and is immutable/idempotent across concurrent creates", async () => {
  const f = await fixture(),
    key = randomUUID(),
    input = { captureId: f.captureId, consent: true, policyVersion: "english-text-v1" };
  const grants = await Promise.all(
    Array.from({ length: 6 }, () => f.service.create(f.actor, key, input)),
  );
  assert.equal(new Set(grants.map((row) => row.consentId)).size, 1);
  assert.equal((await f.service.list(f.actor, f.captureId)).consents.length, 1);
  await assert.rejects(
    f.service.create(f.actor, key, { ...input, captureId: randomUUID() }),
    /IDEMPOTENCY_CONFLICT/,
  );
  await assert.rejects(f.service.create(f.actor, randomUUID(), { ...input, consent: false }));
  f.wrongOwner = true;
  await assert.rejects(f.service.create(f.actor, randomUUID(), input), /OWNER_MISMATCH/);
  assert.equal((await pool.query("SELECT * FROM capture_processing_consents")).rows.length, 0);
});
test("background consent survives logout but rejects generic membership, foreign capture and member revocation", async () => {
  const f = await fixture(),
    grant = await f.service.create(f.actor, randomUUID(), {
      captureId: f.captureId,
      consent: true,
      policyVersion: "english-text-v1",
    });
  const actor = {
      ...f.actor,
      operationGrantId: grant.consentId,
      sessionId: `operation:${grant.consentId}`,
    },
    binding = {
      consentId: grant.consentId,
      expectedVersion: 1,
      meetingId: f.meetingId,
      captureId: f.captureId,
      policyVersion: "english-text-v1",
    };
  await account.logout(f.memberIdentity);
  assert.equal((await f.service.authorize(actor, binding)).active, true);
  await assert.rejects(f.service.list(f.actor), /FORBIDDEN/);
  await assert.rejects(account.checkMember(actor, actor.actorId), /FORBIDDEN/);
  await assert.rejects(
    f.service.authorize(actor, { ...binding, captureId: randomUUID() }),
    /FORBIDDEN/,
  );
  await assert.rejects(
    f.service.authorize({ ...actor, actorId: f.admin.actorId }, binding),
    /FORBIDDEN/,
  );
  await account.changeMember(f.admin, randomUUID(), {
    userId: f.actor.actorId,
    active: false,
    expectedVersion: 1,
  });
  await assert.rejects(f.service.authorize(actor, binding), /FORBIDDEN/);
});
test("owner withdrawal and deletion tombstones fence grants without granting other capabilities", async () => {
  const f = await fixture(),
    grant = await f.service.create(f.actor, randomUUID(), {
      captureId: f.captureId,
      consent: true,
      policyVersion: "english-text-v1",
    });
  const key = randomUUID();
  const withdrawn = await f.service.revoke(f.actor, key, grant.consentId, { expectedVersion: 1 });
  assert.equal(withdrawn.active, false);
  assert.equal(withdrawn.version, 2);
  assert.equal(
    (await f.service.revoke(f.actor, key, grant.consentId, { expectedVersion: 1 })).version,
    2,
  );
  await assert.rejects(
    f.service.revoke(f.actor, randomUUID(), grant.consentId, { expectedVersion: 1 }),
    /VERSION_CONFLICT/,
  );
  await assert.rejects(
    f.service.create(f.actor, randomUUID(), {
      captureId: f.captureId,
      consent: true,
      policyVersion: "english-text-v1",
    }),
    /CONSENT_WITHDRAWN/,
  );
  const deletionId = randomUUID();
  await f.service.cleanup(f.actor.workspaceId, deletionId, {
    meetingId: f.meetingId,
    sourceVersion: 3,
  });
  await f.service.cleanup(f.actor.workspaceId, deletionId, {
    meetingId: f.meetingId,
    sourceVersion: 3,
  });
  await assert.rejects(
    f.service.cleanup(f.actor.workspaceId, deletionId, {
      meetingId: randomUUID(),
      sourceVersion: 3,
    }),
    /DELETION_CONFLICT/,
  );
  await assert.rejects(
    f.service.create(f.actor, randomUUID(), {
      captureId: randomUUID(),
      consent: true,
      policyVersion: "english-text-v1",
    }),
    /SOURCE_DELETED/,
  );
});
test("only pinned dedicated callers can create/authorize/cleanup capture consents", async () => {
  const f = await fixture(),
    keys = await generateKeyPair("EdDSA"),
    publicKey = { ...(await exportJWK(keys.publicKey)), kid: "fixture" };
  const identity = new ServiceIdentity("account", {
    ingest: [publicKey],
    intelligence: [publicKey],
    gateway: [publicKey],
    workspace: [publicKey],
  });
  const app = accountApp(account, async () => f.identity, identity, undefined, f.service);
  const token = (
    caller: "ingest" | "intelligence" | "gateway" | "workspace",
    actor: Actor = f.actor,
  ) =>
    serviceToken({
      caller,
      audience: "account",
      actor,
      privateKey: keys.privateKey,
      keyId: "fixture",
    });
  const path = `/internal/workspaces/${f.actor.workspaceId}/capture-processing`;
  try {
    const denied = await app.inject({
      method: "POST",
      url: `${path}/consents`,
      headers: {
        authorization: `Bearer ${await token("gateway")}`,
        "idempotency-key": randomUUID(),
      },
      payload: { captureId: f.captureId, consent: true, policyVersion: "english-text-v1" },
    });
    assert.equal(denied.statusCode, 403);
    const created = await app.inject({
      method: "POST",
      url: `${path}/consents`,
      headers: {
        authorization: `Bearer ${await token("ingest")}`,
        "idempotency-key": randomUUID(),
      },
      payload: { captureId: f.captureId, consent: true, policyVersion: "english-text-v1" },
    });
    assert.equal(created.statusCode, 200);
    const grant = created.json(),
      actor = {
        ...f.actor,
        operationGrantId: grant.consentId,
        sessionId: `operation:${grant.consentId}`,
      };
    const proof = {
      consentId: grant.consentId,
      expectedVersion: 1,
      meetingId: f.meetingId,
      captureId: f.captureId,
      policyVersion: "english-text-v1",
    };
    const allowed = await app.inject({
      method: "POST",
      url: `${path}/authorize`,
      headers: { authorization: `Bearer ${await token("intelligence", actor)}` },
      payload: proof,
    });
    assert.equal(allowed.statusCode, 200);
    const normal = await app.inject({
      method: "POST",
      url: `${path}/authorize`,
      headers: { authorization: `Bearer ${await token("gateway", actor)}` },
      payload: proof,
    });
    assert.equal(normal.statusCode, 403);
    const generic = await app.inject({
      method: "POST",
      url: `/internal/workspaces/${f.actor.workspaceId}/membership`,
      headers: { authorization: `Bearer ${await token("intelligence", actor)}` },
      payload: { userId: f.actor.actorId },
    });
    assert.equal(generic.statusCode, 403);
    const deniedCleanup = await app.inject({
      method: "POST",
      url: `${path}/deletions/${randomUUID()}`,
      headers: { authorization: `Bearer ${await token("gateway")}` },
      payload: { meetingId: f.meetingId, sourceVersion: 1 },
    });
    assert.equal(deniedCleanup.statusCode, 403);
  } finally {
    await app.close();
  }
});
test("pending withdrawal blocks late grant creation and revokes a resolved grant after logout", async () => {
  const pending = await fixture();
  const stopped = await pending.service.withdrawalCleanup(pending.actor, {
    captureId: pending.captureId,
    meetingId: pending.meetingId,
    policyVersion: "english-text-v1",
  });
  assert.equal(stopped.consentId, null);
  assert.equal(stopped.creationBlocked, true);
  await assert.rejects(
    pending.service.create(pending.actor, randomUUID(), {
      captureId: pending.captureId,
      consent: true,
      policyVersion: "english-text-v1",
    }),
    /CONSENT_WITHDRAWN/,
  );
  const late = await fixture(),
    grant = await late.service.create(late.actor, randomUUID(), {
      captureId: late.captureId,
      consent: true,
      policyVersion: "english-text-v1",
    });
  await account.logout(late.memberIdentity);
  const withdrawn = await late.service.withdrawalCleanup(late.actor, {
    captureId: late.captureId,
    meetingId: late.meetingId,
    policyVersion: "english-text-v1",
  });
  assert.equal(withdrawn.consentId, grant.consentId);
  assert.equal(withdrawn.active, false);
  assert.equal(withdrawn.version, 2);
  await assert.rejects(
    late.service.authorize(
      {
        ...late.actor,
        operationGrantId: grant.consentId,
        sessionId: `operation:${grant.consentId}`,
      },
      {
        consentId: grant.consentId,
        expectedVersion: 1,
        meetingId: late.meetingId,
        captureId: late.captureId,
        policyVersion: "english-text-v1",
      },
    ),
    /FORBIDDEN/,
  );
  await assert.rejects(
    late.service.withdrawalCleanup(
      { ...late.actor, actorId: randomUUID() },
      { captureId: late.captureId, meetingId: late.meetingId, policyVersion: "english-text-v1" },
    ),
    /CONSENT_BINDING_CONFLICT/,
  );
});
