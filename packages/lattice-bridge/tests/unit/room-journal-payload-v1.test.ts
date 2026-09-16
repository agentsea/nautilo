import { describe, expect, test } from "bun:test";
import {
  ROOM_EVENT_PAYLOAD_FORMAT_VERSION_V1,
  ROOM_EVENT_PAYLOAD_MAX_SOURCE_MESSAGES_V1,
  ROOM_EVENT_ROLLUP_PAYLOAD_FORMAT_VERSION_V1,
  assertRoomEventPayloadBindingV1,
  assertRoomEventRollupPayloadBindingV1,
  decodeRoomEventPayloadV1,
  decodeRoomEventRollupPayloadV1,
  encodeRoomEventPayloadV1,
  encodeRoomEventRollupPayloadV1,
  type RoomEventPayloadV1,
  type RoomEventRollupPayloadV1,
} from "../../src/index.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const EVENT_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_EVENT_ID = "10000000-0000-4000-8000-000000000002";
const ROOM_ID = "20000000-0000-4000-8000-000000000001";
const OTHER_ROOM_ID = "20000000-0000-4000-8000-000000000002";
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
    sequence: 42,
    kind: "decision",
    statement: "Ship the encrypted journal.",
    supersedesEventId: null,
    resolvesEventId: null,
    sourceMessageIds: [101, 103],
    sourceBatchId: BATCH_ID,
    batchLocalOrdinal: 2,
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
    throughEventSequence: 42,
    content: "The team decided to ship the encrypted journal.",
    sourceEventCount: 17,
    modelId: "gemini-2.5-flash",
    compactorVersion: "m241-v1",
    createdAt: "2026-08-04T08:10:11.456Z",
    ...overrides,
  };
}

