import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { verifySemanticClaims } from "../src/application/semantic-verification.js";
import { AzureIndependentVerifier } from "../src/infrastructure/azure-verifier.js";
const evidence = {
  meetingId: randomUUID(),
  captureId: randomUUID(),
  segmentId: randomUUID(),
  revision: 2,
  startMs: 0,
  endMs: 2000,
  text: "We might migrate, but have not approved a date.",
  speakerLabel: null,
};
const claim = {
  id: randomUUID(),
  kind: "discussion" as const,
  text: "A migration was discussed without an approved date.",
  citation: {
    meetingId: evidence.meetingId,
    captureId: evidence.captureId,
    segmentId: evidence.segmentId,
    revision: 2,
    quote: "might migrate, but have not approved a date",
  },
};
test("semantic verification sees only exact claim/evidence and cannot consume extractor reasoning", async () => {
  const result = await verifySemanticClaims([claim], [evidence], {
    async verify(input) {
      assert.deepEqual(Object.keys(input[0]!).sort(), ["claim", "evidence"]);
      assert.equal(input[0]!.evidence.text, evidence.text);
      return { verdicts: [{ claimId: claim.id, verdict: "supported" }] };
    },
  });
  assert.equal(result[0]!.text, claim.text);
  await assert.rejects(
    verifySemanticClaims([{ ...claim, reasoning: "I certify this is true" }], [evidence], {
      async verify() {
        throw new Error("must not run");
      },
    }),
  );
  await assert.rejects(
    verifySemanticClaims([{ ...claim, citation: { ...claim.citation, revision: 1 } }], [evidence], {
      async verify() {
        throw new Error("must not run");
      },
    }),
    /CITATION_NOT_SUPPORTED/,
  );
});
test("unsupported or uncertain paraphrases and mismatched verdict IDs are never publishable", async () => {
  for (const verdict of ["unsupported", "uncertain"])
    await assert.rejects(
      verifySemanticClaims([claim], [evidence], {
        async verify() {
          return { verdicts: [{ claimId: claim.id, verdict }] };
        },
      }),
      /CLAIM_NOT_VERIFIED/,
    );
  await assert.rejects(
    verifySemanticClaims([claim], [evidence], {
      async verify() {
        return { verdicts: [{ claimId: randomUUID(), verdict: "supported" }] };
      },
    }),
    /INVALID_VERIFICATION_RESULT/,
  );
});
test("Azure verifier uses its own stateless structured request and no external action tools", async () => {
  const verifier = new AzureIndependentVerifier(
    "https://fixture.openai.azure.com",
    "qualified-verifier",
    async () => "fixture",
    async (_url, options) => {
      const input = JSON.parse(String(options?.body));
      assert.equal(input.model, "qualified-verifier");
      assert.equal(input.store, false);
      assert.equal(input.tools, undefined);
      assert.equal(input.messages.length, 2);
      assert.equal(input.response_format.json_schema.strict, true);
      assert.equal(JSON.stringify(input).includes("extractorReasoning"), false);
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({ verdicts: [{ claimId: claim.id, verdict: "supported" }] }),
              refusal: null,
            },
          },
        ],
      });
    },
  );
  assert.equal((await verifySemanticClaims([claim], [evidence], verifier))[0]!.id, claim.id);
});
