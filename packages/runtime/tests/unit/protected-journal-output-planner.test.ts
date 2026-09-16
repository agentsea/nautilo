import { describe, expect, test } from "bun:test";

import {
  decodeProtectedJournalAttachmentPlanV1,
  encodeProtectedJournalAttachmentPlanV1,
  planProtectedExtractionOutputs,
  planProtectedRollupOutput,
  PROTECTED_JOURNAL_CONTENT_SENTINEL,
} from "../../src/stenographer/protected-journal-output-planner";

const ROOM_ID = "10000000-0000-4000-8000-000000000001";
const NAMESPACE_ID = "20000000-0000-4000-8000-000000000001";
const BATCH_ID = "30000000-0000-4000-8000-000000000001";
const EVENT_1 = "40000000-0000-4000-8000-000000000001";
const EVENT_2 = "40000000-0000-4000-8000-000000000002";
const ROLLUP_ID = "50000000-0000-4000-8000-000000000001";
const CREATED_AT = "2026-08-04T12:00:00.000Z";

describe("protected journal output planner", () => {
  test("plans only the actual ordered output prefix and keeps plaintext out of the attachment plan", () => {
    const result = planProtectedExtractionOutputs({
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      sourceBatchId: BATCH_ID,
      rebuildGeneration: 3,
      extractorVersion: "m241-v1",
      createdAt: CREATED_AT,
      existingEvents: [{
        id: EVENT_1,
        roomId: ROOM_ID,
        sequence: 1,
        kind: "decision",
        statement: "Keep the old decision.",
        status: "active",
      }],
      operations: [
        {
          op: "append",
          kind: "decision",
          statement: "  keep   the old decision. ",
          sourceMessageIds: [10],
        },
        {
          op: "append",
          kind: "fact",
          statement: "The journal is protected.",
          sourceMessageIds: [11, 12],
        },
      ],
      outputSlots: [
        { eventId: EVENT_2, objectId: "journal-object-1" },
        {
          eventId: "40000000-0000-4000-8000-000000000003",
          objectId: "journal-object-2",
        },
      ],
      messageBindings: [10, 11, 12].map((messageId) => ({
        messageId,
        editRevision: 0,
        observedContentFingerprint: `sha256:message-${messageId}`,
      })),
    });

    expect(result.status).toBe("planned");
    if (result.status !== "planned") return;
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]?.objectId).toBe("journal-object-1");
    expect(new TextDecoder().decode(result.outputs[0]?.plaintext))
      .toContain("The journal is protected.");
    expect(result.attachmentPlan.events).toEqual([{
      eventId: EVENT_2,
      objectId: "journal-object-1",
      sequence: 2,
      kind: "fact",
      status: "active",
      supersedesEventId: null,
      resolvesEventId: null,
      sourceMessageIds: [11, 12],
      sourceBatchId: BATCH_ID,
      batchLocalOrdinal: 1,
      extractorVersion: "m241-v1",
      createdAt: CREATED_AT,
    }]);
    expect(result.attachmentPlan.foldedBatchLocalOrdinals).toEqual([0]);
    const attachmentText = new TextDecoder().decode(
      result.attachmentPlanBytes,
    );
    expect(attachmentText).not.toContain("The journal is protected.");
    expect(attachmentText).not.toContain("Keep the old decision.");
    expect(result.productPlaceholder).toBe(
      PROTECTED_JOURNAL_CONTENT_SENTINEL,
    );
    expect(
      encodeProtectedJournalAttachmentPlanV1(
        decodeProtectedJournalAttachmentPlanV1(
          result.attachmentPlanBytes,
        ),
      ),
    ).toEqual(result.attachmentPlanBytes);
  });

  test("rejects insufficient, duplicate, or non-prefix output reservations", () => {
    const base = {
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      sourceBatchId: BATCH_ID,
      rebuildGeneration: 0,
      extractorVersion: "m241-v1",
      createdAt: CREATED_AT,
      existingEvents: [],
      operations: [
        {
          op: "append" as const,
          kind: "fact" as const,
          statement: "One.",
          sourceMessageIds: [1],
        },
        {
          op: "append" as const,
          kind: "risk" as const,
          statement: "Two.",
          sourceMessageIds: [2],
        },
      ],
      messageBindings: [1, 2].map((messageId) => ({
        messageId,
        editRevision: 0,
        observedContentFingerprint: `sha256:message-${messageId}`,
      })),
    };
    expect(() =>
      planProtectedExtractionOutputs({
        ...base,
        outputSlots: [{ eventId: EVENT_1, objectId: "object-1" }],
      })
    ).toThrow();
    expect(() =>
      planProtectedExtractionOutputs({
        ...base,
        outputSlots: [
          { eventId: EVENT_1, objectId: "same-object" },
          { eventId: EVENT_2, objectId: "same-object" },
        ],
      })
    ).toThrow();
    expect(() =>
      planProtectedExtractionOutputs({
        ...base,
        outputSlots: [
          { eventId: EVENT_1, objectId: "object-1" },
          { eventId: EVENT_1, objectId: "object-2" },
        ],
      })
    ).toThrow();
  });

  test("encodes an empty extraction result and a single cumulative rollup without plaintext metadata leakage", () => {
    const empty = planProtectedExtractionOutputs({
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      sourceBatchId: BATCH_ID,
      rebuildGeneration: 4,
      extractorVersion: "m241-v1",
      createdAt: CREATED_AT,
      existingEvents: [],
      operations: [],
      outputSlots: [],
      messageBindings: [],
    });
    expect(empty.status).toBe("planned");
    if (empty.status !== "planned") return;
    expect(empty.outputs).toEqual([]);
    expect(empty.attachmentPlan.events).toEqual([]);

    const rollup = planProtectedRollupOutput({
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      rebuildGeneration: 4,
      rollupId: ROLLUP_ID,
      outputObjectId: "rollup-object-1",
      throughEventSequence: 9,
      content: "Cumulative protected history.",
      sourceEventCount: 9,
      modelId: "model-v1",
      compactorVersion: "m241-v1",
      createdAt: CREATED_AT,
    });
    expect(rollup.outputs).toHaveLength(1);
    expect(rollup.attachmentPlan.rollup).toEqual({
      rollupId: ROLLUP_ID,
      objectId: "rollup-object-1",
      throughEventSequence: 9,
      sourceEventCount: 9,
      modelId: "model-v1",
      compactorVersion: "m241-v1",
      createdAt: CREATED_AT,
    });
    expect(new TextDecoder().decode(rollup.attachmentPlanBytes))
      .not.toContain("Cumulative protected history.");
  });

  test("rejects malformed, non-canonical, unknown-version, oversized, and trailing attachment bytes", () => {
    const invalid = [
      new Uint8Array([0xff]),
      new TextEncoder().encode("{}"),
      new TextEncoder().encode(
        JSON.stringify(["nautilo/protected-journal-attachment", 2]),
      ),
      new TextEncoder().encode(
        `${JSON.stringify([
          "nautilo/protected-journal-attachment",
          1,
          "extraction",
          ROOM_ID,
          NAMESPACE_ID,
          0,
          BATCH_ID,
          [],
          [],
          [],
        ])} `,
      ),
      new Uint8Array(65_537).fill(0x20),
    ];
    for (const bytes of invalid) {
      expect(() => decodeProtectedJournalAttachmentPlanV1(bytes)).toThrow();
    }
  });
});
