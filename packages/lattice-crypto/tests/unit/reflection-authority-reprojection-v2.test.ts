import {describe, expect, test} from "bun:test";
import {LatticeCrypto} from "../../src/crypto/index.ts";
import {ProcessorTransformRecipientRegistryV1} from "../../src/background/one-run-processor-transform-v1.ts";
import {reflectionAuthorityReconciliationFingerprintV2, type ReflectionAuthorityObjectPortV2, type ReflectionAuthorityRunInputV2, type ReflectionAuthorityReconciliationBindingV2, type ReflectionSemanticReconciliationBindingV2} from "../../src/background/reflection-authority-reprojection-v2.ts";
import {createBackgroundAuthorizationResponseV2} from "../../src/background/processor-authorization-v2.ts";
import {encodeBackgroundWorkDescriptorV2, type BackgroundReflectionWorkDescriptorV2} from "../../src/background/work-descriptor-v2.ts";
import {backgroundProcessorWorkV2Fixture} from "../helpers/background-work-v2-fixture.ts";
import {wrapObjectDekForNamespaceV2} from "../../src/object/namespace-envelope.ts";
import {encryptObjectPayloadV2} from "../../src/object/payload.ts";
import {decodeEncryptedPayloadV2, decodeNamespaceObjectEnvelopeV2} from "../../src/format/object-v2.ts";
import {verifyObjectAccessManifestV5} from "../../src/format/object-access-manifest-v5.ts";
import {accessRevision, namespaceId, namespaceGeneration, objectId, unixTimestamp} from "../../src/v2-types/ids.ts";

