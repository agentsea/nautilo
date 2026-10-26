import { describe, expect, test } from "bun:test";

import {
  createProtectedTaskProjectionAuthorityPlan,
  deserializeProtectedTaskProjectionAuthorityPlan,
  protectedTaskProjectionDestinationAuthorityDigest,
  sameProtectedTaskProjectionAuthorityPlan,
  serializeProtectedTaskProjectionAuthorityPlan,
} from "../../src/routes/protected-task-memory-projection-plan";

const SOURCE = "10000000-0000-4000-8000-000000000001";
const DESTINATION = "20000000-0000-4000-8000-000000000002";
const source = Object.freeze({ memoryId: "memory", contentRevision: 2,
  cryptoAccessRevision: 3, cryptoObjectId: "object",
  requiredNamespaceIds: Object.freeze([SOURCE]), payloadDigest: "a".repeat(64) });
const destination = Object.freeze({ roomId: "room", namespaceId: DESTINATION,
  label: "Destination", kind: "group", memberCount: 2,
  audienceFingerprint: "audience" });
const reference = Object.freeze({ referenceId: "reference", toolCallId: "tool",
  requesterUserId: "user", requesterActorId: "actor", agentId: "agent",
  createdAt: 10, expiresAt: 20 });

describe("protected Task projection plan", () => {
  test("seals additional authority and preserves it across serialization and a wider grant", () => {
    const plan = createProtectedTaskProjectionAuthorityPlan({ taskId: "task",
      taskRunId: "run", graphThreadId: "thread", reference,
      operationId: "operation", sources: [source], destination,
      proposalDigest: "b".repeat(64), effectDigest: "c".repeat(64),
      availableAuthority: [{ namespaceId: SOURCE, operations: ["decrypt"] }] });
    expect(plan.kind).toBe("additional_authority_v1");
    const restored = deserializeProtectedTaskProjectionAuthorityPlan(
      serializeProtectedTaskProjectionAuthorityPlan(plan),
    );
    expect(sameProtectedTaskProjectionAuthorityPlan(plan, restored)).toBe(true);
    const wider = createProtectedTaskProjectionAuthorityPlan({ taskId: "task",
      taskRunId: "run", graphThreadId: "thread", reference,
      operationId: "operation", sources: [source], destination,
      proposalDigest: "b".repeat(64), effectDigest: "c".repeat(64),
      availableAuthority: [
        { namespaceId: SOURCE, operations: ["decrypt"] },
        { namespaceId: DESTINATION, operations: ["encrypt"] },
      ] });
    expect(wider.kind).toBe("current_v1");
    expect(sameProtectedTaskProjectionAuthorityPlan(plan, wider)).toBe(false);
  });

  test("binds the complete destination tuple", () => {
    const digest = protectedTaskProjectionDestinationAuthorityDigest(destination);
    expect(digest).toHaveLength(32);
    expect(protectedTaskProjectionDestinationAuthorityDigest({ ...destination,
      memberCount: 3 })).not.toEqual(digest);
    expect(protectedTaskProjectionDestinationAuthorityDigest({ ...destination,
      audienceFingerprint: "changed" })).not.toEqual(digest);
  });
});
