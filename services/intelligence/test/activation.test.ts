import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { generateKeyPair } from "jose";
import { AppError } from "@visualsprint/platform";
import {
  intelligenceFeatureConfig,
  validateFeatures,
} from "../src/infrastructure/feature-config.js";
import { IntelligenceInternalClient } from "../src/infrastructure/internal-client.js";
import { AuthorizedPreparationContext } from "../src/infrastructure/preparation-context.js";
import { admittedGeneration } from "../src/application/model-usage.js";
import type { ModelUsageAdmission } from "../src/application/preparation-jobs.js";
const actor = { workspaceId: randomUUID(), actorId: randomUUID(), sessionId: "owner-session" };
test("native features default disabled and reject model bypass, missing extension and false-string coercion", () => {
  const defaults = intelligenceFeatureConfig.parse({});
  assert.equal(defaults.INTELLIGENCE_RETRIEVAL_ENABLED, false);
  validateFeatures(defaults, { vector: false, extension: false, preparation: false }, false);
  assert.throws(
    () => validateFeatures(defaults, { vector: true, extension: true, preparation: true }, true),
    /MODEL_ADMISSION_REQUIRED/,
  );
  const enabled = intelligenceFeatureConfig.parse({
    INTELLIGENCE_RETRIEVAL_ENABLED: "true",
    INTELLIGENCE_MODEL_ADMISSION_ENABLED: "true",
    AZURE_OPENAI_EMBEDDING_DEPLOYMENT: "small",
  });
  assert.throws(
    () => validateFeatures(enabled, { vector: true, extension: false, preparation: true }, true),
    /RETRIEVAL_CONFIGURATION_INCOMPLETE/,
  );
  assert.equal(
    intelligenceFeatureConfig.parse({ INTELLIGENCE_RETRIEVAL_ENABLED: "false" })
      .INTELLIGENCE_RETRIEVAL_ENABLED,
    false,
  );
  assert.throws(() => intelligenceFeatureConfig.parse({ INTELLIGENCE_PREPARATION_ENABLED: "1" }));
});
test("signed preparation context preserves human facts, excludes target and never fabricates verified completion", async () => {
  const { privateKey } = await generateKeyPair("EdDSA"),
    target = randomUUID(),
    history = randomUUID();
  const input = {
    meetingId: target,
    historyScope: { kind: "customer" as const, id: randomUUID() },
    confirmedScope: true as const,
  };
  let malformed = false;
  const client = new IntelligenceInternalClient(
    "http://127.0.0.1:1",
    "workspace",
    privateKey,
    "fixture",
    async (url, options) => {
      assert.equal(
        new URL(String(url)).pathname,
        `/internal/workspaces/${actor.workspaceId}/preparation-context`,
      );
      assert.deepEqual(JSON.parse(String(options?.body)), input);
      return Response.json({
        target: { id: target, version: 3, title: "Next call" },
        history: {
          scope: input.historyScope,
          meetings: [{ id: malformed ? target : history, version: 2, title: "Selected history" }],
        },
        decisions: [],
        commitments: [
          {
            id: randomUUID(),
            meetingId: history,
            version: 2,
            title: "Deliver".padEnd(250, "x"),
            text: "Ship accepted change",
            state: "completed",
            ownerId: actor.actorId,
            dueDate: "2026-11-01",
            statusSource: "human_review",
            updatedAt: new Date().toISOString(),
            citations: [],
            evidenceStatus: "changed",
            sourcePartial: true,
            externalStatus: "unknown",
            externalVerifiedAt: null,
          },
        ],
      });
    },
  );
  const context = new AuthorizedPreparationContext(client).forInput(input);
  assert.deepEqual(await context.authorizeScope(actor, input.historyScope), {
    meetings: [{ id: history, version: 2 }],
  });
  const accepted = await context.commitments(actor, input.historyScope);
  assert.equal(accepted[0]!.state, "done");
  assert.equal(accepted[0]!.verifiedAt, null);
  const records = await context.records(actor, input.historyScope);
  assert.equal(records[0]!.statusSource, "human_review");
  assert.equal(records[0]!.evidenceStatus, "changed");
  malformed = true;
  await assert.rejects(context.records(actor, input.historyScope), /INVALID_PREPARATION_CONTEXT/);
});
test("replayed or uncertain reservations never call model, and provider ambiguity is terminal", async () => {
  let calls = 0,
    replay = true;
  const outcomes: string[] = [];
  const admission: ModelUsageAdmission = {
    async reserve() {
      return { reservationId: randomUUID(), state: "held", replay };
    },
    async record(_actor, _id, outcome) {
      outcomes.push(outcome);
    },
  };
  const sources = {
    async requireActive() {},
    async read() {
      return { versions: [], evidence: [] };
    },
  };
  const model = {
    async generate() {
      calls++;
      throw new AppError("MODEL_UNAVAILABLE", 503);
    },
  };
  const input = { purpose: "summary" as const, question: null, evidence: [] };
  await assert.rejects(
    admittedGeneration(actor, randomUUID(), "summary", input, model, sources, admission),
    /MODEL_RESERVATION_REPLAY/,
  );
  assert.equal(calls, 0);
  replay = false;
  await assert.rejects(
    admittedGeneration(actor, randomUUID(), "summary", input, model, sources, admission),
    /MODEL_DISPATCH_UNKNOWN/,
  );
  assert.equal(calls, 1);
  assert.deepEqual(outcomes, ["unknown"]);
});
test("source reauthorization after admission can release only a confirmed not-started request", async () => {
  let calls = 0;
  const outcomes: string[] = [];
  const admission: ModelUsageAdmission = {
    async reserve() {
      return { reservationId: randomUUID(), state: "held", replay: false };
    },
    async record(_actor, _id, outcome) {
      outcomes.push(outcome);
    },
  };
  await assert.rejects(
    admittedGeneration(
      actor,
      randomUUID(),
      "chat",
      { purpose: "answer", question: "why", evidence: [] },
      {
        async generate() {
          calls++;
          return { claims: [], unsupported: true };
        },
      },
      {
        async requireActive() {},
        async read() {
          return { versions: [], evidence: [] };
        },
      },
      admission,
      async () => {
        throw new AppError("SOURCE_FORBIDDEN", 403);
      },
    ),
    /SOURCE_FORBIDDEN/,
  );
  assert.equal(calls, 0);
  assert.deepEqual(outcomes, ["not_started"]);
});
