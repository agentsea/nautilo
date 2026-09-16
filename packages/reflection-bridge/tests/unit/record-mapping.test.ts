import { describe, expect, test } from "bun:test";
import type { DurableRecordEnvelope } from "@nautilo/reflection/durable";

import {
  decodeDurableRecordEnvelope,
  encodeDurableRecordEnvelope,
} from "../../src/server/record-mapping";

function envelope(): DurableRecordEnvelope {
  return {
    recordRef: "record-output",
    semantic: {
      observedContentFingerprint: "fingerprint:output",
      posture: "derived",
      statement: "A generated statement.",
      sourceDependencies: [],
      anchors: [{ kind: "room", anchorRef: "room-one", role: "origin" }],
      childRecordRefs: [],
      producer: { producerRef: "organizer", policyVersion: "policy-one" },
      terminalAuthorityLeafHandles: ["leaf-two", "leaf-one"],
      modelExposureDependencies: [
        {
          kind: "source",
          sourceKind: "memory",
          logicalSourceRef: "memory-one",
          observedRevision: "revision-one",
          terminalAuthorityLeafHandle: "leaf-two",
        },
        {
          kind: "record",
          recordRef: "record-input",
          observedProcessingGeneration: 2,
          terminalAuthorityLeafHandles: ["leaf-one"],
        },
      ],
    },
    lifecycle: "current",
    structuralHeight: 1,
    processingGeneration: 1,
  };
}

describe("Record payload mapping", () => {
  test("round-trips immutable model exposure independently of citations", () => {
    const original = envelope();
    const decoded = decodeDurableRecordEnvelope({
      recordRef: original.recordRef,
      lifecycle: original.lifecycle,
      structuralHeight: original.structuralHeight,
      processingGeneration: original.processingGeneration,
      payloadBytes: encodeDurableRecordEnvelope(original),
    });
    expect(decoded.semantic.sourceDependencies).toEqual([]);
    expect(decoded.semantic.modelExposureDependencies).toEqual([
      {
        kind: "record",
        recordRef: "record-input",
        observedProcessingGeneration: 2,
        terminalAuthorityLeafHandles: ["leaf-one"],
      },
      {
        kind: "source",
        sourceKind: "memory",
        logicalSourceRef: "memory-one",
        observedRevision: "revision-one",
        terminalAuthorityLeafHandle: "leaf-two",
      },
    ]);
  });

  test("preserves absence for legacy envelope bytes", () => {
    const legacy = envelope();
    const legacySemantic = { ...legacy.semantic };
    delete legacySemantic.modelExposureDependencies;
    const legacyEnvelope = { ...legacy, semantic: legacySemantic };
    const bytes = encodeDurableRecordEnvelope(legacyEnvelope);
    const decoded = decodeDurableRecordEnvelope({
      recordRef: legacy.recordRef,
      lifecycle: legacy.lifecycle,
      structuralHeight: legacy.structuralHeight,
      processingGeneration: legacy.processingGeneration,
      payloadBytes: bytes,
    });
    expect(Object.hasOwn(decoded.semantic, "modelExposureDependencies")).toBe(false);
    expect(encodeDurableRecordEnvelope(decoded)).toEqual(bytes);
  });
});
