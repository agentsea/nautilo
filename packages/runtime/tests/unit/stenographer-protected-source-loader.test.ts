import { describe, expect, test } from "bun:test";
import type { ProcessorTransformInput } from "@nautilo/lattice-crypto";
import {
  encodeMessagePayloadV2,
  encodeRoomEventPayloadV1,
  encodeRoomEventRollupPayloadV1,
  type MessageRoleV2,
  type RoomEventPayloadV1,
  type RoomEventRollupPayloadV1,
} from "@nautilo/lattice-bridge";
import { encodeRecordPayloadV1 } from "@nautilo/reflection-bridge";

import {
  PROTECTED_STENOGRAPHER_MAX_PARTICIPANTS,
  ProtectedStenographerSourceLoaderError,
  withProtectedStenographerSources,
  type ProtectedStenographerSourceBinding,
} from "../../src/stenographer/protected-source-loader";

const EVENT_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_EVENT_ID = "10000000-0000-4000-8000-000000000002";
const ROOM_ID = "20000000-0000-4000-8000-000000000001";
const NAMESPACE_ID = "30000000-0000-4000-8000-000000000001";
const BATCH_ID = "40000000-0000-4000-8000-000000000001";
const ROLLUP_ID = "50000000-0000-4000-8000-000000000001";

function eventPayload(
  overrides: Partial<RoomEventPayloadV1> = {},
): RoomEventPayloadV1 {
  return {
    eventId: EVENT_ID,
    roomId: ROOM_ID,
    namespaceId: NAMESPACE_ID,
    sequence: 7,
    kind: "decision",
    statement: "Encrypt the journal.",
    supersedesEventId: null,
    resolvesEventId: null,
    sourceMessageIds: [11],
    sourceBatchId: BATCH_ID,
    batchLocalOrdinal: 0,
    extractorVersion: "m241-v1",
    createdAt: "2026-08-04T08:09:10.123Z",
    ...overrides,
  };
}

function rollupPayload(
  overrides: Partial<RoomEventRollupPayloadV1> = {},
): RoomEventRollupPayloadV1 {
  return {
    rollupId: ROLLUP_ID,
    roomId: ROOM_ID,
    namespaceId: NAMESPACE_ID,
    throughEventSequence: 6,
    content: "Earlier journal context.",
    sourceEventCount: 6,
    modelId: "model-v1",
    compactorVersion: "m241-v1",
    createdAt: "2026-08-04T08:09:11.123Z",
    ...overrides,
  };
}

function messageBinding(
  objectId: string,
  source: "current" | "prior",
  messageId: number,
  participantId: string,
  role: MessageRoleV2,
): ProtectedStenographerSourceBinding {
  return {
    kind: "message",
    objectId,
    source,
    messageId,
    editRevision: 0,
    createdAt: new Date(
      Date.parse("2026-08-04T08:09:00.000Z") + messageId * 1_000,
    ),
    participantId,
    role,
    conversationalBoundary:
      source === "current" && (role === "user" || role === "assistant"),
  };
}

