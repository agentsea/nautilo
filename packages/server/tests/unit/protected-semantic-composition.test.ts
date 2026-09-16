import {describe, expect, test} from "bun:test";
import {prepareReflectionSemanticQuestion, type ProtectedReflectionMessageMetadata,
  type ReflectionSemanticOperationRequest} from "@nautilo/lattice-bridge/server";
import type {DurableRecordEnvelope, DurableRecordPublication} from "@nautilo/reflection/durable";
import {DualModeRecordRepository, ExactGroundedDependencyLossResolver,
  createHmacRecordRequestCommitmentPort, encodeDurableRecordEnvelope} from "@nautilo/reflection-bridge/server";
import {InMemoryRecordProductStore} from "@nautilo/reflection-bridge/testing";
import {createGateBoundReflectionRecordPublication,
  createProtectedReflectionMessageCoordinate} from "../../src/reflection/protected-semantic-composition";

const record: DurableRecordEnvelope = {recordRef: "record:generated", lifecycle: "current", structuralHeight: 0, processingGeneration: 1,
  semantic: {posture: "derived", statement: "The release is Tuesday.", observedContentFingerprint: "fingerprint:generated",
    childRecordRefs: [], sourceDependencies: [{sourceKind: "memory", logicalSourceRef: "memory:one", observedRevision: "1",
      observedContentFingerprint: "fingerprint:memory", terminalAuthorityLeafHandle: "namespace:one", authorityBearing: true}],
    anchors: [{kind: "room", anchorRef: "room:one", role: "origin"}], terminalAuthorityLeafHandles: ["namespace:one"],
    producer: {producerRef: "organizer", policyVersion: "candidate-policy-v1"}}};
const publication: DurableRecordPublication = {record, idempotencyKey: "sleep:anchor:1", publicationBindingRef: "binding:one"};
const commitments = createHmacRecordRequestCommitmentPort(new Uint8Array(32).fill(3));
const outputId = "object:output";
const signal = new AbortController().signal;
function attachment(output: Parameters<ReflectionSemanticOperationRequest["attach"]>[0]["output"], authorize = async () => 100,
  ordinarySiblingAllowed?: boolean) {
  return {output, signal, claimId: "crypto:claim", authorizeCommit: authorize,
    held: {executor: {query: async () => []}, product: {query: async () => []}, issuerSigningPublicKey: new Uint8Array(32),
      ...(ordinarySiblingAllowed === undefined ? {} : {ordinarySiblingAllowed})}};
}
function fixture(attachShadowSibling?: Parameters<typeof createGateBoundReflectionRecordPublication>[0]["attachShadowSibling"]) {
  const product = new InMemoryRecordProductStore();
  const gate = createGateBoundReflectionRecordPublication({product, outputObjectId: outputId,
    open: () => Promise.resolve({status: "unavailable", reason: "unauthorized"}),
    ...(attachShadowSibling === undefined ? {} : {attachShadowSibling})});
  const repository = new DualModeRecordRepository({product, commitment: commitments,
    selection: {selectedRepresentation: "protected", migrationGeneration: 1}, protectedPublication: gate.publication});
  return {product, gate, repository};
}

test("protected Message exposure uses its own exact Namespace binding", () => {
  const message: ProtectedReflectionMessageMetadata = {
    messageId: 41,
    logicalSourceRef: "message:41",
    sessionId: "session:one",
    roomId: "room:message",
    namespaceId: "namespace:message",
    namespaceAccessRevision: 8,
    editRevision: 3,
    role: "user",
    inputBinding: {
      objectId: "message:object",
      namespaceId: "namespace:message",
      objectType: "nautilo-message-v2",
    },
  };
  expect(createProtectedReflectionMessageCoordinate({
    message,
    selection: {selectedRepresentation: "protected", migrationGeneration: 4},
  })).toEqual({
    kind: "source",
    role: "candidate",
    sourceKind: "message",
    logicalSourceRef: "message:41",
    contentGeneration: 3,
    representationGeneration: 4,
    authorityGeneration: 9,
    read: {
      namespaceRef: "namespace:message",
      bindingRef: "journal:namespace:namespace:message:protected:v4",
    },
  });
});