describe("RoomEventPayloadV1 canonical codec", () => {
  test("round-trips immutable event facts and excludes mutable status", () => {
    const payload = eventPayload();
    const bytes = encodeRoomEventPayloadV1(payload);
    const wire = decoder.decode(bytes);

    expect(wire).toContain(
      `"payloadKind":"room_event","payloadVersion":${ROOM_EVENT_PAYLOAD_FORMAT_VERSION_V1}`,
    );
    expect(wire).not.toContain("status");
    expect(decodeRoomEventPayloadV1(bytes)).toEqual(payload);
    expect(Object.isFrozen(decodeRoomEventPayloadV1(bytes))).toBe(true);
    expect(
      Object.isFrozen(decodeRoomEventPayloadV1(bytes).sourceMessageIds),
    ).toBe(true);
  });

  test("is deterministic across insertion order", () => {
    const left = eventPayload();
    const right: RoomEventPayloadV1 = {
      createdAt: left.createdAt,
      extractorVersion: left.extractorVersion,
      batchLocalOrdinal: left.batchLocalOrdinal,
      sourceBatchId: left.sourceBatchId,
      sourceMessageIds: left.sourceMessageIds,
      resolvesEventId: left.resolvesEventId,
      supersedesEventId: left.supersedesEventId,
      statement: left.statement,
      kind: left.kind,
      sequence: left.sequence,
      namespaceId: left.namespaceId,
      roomId: left.roomId,
      eventId: left.eventId,
    };

    expect(encodeRoomEventPayloadV1(left)).toEqual(
      encodeRoomEventPayloadV1(right),
    );
  });

  test("rejects mutable, unknown, malformed, non-canonical, and trailing data", () => {
    expect(() =>
      encodeRoomEventPayloadV1({
        ...eventPayload(),
        status: "active",
      } as RoomEventPayloadV1)
    ).toThrow(/status|unknown/i);

    const canonical = decoder.decode(encodeRoomEventPayloadV1(eventPayload()));
    expect(() =>
      decodeRoomEventPayloadV1(encoder.encode(canonical.replace(
        `"payloadVersion":1`,
        `"payloadVersion":2`,
      )))
    ).toThrow(/version/i);
    expect(() =>
      decodeRoomEventPayloadV1(encoder.encode(canonical.replace(
        `"payloadKind":"room_event"`,
        `"payloadKind":"room_event_revised"`,
      )))
    ).toThrow(/kind/i);
    expect(() =>
      decodeRoomEventPayloadV1(encoder.encode(canonical.replace(
        `"eventId"`,
        `"surprise":true,"eventId"`,
      )))
    ).toThrow(/unknown/i);
    expect(() =>
      decodeRoomEventPayloadV1(encoder.encode(canonical.replace(
        `"eventId"`,
        ` "eventId"`,
      )))
    ).toThrow(/canonical/i);
    expect(() =>
      decodeRoomEventPayloadV1(encoder.encode(`${canonical}\n`))
    ).toThrow();
    expect(() =>
      decodeRoomEventPayloadV1(
        Uint8Array.from([0x7b, 0x22, 0x80, 0x22, 0x7d]),
      )
    ).toThrow(/malformed/i);
  });

  test("enforces UUID, transition, source, integer, timestamp, and text bounds", () => {
    expect(() =>
      encodeRoomEventPayloadV1(eventPayload({ roomId: "not-a-uuid" }))
    ).toThrow(/UUID/i);
    expect(() =>
      encodeRoomEventPayloadV1(eventPayload({
        supersedesEventId: OTHER_EVENT_ID,
        resolvesEventId: EVENT_ID,
      }))
    ).toThrow(/transition/i);
    expect(() =>
      encodeRoomEventPayloadV1(eventPayload({ sourceMessageIds: [103, 101] }))
    ).toThrow(/ascending/i);
    expect(() =>
      encodeRoomEventPayloadV1(eventPayload({ sourceMessageIds: [101, 101] }))
    ).toThrow(/ascending|duplicate/i);
    expect(() =>
      encodeRoomEventPayloadV1(eventPayload({
        sourceMessageIds: Array.from(
          { length: ROOM_EVENT_PAYLOAD_MAX_SOURCE_MESSAGES_V1 + 1 },
          (_, index) => index + 1,
        ),
      }))
    ).toThrow(/bounds/i);
    expect(() =>
      encodeRoomEventPayloadV1(eventPayload({ sequence: 0 }))
    ).toThrow(/sequence/i);
    expect(() =>
      encodeRoomEventPayloadV1(eventPayload({ batchLocalOrdinal: -1 }))
    ).toThrow(/ordinal/i);
    expect(() =>
      encodeRoomEventPayloadV1(eventPayload({
        createdAt: "2026-08-04T08:09:10Z",
      }))
    ).toThrow(/timestamp/i);
    expect(() =>
      encodeRoomEventPayloadV1(eventPayload({
        statement: "x".repeat(501),
      }))
    ).toThrow(/statement/i);
    expect(() =>
      encodeRoomEventPayloadV1(eventPayload({ statement: "\ud800" }))
    ).toThrow(/Unicode/i);

    expect(
      decodeRoomEventPayloadV1(
        encodeRoomEventPayloadV1(eventPayload({
          statement: "💣".repeat(500),
        })),
      ).statement,
    ).toBe("💣".repeat(500));
  });

  test("rejects accessors and collection-owned fields without invoking them", () => {
    let getterInvoked = false;
    const withGetter = { ...eventPayload() } as Record<string, unknown>;
    Object.defineProperty(withGetter, "statement", {
      enumerable: true,
      get: () => {
        getterInvoked = true;
        return "must not be read";
      },
    });
    expect(() =>
      encodeRoomEventPayloadV1(withGetter as unknown as RoomEventPayloadV1)
    ).toThrow(/non-data|required data/i);
    expect(getterInvoked).toBe(false);

    const sourceIds = [101] as number[] & { injected?: boolean };
    sourceIds.injected = true;
    expect(() =>
      encodeRoomEventPayloadV1(eventPayload({
        sourceMessageIds: sourceIds,
      }))
    ).toThrow(/extra field/i);
  });

  test("detects product-row identity and immutable-metadata substitution", () => {
    const payload = decodeRoomEventPayloadV1(
      encodeRoomEventPayloadV1(eventPayload()),
    );
    expect(() =>
      assertRoomEventPayloadBindingV1(payload, {
        eventId: EVENT_ID,
        roomId: OTHER_ROOM_ID,
        namespaceId: NAMESPACE_ID,
        sequence: 42,
        kind: "decision",
        supersedesEventId: null,
        resolvesEventId: null,
        sourceMessageIds: [101, 103],
        sourceBatchId: BATCH_ID,
        batchLocalOrdinal: 2,
        extractorVersion: "m241-v1",
        createdAt: "2026-08-04T08:09:10.123Z",
      })
    ).toThrow(/roomId/i);
    expect(() =>
      assertRoomEventPayloadBindingV1(payload, {
        eventId: EVENT_ID,
        roomId: ROOM_ID,
        namespaceId: NAMESPACE_ID,
        sequence: 42,
        kind: "decision",
        supersedesEventId: null,
        resolvesEventId: null,
        sourceMessageIds: [101, 104],
        sourceBatchId: BATCH_ID,
        batchLocalOrdinal: 2,
        extractorVersion: "m241-v1",
        createdAt: "2026-08-04T08:09:10.123Z",
      })
    ).toThrow(/sourceMessageIds/i);
  });
});

