import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  databasePool,
  migrate,
  assertRuntimeRole,
  AppError,
  type Actor,
} from "@visualsprint/platform";
import { AccountService } from "../../src/application/account.js";
import { VerifiedProfileService } from "../../src/application/verified-profile.js";
import { PostgresAccount } from "../../src/infrastructure/store.js";
import { PostgresProfiles } from "../../src/infrastructure/profile-store.js";

// Activation is deliberately explicit. This suite never reads/applies migration-drafts.
const enabled = process.env.ACCOUNT_PROFILE_TEST_ENABLED === "true";
const migrations = databasePool(
  process.env.ACCOUNT_TEST_MIGRATION_URL ??
    "postgres://vs_account_migration:local-migration-only@127.0.0.1:55434/account",
  1,
);
const runtime = databasePool(
  process.env.ACCOUNT_TEST_DATABASE_URL ??
    "postgres://vs_account_runtime:local-runtime-only@127.0.0.1:55434/account",
  3,
);
const account = new AccountService(new PostgresAccount(runtime), "dev-cell");
const repository = new PostgresProfiles(runtime);
before(async () => {
  if (!enabled) return;
  await migrate(migrations, fileURLToPath(new URL("../../migrations", import.meta.url)));
  await assertRuntimeRole(runtime);
  const table = (await runtime.query("SELECT to_regclass('public.verified_profiles') AS relation"))
    .rows[0];
  assert.equal(
    table?.relation,
    "verified_profiles",
    "Activate and review Account 0004 before enabling profile integration tests",
  );
});
after(async () => {
  await runtime.end();
  await migrations.end();
});
async function fixture() {
  const identity = {
    subject: "user_Profile" + randomUUID().replaceAll("-", ""),
    sessionId: randomUUID(),
  };
  const owner = await account.me(identity);
  const workspace = await account.createWorkspace(identity, randomUUID(), {
    name: "Verified profile fixture",
  });
  const actor: Actor = {
    actorId: owner.userId,
    workspaceId: workspace.id,
    sessionId: "notification:" + randomUUID(),
  };
  return { identity, actor };
}
async function ownRow(actor: Actor) {
  const client = await runtime.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.actor_id',$1,true),set_config('app.workspace_id',$2,true)",
      [actor.actorId, actor.workspaceId],
    );
    const row = (
      await client.query("SELECT * FROM verified_profiles WHERE user_id=$1", [actor.actorId])
    ).rows[0];
    await client.query("COMMIT");
    return row;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