describe("production protected semantic publication uses the existing repository receipt", () => {
  test.each(["fallback", "strict"] as const)("%s Shadow attaches one ordinary sibling from the verified output", async () => {
    type SiblingInput = Parameters<NonNullable<Parameters<typeof createGateBoundReflectionRecordPublication>[0]["attachShadowSibling"]>>[0];
    const siblingCalls: SiblingInput[] = [];
    const f = fixture(async value => {siblingCalls.push(value);});
    f.gate.setCompletion(async output => {
      f.gate.validateOutput(output!);
      await f.gate.attach(attachment(output, async () => 100, true), f.product);
      return {status: "executed"};
    });
    expect(await f.repository.publish(publication)).toMatchObject({status: "published"});
    expect(siblingCalls).toHaveLength(1);
    expect(siblingCalls[0]!.publication.idempotencyKey).toBe(publication.idempotencyKey);
    expect(siblingCalls[0]!.requestCommitment).toBeInstanceOf(Uint8Array);
    expect(siblingCalls[0]!.plaintext).toBeInstanceOf(Uint8Array);
    f.gate.dispose();
  });

  test.each([undefined, false] as const)("ordinary sibling permission %s performs no ordinary write", async allowed => {
    let siblingCalls = 0;
    const f = fixture(async () => {siblingCalls++;});
    f.gate.setCompletion(async output => {
      await f.gate.attach(attachment(output, async () => 100, allowed), f.product);
      return {status: "executed"};
    });
    expect(await f.repository.publish(publication)).toMatchObject({status: "published"});
    expect(siblingCalls).toBe(0);
    f.gate.dispose();
  });

  test("Shadow permission fails closed when the sibling seam is absent", async () => {
    const f = fixture();
    f.gate.setCompletion(async output => {
      await f.gate.attach(attachment(output, async () => 100, true), f.product);
      return {status: "executed"};
    });
    expect(f.repository.publish(publication)).rejects.toThrow();
    f.gate.dispose();
  });

  test("denied commit authority never invokes the sibling seam", async () => {
    let siblingCalls = 0;
    const f = fixture(async () => {siblingCalls++;});
    f.gate.setCompletion(async output => {
      await f.gate.attach(attachment(output, () => Promise.reject(new Error("revoked")), true), f.product);
      return {status: "executed"};
    });
    expect(f.repository.publish(publication)).rejects.toThrow();
    expect(siblingCalls).toBe(0);
    f.gate.dispose();
  });

  test("sibling failure aborts protected completion", async () => {
    const f = fixture(async () => {throw new Error("sibling conflict");});
    f.gate.setCompletion(async output => {
      await f.gate.attach(attachment(output, async () => 100, true), f.product);
      return {status: "executed"};
    });
    expect(f.repository.publish(publication)).rejects.toThrow();
    expect(await f.product.readCompletedPublicationRecordId({idempotencyKey: publication.idempotencyKey}))
      .toMatchObject({status: "unavailable", reason: "incomplete"});
    f.gate.dispose();
  });

  test("no-output completion never invokes the sibling seam", async () => {
    let siblingCalls = 0;
    const f = fixture(async () => {siblingCalls++;});
    f.gate.setCompletion(async output => {
      await f.gate.attach(attachment(output, async () => 100, true), f.product);
      return {status: "executed"};
    });
    await f.gate.finishNoChange();
    expect(siblingCalls).toBe(0);
    f.gate.dispose();
  });

  test("binds the reserved output before crypto, then finishes canonical publication only after held attachment", async () => {
    const f = fixture(); let authorized = false;
    f.gate.setCompletion(async output => {
      expect(output?.objectId).toBe(outputId);
      expect(await f.product.readVisible({recordId: record.recordRef, representation: "protected"})).toMatchObject({status: "unavailable"});
      const pending = await f.product.claimDueProtected(1);
      expect(pending[0]?.reservedCryptoObjectId).toBe(outputId);
      expect(pending[0]?.cryptoObjectId).toBeUndefined();
      f.gate.validateOutput(output!);
      await f.gate.attach(attachment(output, async () => {authorized = true; return 100;}), f.product);
      return {status: "executed"};
    });
    expect(await f.repository.publish(publication)).toMatchObject({status: "published", record: {recordRef: record.recordRef}});
    expect(authorized).toBe(true);
    expect(await f.product.readVisible({recordId: record.recordRef, representation: "protected"})).toMatchObject({status: "available", row: {cryptoObjectId: outputId}});
    f.gate.dispose();
  });

  test("captures the full publication and rejects output bytes that differ from its reservation", async () => {
    const f = fixture(), value = structuredClone(publication);
    const commitment = commitments.commit(encodeDurableRecordEnvelope(value.record), value);
    await f.product.reserveProtected({publication: value, requestCommitment: commitment});
    Object.assign(value.record.semantic, {statement: "Mutated after reservation"});
    const original = encodeDurableRecordEnvelope(record), mutated = encodeDurableRecordEnvelope(value.record);
    expect(() => f.gate.validateOutput({objectId: outputId, plaintext: original})).not.toThrow();
    expect(() => f.gate.validateOutput({objectId: outputId, plaintext: mutated})).toThrow();
    expect(() => f.gate.validateOutput({objectId: "object:other", plaintext: original})).toThrow();
    original.fill(0); mutated.fill(0); f.gate.dispose();
    expect(() => f.gate.validateOutput({objectId: outputId, plaintext: original})).toThrow();
  });

  test("a denied attachment never marks crypto complete or exposes a product Record", async () => {
    const f = fixture();
    f.gate.setCompletion(async output => {
      await f.gate.attach(attachment(output, () => Promise.reject(new Error("revoked"))), f.product);
      return {status: "executed"};
    });
    expect(await f.repository.publish(publication).then(() => null, (error: unknown) => error)).toBeInstanceOf(Error);
    expect(await f.product.readVisible({recordId: record.recordRef, representation: "protected"})).toMatchObject({status: "unavailable"});
    const pending = await f.product.claimDueProtected(1);
    expect(pending[0]?.reservedCryptoObjectId).toBe(outputId);
    expect(pending[0]?.cryptoObjectId).toBeUndefined();
    f.gate.dispose();
  });

  test("a stale final product fence after commit authorization prevents attachment", async () => {
    const f = fixture();
    const events: string[] = [];
    f.gate.setCompletion(async output => {
      await f.gate.attach(attachment(output, async () => {
        events.push("authorized");
        events.push("final-fence");
        throw new Error("stale cross-Room input");
      }), f.product);
      return {status: "executed"};
    });
    expect(await f.repository.publish(publication)
      .then(() => null, (error: unknown) => error)).toBeInstanceOf(Error);
    expect(events).toEqual(["authorized", "final-fence"]);
    expect(await f.product.readVisible({
      recordId: record.recordRef,
      representation: "protected",
    })).toMatchObject({status: "unavailable"});
    const pending = await f.product.claimDueProtected(1);
    expect(pending[0]?.reservedCryptoObjectId).toBe(outputId);
    expect(pending[0]?.cryptoObjectId).toBeUndefined();
    f.gate.dispose();
  });

  test("no change attaches exactly once without reserving or publishing a Record", async () => {
    const f = fixture(); let commits = 0;
    f.gate.setCompletion(async output => {expect(output).toBeNull(); await f.gate.attach(attachment(output, async () => ++commits), f.product); return {status: "executed"};});
    await f.gate.finishNoChange(); await f.gate.finishNoChange();
    expect(commits).toBe(1); expect(await f.product.claimDueProtected(1)).toEqual([]);
    expect(() => f.gate.setCompletion(async () => ({status: "executed"}))).toThrow();
    f.gate.dispose();
  });

  test("prepared completion waits through attachment and owns the output buffer until commit", async () => {
    const f = fixture(); let attachStarted!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => {attachStarted = resolve;});
    const held = new Promise<void>(resolve => {release = resolve;});
    let bytes: Uint8Array | undefined;
    const prepared = await prepareReflectionSemanticQuestion({
      operation: {async runSemantic(request) {
        const output = await request.execute([], outputId, request.signal!, async () => {request.signal!.throwIfAborted();});
        if (output !== null) {bytes = output.plaintext; await request.validateOutput({...output, signal: request.signal!});}
        attachStarted(); await held;
        await request.attach(attachment(output)); return {status: "executed"};
      }}, request: {workKind: "reflection.organization", coordinates: {recordRef: "anchor:distinct", claimGeneration: 1, inputBindings: [], outputNamespaceIds: ["namespace:one"]},
        validateInput: async () => {}, validateOutput: async output => {f.gate.validateOutput(output);}, attach: operation => f.gate.attach(operation, f.product)},
      prepare: async () => f.repository,
    });
    expect(prepared.status).toBe("ready"); if (prepared.status !== "ready") throw new Error("not ready");
    f.gate.setCompletion(output => prepared.complete(output));
    let finished = false;
    const publishing = prepared.value.publish(publication).then(result => {finished = true; return result;});
    await started; expect(finished).toBe(false); expect(bytes?.some(byte => byte !== 0)).toBe(true);
    release(); expect(await publishing).toMatchObject({status: "published"});
    expect(bytes?.every(byte => byte === 0)).toBe(true); await prepared.close(); f.gate.dispose();
  });
});

