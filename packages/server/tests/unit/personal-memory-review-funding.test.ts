import { describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { createPersonalMemoryReviewAdmitter } from "../../src/lib/personal-memory-review-funding";
import type { MemoryReviewClaim, MemoryReviewRepository } from "@nautilo/runtime";

const claim: MemoryReviewClaim = {
  workId: "work", attemptId: "attempt", ownerId: "room-owner", actorId: "actor", agentId: "agent",
  roomId: "room", threadId: "thread", scopeId: null, turnIds: ["turn"], sourceIds: [1],
  leaseUntil: new Date("2099-01-01"),
};
const envelope = { ownerId: "room-owner", actorId: "actor", agentId: "agent", roomId: "room",
  readableNamespaces: ["namespace"], mutableNamespaces: ["namespace"], writableNamespaces: ["namespace"], toolPolicy: {} };
const initial = [{ kind: "source" as const, sourceKind: "message", logicalSourceRef: "message:1",
  observedRevision: "2", observedContentFingerprint: "sha256:source", terminalAuthorityLeafHandle: "namespace" }];

function repository(): MemoryReviewRepository {
  return {
    claimNext: async () => null, assertCurrent: async () => {}, load: async () => ({ messages: [], memoryAccessEnvelope: envelope }),
    reconcile: async () => "not_published", publish: async () => "published", fail: async () => {}, drainEffects: async () => {},
    bindModelOperation: async (_claim, resolve) => resolve(),
  };
}

describe("personal Memory review funding adapter", () => {
  test("threads exact initial and retrieved evidence through shared admission fences", async () => {
    const exposure = [{ ...initial[0]!, logicalSourceRef: "memory:m1" }];
    const asserted: unknown[] = [];
    let current = 0;
    const admit = createPersonalMemoryReviewAdmitter({
      repository: repository(), evidence: {} as never, budget: { maxVisitedRecords: 10, maxTraversalWork: 20 },
      commitmentKey: new Uint8Array(32).fill(1), resolveServiceModel: () => "service-model",
      resolveExposureDependencies: async (_claim, snapshots) => {
        expect(snapshots).toEqual([{ memoryId: "m1", fingerprint: "snapshot" }]);
        return exposure;
      },
      openOperation: async (input) => {
        expect(await input.dependencies()).toEqual(initial);
        const binding = await input.bind(async () => ({ version: 1, kind: "human", role: "memoryReview",
          modelId: "personal-model", inputCommitment: `hmac-sha256:${"a".repeat(43)}`,
          humanUserId: "actual-human", preferenceRevision: 4,
          funding: { kind: "server", providerRoute: "openai" } }));
        return { binding, modelId: binding.modelId, humanUserId: "actual-human", fundingSession: {} as never,
          assertCurrent: async () => { current += 1; }, assertExposure: async (deps) => { asserted.push(deps); } };
      },
    });
    const admitted = await admit(claim, { messages: [new HumanMessage("actual")], memoryAccessEnvelope: envelope,
      modelExposureDependencies: initial }, async () => {});
    expect(admitted.modelId).toBe("personal-model");
    await admitted.onModelExposure?.([]);
    await admitted.onModelExposure?.([{ memoryId: "m1", fingerprint: "snapshot" }]);
    expect(current).toBe(1);
    expect(asserted).toEqual([exposure]);
  });

  test("shared evidence remains an admitted service operation", async () => {
    const admit = createPersonalMemoryReviewAdmitter({
      repository: repository(), evidence: {} as never, budget: { maxVisitedRecords: 1, maxTraversalWork: 1 },
      commitmentKey: new Uint8Array(32).fill(2), resolveServiceModel: () => "service-model",
      resolveExposureDependencies: async () => undefined,
      openOperation: async () => ({ binding: { version: 1, kind: "service", role: "memoryReview",
        modelId: "service-model", inputCommitment: `hmac-sha256:${"b".repeat(43)}` },
        modelId: "service-model", humanUserId: null, assertCurrent: async () => {}, assertExposure: async () => {} }),
    });
    expect((await admit(claim, { messages: [], memoryAccessEnvelope: envelope }, async () => {})).modelId).toBe("service-model");
  });
});
