import { describe, expect, test } from "bun:test";
import {
  decodeRecordPayloadV1,
  encodeRecordPayloadV1,
  RECORD_PAYLOAD_FORMAT_VERSION_V1,
  RECORD_PAYLOAD_V1_LIMITS,
  RecordPayloadCodecError,
  type RecordPayloadV1,
} from "../../src/record-payload-v1";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

function payload(overrides: Partial<RecordPayloadV1> = {}): RecordPayloadV1 {
  return {
    formatVersion: RECORD_PAYLOAD_FORMAT_VERSION_V1,
    posture: "derived",
    observedContentFingerprint: "sha256:record",
    sourceOwnedKind: "journal_event:decision",
    observedLogicalObjectRef: "journal-event-42",
    observedRevision: "event-version-3",
    statement: "PostgreSQL was selected for portable SQL and transactions.",
    sourceDependencies: [
      {
        sourceKind: "journal_event",
        logicalObjectRef: "journal-event-b",
        observedRevision: "rev-2",
        observedContentFingerprint: "sha256:bbbb",
        terminalAuthorityLeafHandle: "leaf-b",
        authorityBearing: true,
      },
      {
        sourceKind: "memory",
        logicalObjectRef: "memory-a",
        observedRevision: null,
        observedContentFingerprint: "sha256:aaaa",
        terminalAuthorityLeafHandle: "leaf-a",
        authorityBearing: true,
      },
    ],
    anchors: [
      { kind: "subject", anchorRef: "postgres", role: "topic" },
      { kind: "room", anchorRef: "room-a", role: "origin" },
    ],
    childRecordIds: ["record-b", "record-a"],
    producer: {
      producerRef: "organizer",
      policyVersion: "candidate-policy-v1",
    },
    terminalAuthorityLeafHandles: ["leaf-b", "leaf-a"],
    ...overrides,
  };
}