function fixture() {
  const event = eventPayload();
  const rollup = rollupPayload();
  const bindings: readonly ProtectedStenographerSourceBinding[] = [
    messageBinding("message-prior-10", "prior", 10, "actor-bob", "assistant"),
    {
      kind: "rollup",
      objectId: "journal-rollup-6",
      binding: {
        rollupId: rollup.rollupId,
        roomId: rollup.roomId,
        namespaceId: rollup.namespaceId,
        throughEventSequence: rollup.throughEventSequence,
        sourceEventCount: rollup.sourceEventCount,
        modelId: rollup.modelId,
        compactorVersion: rollup.compactorVersion,
        createdAt: rollup.createdAt,
      },
    },
    {
      kind: "event",
      objectId: "journal-event-7",
      status: "active",
      binding: {
        eventId: event.eventId,
        roomId: event.roomId,
        namespaceId: event.namespaceId,
        sequence: event.sequence,
        kind: event.kind,
        supersedesEventId: event.supersedesEventId,
        resolvesEventId: event.resolvesEventId,
        sourceMessageIds: event.sourceMessageIds,
        sourceBatchId: event.sourceBatchId,
        batchLocalOrdinal: event.batchLocalOrdinal,
        extractorVersion: event.extractorVersion,
        createdAt: event.createdAt,
      },
    },
    messageBinding("message-current-11", "current", 11, "actor-alice", "user"),
  ];
  const opened: readonly ProcessorTransformInput[] = [
    {
      objectId: "message-prior-10",
      plaintext: encodeMessagePayloadV2({
        role: "assistant",
        content: "Prior answer.",
      }),
    },
    {
      objectId: "journal-rollup-6",
      plaintext: encodeRoomEventRollupPayloadV1(rollup),
    },
    {
      objectId: "journal-event-7",
      plaintext: encodeRoomEventPayloadV1(event),
    },
    {
      objectId: "message-current-11",
      plaintext: encodeMessagePayloadV2({
        role: "user",
        content: "Current request.",
      }),
    },
  ];
  return { bindings, event, opened, rollup };
}

function allZero(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}

async function expectLoaderFailure(
  openedInputs: readonly ProcessorTransformInput[],
  bindings: readonly ProtectedStenographerSourceBinding[],
  expectedCode: ProtectedStenographerSourceLoaderError["code"],
): Promise<void> {
  let callbackCalls = 0;
  let projectionCalls = 0;
  try {
    await withProtectedStenographerSources({
      openedInputs,
      bindings,
      resolveParticipantDisplays: () => {
        projectionCalls += 1;
        return Promise.resolve([]);
      },
      use: () => {
        callbackCalls += 1;
      },
    });
    throw new Error("protected source loader unexpectedly succeeded");
  } catch (error) {
    expect(error).toBeInstanceOf(ProtectedStenographerSourceLoaderError);
    expect((error as ProtectedStenographerSourceLoaderError).code)
      .toBe(expectedCode);
  }
  expect(callbackCalls).toBe(0);
  expect(projectionCalls).toBe(0);
  expect(openedInputs.every((item) => allZero(item.plaintext))).toBe(true);
}

