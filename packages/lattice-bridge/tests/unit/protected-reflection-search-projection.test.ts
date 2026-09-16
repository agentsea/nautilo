import {describe, expect, test} from "bun:test";
import type {DurableSleepClaim} from "@nautilo/reflection/durable";
import {encodeRecordPayloadV1} from "@nautilo/reflection/payload";
import {RECORD_SEARCH_POLICY_V1, type RecordEmbeddingResult, type RecordSearchProjectionV1} from "@nautilo/reflection/search";
import {createProtectedReflectionSearchProjection, type ProtectedReflectionSearchMetadata, type ProtectedReflectionSearchProjectionPorts} from "../../src/server/reflection/protected-search-projection.ts";
import type {ReflectionSemanticOperationRequest} from "../../src/server/reflection/semantic-operation.ts";

const claim: DurableSleepClaim = {recordRef: "record-1", logicalObjectRef: "logical-1", generation: 4, changeReason: "created", stage: "search_projection", leaseToken: "lease-1"};
const provenance = {provider: "openai", canonicalModel: "text-embedding-3-small", dimensions: 1536, contractVersion: 1} as const;
function projected(): NonNullable<ProtectedReflectionSearchMetadata["currentProjection"]> {
  return {recordRef: "record-1", recordProcessingGeneration: 2, projectionVersion: 1, projectionGeneration: 1,
    embeddingProvider: provenance.provider, embeddingCanonicalModel: provenance.canonicalModel, embeddingDimensions: provenance.dimensions, embeddingContractVersion: 1};
}
function fixture() {
  const metadata: ProtectedReflectionSearchMetadata = {recordRef: "record-1", processingGeneration: 2, representationGeneration: 1, producerPolicyVersion: "policy-1", lifecycle: "current",
    inputBinding: {objectId: "object-1", namespaceId: "namespace-1", objectType: "nautilo.reflection.record.v1"}, expectedEmbeddingProvenance: provenance, currentProjection: null};
  let current = metadata;
  let bytes = encodeRecordPayloadV1({formatVersion: 1, posture: "derived", observedContentFingerprint: "fingerprint-1", sourceOwnedKind: null, observedLogicalObjectRef: null, observedRevision: null,
    statement: "The launch is on Tuesday.", sourceDependencies: [], anchors: [{kind: "room", anchorRef: "room-1", role: "origin"}], childRecordIds: [], producer: {producerRef: "reflection", policyVersion: "policy-1"}, terminalAuthorityLeafHandles: ["namespace-1"]});
  const calls: string[] = [], vectors: readonly number[][] = [];
  let stored: RecordSearchProjectionV1 | undefined;
  let operation: ReflectionSemanticOperationRequest | undefined;
  let gateOutcome: "executed" | "waiting" | "reconciliation_required" = "executed";
  let afterEmbedding: (() => void) | undefined;
  let embeddingOutcome: RecordEmbeddingResult = {status: "available", embedding: {provenance, vector: Object.freeze(new Array<number>(RECORD_SEARCH_POLICY_V1.embeddingDimensions).fill(0.25))}};
  const ports: ProtectedReflectionSearchProjectionPorts = {
    resolveMetadata: async () => {calls.push("metadata"); return structuredClone(current);},
    embedding: {embed: async request => {calls.push("embed"); expect(request.purpose).toBe("record.statement_embedding"); expect(request.plaintext).toBe("The launch is on Tuesday."); afterEmbedding?.(); return embeddingOutcome;}},
    nextRetryAt: () => 100_000,
    publish: async request => {
      calls.push("publish"); expect(request.expectedProjectionGeneration).toBeNull(); expect(request.claim).toEqual(claim); expect(request.metadata.inputBinding).toEqual(metadata.inputBinding);
      expect(request.held.product).toBeDefined(); (vectors as number[][]).push(request.projection.embedding.vector as number[]);
      await request.authorizeCommit(); stored = structuredClone(request.projection); current = {...current, currentProjection: projected()}; return "published";
    },
    operation: {runSemantic: async request => {
      operation = request; calls.push("gate");
      expect(request.workKind).toBe("reflection.search_projection"); expect(request.coordinates.outputNamespaceIds).toEqual([]);
      expect(request.coordinates.inputBindings).toEqual([metadata.inputBinding]); expect(request.coordinates.claimGeneration).toBe(claim.generation);
      if (gateOutcome === "waiting") return {status: gateOutcome};
      const signal = request.signal ?? new AbortController().signal;
      const input = {...metadata.inputBinding, plaintext: bytes.slice(), signal};
      try {
        await request.validateInput(input);
        const output = await request.execute([input], undefined, signal, () => {signal.throwIfAborted(); return Promise.resolve();}); expect(output).toBeNull();
        await request.attach({output, claimId: "crypto-claim-1", held: {executor: {query: async () => []}, product: {query: async () => []}, issuerSigningPublicKey: new Uint8Array(32)}, signal,
          authorizeCommit: async () => {calls.push("authorize"); signal.throwIfAborted(); return 10_000;}});
        return {status: gateOutcome};
      } finally {input.plaintext.fill(0);}
    }},
  };
  return {ports, calls, vectors, getStored: () => stored, getOperation: () => operation, setCurrent: (value: Partial<ProtectedReflectionSearchMetadata>) => {current = {...current, ...value};},
    setBytes: (value: Uint8Array) => {bytes = value;}, setGateOutcome: (value: typeof gateOutcome) => {gateOutcome = value;}, setEmbeddingOutcome: (value: RecordEmbeddingResult) => {embeddingOutcome = value;},
    afterEmbedding: (change: () => void) => {afterEmbedding = change;}};
}