function expectCodecError(
  action: () => unknown,
  code: RecordPayloadCodecError["code"],
): void {
  try {
    action();
    throw new Error("expected RecordPayload codec rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(RecordPayloadCodecError);
    expect((error as RecordPayloadCodecError).code).toBe(code);
  }
}

describe("RecordPayloadV1 codec", () => {
  test("pins one canonical byte vector and canonical inventory order", () => {
    const bytes = encodeRecordPayloadV1(payload());
    expect(TEXT_DECODER.decode(bytes)).toBe(
      "{\"anchors\":[{\"anchorRef\":\"room-a\",\"kind\":\"room\",\"role\":\"origin\"},{\"anchorRef\":\"postgres\",\"kind\":\"subject\",\"role\":\"topic\"}],\"childRecordIds\":[\"record-a\",\"record-b\"],\"formatVersion\":1,\"observedContentFingerprint\":\"sha256:record\",\"observedLogicalObjectRef\":\"journal-event-42\",\"observedRevision\":\"event-version-3\",\"posture\":\"derived\",\"producer\":{\"policyVersion\":\"candidate-policy-v1\",\"producerRef\":\"organizer\"},\"sourceDependencies\":[{\"authorityBearing\":true,\"logicalObjectRef\":\"journal-event-b\",\"observedContentFingerprint\":\"sha256:bbbb\",\"observedRevision\":\"rev-2\",\"sourceKind\":\"journal_event\",\"terminalAuthorityLeafHandle\":\"leaf-b\"},{\"authorityBearing\":true,\"logicalObjectRef\":\"memory-a\",\"observedContentFingerprint\":\"sha256:aaaa\",\"observedRevision\":null,\"sourceKind\":\"memory\",\"terminalAuthorityLeafHandle\":\"leaf-a\"}],\"sourceOwnedKind\":\"journal_event:decision\",\"statement\":\"PostgreSQL was selected for portable SQL and transactions.\",\"terminalAuthorityLeafHandles\":[\"leaf-a\",\"leaf-b\"]}",
    );
    const decoded = decodeRecordPayloadV1(bytes);
    expect(Object.hasOwn(decoded, "modelExposureDependencies")).toBe(false);
    expect(encodeRecordPayloadV1(decoded)).toEqual(bytes);
    expect(decoded).toEqual(payload({
      sourceDependencies: [...payload().sourceDependencies],
      anchors: [
        { kind: "room", anchorRef: "room-a", role: "origin" },
        { kind: "subject", anchorRef: "postgres", role: "topic" },
      ],
      childRecordIds: ["record-a", "record-b"],
      terminalAuthorityLeafHandles: ["leaf-a", "leaf-b"],
    }));
  });

  test("canonically binds complete model exposure separately from citations", () => {
    const encoded = encodeRecordPayloadV1(payload({
      sourceDependencies: [],
      modelExposureDependencies: [
        {
          kind: "source",
          sourceKind: "memory",
          logicalObjectRef: "memory-b",
          observedRevision: "revision-2",
          observedContentFingerprint: null,
          terminalAuthorityLeafHandle: "leaf-b",
        },
        {
          kind: "record",
          recordId: "record-a",
          observedProcessingGeneration: 3,
          terminalAuthorityLeafHandles: ["leaf-c", "leaf-a"],
        },
      ],
    }));
    const decoded = decodeRecordPayloadV1(encoded);
    expect(decoded.sourceDependencies).toEqual([]);
    expect(decoded.modelExposureDependencies).toEqual([
      {
        kind: "record",
        recordId: "record-a",
        observedProcessingGeneration: 3,
        terminalAuthorityLeafHandles: ["leaf-a", "leaf-c"],
      },
      {
        kind: "source",
        sourceKind: "memory",
        logicalObjectRef: "memory-b",
        observedRevision: "revision-2",
        observedContentFingerprint: null,
        terminalAuthorityLeafHandle: "leaf-b",
      },
    ]);
    expect(encodeRecordPayloadV1(decoded)).toEqual(encoded);
    expect(Object.hasOwn(
      decodeRecordPayloadV1(encodeRecordPayloadV1(payload({
        modelExposureDependencies: [],
      }))),
      "modelExposureDependencies",
    )).toBe(true);
  });

  test("rejects malformed and duplicate model exposure relations", () => {
    expectCodecError(
      () => encodeRecordPayloadV1(payload({
        modelExposureDependencies: [{
          kind: "record",
          recordId: "record-a",
          observedProcessingGeneration: 0,
          terminalAuthorityLeafHandles: ["leaf-a"],
        }],
      })),
      "invalid_value",
    );
    expectCodecError(
      () => encodeRecordPayloadV1(payload({
        modelExposureDependencies: [{
          kind: "record",
          recordId: "record-a",
          observedProcessingGeneration: 1,
          terminalAuthorityLeafHandles: [],
        }],
      })),
      "invalid_value",
    );
    expectCodecError(
      () => encodeRecordPayloadV1(payload({
        modelExposureDependencies: [
          {
            kind: "source",
            sourceKind: "memory",
            logicalObjectRef: "memory-a",
            observedRevision: null,
            observedContentFingerprint: null,
            terminalAuthorityLeafHandle: "leaf-a",
          },
          {
            kind: "source",
            sourceKind: "memory",
            logicalObjectRef: "memory-a",
            observedRevision: "different",
            observedContentFingerprint: null,
            terminalAuthorityLeafHandle: "leaf-b",
          },
        ],
      })),
      "duplicate_reference",
    );
    expectCodecError(
      () => encodeRecordPayloadV1(payload({
        modelExposureDependencies: [{
          kind: "source",
          sourceKind: "memory",
          logicalObjectRef: "memory-a",
          observedRevision: null,
          observedContentFingerprint: null,
          terminalAuthorityLeafHandle: "leaf-a",
          unexpected: true,
        } as never],
      })),
      "unknown_field",
    );
  });

  test("gives ordinary storage and protected encryption identical bytes", () => {
    const ordinaryPayloadBytes = encodeRecordPayloadV1(payload());
    const protectedPlaintextBytes = encodeRecordPayloadV1(payload());
    expect(protectedPlaintextBytes).toEqual(ordinaryPayloadBytes);
  });

  test("rejects unknown versions and fields at every object level", () => {
    expectCodecError(
      () => encodeRecordPayloadV1({ ...payload(), formatVersion: 2 }),
      "unsupported_version",
    );
    expectCodecError(
      () => encodeRecordPayloadV1({ ...payload(), leakedStatement: "no" }),
      "unknown_field",
    );
    expectCodecError(
      () => encodeRecordPayloadV1({
        ...payload(),
        producer: { ...payload().producer, model: "hidden" },
      }),
      "unknown_field",
    );
    expectCodecError(
      () => encodeRecordPayloadV1({
        ...payload(),
        anchors: [{ ...payload().anchors[0]!, extra: true }],
      }),
      "unknown_field",
    );
    const missingProducer = Object.fromEntries(
      Object.entries(payload()).filter(([key]) => key !== "producer"),
    );
    expectCodecError(
      () => encodeRecordPayloadV1(missingProducer),
      "malformed",
    );
  });

  test("rejects malformed, trailing, duplicate-key, and noncanonical bytes", () => {
    const canonical = TEXT_DECODER.decode(encodeRecordPayloadV1(payload()));
    expectCodecError(
      () => decodeRecordPayloadV1(TEXT_ENCODER.encode(`${canonical} `)),
      "noncanonical",
    );
    expectCodecError(
      () => decodeRecordPayloadV1(TEXT_ENCODER.encode(`${canonical}junk`)),
      "malformed",
    );
    expectCodecError(
      () => decodeRecordPayloadV1(TEXT_ENCODER.encode(
        canonical.replace(
          "\"formatVersion\":1",
          "\"formatVersion\":1,\"formatVersion\":1",
        ),
      )),
      "noncanonical",
    );
    expectCodecError(
      () => decodeRecordPayloadV1(TEXT_ENCODER.encode(
        canonical.replace(
          "[\"record-a\",\"record-b\"]",
          "[\"record-b\",\"record-a\"]",
        ),
      )),
      "noncanonical",
    );
    expectCodecError(
      () => decodeRecordPayloadV1(new Uint8Array([0xff, 0xfe, 0xfd])),
      "malformed",
    );
  });

  test("rejects duplicate logical references before canonical sorting", () => {
    expectCodecError(
      () => encodeRecordPayloadV1({
        ...payload(),
        childRecordIds: ["record-a", "record-a"],
      }),
      "duplicate_reference",
    );
    expectCodecError(
      () => encodeRecordPayloadV1({
        ...payload(),
        sourceDependencies: [
          payload().sourceDependencies[0]!,
          {
            ...payload().sourceDependencies[0]!,
            observedRevision: "conflicting-revision",
          },
        ],
      }),
      "duplicate_reference",
    );
    expectCodecError(
      () => encodeRecordPayloadV1({
        ...payload(),
        anchors: [payload().anchors[0]!, payload().anchors[0]!],
      }),
      "duplicate_reference",
    );
  });

  test("enforces portable identifier and Unicode boundaries", () => {
    const exactId = "a".repeat(RECORD_PAYLOAD_V1_LIMITS.identifierBytes);
    expect(() => encodeRecordPayloadV1(payload({ childRecordIds: [exactId] })))
      .not.toThrow();
    expectCodecError(
      () => encodeRecordPayloadV1(payload({
        childRecordIds: [`a${"b".repeat(RECORD_PAYLOAD_V1_LIMITS.identifierBytes)}`],
      })),
      "invalid_identifier",
    );
    expectCodecError(
      () => encodeRecordPayloadV1(payload({ childRecordIds: ["not canonical"] })),
      "invalid_identifier",
    );
    expectCodecError(
      () => encodeRecordPayloadV1(payload({ statement: "\ud800" })),
      "invalid_value",
    );
    const longRevision = "r".repeat(1024);
    const extended = payload({sourceDependencies: [{
      ...payload().sourceDependencies[0]!, observedRevision: longRevision,
    }]});
    expect(decodeRecordPayloadV1(encodeRecordPayloadV1(extended))
      .sourceDependencies[0]!.observedRevision).toBe(longRevision);
  });

  test("accepts 800 Unicode code points and rejects the next one", () => {
    expect(() => encodeRecordPayloadV1(payload({ statement: "🧠".repeat(800) })))
      .not.toThrow();
    expectCodecError(
      () => encodeRecordPayloadV1(payload({ statement: "🧠".repeat(801) })),
      "invalid_value",
    );
  });

  test("does not turn operation bounds into semantic inventory ceilings", () => {
    expect(() => encodeRecordPayloadV1(payload({
      childRecordIds: Array.from(
        { length: 33 },
        (_, index) => `record-${String(index).padStart(2, "0")}`,
      ),
      terminalAuthorityLeafHandles: Array.from(
        { length: 257 },
        (_, index) => `leaf-${String(index).padStart(3, "0")}`,
      ),
    }))).not.toThrow();
  });

  test("enforces the total canonical payload-byte ceiling", () => {
    expectCodecError(
      () => decodeRecordPayloadV1(
        new Uint8Array(RECORD_PAYLOAD_V1_LIMITS.payloadBytes + 1),
      ),
      "oversized",
    );
  });
});