import {encodeMemoryPayloadV1} from "@nautilo/lattice-bridge";
import type {PostgresProtectedOrganizerMetadata, ProtectedOrganizerMemoryMetadata} from "@nautilo/lattice-bridge/server";
import {createHmacOrdinarySourceFingerprintPort} from "@nautilo/runtime";
import {createGateBoundReflectionMemorySources} from "../../src/reflection/protected-semantic-composition";

function memoryFixture() {
  const metadata: ProtectedOrganizerMemoryMetadata = {memoryRef: "one", logicalSourceRef: "memory:one", contentRevision: 7, cryptoAccessRevision: 2,
    inputBinding: {objectId: "memory:object", namespaceId: "namespace:one", objectType: "nautilo-memory-v1"}};
  let current: Awaited<ReturnType<PostgresProtectedOrganizerMetadata["resolveMemoryDependency"]>> =
    {status: "available", metadata: structuredClone(metadata)};
  const controller = new AbortController(), key = new Uint8Array(32).fill(6);
  const payload = {formatVersion: 1 as const, type: "fact", content: "The launch is Tuesday."};
  const bytes = encodeMemoryPayloadV1(payload);
  const sources = createGateBoundReflectionMemorySources({commitmentKey: key, memories: new Map([[metadata.logicalSourceRef, metadata]]),
    payloads: new Map([[metadata.inputBinding.objectId, {plaintext: bytes}]]), scores: new Map([[metadata.logicalSourceRef, 0.9]]),
    roomBindings: new Map([[metadata.logicalSourceRef, {roomAnchorRef: "room:one", readBindingRef: "binding:one"}]]), signal: controller.signal, resolveMemoryDependency: async request => {
      expect(request.namespaceId).toBe(metadata.inputBinding.namespaceId);
      expect(request.observedRevision).toBe(String(metadata.contentRevision)); return current;
    }});
  return {sources, metadata, payload, key, controller, bytes, setCurrent: (value: typeof current) => {current = value;}};
}