test(
  "verified profile projection derives provider subject from Account identity, supports ordinary logout and clears unverified destinations",
  { skip: !enabled },
  async () => {
    const f = await fixture();
    await account.logout(f.identity);
    let verified = true;
    let changed = new Date("2026-10-13T00:00:00Z");
    const service = new VerifiedProfileService(repository, {
      async lookup(subject) {
        assert.equal(subject, f.identity.subject);
        return {
          subject,
          verifiedEmail: verified ? "verified@example.test" : null,
          providerUpdatedAt: changed,
        };
      },
    });
    assert.deepEqual(await service.forActor(f.actor), { verifiedEmail: "verified@example.test" });
    assert.equal((await ownRow(f.actor)).subject, f.identity.subject);
    verified = false;
    changed = new Date("2026-10-13T00:01:00Z");
    assert.deepEqual(await service.forActor(f.actor), { verifiedEmail: null });
    const row = await ownRow(f.actor);
    assert.equal(row.verified_email, null);
    assert.equal(Number(row.request_sequence), Number(row.applied_sequence));
  },
);
test(
  "concurrent refresh fencing prevents a late verified result from replacing a newer unverified profile",
  { skip: !enabled },
  async () => {
    const f = await fixture();
    const [first, second] = await Promise.all([
      repository.begin(f.actor),
      repository.begin(f.actor),
    ]);
    const older = first.sequence < second.sequence ? first : second,
      newer = first.sequence < second.sequence ? second : first;
    await repository.save(f.actor, newer.sequence, {
      subject: f.identity.subject,
      verifiedEmail: null,
      providerUpdatedAt: new Date("2026-10-13T00:02:00Z"),
    });
    await assert.rejects(
      repository.save(f.actor, older.sequence, {
        subject: f.identity.subject,
        verifiedEmail: "late@example.test",
        providerUpdatedAt: new Date("2026-10-13T00:01:00Z"),
      }),
      /PROFILE_REFRESH_STALE/,
    );
    assert.equal((await ownRow(f.actor)).verified_email, null);
  },
);
test(
  "projection rejects provider revision regression/conflicting subject and never returns stored email during a provider outage",
  { skip: !enabled },
  async () => {
    const f = await fixture();
    const initial = await repository.begin(f.actor);
    await repository.save(f.actor, initial.sequence, {
      subject: f.identity.subject,
      verifiedEmail: "verified@example.test",
      providerUpdatedAt: new Date("2026-10-13T00:03:00Z"),
    });
    let next = await repository.begin(f.actor);
    await assert.rejects(
      repository.save(f.actor, next.sequence, {
        subject: f.identity.subject,
        verifiedEmail: "old@example.test",
        providerUpdatedAt: new Date("2026-10-13T00:02:00Z"),
      }),
      /PROFILE_SOURCE_REVISION_CONFLICT/,
    );
    next = await repository.begin(f.actor);
    await assert.rejects(
      repository.save(f.actor, next.sequence, {
        subject: "user_AnotherSubject",
        verifiedEmail: "wrong@example.test",
        providerUpdatedAt: new Date("2026-10-13T00:04:00Z"),
      }),
      /PROFILE_REFRESH_STALE/,
    );
    const unavailable = new VerifiedProfileService(repository, {
      async lookup() {
        throw new AppError("PROFILE_PROVIDER_UNAVAILABLE", 503);
      },
    });
    await assert.rejects(unavailable.forActor(f.actor), /PROFILE_PROVIDER_UNAVAILABLE/);
    assert.equal((await ownRow(f.actor)).verified_email, "verified@example.test");
  },
);
test(
  "membership revoked while provider lookup runs blocks publication and profile RLS cannot be widened by workspace context",
  { skip: !enabled },
  async () => {
    const owner = await fixture();
    const memberIdentity = {
      subject: "user_ProfileMember" + randomUUID().replaceAll("-", ""),
      sessionId: randomUUID(),
    };
    const member = await account.me(memberIdentity);
    const ownerActor = { ...owner.actor, sessionId: owner.identity.sessionId };
    await account.changeMember(ownerActor, randomUUID(), {
      userId: member.userId,
      active: true,
      expectedVersion: 0,
    });
    const actor: Actor = {
      actorId: member.userId,
      workspaceId: owner.actor.workspaceId,
      sessionId: "notification:" + randomUUID(),
    };
    const service = new VerifiedProfileService(repository, {
      async lookup(subject) {
        assert.equal(subject, memberIdentity.subject);
        await account.changeMember(ownerActor, randomUUID(), {
          userId: member.userId,
          active: false,
          expectedVersion: 1,
        });
        return {
          subject,
          verifiedEmail: "revoked@example.test",
          providerUpdatedAt: new Date("2026-10-13T00:05:00Z"),
        };
      },
    });
    await assert.rejects(service.forActor(actor), /FORBIDDEN/);
    assert.equal((await ownRow(actor)).verified_email, null);
    await assert.rejects(
      repository.begin({ ...owner.actor, workspaceId: randomUUID() }),
      /FORBIDDEN/,
    );
    const intent = await repository.begin(owner.actor);
    await repository.save(owner.actor, intent.sequence, {
      subject: owner.identity.subject,
      verifiedEmail: "private@example.test",
      providerUpdatedAt: new Date("2026-10-13T00:06:00Z"),
    });
    assert.equal(
      (
        await runtime.query("SELECT * FROM verified_profiles WHERE user_id=$1", [
          owner.actor.actorId,
        ])
      ).rowCount,
      0,
    );
    const client = await runtime.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.actor_id',$1,true),set_config('app.workspace_id',$2,true)",
        [member.userId, owner.actor.workspaceId],
      );
      assert.equal(
        (
          await client.query("SELECT * FROM verified_profiles WHERE user_id=$1", [
            owner.actor.actorId,
          ])
        ).rowCount,
        0,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
);
test(
  "configured Account notification capability publishes only self verified profiles and rechecks revocation after external lookup",
  { skip: !enabled },
  async () => {
    const owner = await fixture();
    let reads = 0;
    const profiles = new VerifiedProfileService(repository, {
      async lookup(subject) {
        reads++;
        return {
          subject,
          verifiedEmail: "verified@example.test",
          providerUpdatedAt: new Date("2026-10-13T00:10:00Z"),
        };
      },
    });
    const configured = new AccountService(new PostgresAccount(runtime), "dev-cell", profiles);
    await account.logout(owner.identity);
    assert.deepEqual(
      await configured.notificationMembership(owner.actor, { userId: owner.actor.actorId }),
      { active: true, verifiedEmail: "verified@example.test" },
    );
    await assert.rejects(
      configured.notificationMembership(owner.actor, { userId: randomUUID() }),
      /FORBIDDEN/,
    );
    assert.equal(reads, 1);
    const manager = await fixture();
    const recipientIdentity = {
      subject: "user_ProfileRecipient" + randomUUID().replaceAll("-", ""),
      sessionId: randomUUID(),
    };
    const recipient = await account.me(recipientIdentity);
    const managerActor = { ...manager.actor, sessionId: manager.identity.sessionId };
    await account.changeMember(managerActor, randomUUID(), {
      userId: recipient.userId,
      active: true,
      expectedVersion: 0,
    });
    const raced = new AccountService(new PostgresAccount(runtime), "dev-cell", {
      async forActor(actor) {
        assert.equal(actor.actorId, recipient.userId);
        await account.changeMember(managerActor, randomUUID(), {
          userId: recipient.userId,
          active: false,
          expectedVersion: 1,
        });
        return { verifiedEmail: "must-not-publish@example.test" };
      },
    });
    await assert.rejects(
      raced.notificationMembership(
        {
          workspaceId: manager.actor.workspaceId,
          actorId: recipient.userId,
          sessionId: "notification:" + randomUUID(),
        },
        { userId: recipient.userId },
      ),
      /FORBIDDEN/,
    );
  },
);