describe("protected Reflection search projection", () => {
  test("one exact payload is decoded, embedded once and transactionally published with no crypto output", async () => {
    const f = fixture(); expect(await createProtectedReflectionSearchProjection(f.ports).ensureSearchProjection(claim)).toEqual({status: "ready"});
    expect(f.calls.filter(call => call === "embed")).toHaveLength(1); expect(f.calls.filter(call => call === "authorize")).toHaveLength(1);
    expect(f.getStored()?.embedding.vector[0]).toBe(0.25); expect(f.vectors[0]?.every(value => value === 0)).toBe(true);
    expect(await createProtectedReflectionSearchProjection(f.ports).ensureSearchProjection(claim)).toEqual({status: "ready"});
    expect(f.calls.filter(call => call === "embed")).toHaveLength(1);
  });
  test("missing device/grant and provider availability use the existing wait schedule without fake publication", async () => {
    for (const reason of ["grant", "provider"] as const) {
      const f = fixture(); if (reason === "grant") f.setGateOutcome("waiting"); else f.setEmbeddingOutcome({status: "unavailable", reason: "provider_unavailable"});
      expect(await createProtectedReflectionSearchProjection(f.ports).ensureSearchProjection(claim)).toEqual({status: "waiting", retryAt: 100_000});
      expect(f.calls).not.toContain("publish"); expect(f.calls).not.toContain("authorize");
      if (reason === "grant") expect(f.calls).not.toContain("embed");
    }
  });
  test("exact compatible projection bypasses grant and provider calls", async () => {
    const f = fixture(); f.setCurrent({currentProjection: projected()});
    expect(await createProtectedReflectionSearchProjection(f.ports).ensureSearchProjection(claim)).toEqual({status: "ready"});
    expect(f.calls).toEqual(["metadata"]);
  });
  test("malformed canonical payload and wrong producer policy never reach embedding", async () => {
    const f = fixture(); f.setBytes(new TextEncoder().encode('{"statement":"unauthenticated"}'));
    expect(createProtectedReflectionSearchProjection(f.ports).ensureSearchProjection(claim)).rejects.toMatchObject({failureClass: "integrity"});
    const g = fixture(); g.setCurrent({producerPolicyVersion: "different-policy"});
    expect(createProtectedReflectionSearchProjection(g.ports).ensureSearchProjection(claim)).rejects.toMatchObject({failureClass: "integrity"});
    await new Promise<void>(resolve => {setTimeout(resolve, 0);});
    expect(f.calls).not.toContain("embed"); expect(g.calls).not.toContain("embed");
  });
  test("metadata changes after provider completion are stale without publication or substitution", async () => {
    const f = fixture(); f.afterEmbedding(() => f.setCurrent({processingGeneration: 3}));
    expect(createProtectedReflectionSearchProjection(f.ports).ensureSearchProjection(claim)).rejects.toMatchObject({failureClass: "stale"});
    await new Promise<void>(resolve => {setTimeout(resolve, 0);}); expect(f.calls).not.toContain("publish");
  });
  test("actual canonical provider model aliases are retained instead of rejected", async () => {
    const f = fixture(); f.setEmbeddingOutcome({status: "available", embedding: {provenance: {...provenance, canonicalModel: "canonical-returned-model"}, vector: new Array<number>(1536).fill(0.5)}});
    expect(await createProtectedReflectionSearchProjection(f.ports).ensureSearchProjection(claim)).toEqual({status: "ready"});
    expect(f.getStored()?.embedding.provenance.canonicalModel).toBe("canonical-returned-model");
  });
  test("lost completion reply reuses the committed compatible projection", async () => {
    const f = fixture(); f.setGateOutcome("reconciliation_required");
    expect(await createProtectedReflectionSearchProjection(f.ports).ensureSearchProjection(claim)).toEqual({status: "ready"});
    expect(f.calls.filter(call => call === "embed")).toHaveLength(1);
  });
  test("skipped and swallowed duplicate commit permits cannot report success, and vectors are wiped", async () => {
    for (const mode of ["skip", "duplicate"] as const) {
      const f = fixture(); let lent: readonly number[] = [];
      expect(createProtectedReflectionSearchProjection({...f.ports, publish: async request => {
        lent = request.projection.embedding.vector;
        if (mode === "duplicate") {await request.authorizeCommit(); await request.authorizeCommit().catch(() => {});}
        return "published";
      }}).ensureSearchProjection(claim)).rejects.toMatchObject({failureClass: "integrity"});
      await new Promise<void>(resolve => {setTimeout(resolve, 0);}); expect(lent.every(value => value === 0)).toBe(true);
    }
  });
  test("cancellation at publication wipes borrowed vectors and rejects a retained late permit", async () => {
    const f = fixture(); const controller = new AbortController(); let lent: readonly number[] = []; let late: (() => Promise<number>) | undefined;
    const run = createProtectedReflectionSearchProjection({...f.ports, publish: async request => {
      lent = request.projection.embedding.vector; late = request.authorizeCommit; controller.abort(new Error("cancelled")); await request.authorizeCommit(); return "published";
    }}).ensureSearchProjection(claim, controller.signal);
    expect(run).rejects.toThrow("cancelled"); await run.catch(() => {});
    expect(lent.every(value => value === 0)).toBe(true); expect(late!()).rejects.toThrow();
  });
});