describe("protected same-Room Memory bodies", () => {
  test("uses the canonical source fingerprint and typed snapshot from only declared plaintext", async () => {
    const f = memoryFixture(), candidate = f.sources.memoryValues.get("memory:one")!;
    const fingerprint = createHmacOrdinarySourceFingerprintPort(f.key).memory({id: "one", contentRevision: 7,
      type: f.payload.type, content: f.payload.content});
    expect(candidate.dependency.observedContentFingerprint).toBe(fingerprint);
    expect(candidate.snapshot).toMatchObject({posture: "authored", statement: f.payload.content, sourceOwnedKind: "memory", anchors: ["room:one"], observedRevision: "7"});
    expect(await f.sources.sources.readExact({dependency: candidate.dependency, evidenceBindingRef: "binding:one", returnedBytesMaximum: 1000}))
      .toEqual({status: "available", kind: "memory", content: f.payload.content});
    expect(await f.sources.sources.readExact({dependency: candidate.dependency, evidenceBindingRef: "binding:one", returnedBytesMaximum: 1})
      .then(() => null, (error: unknown) => error)).toBeInstanceOf(Error);
    f.sources.dispose(); expect(f.sources.memoryValues.size).toBe(0); f.bytes.fill(0);
  });

  test("revoked, changed or undeclared Memory never yields content", async () => {
    for (const change of ["revision", "access", "object", "missing"] as const) {
      const f = memoryFixture(), dependency = f.sources.memoryValues.get("memory:one")!.dependency;
      f.setCurrent(change === "missing" ? {status: "missing"} : change === "revision" ? {status: "changed"}
        : {status: "available", metadata: {...f.metadata, ...(change === "access" ? {cryptoAccessRevision: 3} : {}),
          ...(change === "object" ? {inputBinding: {...f.metadata.inputBinding, objectId: "other"}} : {})}});
      expect(await f.sources.sources.readExact({dependency, evidenceBindingRef: "binding:one", returnedBytesMaximum: 1000}))
        .toEqual({status: change === "missing" ? "unavailable" : "changed"});
      f.sources.dispose(); f.bytes.fill(0);
    }
  });

  test("mapping waits and metadata failures abort dependency-loss reads", async () => {
    for (const status of ["waiting", "unavailable"] as const) {
      const f = memoryFixture(), dependency = f.sources.memoryValues.get("memory:one")!.dependency;
      f.setCurrent({status});
      expect(await f.sources.sources.readExact({dependency, evidenceBindingRef: "binding:one", returnedBytesMaximum: 1000})
        .then(() => null, (error: unknown) => error)).toBeInstanceOf(Error);
      f.sources.dispose(); f.bytes.fill(0);
    }
    const f = memoryFixture(), dependency = f.sources.memoryValues.get("memory:one")!.dependency;
    expect(await f.sources.validateMemory({...dependency, logicalSourceRef: "memory:undeclared"})
      .then(() => null, (error: unknown) => error)).toBeInstanceOf(Error);
    f.sources.dispose(); f.bytes.fill(0);
  });

  test("does not admit a pending mapping as dependency loss", async () => {
    const f = memoryFixture(), dependency = f.sources.memoryValues.get("memory:one")!.dependency;
    const invalidations: unknown[] = [];
    f.setCurrent({status: "waiting"});
    const resolver = new ExactGroundedDependencyLossResolver({repository: {} as never, eligibility: {} as never,
      source: f.sources.sources, invalidation: {async admit(value) {invalidations.push(value);}},
      statements: {async rewrite() {return {status: "unavailable"};}}});
    const error = await resolver.resolve({claim: {logicalObjectRef: record.recordRef, generation: 1, recordRef: record.recordRef,
      changeReason: "dependency_lost", stage: "organization", leaseToken: "lease:one"},
    record: {...record, semantic: {...record.semantic, sourceDependencies: [dependency]}},
    binding: {roomAnchorRef: "room:one", invocationAudience: {humanRefs: ["human:one"], includesPublicBoundary: false},
      readBindingRef: "read:one", searchBindingRef: "search:one", publicationBindingRef: "publish:one"}})
      .then(() => null, (value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect(invalidations).toEqual([]);
    f.sources.dispose(); f.bytes.fill(0);
  });

  test("cancellation drops decoded Memory references and rejects subsequent disclosure", async () => {
    const f = memoryFixture(), dependency = f.sources.memoryValues.get("memory:one")!.dependency;
    f.controller.abort(); expect(f.sources.memoryValues.size).toBe(0);
    expect(await f.sources.sources.readExact({dependency, evidenceBindingRef: "binding:one", returnedBytesMaximum: 1000})
      .then(() => null, (error: unknown) => error)).toBeInstanceOf(Error);
    f.bytes.fill(0);
  });
});

import {resolveProtectedReflectionOutputAudience} from "../../src/reflection/protected-semantic-composition";
import type {RecordAccessAudiencePort, CanonicalSourceAuthorityPort} from "@nautilo/reflection-bridge/server";

describe("protected output audience is fixed before the grant", () => {
  test("an uncited narrower Memory and Record constrain the complete question, including after expansion", async () => {
    const materialized: string[][] = [], accessed: string[][] = [];
    const accessAudiences: RecordAccessAudiencePort = {
      async readExactSet(namespaces) {
        accessed.push([...namespaces]);
        return {status: "available", audiences: namespaces.map(namespace => namespace === "access:changed" ? ["human:a", "human:b", "human:c"] : ["human:a", "human:b"])};
      }, async resolveOrCreateExact(humanRefs) {
        materialized.push([...humanRefs]); return {accessNamespaceId: `access:${humanRefs.length}`, accessRoomId: `room:${humanRefs.length}`, humanRefs};
      },
    };
    const sourceAuthority: CanonicalSourceAuthorityPort = {async resolve(handle) {
      expect(handle).toBe("conversation:memory");
      return {status: "available", leaf: {terminalAuthorityLeafHandle: handle, alternatives: [{humanRefs: ["human:a"], includesPublicBoundary: false}]}};
    }};
    const changed = {namespaceId: "access:changed", objectId: "record:changed", objectType: "nautilo.reflection.record.v1" as const};
    const candidate = {...changed, namespaceId: "access:narrow-record", objectId: "record:uncited"};
    const memory = {namespaceId: "conversation:memory", objectId: "memory:uncited", objectType: "nautilo-memory-v1" as const};
    expect(await resolveProtectedReflectionOutputAudience({inputBindings: [changed], accessAudiences, sourceAuthority})).toMatchObject({accessNamespaceId: "access:3"});
    expect(await resolveProtectedReflectionOutputAudience({inputBindings: [changed, candidate], accessAudiences, sourceAuthority})).toMatchObject({accessNamespaceId: "access:2"});
    expect(await resolveProtectedReflectionOutputAudience({inputBindings: [changed, candidate, memory], accessAudiences, sourceAuthority})).toMatchObject({accessNamespaceId: "access:1"});
    expect(materialized).toEqual([["human:a", "human:b", "human:c"], ["human:a", "human:b"], ["human:a"]]);
    expect(accessed.flat()).not.toContain("conversation:memory");
  });

  test("exact encrypted dependencies do not acquire the unrelated sixteen-candidate limit", async () => {
    const inputBindings = Array.from({length: 17}, (_, index) => ({namespaceId: `access:${index}`, objectId: `record:${index}`, objectType: "nautilo.reflection.record.v1" as const}));
    const accessAudiences: RecordAccessAudiencePort = {readExactSet: async namespaces => ({status: "available", audiences: namespaces.map(() => ["human:a"])}),
      resolveOrCreateExact: async humanRefs => ({accessNamespaceId: "access:shared", accessRoomId: "room:shared", humanRefs})};
    expect(await resolveProtectedReflectionOutputAudience({inputBindings, accessAudiences, sourceAuthority: {resolve: () => Promise.reject(new Error("not a source"))}}))
      .toMatchObject({accessNamespaceId: "access:shared", humanRefs: ["human:a"]});
  });

  test("missing current membership or an empty intersection does not materialize output authority", async () => {
    let created = 0;
    const inputBindings = [{namespaceId: "access:one", objectId: "record:one", objectType: "nautilo.reflection.record.v1" as const},
      {namespaceId: "access:two", objectId: "record:two", objectType: "nautilo.reflection.record.v1" as const}];
    for (const missing of [false, true]) {
      expect(await resolveProtectedReflectionOutputAudience({inputBindings,
        accessAudiences: {readExactSet: async () => missing ? {status: "unavailable"} : {status: "available", audiences: [["human:a"], ["human:b"]]},
          resolveOrCreateExact: async humanRefs => {created++; return {accessNamespaceId: "never", accessRoomId: "never", humanRefs};}},
        sourceAuthority: {resolve: () => Promise.reject(new Error("not a source"))}})).toBeNull();
    }
    expect(created).toBe(0);
  });
});

import {createPreparedReflectionCrossRoomPartition} from "../../src/reflection/protected-semantic-composition";
import type {CrossRoomOrganizerDiscoveryResult} from "@nautilo/reflection-bridge/server";

describe("prepared protected cross-Room inputs", () => {
  test("keeps each granted Memory's Room anchor rather than the invoking Room", () => {
    const bytes = encodeMemoryPayloadV1({formatVersion: 1, type: "fact", content: "Cross-room fact"});
    const metadata: ProtectedOrganizerMemoryMetadata = {memoryRef: "cross", logicalSourceRef: "memory:cross", contentRevision: 1,
      cryptoAccessRevision: 0, inputBinding: {objectId: "cross-object", namespaceId: "cross-namespace", objectType: "nautilo-memory-v1"}};
    const sources = createGateBoundReflectionMemorySources({commitmentKey: new Uint8Array(32).fill(7),
      memories: new Map([[metadata.logicalSourceRef, metadata]]), payloads: new Map([["cross-object", {plaintext: bytes}]]),
      scores: new Map(), roomBindings: new Map([[metadata.logicalSourceRef, {roomAnchorRef: "cross-room", readBindingRef: "cross-binding"}]]),
      signal: new AbortController().signal, resolveMemoryDependency: async () => ({status: "available", metadata})});
    expect(sources.memoryValues.get("memory:cross")?.snapshot.anchors).toEqual(["cross-room"]);
    expect(sources.memoryValues.get("memory:cross")?.dependency.terminalAuthorityLeafHandle).toBe("cross-namespace");
    sources.dispose(); bytes.fill(0);
  });

  test("only projects declared gate-opened Records and refuses stale discovery", async () => {
    let current = true;
    const candidate = {kind: "record" as const, recordRef: record.recordRef, structuralHeight: 1,
      recordProcessingGeneration: record.processingGeneration, searchProjectionGeneration: 1,
      payloadRepresentationGeneration: 1, authorityProjectionGeneration: 1, authorityAccessNamespaceRef: "access",
      readNamespaceRef: "origin", readBindingRef: "origin-binding", score: 1,
      audience: {humanRefs: ["alice"], includesPublicBoundary: false}};
    const discovery: Extract<CrossRoomOrganizerDiscoveryResult, {status: "available"}> = {status: "available", changed: candidate,
      candidates: [candidate], metrics: {recordRowsConsidered: 1, memoryRowsConsidered: 0, rowsSelected: 1,
        unsupportedAuthorityShapes: 0, authorityParentsResolved: 1, authorityParentsSkipped: 0, topologyWork: 1}};
    const records = new Map([[record.recordRef, {...record, structuralHeight: 1}]]);
    const partition = createPreparedReflectionCrossRoomPartition({discovery, records, memories: new Map(),
      assertCurrent: async () => {if (!current) throw new Error("stale discovery");},
      publicationPlan: () => {throw new Error("not yet planned");}});
    // The adapter only projects an already-authorized frozen set; it has no
    // repository, model, device or payload-opening capability of its own.
    const augment = () => partition.augment({} as Parameters<typeof partition.augment>[0]);
    const view = await augment();
    expect(view.status).toBe("available");
    if (view.status !== "available") throw new Error("expected prepared view");
    expect(view.candidates).toHaveLength(0);
    expect(view.existingParents.map(value => value.snapshot.recordRef)).toEqual([record.recordRef]);
    expect(view.protectedExecutionUnavailable).toBe(0);
    records.clear();
    expect(await augment().then(() => null, (error: unknown) => error)).toBeInstanceOf(Error);
    records.set(record.recordRef, {...record, structuralHeight: 1}); current = false;
    expect(await augment().then(() => null, (error: unknown) => error)).toEqual(new Error("stale discovery"));
  });
});
