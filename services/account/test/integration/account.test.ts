import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { assertRuntimeRole, databasePool, migrate, type Actor } from "@visualsprint/platform";
import { PostgresAccount } from "../../src/infrastructure/store.js";
import { AccountService } from "../../src/application/account.js";
const migrations = databasePool(
  process.env.ACCOUNT_TEST_MIGRATION_URL ??
    "postgres://vs_account_migration:local-migration-only@127.0.0.1:55434/account",
  1,
);
const runtime = databasePool(
  process.env.ACCOUNT_TEST_DATABASE_URL ??
    "postgres://vs_account_runtime:local-runtime-only@127.0.0.1:55434/account",
  2,
);
const account = new AccountService(new PostgresAccount(runtime), "dev-cell");
const alice = { subject: `user_${randomUUID().replaceAll("-", "")}`, sessionId: randomUUID() };
const bob = { subject: `user_${randomUUID().replaceAll("-", "")}`, sessionId: randomUUID() };
before(async () => {
  await migrate(migrations, fileURLToPath(new URL("../../migrations", import.meta.url)));
  await assertRuntimeRole(runtime);
});
test("notification membership is self-recipient-only, survives logout, but current revocation blocks delivery", async () => {
  const ownerIdentity = {
      subject: `user_${randomUUID().replaceAll("-", "")}`,
      sessionId: randomUUID(),
    },
    recipientIdentity = {
      subject: `user_${randomUUID().replaceAll("-", "")}`,
      sessionId: randomUUID(),
    };
  const recipient = await account.me(recipientIdentity),
    owner = await account.me(ownerIdentity),
    ws = await account.createWorkspace(ownerIdentity, randomUUID(), {
      name: "Notification authority",
    });
  const actor = { workspaceId: ws.id, actorId: owner.userId, sessionId: ownerIdentity.sessionId };
  await account.changeMember(actor, randomUUID(), {
    userId: recipient.userId,
    active: true,
    expectedVersion: 0,
  });
  const deliveryActor = {
    workspaceId: ws.id,
    actorId: recipient.userId,
    sessionId: `notification:${randomUUID()}`,
  };
  await account.logout(recipientIdentity);
  assert.deepEqual(
    await account.notificationMembership(deliveryActor, { userId: recipient.userId }),
    { active: true, verifiedEmail: null },
  );
  await assert.rejects(
    () => account.notificationMembership(deliveryActor, { userId: owner.userId }),
    /FORBIDDEN/,
  );
  await account.changeMember(actor, randomUUID(), {
    userId: recipient.userId,
    active: false,
    expectedVersion: 1,
  });
  await assert.rejects(
    account.notificationMembership(deliveryActor, { userId: recipient.userId }),
    /FORBIDDEN/,
  );
});
after(async () => {
  await runtime.end();
  await migrations.end();
});
test("identity mapping and workspace create are idempotent across concurrent requests", async () => {
  const users = await Promise.all(Array.from({ length: 4 }, () => account.me(alice)));
  assert.equal(new Set(users.map((user) => user.userId)).size, 1);
  const key = randomUUID();
  const workspaces = await Promise.all(
    Array.from({ length: 4 }, () =>
      account.createWorkspace(alice, key, { name: "Founder workspace" }),
    ),
  );
  assert.equal(new Set(workspaces.map((workspace) => workspace.id)).size, 1);
  await assert.rejects(
    () => account.createWorkspace(alice, key, { name: "Changed" }),
    /IDEMPOTENCY_CONFLICT/,
  );
  assert.equal(
    (await account.me(alice)).workspaces.some((workspace) => workspace.id === workspaces[0]!.id),
    true,
  );
  assert.equal((await account.me(bob)).workspaces.length, 0);
  assert.equal((await runtime.query("SELECT * FROM memberships")).rowCount, 0);
});
test("current membership and session revocation override previously issued delegation", async () => {
  const owner = await account.me(alice);
  const member = await account.me(bob);
  const workspace = await account.createWorkspace(alice, randomUUID(), { name: "Customer calls" });
  const actor: Actor = {
    actorId: owner.userId,
    workspaceId: workspace.id,
    sessionId: alice.sessionId,
  };
  const delegated: Actor = {
    actorId: member.userId,
    workspaceId: workspace.id,
    sessionId: bob.sessionId,
  };
  await assert.rejects(() => account.directory(delegated), /FORBIDDEN/);
  const granted = await account.changeMember(actor, randomUUID(), {
    userId: member.userId,
    active: true,
    expectedVersion: 0,
  });
  assert.deepEqual(await account.checkMember(delegated, member.userId), { active: true });
  assert.equal((await account.directory(delegated)).cellId, "dev-cell");
  await assert.rejects(
    () =>
      account.changeMember(delegated, randomUUID(), {
        userId: owner.userId,
        active: false,
        expectedVersion: 1,
      }),
    /FORBIDDEN/,
  );
  await account.changeMember(actor, randomUUID(), {
    userId: member.userId,
    active: false,
    expectedVersion: granted.version,
  });
  await assert.rejects(() => account.directory(delegated), /FORBIDDEN/);
  await assert.rejects(
    () =>
      account.changeMember(actor, randomUUID(), {
        userId: owner.userId,
        active: false,
        expectedVersion: 1,
      }),
    /FORBIDDEN/,
  );
  await account.logout(alice);
  await assert.rejects(() => account.directory(actor), /UNAUTHENTICATED/);
  await assert.rejects(() => account.me(alice), /UNAUTHENTICATED/);
});