async function rejected(work: Promise<unknown>, text?: string) {
  const error: unknown = await work.then(() => null, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  if (text !== undefined && error instanceof Error) expect(error.message).toContain(text);
}
async function fixture(payloadLength?: number) {
  const crypto = new LatticeCrypto(), device = crypto.generateSigningKeyPair();
  let now = 1_700_000_000_001, available = true;
  const controller = new AbortController();
  const registry = new ProcessorTransformRecipientRegistryV1({crypto, now: () => now,
    scheduler: {scheduleAt: () => ({cancel: () => {}})}});
  const created = await registry.createAttempt({requestId: "request-1", workId: "work-1", namespaceId: "namespace-1", recipientGeneration: 0, recipientKeyId: "recipient-1", expiresAt: 1_700_000_300_000});
  if (created.status !== "created") throw new Error("No recipient");
  const base = backgroundProcessorWorkV2Fixture(created.attempt.recipientPublicKey);
  const {authority, ...common} = base;
  const descriptor: BackgroundReflectionWorkDescriptorV2 = {...common,
    workKind: "reflection.authority_reproject", purpose: "record.reproject", subject: {kind: "processor", processorKind: "reflection", processorVersion: 1},
    source: {kind: "reflection_authority", recordRef: "record-1", sourceChangeGeneration: 4, projectionGeneration: 5, expectedRepresentationGeneration: 1, targetRepresentationGeneration: 2, fingerprint: new Uint8Array(32).fill(6)},
    namespaceRequirements: [{authority, operations: ["decrypt", "encrypt"]}, {authority: {...authority, roomId: "room-2", namespaceId: "namespace-2", domainId: "domain-2"}, operations: ["encrypt"]}],
    inputBindings: [{objectId: "old-object", namespaceId: "namespace-1"}],
    outputSlots: [{objectId: "new-object", objectType: "nautilo.reflection.record.v1", createdAt: base.issuedAt, namespaceIds: ["namespace-1", "namespace-2"]}]};
  const domainKeys = [1,2].map(i => ({domainId: `domain-${i}`, key: crypto.randomBytes(32)}));
  const keys = new Map([1,2].map(i => [`namespace-${i}`, crypto.randomBytes(32)]));
  const issuer = {humanId: "human-1", deviceId: "device-1", deviceGeneration: 2, serverInstanceId: "instance-1", lineageGeneration: 3, epoch: 4, securityRevision: 5, headDigest: new Uint8Array(32), signingPublicKeyHash: crypto.hash(device.publicKey)};
  const response = (value: BackgroundReflectionWorkDescriptorV2) => createBackgroundAuthorizationResponseV2(crypto, {credentialId: `credential-${value.requestId}`, descriptorBytes: encodeBackgroundWorkDescriptorV2(value), issuer, issuerSigningPrivateKey: device.privateKey, domainKeys});
  const plaintext = payloadLength === undefined ? new TextEncoder().encode('{"recordId":"record-1","body":"same canonical bytes"}') : new Uint8Array(payloadLength).fill(42);
  const encrypted = encryptObjectPayloadV2(crypto, {objectId: objectId("old-object"), keyClass: "ai", objectType: "nautilo.reflection.record.v1", createdAt: unixTimestamp(base.issuedAt)}, plaintext);
  const envelope = wrapObjectDekForNamespaceV2(crypto, keys.get("namespace-1")!, {objectId: objectId("old-object"), namespaceId: namespaceId("namespace-1"), keyClass: "ai", keyGeneration: namespaceGeneration(0), bindingRevisionAtWrap: accessRevision(1)}, encrypted.dek); encrypted.dek.fill(0);
  const calls: string[] = [], borrowed: Uint8Array[] = [];
  let saved: Parameters<ReflectionAuthorityObjectPortV2["publishOutput"]>[0] | undefined;
  const objects: ReflectionAuthorityObjectPortV2 = {
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
    validateRecordPayload: async request => {calls.push("validate"); expect(request.recordRef).toBe("record-1"); expect(request.plaintext).toEqual(plaintext); borrowed.push(request.plaintext);},
    publishOutput: async request => {
      calls.push("publish"); await request.authorizeCommit();
      saved = {...request, payloadBytes: Uint8Array.from(request.payloadBytes), namespaceEnvelopes: request.namespaceEnvelopes.map(entry => ({namespaceId: entry.namespaceId, envelopeBytes: Uint8Array.from(entry.envelopeBytes)})), manifestBytes: Uint8Array.from(request.manifestBytes), tombstoneManifestBytes: Uint8Array.from(request.tombstoneManifestBytes), signerAuthorizationBytes: Uint8Array.from(request.signerAuthorizationBytes)};
    },
    attach: async request => {calls.push("attach"); expect(request.plaintext).toEqual(plaintext); borrowed.push(request.plaintext); await request.authorizeCommit();},
  };
  const run: ReflectionAuthorityRunInputV2 = {requestId: descriptor.requestId, recipientGeneration: 0, recipientKeyId: descriptor.recipientKeyId, claimId: "claim-1", responseBytes: await response(descriptor), reflectionObjects: objects, signal: controller.signal,
    resolveCurrentIssuer: () => {calls.push("authority"); return available ? device.publicKey : null;}, claims: {claimExactCredential: async () => {calls.push("claim"); return "claimed";}}};
  return {crypto, registry, descriptor, device, issuer, domainKeys, keys, plaintext, calls, borrowed, objects, run, response, controller,
    saved: () => {if (!saved) throw new Error("No publication"); return saved;}, revoke: () => {available = false;}, expire: () => {now = base.expiresAt;}};
}

describe("deterministic Reflection authority custody", () => {
  test("keeps the existing authority reconciliation fingerprint bytes unchanged", () => {
    const binding: ReflectionAuthorityReconciliationBindingV2 = {
      publicationId: "publication-legacy",
      recordRef: "record-legacy",
      sourceChangeGeneration: 4,
      expectedProjectionGeneration: 5,
      previousRepresentationGeneration: 1,
      representationGeneration: 2,
      previousObjectId: "object-old",
      attachmentPlanHash: new Uint8Array(32).fill(7),
      objectId: "object-new",
      objectType: "nautilo.reflection.record.v1",
      createdAt: 1_700_000_000_001,
      payloadHash: new Uint8Array(32).fill(8),
      namespaceEnvelopes: [{
        namespaceId: "namespace-1",
        envelopeHash: new Uint8Array(32).fill(9),
      }],
    };
    expect(Buffer.from(reflectionAuthorityReconciliationFingerprintV2(
      new LatticeCrypto(),
      binding,
    )).toString("hex")).toBe(
      "ed4f1b911ba572043945b08a700a1c582e86aa5143fcab40b10b608182b04713",
    );
  });
  test("claims once, preserves exact Record bytes across Domains, reopens every envelope and signs V5", async () => {
    const f = await fixture(); expect(await f.registry.runCurrentReflectionAuthority(f.run)).toEqual({status: "executed"});
    expect(f.calls.indexOf("claim")).toBeLessThan(f.calls.findIndex(value => value.startsWith("open:")));
    expect(f.calls.filter(value => value.startsWith("open:new-object"))).toEqual(["open:new-object:namespace-1", "open:new-object:namespace-2"]);
    expect(f.borrowed.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
    const saved = f.saved();
    const manifest = verifyObjectAccessManifestV5(f.crypto, {manifestBytes: saved.manifestBytes,
      resolveAgentRuntimeSignerPublicKey: () => null, resolveHistoricalHumanDeviceSigningPublicKey: () => null,
      resolveHistoricalProcessorIssuingDevicePublicKey: () => null, resolveProcessorSignerAuthorizationBytes: () => saved.signerAuthorizationBytes,
      resolveHistoricalCurrentIssuer: () => f.device.publicKey});
    expect(manifest.currentSignerAuthorization?.certificate.signer.processorKind).toBe("reflection");
    expect(await f.registry.runCurrentReflectionAuthority(f.run)).toMatchObject({status: "unavailable"});
  });
  test("never publishes when validation fails, authority changes, or a lender omits its callback", async () => {
    for (const mode of ["validation", "revocation", "key"] as const) {
      const f = await fixture();
      const objects: ReflectionAuthorityObjectPortV2 = {...f.objects,
        ...(mode === "validation" ? {validateRecordPayload: async () => {throw new Error("invalid Record");}} : {}),
        ...(mode === "revocation" ? {validateRecordPayload: async () => {f.revoke();}} : {}),
        ...(mode === "key" ? {withNamespaceKey: async <Value>() => undefined as Value} : {}),
      };
      await rejected(f.registry.runCurrentReflectionAuthority({...f.run, reflectionObjects: objects}));
      expect(f.calls).not.toContain("publish"); expect(f.calls).not.toContain("attach");
      expect(f.borrowed.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
    }
  });
  test("cannot substitute validation bytes, skip publication permit, or attach corrupt saved output", async () => {
    const f = await fixture();
    expect(await f.registry.runCurrentReflectionAuthority({...f.run, reflectionObjects: {...f.objects, validateRecordPayload: async ({plaintext}) => {plaintext.fill(1);}}})).toEqual({status: "executed"});
    for (const mode of ["permit", "corrupt"] as const) {
      const g = await fixture();
      const objects = {...g.objects, publishOutput: async (request: Parameters<ReflectionAuthorityObjectPortV2["publishOutput"]>[0]) => {
        if (mode === "permit") return;
        await g.objects.publishOutput(request); g.saved().payloadBytes[g.saved().payloadBytes.length - 1]! ^= 1;
      }};
      await rejected(g.registry.runCurrentReflectionAuthority({...g.run, reflectionObjects: objects})); expect(g.calls).not.toContain("attach");
    }
  });
  test("expiry and cancellation wipe borrowed bytes and forbid late permits", async () => {
    for (const mode of ["expiry", "abort"] as const) {
      const f = await fixture(); let permit: (() => Promise<number>) | undefined;
      await rejected(f.registry.runCurrentReflectionAuthority({...f.run, reflectionObjects: {...f.objects, publishOutput: async request => {
        permit = request.authorizeCommit; if (mode === "expiry") f.expire(); else f.controller.abort(new Error("cancelled")); await request.authorizeCommit();
      }}}));
      expect(f.calls).not.toContain("attach"); expect(f.borrowed.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
      await rejected(permit!());
    }
  });
  test("bounds the actual Record and forbids extra input objects before claiming", async () => {
    const maximum = await fixture(256 * 1024);
    expect(await maximum.registry.runCurrentReflectionAuthority(maximum.run)).toEqual({status: "executed"});
    const oversized = await fixture(256 * 1024 + 1);
    await rejected(oversized.registry.runCurrentReflectionAuthority(oversized.run), "canonical byte bound");
    expect(oversized.calls).not.toContain("publish");
    const batch = await fixture();
    const value = {...batch.descriptor, inputBindings: [...batch.descriptor.inputBindings, {objectId: "other-record", namespaceId: "namespace-1"}]};
    await rejected(batch.registry.runCurrentReflectionAuthority({...batch.run, responseBytes: await batch.response(value)}), "exactly one");
    expect(batch.calls).not.toContain("claim");
  });
  test("replayed durable claims never open bodies and duplicate permits remain fatal if swallowed", async () => {
    const f = await fixture();
    expect(await f.registry.runCurrentReflectionAuthority({...f.run, claims: {claimExactCredential: async () => "already_claimed"}})).toEqual({status: "unavailable", reason: "credential_replayed"});
    expect(f.calls.some(value => value.startsWith("open:"))).toBe(false);
    const g = await fixture();
    await rejected(g.registry.runCurrentReflectionAuthority({...g.run, reflectionObjects: {...g.objects, publishOutput: async request => {
      await request.authorizeCommit(); await request.authorizeCommit().catch(() => {});
    }}}), "one-use");
    expect(g.calls).not.toContain("attach");
  });
  test("recovers one committed object through every exact Namespace using a fresh receipt-bound grant", async () => {
    const f = await fixture(); await f.registry.runCurrentReflectionAuthority(f.run); const saved = f.saved();
    const binding: ReflectionAuthorityReconciliationBindingV2 = {publicationId: "publication-1", recordRef: "record-1", sourceChangeGeneration: 4, expectedProjectionGeneration: 5,
      previousRepresentationGeneration: 1, representationGeneration: 2, previousObjectId: "old-object", attachmentPlanHash: new Uint8Array(32).fill(7), objectId: saved.objectId, objectType: "nautilo.reflection.record.v1", createdAt: f.descriptor.issuedAt,
      payloadHash: f.crypto.hash(saved.payloadBytes), namespaceEnvelopes: saved.namespaceEnvelopes.map(entry => ({namespaceId: entry.namespaceId, envelopeHash: f.crypto.hash(entry.envelopeBytes)}))};
    const created = await f.registry.createAttempt({requestId: "request-2", workId: "work-2", namespaceId: "namespace-1", recipientGeneration: 0, recipientKeyId: "recipient-2", expiresAt: f.descriptor.expiresAt});
    if (created.status !== "created") throw new Error("No recovery recipient");
    const descriptor: BackgroundReflectionWorkDescriptorV2 = {...f.descriptor, requestId: "request-2", workId: "work-2", recipientKeyId: "recipient-2", recipientPublicKey: created.attempt.recipientPublicKey,
      workKind: "reflection.publication_reconcile", purpose: "record.reconcile", source: {kind: "reflection_publication", publicationId: binding.publicationId, recordRef: binding.recordRef, representationGeneration: 2, fingerprint: reflectionAuthorityReconciliationFingerprintV2(f.crypto, binding)},
      operations: ["decrypt"], namespaceRequirements: f.descriptor.namespaceRequirements.map(entry => ({...entry, operations: ["decrypt"]})), outputSlots: [], inputBindings: binding.namespaceEnvelopes.map(entry => ({objectId: binding.objectId, namespaceId: entry.namespaceId}))};
    expect(() => encodeBackgroundWorkDescriptorV2({...descriptor, inputBindings: [descriptor.inputBindings[0]!, descriptor.inputBindings[0]!]})).toThrow("duplicate");
    const before = f.calls.filter(value => value === "publish").length;
    expect(await f.registry.runCurrentReflectionAuthority({...f.run, requestId: "request-2", recipientKeyId: "recipient-2", responseBytes: await f.response(descriptor), reconciliationBinding: binding})).toEqual({status: "executed"});
    expect(f.calls.filter(value => value === "publish")).toHaveLength(before);
    const third = await f.registry.createAttempt({requestId: "request-3", workId: "work-3", namespaceId: "namespace-1", recipientGeneration: 0, recipientKeyId: "recipient-3", expiresAt: descriptor.expiresAt});
    if (third.status !== "created") throw new Error("No substitution-test recipient");
    const thirdDescriptor = {...descriptor, requestId: "request-3", workId: "work-3", recipientKeyId: "recipient-3", recipientPublicKey: third.attempt.recipientPublicKey};
    const claimsBefore = f.calls.filter(value => value === "claim").length;
    await rejected(f.registry.runCurrentReflectionAuthority({...f.run, requestId: "request-3", recipientKeyId: "recipient-3", responseBytes: await f.response(thirdDescriptor),
      reconciliationBinding: {...binding, expectedProjectionGeneration: binding.expectedProjectionGeneration + 1}}), "signed publication binding");
    expect(f.calls.filter(value => value === "claim")).toHaveLength(claimsBefore);
    for (const changed of [{...binding, expectedProjectionGeneration: 6}, {...binding, recordRef: "other"}, {...binding, attachmentPlanHash: new Uint8Array(32)}, {...binding, namespaceEnvelopes: binding.namespaceEnvelopes.slice(1)}]) {
      expect(reflectionAuthorityReconciliationFingerprintV2(f.crypto, changed)).not.toEqual(descriptor.source.fingerprint);
    }
  });

  test("semantic recovery reopens saved output without executing or publishing a model result", async () => {
    const f = await fixture();
    await f.registry.runCurrentReflectionAuthority(f.run);
    const saved = f.saved();
    const binding: ReflectionSemanticReconciliationBindingV2 = {
      kind: "semantic",
      publicationId: "semantic-publication-1",
      recordRef: "generated-record-1",
      sourceRecordRef: "record-1",
      claimGeneration: 4,
      representationGeneration: 1,
      attachmentPlanHash: new Uint8Array(32).fill(11),
      objectId: saved.objectId,
      objectType: "nautilo.reflection.record.v1",
      createdAt: f.descriptor.issuedAt,
      payloadHash: f.crypto.hash(saved.payloadBytes),
      namespaceEnvelopes: saved.namespaceEnvelopes.map(entry => ({
        namespaceId: entry.namespaceId,
        envelopeHash: f.crypto.hash(entry.envelopeBytes),
      })),
    };
    const created = await f.registry.createAttempt({
      requestId: "semantic-recovery-request",
      workId: "semantic-recovery-work",
      namespaceId: "namespace-1",
      recipientGeneration: 0,
      recipientKeyId: "semantic-recovery-recipient",
      expiresAt: f.descriptor.expiresAt,
    });
    if (created.status !== "created") throw new Error("No semantic recovery recipient");
    const descriptor: BackgroundReflectionWorkDescriptorV2 = {
      ...f.descriptor,
      requestId: "semantic-recovery-request",
      workId: "semantic-recovery-work",
      recipientKeyId: "semantic-recovery-recipient",
      recipientPublicKey: created.attempt.recipientPublicKey,
      workKind: "reflection.publication_reconcile",
      purpose: "record.reconcile",
      source: {
        kind: "reflection_publication",
        publicationId: binding.publicationId,
        recordRef: binding.recordRef,
        representationGeneration: 1,
        fingerprint: reflectionAuthorityReconciliationFingerprintV2(f.crypto, binding),
      },
      operations: ["decrypt"],
      namespaceRequirements: f.descriptor.namespaceRequirements.map(entry => ({
        ...entry,
        operations: ["decrypt"],
      })),
      outputSlots: [],
      inputBindings: binding.namespaceEnvelopes.map(entry => ({
        objectId: binding.objectId,
        namespaceId: entry.namespaceId,
      })),
    };
    const publishes = f.calls.filter(value => value === "publish").length;

    expect(await f.registry.runCurrentReflectionAuthority({
      ...f.run,
      requestId: descriptor.requestId,
      recipientKeyId: descriptor.recipientKeyId,
      responseBytes: await f.response(descriptor),
      reconciliationBinding: binding,
      reflectionObjects: {
        ...f.objects,
        validateRecordPayload: async request => {
          f.calls.push("validate-recovered");
          expect(request.recordRef).toBe(binding.recordRef);
        },
      },
    })).toEqual({ status: "executed" });
    expect(f.calls.filter(value => value === "publish")).toHaveLength(publishes);
    for (const changed of [
      { ...binding, recordRef: "forged-record" },
      { ...binding, sourceRecordRef: "forged-source" },
      { ...binding, claimGeneration: binding.claimGeneration + 1 },
      { ...binding, attachmentPlanHash: new Uint8Array(32) },
    ]) {
      expect(reflectionAuthorityReconciliationFingerprintV2(f.crypto, changed))
        .not.toEqual(descriptor.source.fingerprint);
    }
  });
});
