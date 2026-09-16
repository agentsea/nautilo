import { describe, expect, mock, test } from "bun:test";
const reservations: unknown[][] = [];
mock.module("@nautilo/agent", () => ({ reserveMemoryReviewSources: async (...args: unknown[]) => { reservations.push(args); } }));
const { memoryReviewAdmission } = await import("../../src/memory-review/admission");
const envelope = { ownerId: "owner", actorId: "actor", agentId: "agent", roomId: "room", readableNamespaces: ["namespace"], mutableNamespaces: ["namespace"], writableNamespaces: ["namespace"], toolPolicy: {} };
describe("already-persisted Memory input", () => {
  test("foreground-opened content never enters the durable background reservation", async () => {
    reservations.length = 0;
    const admitted = await memoryReviewAdmission(envelope, "checkpoint", {
      threadId: "transcript", transcriptOwnerId: "owner", turnId: "protected-turn",
      input: {
        humanAlreadyPersisted: true, currentMessageId: 23,
        messages: [{ content: "foreground-only plaintext canary" }],
        soulFile: "private soul canary",
      },
    });
    expect(reservations[0]?.[2]).toMatchObject({ memoryReview: { existingSourceMessageIds: [23] } });
    const serialized = JSON.stringify({ reservations, admitted });
    expect(serialized).not.toContain("plaintext canary");
    expect(serialized).not.toContain("soul canary");
    expect(serialized).not.toContain('"messages"');
  });
  test("reserves exact Human coordinates before model work without appending a duplicate", async () => {
    reservations.length = 0;
    const admitted = await memoryReviewAdmission(envelope, "fork-checkpoint", { threadId: "transcript", transcriptOwnerId: "owner", turnId: "turn", input: { humanAlreadyPersisted: true, currentMessageId: 22, memoryReviewSourceMessageIds: [21, 22] } });
    expect(reservations).toEqual([["transcript", "owner", { agentId: "agent", roomId: "room", humanTurnId: "turn", memoryReview: { ownerId: "owner", actorId: "actor", checkpointThreadId: "fork-checkpoint", accessScope: "namespace", existingSourceMessageIds: [21, 22] } }]]);
    expect(admitted.memoryReview).not.toHaveProperty("existingSourceMessageIds");
    expect(admitted.memoryReview).not.toHaveProperty("existingHumanTurnId");
  });
  test("legacy pre-persist callers use only exact Human turn identity, never room history", async () => {
    reservations.length = 0;
    await memoryReviewAdmission(envelope, "checkpoint", { threadId: "transcript", transcriptOwnerId: "owner", turnId: "exact-turn", input: { humanAlreadyPersisted: true } });
    expect(reservations[0]?.[2]).toMatchObject({ memoryReview: { existingHumanTurnId: "exact-turn" } });
  });
});