describe("RoomEventRollupPayloadV1 canonical codec", () => {
  test("round-trips immutable rollup facts with a distinct domain", () => {
    const payload = rollupPayload();
    const bytes = encodeRoomEventRollupPayloadV1(payload);
    const wire = decoder.decode(bytes);

    expect(wire).toContain(
      `"payloadKind":"room_event_rollup","payloadVersion":${ROOM_EVENT_ROLLUP_PAYLOAD_FORMAT_VERSION_V1}`,
    );
    expect(decodeRoomEventRollupPayloadV1(bytes)).toEqual(payload);
    expect(() => decodeRoomEventPayloadV1(bytes)).toThrow(/payload|kind/i);
    expect(() =>
      decodeRoomEventRollupPayloadV1(encodeRoomEventPayloadV1(eventPayload()))
    ).toThrow(/payload|kind/i);
  });

  test("enforces rollup bounds and rejects non-canonical input", () => {
    expect(() =>
      encodeRoomEventRollupPayloadV1(rollupPayload({
        throughEventSequence: 0,
      }))
    ).toThrow(/sequence/i);
    expect(() =>
      encodeRoomEventRollupPayloadV1(rollupPayload({
        sourceEventCount: 0,
      }))
    ).toThrow(/count/i);
    expect(() =>
      encodeRoomEventRollupPayloadV1(rollupPayload({
        content: "x".repeat(12_001),
      }))
    ).toThrow(/content/i);
    expect(() =>
      encodeRoomEventRollupPayloadV1(rollupPayload({
        modelId: "model id with spaces",
      }))
    ).toThrow(/identifier/i);

    const canonical = decoder.decode(
      encodeRoomEventRollupPayloadV1(rollupPayload()),
    );
    expect(() =>
      decodeRoomEventRollupPayloadV1(encoder.encode(canonical.replace(
        `"content"`,
        ` "content"`,
      )))
    ).toThrow(/canonical/i);
  });

  test("detects rollup identity and cursor substitution", () => {
    const payload = decodeRoomEventRollupPayloadV1(
      encodeRoomEventRollupPayloadV1(rollupPayload()),
    );
    expect(() =>
      assertRoomEventRollupPayloadBindingV1(payload, {
        rollupId: ROLLUP_ID,
        roomId: ROOM_ID,
        namespaceId: NAMESPACE_ID,
        throughEventSequence: 41,
        sourceEventCount: 17,
        modelId: "gemini-2.5-flash",
        compactorVersion: "m241-v1",
        createdAt: "2026-08-04T08:10:11.456Z",
      })
    ).toThrow(/throughEventSequence/i);
  });
});
