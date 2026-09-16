import {describe, expect, test} from "bun:test";
import {stenographerOrdinaryOutputFingerprint, type StenographerOrdinaryOutputProvenance} from "../../src/journal/stenographer-ordinary-output-provenance.ts";

function receipt(): StenographerOrdinaryOutputProvenance {
  return {kind: "extraction", receiptId: "batch-1", roomId: "room-1", namespaceId: "namespace-1",
    rebuildGeneration: 2, fallbackReason: "device", outputs: [
      {logicalId: "event-1", objectType: "nautilo.reflection.record.v1", createdAt: 1000, payloadBytes: new TextEncoder().encode("first canonical record")},
      {logicalId: "event-2", objectType: "nautilo.reflection.record.v1", createdAt: 1000, payloadBytes: new TextEncoder().encode("second canonical record")},
    ]};
}

describe("Stenographer ordinary output provenance", () => {
  test("preserves the persisted ordinary-output/v1 digest after moving the implementation", () => {
    const source = receipt();
    expect(Buffer.from(stenographerOrdinaryOutputFingerprint(source)).toString("hex"))
      .toBe("03692592ba6806abff3d7935cdbc51080b44db6f3d4ee038e2af5cfb0ea1a11f");
    expect(Buffer.from(stenographerOrdinaryOutputFingerprint({...source, outputs: []})).toString("hex"))
      .toBe("499643c039548dccdce987ffa2dfa4613d9d9e59fbf6fdb4dfc7d6471053821c");
  });

  test("recomputes from durable values without taking ownership of ordinary bytes", () => {
    const source = receipt();
    const copy = structuredClone(source);
    const fingerprint = stenographerOrdinaryOutputFingerprint(source);
    expect(fingerprint).toHaveLength(32);
    expect(stenographerOrdinaryOutputFingerprint(copy)).toEqual(fingerprint);
    expect(source).toEqual(copy);
  });

  test("binds the receipt, audience, generation, reason, and exact ordered output bytes", () => {
    const source = receipt();
    const fingerprint = stenographerOrdinaryOutputFingerprint(source);
    const alternatives: StenographerOrdinaryOutputProvenance[] = [
      {...source, receiptId: "batch-2"}, {...source, roomId: "room-2"}, {...source, namespaceId: "namespace-2"},
      {...source, rebuildGeneration: 3}, {...source, fallbackReason: "authority"},
      {...source, outputs: []}, {...source, outputs: [...source.outputs].reverse()},
      {...source, outputs: source.outputs.map(output => ({...output, createdAt: 1001}))},
      {...source, outputs: source.outputs.map(output => ({...output, logicalId: `changed:${output.logicalId}`}))},
      {...source, outputs: source.outputs.map(output => ({...output, payloadBytes: new TextEncoder().encode("different stored result")}))},
    ];
    for (const alternative of alternatives) expect(stenographerOrdinaryOutputFingerprint(alternative)).not.toEqual(fingerprint);
  });

  test("rejects duplicated outputs and mixed Record/rollup inventories", () => {
    const source = receipt();
    expect(() => stenographerOrdinaryOutputFingerprint({...source, outputs: [source.outputs[0]!, source.outputs[0]!]})).toThrow();
    expect(() => stenographerOrdinaryOutputFingerprint({...source, kind: "compaction"})).toThrow();
    expect(() => stenographerOrdinaryOutputFingerprint({...source, rebuildGeneration: -1})).toThrow();
  });
});
