import {describe, expect, test} from "bun:test";
import {LatticeCrypto} from "../../src/crypto/index.ts";
import {ProcessorTransformRecipientRegistryV1} from "../../src/background/one-run-processor-transform-v1.ts";
import {type ReflectionAuthorityObjectPortV2, type ReflectionSemanticRunInputV2, type ReflectionSemanticObjectPortV2, type ReflectionSemanticInputV2} from "../../src/background/reflection-authority-reprojection-v2.ts";
import {createBackgroundAuthorizationResponseV2} from "../../src/background/processor-authorization-v2.ts";
import {decodeAnyBackgroundProcessorWorkDescriptorV2, REFLECTION_SEMANTIC_MAX_PLAINTEXT_BYTES_V2, REFLECTION_SEMANTIC_MAX_CIPHERTEXT_BYTES_V2, REFLECTION_SEMANTIC_MAX_INPUT_PLAINTEXT_BYTES_V2, REFLECTION_SEMANTIC_MAX_OUTPUT_PLAINTEXT_BYTES_V2, encodeBackgroundWorkDescriptorV2, type BackgroundReflectionSemanticWorkDescriptorV2} from "../../src/background/work-descriptor-v2.ts";
import {backgroundProcessorWorkV2Fixture} from "../helpers/background-work-v2-fixture.ts";
import {wrapObjectDekForNamespaceV2} from "../../src/object/namespace-envelope.ts";
import {encryptObjectPayloadV2} from "../../src/object/payload.ts";
import {decodeEncryptedPayloadV2, decodeNamespaceObjectEnvelopeV2} from "../../src/format/object-v2.ts";
import {accessRevision, namespaceId, namespaceGeneration, objectId, unixTimestamp} from "../../src/v2-types/ids.ts";