describe("protected Stenographer source loader", () => {
  test("opens a native protected observation through its canonical Record payload", async () => {
    const event = eventPayload();
    const binding: ProtectedStenographerSourceBinding = {
      kind: "event",
      objectId: "record-event-7",
      status: "active",
      payloadFormat: "record_v1",
      recordMetadata: {
        lifecycle: "current",
        structuralHeight: 0,
        processingGeneration: 4,
      },
      binding: {
        eventId: event.eventId,
        roomId: event.roomId,
        namespaceId: event.namespaceId,
        sequence: event.sequence,
        kind: event.kind,
        supersedesEventId: event.supersedesEventId,
        resolvesEventId: event.resolvesEventId,
        sourceMessageIds: event.sourceMessageIds,
        sourceBatchId: event.sourceBatchId,
        batchLocalOrdinal: event.batchLocalOrdinal,
        extractorVersion: event.extractorVersion,
        createdAt: event.createdAt,
      },
    };
    const opened = [{
      objectId: "record-event-7",
      plaintext: encodeRecordPayloadV1({
        formatVersion: 1,
        posture: "derived",
        observedContentFingerprint: "sha256:event-seven",
        sourceOwnedKind: "journal_event:decision",
        observedLogicalObjectRef: event.eventId,
        observedRevision: "4",
        statement: event.statement,
        sourceDependencies: [{
          sourceKind: "message",
          logicalObjectRef: "message:11",
          observedRevision: "0",
          observedContentFingerprint: "sha256:message-eleven",
          terminalAuthorityLeafHandle: NAMESPACE_ID,
          authorityBearing: true,
        }],
        anchors: [{ kind: "room", anchorRef: ROOM_ID, role: "origin" }],
        childRecordIds: [],
        producer: { producerRef: "stenographer", policyVersion: "m241-v1" },
        terminalAuthorityLeafHandles: [NAMESPACE_ID],
      }),
    }];
    const statements: string[] = [];

    await withProtectedStenographerSources({
      openedInputs: opened,
      bindings: [binding],
      resolveParticipantDisplays: () => Promise.resolve([]),
      use: (sources) => {
        statements.push(sources.events[0]?.payload.statement ?? "");
      },
    });

    expect(statements).toEqual(["Encrypt the journal."]);
    expect(allZero(opened[0]!.plaintext)).toBe(true);
  });

  test("preserves exact order, separates source families, and exposes plaintext only inside one callback", async () => {
    const state = fixture();
    const projectionRequests: string[][] = [];
    let callbackCalls = 0;
    let callbackFinished = false;

    const result = await withProtectedStenographerSources({
      openedInputs: state.opened,
      bindings: state.bindings,
      resolveParticipantDisplays: (participantIds) => {
        projectionRequests.push([...participantIds]);
        return Promise.resolve([
          { participantId: "actor-bob", displayLabel: "Bob" },
          { participantId: "actor-alice", displayLabel: "Alice" },
        ]);
      },
      use: async (sources) => {
        callbackCalls += 1;
        expect(sources.orderedSources.map((source) => source.kind)).toEqual([
          "message",
          "rollup",
          "event",
          "message",
        ]);
        expect(sources.priorMessages.map((message) => [
          message.messageId,
          message.displayLabel,
          message.payload.content,
        ])).toEqual([[10, "Bob", "Prior answer."]]);
        expect(sources.currentMessages.map((message) => [
          message.messageId,
          message.displayLabel,
          message.payload.content,
        ])).toEqual([[11, "Alice", "Current request."]]);
        expect(sources.events.map((event) => [
          event.status,
          event.payload.sequence,
          event.payload.statement,
        ])).toEqual([["active", 7, "Encrypt the journal."]]);
        expect(sources.latestRollup?.payload.content)
          .toBe("Earlier journal context.");
        expect(Object.isFrozen(sources)).toBe(true);
        expect(Object.isFrozen(sources.orderedSources)).toBe(true);
        await Promise.resolve();
        expect(state.opened.some((item) => allZero(item.plaintext)))
          .toBe(false);
        callbackFinished = true;
      },
    });

    expect(result).toBeUndefined();
    expect(callbackCalls).toBe(1);
    expect(callbackFinished).toBe(true);
    expect(projectionRequests).toEqual([["actor-bob", "actor-alice"]]);
    expect(state.opened.every((item) => allZero(item.plaintext))).toBe(true);
  });

  test("rejects missing, extra, reordered, duplicate, and substituted object identities", async () => {
    {
      const state = fixture();
      await expectLoaderFailure(
        state.opened.slice(0, -1),
        state.bindings,
        "input_mismatch",
      );
    }
    {
      const state = fixture();
      await expectLoaderFailure(
        [...state.opened, {
          objectId: "extra",
          plaintext: encodeMessagePayloadV2({
            role: "user",
            content: "extra",
          }),
        }],
        state.bindings,
        "input_mismatch",
      );
    }
    {
      const state = fixture();
      await expectLoaderFailure(
        [
          state.opened[1]!,
          state.opened[0]!,
          ...state.opened.slice(2),
        ],
        state.bindings,
        "input_mismatch",
      );
    }
    {
      const state = fixture();
      await expectLoaderFailure(
        [
          state.opened[0]!,
          { ...state.opened[1]!, objectId: state.opened[0]!.objectId },
          ...state.opened.slice(2),
        ],
        state.bindings,
        "input_mismatch",
      );
    }
    {
      const state = fixture();
      await expectLoaderFailure(
        [
          { ...state.opened[0]!, objectId: "substituted-object" },
          ...state.opened.slice(1),
        ],
        state.bindings,
        "input_mismatch",
      );
    }
  });

  test("rejects message-role and event/rollup metadata substitution before display lookup", async () => {
    {
      const state = fixture();
      const changed = [...state.opened];
      changed[0] = {
        objectId: changed[0]!.objectId,
        plaintext: encodeMessagePayloadV2({
          role: "user",
          content: "Role substitution.",
        }),
      };
      await expectLoaderFailure(
        changed,
        state.bindings,
        "binding_mismatch",
      );
    }
    {
      const state = fixture();
      const bindings = [...state.bindings];
      bindings[2] = {
        ...bindings[2] as Extract<
          ProtectedStenographerSourceBinding,
          { kind: "event" }
        >,
        binding: {
          ...(bindings[2] as Extract<
            ProtectedStenographerSourceBinding,
            { kind: "event" }
          >).binding,
          eventId: OTHER_EVENT_ID,
        },
      };
      await expectLoaderFailure(
        state.opened,
        bindings,
        "binding_mismatch",
      );
    }
    {
      const state = fixture();
      const bindings = [...state.bindings];
      bindings[1] = {
        ...bindings[1] as Extract<
          ProtectedStenographerSourceBinding,
          { kind: "rollup" }
        >,
        binding: {
          ...(bindings[1] as Extract<
            ProtectedStenographerSourceBinding,
            { kind: "rollup" }
          >).binding,
          throughEventSequence: 5,
        },
      };
      await expectLoaderFailure(
        state.opened,
        bindings,
        "binding_mismatch",
      );
    }
    {
      const state = fixture();
      const changed = [...state.opened];
      changed[2] = {
        objectId: changed[2]!.objectId,
        plaintext: new Uint8Array([0xff]),
      };
      await expectLoaderFailure(
        changed,
        state.bindings,
        "payload_invalid",
      );
    }
  });

  test("requires one exact bounded participant display projection after object validation", async () => {
    {
      const state = fixture();
      let callbackCalls = 0;
      let failure: unknown;
      try {
        await withProtectedStenographerSources({
          openedInputs: state.opened,
          bindings: state.bindings,
          resolveParticipantDisplays: () => Promise.resolve([
            { participantId: "actor-alice", displayLabel: "Alice" },
            { participantId: "actor-bob", displayLabel: "Bob" },
          ]),
          use: () => {
            callbackCalls += 1;
          },
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(
        ProtectedStenographerSourceLoaderError,
      );
      expect(callbackCalls).toBe(0);
      expect(state.opened.every((item) => allZero(item.plaintext))).toBe(true);
    }
    {
      const bindings: ProtectedStenographerSourceBinding[] = [];
      const opened: ProcessorTransformInput[] = [];
      for (
        let index = 0;
        index < PROTECTED_STENOGRAPHER_MAX_PARTICIPANTS + 1;
        index++
      ) {
        const objectId = `message-${index + 1}`;
        bindings.push(
          messageBinding(
            objectId,
            "current",
            index + 1,
            `actor-${index + 1}`,
            "user",
          ),
        );
        opened.push({
          objectId,
          plaintext: encodeMessagePayloadV2({
            role: "user",
            content: `message ${index + 1}`,
          }),
        });
      }
      await expectLoaderFailure(
        opened,
        bindings,
        "participant_projection_invalid",
      );
    }
  });

  test("wipes every opened buffer when the sole plaintext callback throws", async () => {
    const state = fixture();
    const sentinel = new Error("callback failed");
    try {
      await withProtectedStenographerSources({
        openedInputs: state.opened,
        bindings: state.bindings,
        resolveParticipantDisplays: (participantIds) =>
          Promise.resolve(
            participantIds.map((participantId) => ({
              participantId,
              displayLabel: participantId,
            })),
          ),
        use: () => {
          throw sentinel;
        },
      });
      throw new Error("callback unexpectedly succeeded");
    } catch (error) {
      expect(error).toBe(sentinel);
    }
    expect(state.opened.every((item) => allZero(item.plaintext))).toBe(true);
  });
});
