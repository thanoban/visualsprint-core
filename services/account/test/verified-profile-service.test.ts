import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { VerifiedProfileService } from "../src/application/verified-profile.js";
test("Account profile service binds lookup to its persisted subject and never saves a forged subject or outage result", async () => {
  const actor = {
    workspaceId: randomUUID(),
    actorId: randomUUID(),
    sessionId: "notification:" + randomUUID(),
  };
  let saves = 0;
  const repository = {
    async begin() {
      return { subject: "user_StoredVerifiedSubject", sequence: 2 };
    },
    async save(
      _actor: typeof actor,
      sequence: number,
      profile: { subject: string; verifiedEmail: string | null; providerUpdatedAt: Date | null },
    ) {
      assert.equal(sequence, 2);
      saves++;
      return { verifiedEmail: profile.verifiedEmail };
    },
  };
  const good = new VerifiedProfileService(repository, {
    async lookup(subject) {
      assert.equal(subject, "user_StoredVerifiedSubject");
      return {
        subject,
        verifiedEmail: "verified@example.test",
        providerUpdatedAt: new Date("2026-10-13T00:00:00Z"),
      };
    },
  });
  assert.deepEqual(await good.forActor(actor), { verifiedEmail: "verified@example.test" });
  assert.equal(saves, 1);
  const forged = new VerifiedProfileService(repository, {
    async lookup() {
      return {
        subject: "user_Attacker",
        verifiedEmail: "wrong@example.test",
        providerUpdatedAt: null,
      };
    },
  });
  await assert.rejects(forged.forActor(actor), /PROFILE_RESPONSE_INVALID/);
  const unavailable = new VerifiedProfileService(repository, {
    async lookup() {
      throw new Error("PROVIDER_DOWN");
    },
  });
  await assert.rejects(unavailable.forActor(actor), /PROVIDER_DOWN/);
  await assert.rejects(good.forActor({ ...actor, operationGrantId: randomUUID() }), /FORBIDDEN/);
  assert.equal(saves, 1);
});