async function rejected(work: Promise<unknown>, text?: string) {
  const error: unknown = await work.then(() => null, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  if (text !== undefined && error instanceof Error) expect(error.message).toContain(text);
}
async function fixture(purpose: "organization" | "search_projection" | "dependency_rewrite" = "organization", payloadLength?: number) {
  const crypto = new LatticeCrypto(), device = crypto.generateSigningKeyPair();
  let now = 1_700_000_000_001, available = true;
  const controller = new AbortController();
  const registry = new ProcessorTransformRecipientRegistryV1({crypto, now: () => now,
    scheduler: {scheduleAt: () => ({cancel: () => {}})}});
  const created = await registry.createAttempt({requestId: "request-1", workId: "work-1", namespaceId: "namespace-1", recipientGeneration: 0, recipientKeyId: "recipient-1", expiresAt: 1_700_000_300_000});
  if (created.status !== "created") throw new Error("No recipient");
  const base = backgroundProcessorWorkV2Fixture(created.attempt.recipientPublicKey);
  const {authority, ...common} = base;
  let descriptor = {...common, maximumPlaintextBytes: REFLECTION_SEMANTIC_MAX_PLAINTEXT_BYTES_V2, maximumCiphertextBytes: REFLECTION_SEMANTIC_MAX_CIPHERTEXT_BYTES_V2,
    workKind: `reflection.${purpose}`, purpose: purpose === "organization" ? "record.organize" : `record.${purpose}`, subject: {kind: "processor", processorKind: "reflection", processorVersion: 1},
    source: {kind: "reflection_semantic", recordRef: "record-1", claimGeneration: 4, fingerprint: new Uint8Array(32).fill(6)},
    namespaceRequirements: [{authority, operations: ["decrypt", "encrypt"]}, {authority: {...authority, roomId: "room-2", namespaceId: "namespace-2", domainId: "domain-2"}, operations: ["encrypt"]}],
    inputBindings: [{objectId: "old-object", namespaceId: "namespace-1", objectType: "nautilo.reflection.record.v1"}],
    outputSlots: [{objectId: "new-object", objectType: "nautilo.reflection.record.v1", createdAt: base.issuedAt, namespaceIds: ["namespace-1", "namespace-2"]}]} as BackgroundReflectionSemanticWorkDescriptorV2;
  if (purpose === "search_projection") descriptor = {...descriptor, operations: ["decrypt"], outputSlots: [], namespaceRequirements: [{authority, operations: ["decrypt"]}]};
  const domainKeys = [1,2].map(i => ({domainId: `domain-${i}`, key: crypto.randomBytes(32)}));
  const keys = new Map([1,2].map(i => [`namespace-${i}`, crypto.randomBytes(32)]));
  const issuer = {humanId: "human-1", deviceId: "device-1", deviceGeneration: 2, serverInstanceId: "instance-1", lineageGeneration: 3, epoch: 4, securityRevision: 5, headDigest: new Uint8Array(32), signingPublicKeyHash: crypto.hash(device.publicKey)};
  const response = (value: BackgroundReflectionSemanticWorkDescriptorV2) => createBackgroundAuthorizationResponseV2(crypto, {credentialId: `credential-${value.requestId}`, descriptorBytes: encodeBackgroundWorkDescriptorV2(value), issuer, issuerSigningPrivateKey: device.privateKey, domainKeys: value.namespaceRequirements.length === 1 ? domainKeys.slice(0,1) : domainKeys});
  const plaintext = payloadLength === undefined ? new TextEncoder().encode('{"recordId":"record-1","body":"same canonical bytes"}') : new Uint8Array(payloadLength).fill(42);
  const encrypted = encryptObjectPayloadV2(crypto, {objectId: objectId("old-object"), keyClass: "ai", objectType: "nautilo.reflection.record.v1", createdAt: unixTimestamp(base.issuedAt)}, plaintext);
  const envelope = wrapObjectDekForNamespaceV2(crypto, keys.get("namespace-1")!, {objectId: objectId("old-object"), namespaceId: namespaceId("namespace-1"), keyClass: "ai", keyGeneration: namespaceGeneration(0), bindingRevisionAtWrap: accessRevision(1)}, encrypted.dek); encrypted.dek.fill(0);
  const calls: string[] = [], borrowed: Uint8Array[] = [];
  let saved: Parameters<ReflectionAuthorityObjectPortV2["publishOutput"]>[0] | undefined;
  const objects: ReflectionSemanticObjectPortV2 = {
    openObject: async request => {
      calls.push(`open:${request.objectId}:${request.namespaceId}`);
      if (request.objectId === "old-object") return {payload: encrypted.payload, envelope};
      if (saved === undefined) throw new Error("No saved output");
      return {payload: decodeEncryptedPayloadV2(saved.payloadBytes), envelope: decodeNamespaceObjectEnvelopeV2(saved.namespaceEnvelopes.find(entry => entry.namespaceId === request.namespaceId)!.envelopeBytes)};
    },
    withNamespaceKey: async (request, use) => {
      calls.push(`key:${request.authority.namespaceId}:${request.generation}`);
      expect(request.domainKey).toEqual(domainKeys.find(entry => entry.domainId === request.authority.domainId)!.key);
      borrowed.push(request.domainKey); return use(keys.get(request.authority.namespaceId)!);
    },
    validateInput: async request => {calls.push("validate-input"); expect(request.objectId).toBe("old-object"); expect(request.plaintext).toEqual(plaintext); borrowed.push(request.plaintext);},
    validateOutput: async request => {calls.push("validate-output"); expect(request.objectId).toBe("new-object"); borrowed.push(request.plaintext);},
    publishOutput: async request => {
      calls.push("publish"); await request.authorizeCommit();
      saved = {...request, payloadBytes: Uint8Array.from(request.payloadBytes), namespaceEnvelopes: request.namespaceEnvelopes.map(entry => ({namespaceId: entry.namespaceId, envelopeBytes: Uint8Array.from(entry.envelopeBytes)})), manifestBytes: Uint8Array.from(request.manifestBytes), tombstoneManifestBytes: Uint8Array.from(request.tombstoneManifestBytes), signerAuthorizationBytes: Uint8Array.from(request.signerAuthorizationBytes)};
    },
    attach: async request => {calls.push("attach"); if (request.output !== null) {expect(request.output.plaintext).toEqual(new TextEncoder().encode("organized")); borrowed.push(request.output.plaintext);} await request.authorizeCommit();},
  };
  const run: ReflectionSemanticRunInputV2 = {requestId: descriptor.requestId, recipientGeneration: 0, recipientKeyId: descriptor.recipientKeyId, claimId: "claim-1", responseBytes: await response(descriptor), semanticObjects: objects, execute: async inputs => {
      calls.push("execute"); inputs.forEach(entry => borrowed.push(entry.plaintext));
      if (purpose === "search_projection") return null;
      const output = new TextEncoder().encode("organized"); borrowed.push(output); return {objectId: "new-object", plaintext: output};
    }, signal: controller.signal,
    resolveCurrentIssuer: () => {calls.push("authority"); return available ? device.publicKey : null;}, claims: {claimExactCredential: async () => {calls.push("claim"); return "claimed";}}};
  return {crypto, registry, descriptor, device, issuer, domainKeys, keys, plaintext, calls, borrowed, objects, run, response, controller,
    saved: () => {if (!saved) throw new Error("No publication"); return saved;}, revoke: () => {available = false;}, expire: () => {now = base.expiresAt;}};
}

describe("Reflection semantic exact-set custody", () => {
  test("a final product commit may supersede its own source without reopening authority", async () => {
    const f = await fixture();
    const result = await f.registry.runCurrentReflectionSemantic({...f.run, semanticObjects: {...f.objects,
      attach: async request => {await request.authorizeCommit(); f.revoke();},
    }});
    expect(result.status).toBe("executed");
    expect(f.borrowed.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
    const denied = await fixture();
    await rejected(denied.registry.runCurrentReflectionSemantic({...denied.run, semanticObjects: {...denied.objects,
      attach: async request => {denied.revoke(); await request.authorizeCommit();},
    }}));
  });
  test("only dependency repair admits exact typed Message inputs in additive V2", async () => {
    const f = await fixture("dependency_rewrite");
    const descriptor: BackgroundReflectionSemanticWorkDescriptorV2 = {...f.descriptor,
      inputBindings: [...f.descriptor.inputBindings, {objectId: "message-input", namespaceId: "namespace-1", objectType: "nautilo-message-v2"}]};
    expect(decodeAnyBackgroundProcessorWorkDescriptorV2(encodeBackgroundWorkDescriptorV2(descriptor))).toEqual(descriptor);
    expect(() => encodeBackgroundWorkDescriptorV2({...descriptor, workKind: "reflection.organization", purpose: "record.organize"})).toThrow("Message inputs require Reflection dependency repair");
  });

  test("parked semantic callbacks revalidate current authority and close their check capability", async () => {
    for (const change of ["revoke", "expire"] as const) {
      const f = await fixture("search_projection");
      let retained: (() => Promise<void>) | undefined;
      await rejected(f.registry.runCurrentReflectionSemantic({...f.run, execute: async (inputs, _signal, assertCurrent) => {
        retained = assertCurrent;
        f.borrowed.push(inputs[0]!.plaintext);
        await assertCurrent();
        f[change]();
        await assertCurrent();
        return null;
      }}));
      expect(f.calls).not.toContain("attach");
      expect(f.borrowed.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
      await rejected(retained!(), "scope is closed");
    }
    const f = await fixture("search_projection");
    let retained: (() => Promise<void>) | undefined;
    expect(await f.registry.runCurrentReflectionSemantic({...f.run, execute: async (_inputs, _signal, assertCurrent) => {
      retained = assertCurrent; await assertCurrent(); return null;
    }})).toEqual({status: "executed"});
    await rejected(retained!(), "scope is closed");
  });

  test.each(["organization", "dependency_rewrite"] as const)("%s publishes one result and verifies every output Namespace", async purpose => {
    const f = await fixture(purpose);
    expect(await f.registry.runCurrentReflectionSemantic(f.run)).toEqual({status: "executed"});
    expect(f.calls.filter(value => value === "execute")).toHaveLength(1);
    expect(f.calls.indexOf("claim")).toBeLessThan(f.calls.indexOf("execute"));
    expect(f.calls.filter(value => value.startsWith("open:new-object"))).toEqual(["open:new-object:namespace-1", "open:new-object:namespace-2"]);
    expect(f.borrowed.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
    expect(await f.registry.runCurrentReflectionSemantic(f.run)).toMatchObject({status: "unavailable"});
  });
  test("search discloses only its exact input and cannot publish", async () => {
    const f = await fixture("search_projection");
    expect(await f.registry.runCurrentReflectionSemantic(f.run)).toEqual({status: "executed"});
    expect(f.calls.filter(value => value.startsWith("open:"))).toEqual(["open:old-object:namespace-1"]);
    expect(f.calls).not.toContain("publish"); expect(f.calls).toContain("attach");
    expect(f.borrowed.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
    const g = await fixture("search_projection");
    await rejected(g.registry.runCurrentReflectionSemantic({...g.run, execute: async () => ({objectId: "new-object", plaintext: new Uint8Array([1])})}), "exact slot");
    expect(g.calls).not.toContain("publish");
  });
  test("optional reserved output can complete no-change through the product fence", async () => {
    const f = await fixture();
    expect(await f.registry.runCurrentReflectionSemantic({...f.run, execute: async () => null})).toEqual({status: "executed"});
    expect(f.calls).not.toContain("publish"); expect(f.calls).toContain("attach");
    const g = await fixture();
    await rejected(g.registry.runCurrentReflectionSemantic({...g.run, execute: async () => null, semanticObjects: {...g.objects, attach: async () => {}}}), "skipped commit");
  });
  test("replayed and stale grants disclose zero input bodies", async () => {
    for (const mode of ["replay", "stale"] as const) {
      const f = await fixture(); if (mode === "stale") f.revoke();
      const outcome = f.registry.runCurrentReflectionSemantic({...f.run, claims: {claimExactCredential: async () => "already_claimed"}});
      if (mode === "replay") expect(await outcome).toEqual({status: "unavailable", reason: "credential_replayed"}); else await rejected(outcome);
      expect(f.calls.some(value => value.startsWith("open:"))).toBe(false); expect(f.calls).not.toContain("execute");
    }
  });
  test("revocation after input validation prevents model disclosure", async () => {
    const f = await fixture();
    await rejected(f.registry.runCurrentReflectionSemantic({...f.run, semanticObjects: {...f.objects, validateInput: async () => {f.revoke();}}}));
    expect(f.calls).not.toContain("execute"); expect(f.borrowed.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
  });
  test("cancellation wipes a suspended callback and late returned bytes", async () => {
    const f = await fixture(); let resolve!: (value: {objectId: string; plaintext: Uint8Array}) => void;
    let entered!: () => void; const ready = new Promise<void>(done => {entered = done;});
    let lent: readonly ReflectionSemanticInputV2[] = [];
    const work = f.registry.runCurrentReflectionSemantic({...f.run, execute: inputs => {
      lent = inputs; entered(); return new Promise(done => {resolve = done;});
    }});
    await ready; f.controller.abort(new Error("cancelled")); await rejected(work);
    expect(lent.every(entry => entry.plaintext.every(byte => byte === 0))).toBe(true);
    const late = new Uint8Array([7]); resolve({objectId: "new-object", plaintext: late});
    await new Promise<void>(done => {queueMicrotask(done);});
    expect(late).toEqual(new Uint8Array(1)); expect(f.calls).not.toContain("publish");
  });
  test("mismatched object type and unreserved output cannot cross their exact bindings", async () => {
    const f = await fixture(); const descriptor = {...f.descriptor, inputBindings: f.descriptor.inputBindings.map(entry => ({...entry, objectType: "nautilo-memory-v1" as const}))};
    await rejected(f.registry.runCurrentReflectionSemantic({...f.run, responseBytes: await f.response(descriptor)}), "exact Record binding");
    expect(f.calls).not.toContain("execute");
    const g = await fixture(); await rejected(g.registry.runCurrentReflectionSemantic({...g.run, execute: async () => ({objectId: "foreign", plaintext: new Uint8Array([1])})}), "exact slot");
    expect(g.calls).not.toContain("publish");
  });
  test("accepts the existing semantic input budget and rejects oversized output before publication", async () => {
    const f = await fixture("search_projection", REFLECTION_SEMANTIC_MAX_INPUT_PLAINTEXT_BYTES_V2);
    expect(await f.registry.runCurrentReflectionSemantic(f.run)).toEqual({status: "executed"});
    const g = await fixture(); const output = new Uint8Array(REFLECTION_SEMANTIC_MAX_OUTPUT_PLAINTEXT_BYTES_V2 + 1).fill(3);
    await rejected(g.registry.runCurrentReflectionSemantic({...g.run, execute: async () => ({objectId: "new-object", plaintext: output})}), "output byte budget");
    expect(output.every(value => value === 0)).toBe(true); expect(g.calls).not.toContain("publish");
  });
  test("signed plaintext budget failure precedes Namespace key lending", async () => {
    const f = await fixture("search_projection");
    await rejected(f.registry.runCurrentReflectionSemantic({...f.run, responseBytes: await f.response({...f.descriptor, maximumPlaintextBytes: 1})}), "plaintext budget");
    expect(f.calls.some(value => value.startsWith("key:"))).toBe(false);
    expect(f.calls).not.toContain("execute");
  });
  test("a generated Record has its own logical identity and is fenced after model completion", async () => {
    const f = await fixture(); const output = new TextEncoder().encode('{"recordId":"generated-record"}');
    let read: string | undefined;
    expect(await f.registry.runCurrentReflectionSemantic({...f.run, execute: async () => ({objectId: "new-object", plaintext: output}), semanticObjects: {...f.objects,
      validateOutput: async request => {expect(request.objectId).toBe("new-object"); expect(JSON.parse(new TextDecoder().decode(request.plaintext)) as unknown).toEqual({recordId: "generated-record"});},
      attach: async request => {read = new TextDecoder().decode(request.output!.plaintext); await request.authorizeCommit();},
    }})).toEqual({status: "executed"});
    expect(read).toBe('{"recordId":"generated-record"}');
    const g = await fixture(); await rejected(g.registry.runCurrentReflectionSemantic({...g.run, execute: async () => {g.revoke(); return null;}}));
    expect(g.calls).not.toContain("attach");
  });
  test("opens authored Memory using its signed type without broadening Record authority", async () => {
    const f = await fixture("search_projection");
    const descriptor = {...f.descriptor, inputBindings: [{objectId: "memory-object", namespaceId: "namespace-1", objectType: "nautilo-memory-v1" as const}]};
    const bytes = new TextEncoder().encode("authored Memory");
    const encrypted = encryptObjectPayloadV2(f.crypto, {objectId: objectId("memory-object"), keyClass: "ai", objectType: "nautilo-memory-v1", createdAt: unixTimestamp(descriptor.issuedAt)}, bytes);
    const envelope = wrapObjectDekForNamespaceV2(f.crypto, f.keys.get("namespace-1")!, {objectId: objectId("memory-object"), namespaceId: namespaceId("namespace-1"), keyClass: "ai", keyGeneration: namespaceGeneration(0), bindingRevisionAtWrap: accessRevision(1)}, encrypted.dek);
    encrypted.dek.fill(0);
    expect(await f.registry.runCurrentReflectionSemantic({...f.run, responseBytes: await f.response(descriptor), execute: async inputs => {expect(inputs).toHaveLength(1); expect(inputs[0]!.plaintext).toEqual(bytes); return null;},
      semanticObjects: {...f.objects, openObject: async request => {expect(request.objectId).toBe("memory-object"); return {payload: encrypted.payload, envelope};}, validateInput: async request => {expect(request.objectType).toBe("nautilo-memory-v1");}},
    })).toEqual({status: "executed"});
  });
  test("semantic wire binds plan generation, typed objects, exact read/write sets and complete capacity", async () => {
    const f = await fixture("search_projection");
    const original = encodeBackgroundWorkDescriptorV2(f.descriptor);
    expect(decodeAnyBackgroundProcessorWorkDescriptorV2(original)).toEqual(f.descriptor);
    expect(encodeBackgroundWorkDescriptorV2({...f.descriptor, source: {...f.descriptor.source, claimGeneration: 5}})).not.toEqual(original);
    for (const value of [
      {...f.descriptor, purpose: "record.reproject"},
      {...f.descriptor, source: {...f.descriptor.source, unexpected: 1}},
      {...f.descriptor, inputBindings: [{...f.descriptor.inputBindings[0]!, objectType: "unknown"}]},
      {...f.descriptor, outputSlots: [{objectId: "extra", objectType: "nautilo.reflection.record.v1", createdAt: f.descriptor.issuedAt, namespaceIds: ["namespace-1"]}]},
      {...f.descriptor, namespaceRequirements: f.descriptor.namespaceRequirements.map(entry => ({...entry, operations: ["decrypt", "encrypt"]}))},
    ]) expect(() => encodeBackgroundWorkDescriptorV2(value as never)).toThrow();
    const authority = f.descriptor.namespaceRequirements[0]!.authority;
    const namespaces = Array.from({length: 16384}, (_, i) => `namespace-${String(i).padStart(5, "0")}`);
    const complete = {...f.descriptor, anchorNamespaceId: namespaces[0]!, namespaceRequirements: namespaces.map(id => ({authority: {...authority, namespaceId: id}, operations: ["decrypt" as const]})),
      inputBindings: namespaces.map(id => ({objectId: `object-${id}`, namespaceId: id, objectType: "nautilo-memory-v1" as const}))};
    expect(decodeAnyBackgroundProcessorWorkDescriptorV2(encodeBackgroundWorkDescriptorV2(complete))).toEqual(complete);
    expect(() => encodeBackgroundWorkDescriptorV2({...complete, inputBindings: [...complete.inputBindings, complete.inputBindings[0]!]})).toThrow();
  });
  test("maintenance authority cannot authorize semantics or accept an execute callback", async () => {
    const f = await fixture();
    await rejected(f.registry.runCurrentReflectionAuthority({...f.run} as never), "deterministic gate");
    const value = {...f.descriptor, maximumPlaintextBytes: 512_000, maximumCiphertextBytes: 1_024_000, workKind: "reflection.authority_reproject", purpose: "record.reproject", source: {kind: "reflection_authority", recordRef: "record-1", sourceChangeGeneration: 4, projectionGeneration: 5, expectedRepresentationGeneration: 1, targetRepresentationGeneration: 2, fingerprint: new Uint8Array(32).fill(6)}, inputBindings: [{objectId: "old-object", namespaceId: "namespace-1"}]} as const;
    await rejected(f.registry.runCurrentReflectionSemantic({...f.run, responseBytes: await f.response(value as never)}), "separate exact inputs");
    expect(f.calls).not.toContain("claim");
  });
});
