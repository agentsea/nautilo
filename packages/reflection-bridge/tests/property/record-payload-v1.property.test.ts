import { expect, test } from "bun:test";
import {
  decodeRecordPayloadV1,
  encodeRecordPayloadV1,
  RECORD_PAYLOAD_FORMAT_VERSION_V1,
  RecordPayloadCodecError,
  type RecordPayloadAnchorKindV1,
  type RecordPayloadV1,
} from "../../src/record-payload-v1";

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function shuffled<T>(values: readonly T[], next: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1));
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
}

function generatedPayload(seed: number): RecordPayloadV1 {
  const next = random(seed);
  const count = (maximum: number): number => 1 + Math.floor(next() * maximum);
  const sourceDependencies = Array.from({ length: count(12) }, (_, index) => ({
    sourceKind: index % 2 === 0 ? "memory" : "journal_event",
    logicalObjectRef: `source-${seed}-${index}`,
    observedRevision: index % 3 === 0 ? null : `revision-${seed}-${index}`,
    observedContentFingerprint: `sha256:${seed.toString(16)}-${index}`,
    terminalAuthorityLeafHandle: `leaf-${seed}-${index}`,
    authorityBearing: true,
  }));
  const kinds: readonly RecordPayloadAnchorKindV1[] = [
    "room",
    "task",
    "artifact",
    "subject",
  ];
  const anchors = Array.from({ length: count(12) }, (_, index) => ({
    kind: kinds[index % kinds.length]!,
    anchorRef: `anchor-${seed}-${index}`,
    role: `role-${index % 3}`,
  }));
  return {
    formatVersion: RECORD_PAYLOAD_FORMAT_VERSION_V1,
    posture: "derived",
    observedContentFingerprint: `sha256:record-${seed}`,
    sourceOwnedKind: seed % 2 === 0 ? "journal_event" : null,
    observedLogicalObjectRef: seed % 3 === 0 ? `logical-${seed}` : null,
    observedRevision: seed % 5 === 0 ? `revision-${seed}` : null,
    statement: `Decision ${seed} preserves evidence 🧠${"x".repeat(seed % 97)}`,
    sourceDependencies: shuffled(sourceDependencies, next),
    anchors: shuffled(anchors, next),
    childRecordIds: shuffled(
      Array.from({ length: count(16) }, (_, index) => `record-${seed}-${index}`),
      next,
    ),
    producer: {
      producerRef: "organizer",
      policyVersion: `policy-${seed % 7}`,
    },
    terminalAuthorityLeafHandles: shuffled(
      Array.from({ length: count(24) }, (_, index) => `leaf-${seed}-${index}`),
      next,
    ),
  };
}

test("RecordPayloadV1 deterministic property corpus round-trips canonically", () => {
  for (let seed = 1; seed <= 300; seed += 1) {
    const input = generatedPayload(seed);
    const first = encodeRecordPayloadV1(input);
    const decoded = decodeRecordPayloadV1(first);
    const second = encodeRecordPayloadV1(decoded);
    expect(second).toEqual(first);

    const reordered = {
      ...input,
      sourceDependencies: [...input.sourceDependencies].reverse(),
      anchors: [...input.anchors].reverse(),
      childRecordIds: [...input.childRecordIds].reverse(),
      terminalAuthorityLeafHandles: [
        ...input.terminalAuthorityLeafHandles,
      ].reverse(),
    };
    expect(encodeRecordPayloadV1(reordered)).toEqual(first);

    const suffixed = new Uint8Array(first.length + 1);
    suffixed.set(first);
    suffixed[first.length] = 0x20;
    expect(() => decodeRecordPayloadV1(suffixed)).toThrow(RecordPayloadCodecError);
  }
});
