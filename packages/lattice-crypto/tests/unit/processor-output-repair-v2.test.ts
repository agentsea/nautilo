import {describe, expect, test} from "bun:test";
import {LatticeCrypto} from "../../src/crypto/index.ts";
import {ProcessorTransformRecipientRegistryV1} from "../../src/background/one-run-processor-transform-v1.ts";
import type {ProcessorOutputRepairRunInputV2, ProcessorOutputRepairObjectPortV2, ProcessorTransformRunInputV2, ProcessorReconciliationRunInputV2} from "../../src/background/one-run-processor-transform-v2.ts";
import {copyOutputRepairBindingV2, outputRepairFingerprintV2, stenographerOrdinaryOutputFingerprint, type ProcessorOutputRepairBindingV2} from "../../src/background/output-repair-v2.ts";
import {createBackgroundAuthorizationResponseV2, verifyProcessorSignerAuthorizationV2} from "../../src/background/processor-authorization-v2.ts";
import {encodeBackgroundWorkDescriptorV2, type BackgroundProcessorWorkDescriptorV2} from "../../src/background/work-descriptor-v2.ts";
import {backgroundProcessorWorkV2Fixture} from "../helpers/background-work-v2-fixture.ts";
import {wrapObjectDekForNamespaceV2} from "../../src/object/namespace-envelope.ts";
import {encryptObjectPayloadV2} from "../../src/object/payload.ts";
import {decodeEncryptedPayloadV2, decodeNamespaceObjectEnvelopeV2} from "../../src/format/object-v2.ts";
import {decodeObjectAccessManifestV5} from "../../src/format/object-access-manifest-v5.ts";
import {accessRevision, namespaceId, namespaceGeneration, objectId, unixTimestamp} from "../../src/v2-types/ids.ts";

const text = (value: string) => new TextEncoder().encode(value);
const zeroed = (bytes: Uint8Array) => bytes.every(byte => byte === 0);
async function rejected(work: Promise<unknown>, message?: string): Promise<void> {
  const error: unknown = await work.then(() => null, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  if (message !== undefined && error instanceof Error) expect(error.message).toContain(message);
}

async function fixture(dispositions: readonly ("existing" | "create")[] = ["existing", "create"], kind: "extraction" | "compaction" = "extraction",
  patch: Partial<BackgroundProcessorWorkDescriptorV2> = {}, payloadTimeOffset = 0) {
  const crypto = new LatticeCrypto();
  const device = crypto.generateSigningKeyPair();
  const domainKey = crypto.randomBytes(32);
  const namespaceKey = crypto.randomBytes(32);
  const controller = new AbortController();
  let now = 1_700_000_000_001;
  let available = true;
  const registry = new ProcessorTransformRecipientRegistryV1({crypto, now: () => now,
    scheduler: {scheduleAt: () => ({cancel: () => {}})}});
  const attempt = await registry.createAttempt({requestId: "request-1", workId: "work-1", namespaceId: "namespace-1",
    recipientGeneration: 0, recipientKeyId: "recipient-1", expiresAt: 1_700_000_300_000});
  if (attempt.status !== "created") throw new Error("No recipient");
  const base = backgroundProcessorWorkV2Fixture(attempt.attempt.recipientPublicKey);
  const plaintexts = dispositions.map((_value, index) => text(`canonical ordinary ${index}`));
  const inventory = dispositions.map((disposition, index) => ({logicalId: `logical-${index}`, objectId: `output-${index}`,
    objectType: kind === "extraction" ? "nautilo.reflection.record.v1" as const : "room_event_rollup" as const,
    createdAt: base.issuedAt + index + payloadTimeOffset, disposition, representationGeneration: 0, ordinaryRepresentationGeneration: kind === "extraction" ? 0 : null}));
  const receipt = {kind, id: "receipt-1", roomId: base.authority.roomId, namespaceId: base.authority.namespaceId,
    rebuildGeneration: base.source.rebuildGeneration, fallbackReason: "device" as const};
  const aggregate = stenographerOrdinaryOutputFingerprint({...receipt, receiptId: receipt.id,
    outputs: inventory.map((output, index) => ({...output, createdAt: output.createdAt - payloadTimeOffset, payloadBytes: plaintexts[index]!}))});
  const binding: ProcessorOutputRepairBindingV2 = {receipt: {...receipt, ordinaryOutputFingerprint: aggregate}, outputs: inventory};
  const descriptor: BackgroundProcessorWorkDescriptorV2 = {...base, workKind: "stenographer.output_repair", purpose: "journal.repair",
    source: {...base.source, fingerprint: outputRepairFingerprintV2(crypto, binding)},
    operations: [...(inventory.some(output => output.disposition === "existing") ? ["decrypt" as const] : []), ...(inventory.some(output => output.disposition === "create") ? ["encrypt" as const] : [])],
    inputBindings: inventory.filter(output => output.disposition === "existing").map(output => ({objectId: output.objectId, namespaceId: base.anchorNamespaceId})),
    outputSlots: inventory.filter(output => output.disposition === "create").map(({objectId, objectType, createdAt}) => ({objectId, objectType, createdAt, namespaceIds: [base.anchorNamespaceId]})),
    maximumPlaintextBytes: plaintexts.reduce((sum, bytes) => sum + bytes.length, 0), ...patch};
  const responseBytes = await createBackgroundAuthorizationResponseV2(crypto, {
    credentialId: "credential-1", descriptorBytes: encodeBackgroundWorkDescriptorV2(descriptor),
    issuer: {humanId: "human-1", deviceId: "device-1", deviceGeneration: 2, serverInstanceId: "instance-1",
      lineageGeneration: 3, epoch: 4, securityRevision: 5, headDigest: new Uint8Array(32), signingPublicKeyHash: crypto.hash(device.publicKey)},
    issuerSigningPrivateKey: device.privateKey, domainKey,
  });
  const existing = new Map(inventory.filter(output => output.disposition === "existing").map(output => {
    const index = inventory.indexOf(output);
    const encrypted = encryptObjectPayloadV2(crypto, {objectId: objectId(output.objectId), keyClass: "ai", objectType: output.objectType,
      createdAt: unixTimestamp(output.createdAt)}, plaintexts[index]!);
    const envelope = wrapObjectDekForNamespaceV2(crypto, namespaceKey, {objectId: objectId(output.objectId), namespaceId: namespaceId("namespace-1"),
      keyClass: "ai", keyGeneration: namespaceGeneration(0), bindingRevisionAtWrap: accessRevision(1)}, encrypted.dek);
    encrypted.dek.fill(0);
    return [output.objectId, {payload: encrypted.payload, envelope}] as const;
  }));
  const calls: string[] = [];
  const lent: Uint8Array[] = [];
  const attached: Uint8Array[] = [];
  const published: Parameters<ProcessorOutputRepairObjectPortV2["publishOutputs"]>[0]["outputs"][] = [];
  const objects: ProcessorOutputRepairObjectPortV2 = {
    withOrdinaryOutputs: async ({signal}, use) => {
      calls.push("ordinary"); expect(signal.aborted).toBe(false);
      const outputs = inventory.map((output, index) => ({logicalId: output.logicalId, objectId: output.objectId, fingerprintCreatedAt: output.createdAt - payloadTimeOffset, plaintext: plaintexts[index]!.slice()}));
      lent.push(...outputs.map(output => output.plaintext));
      await use(outputs);
      expect(outputs.every(output => zeroed(output.plaintext))).toBe(true);
    },
    openInput: async ({objectId}) => {calls.push("input"); const value = existing.get(objectId); if (!value) throw new Error("Missing input"); return value;},
    withNamespaceKey: async (request, use) => {calls.push("key"); expect(request.domainKey).toEqual(domainKey); return use(namespaceKey);},
    publishOutputs: async request => {calls.push("publish"); await request.authorizeCommit(); published.push(structuredClone(request.outputs));},
    openPublishedOutput: async ({objectId}) => {
      calls.push("reopen"); const value = published[0]?.find(output => output.objectId === objectId);
      if (!value) throw new Error("Missing output");
      return {payload: decodeEncryptedPayloadV2(value.payloadBytes), envelope: decodeNamespaceObjectEnvelopeV2(value.envelopeBytes)};
    },
    attach: async request => {
      calls.push("attach"); await request.authorizeCommit();
      expect(request.outputs.map(output => output.objectId)).toEqual(inventory.map(output => output.objectId));
      expect(request.outputs.map(output => output.plaintext)).toEqual(plaintexts);
      attached.push(...request.outputs.map(output => output.plaintext));
    },
  };
  const run: ProcessorOutputRepairRunInputV2 = {requestId: "request-1", recipientGeneration: 0, recipientKeyId: "recipient-1", claimId: "claim-1",
    responseBytes, repairBinding: binding, objects, signal: controller.signal,
    resolveCurrentIssuer: () => {calls.push("authority"); return available ? device.publicKey : null;},
    claims: {claimExactCredential: async () => {calls.push("claim"); return "claimed";}}};
  return {crypto, device, namespaceKey, registry, descriptor, binding, plaintexts, run, objects, existing, lent, attached, published, calls, controller,
    revoke: () => {available = false;}, expire: () => {now = descriptor.expiresAt;}};
}

describe("closed current output repair", () => {
  test("repairs historical event receipt times with distinct canonical payload creation times through the real crypto engine", async () => {
    const f = await fixture(["existing", "create"], "extraction", {}, 7_017);
    expect(await f.registry.runCurrentOutputRepair(f.run)).toEqual({status: "executed"});
    expect(f.published).toHaveLength(1);
    expect(decodeEncryptedPayloadV2(f.published[0]![0]!.payloadBytes).context.createdAt).toBe(unixTimestamp(f.binding.outputs[1]!.createdAt));
    expect(f.calls).toContain("attach");
    expect(f.lent.every(zeroed)).toBe(true);
  });

  test("substituted or invalid historical fingerprint timestamps fail before crypto reads or publication", async () => {
    for (const timestamp of [Number.NaN, -1, 1.5, 1_700_000_000_099]) {
      const f = await fixture();
      await rejected(f.registry.runCurrentOutputRepair({...f.run, objects: {...f.objects,
        withOrdinaryOutputs: async (_request, use) => use(f.binding.outputs.map((output, index) => ({...output,
          fingerprintCreatedAt: timestamp, plaintext: f.plaintexts[index]!.slice()}))),
      }}));
      expect(f.calls).not.toContain("input");
      expect(f.published).toHaveLength(0);
    }
  });
  test.each([{dispositions: ["existing", "create"]}, {dispositions: ["create", "existing", "create"]},
    {dispositions: ["existing", "existing"]}, {dispositions: ["create"]}] as const)(
    "verifies the complete ordinary result and protects only missing outputs: %j", async ({dispositions}) => {
      const f = await fixture(dispositions);
      expect(await f.registry.runCurrentOutputRepair(f.run)).toEqual({status: "executed"});
      expect(f.calls.indexOf("claim")).toBeLessThan(f.calls.indexOf("ordinary"));
      expect(f.calls.filter(call => call === "ordinary")).toHaveLength(1);
      expect(f.published).toHaveLength(1);
      expect(f.published[0]!.map(output => output.objectId)).toEqual(f.descriptor.outputSlots.map(output => output.objectId));
      expect(f.attached.every(zeroed)).toBe(true); expect(f.lent.every(zeroed)).toBe(true);
      for (const output of f.published[0]!) {
        expect(decodeObjectAccessManifestV5(output.manifestBytes).accessRevision).toBe(accessRevision(0));
        expect(verifyProcessorSignerAuthorizationV2(f.crypto, {authorizationBytes: output.signerAuthorizationBytes,
          issuerSigningPublicKey: f.device.publicKey}).descriptor.workKind).toBe("stenographer.output_repair");
      }
      expect(await f.registry.runCurrentOutputRepair(f.run)).toEqual({status: "unavailable", reason: "recipient_unavailable"});
    });

  test("compaction protects the original rollup with the same canonical V5 publisher", async () => {
    const f = await fixture(["create"], "compaction");
    expect(await f.registry.runCurrentOutputRepair(f.run)).toEqual({status: "executed"});
    expect(decodeEncryptedPayloadV2(f.published[0]![0]!.payloadBytes).context.objectType).toBe("room_event_rollup");
  });

  test("wrong entry points reject repair without claiming or executing a model", async () => {
    const f = await fixture(); let modelCalls = 0;
    await rejected(f.registry.runCurrent({...f.run, execute: () => {modelCalls++;}} as unknown as ProcessorTransformRunInputV2));
    await rejected(f.registry.runCurrentReconciliation(f.run as unknown as ProcessorReconciliationRunInputV2));
    await rejected(f.registry.runCurrentOutputRepair({...f.run, execute: () => {modelCalls++;}} as unknown as ProcessorOutputRepairRunInputV2));
    expect(modelCalls).toBe(0); expect(f.calls).toEqual([]); f.registry.close();
  });

  test("signed execution kind cannot enter the repair gate", async () => {
    const f = await fixture(["existing", "create"], "extraction", {workKind: "stenographer.extraction", purpose: "journal.extract"});
    await rejected(f.registry.runCurrentOutputRepair(f.run), "separate gates");
    expect(f.calls).not.toContain("claim");
  });

  test("binding scope mutation is rejected before ordinary reads", async () => {
    const f = await fixture();
    const wrong = copyOutputRepairBindingV2(f.binding);
    wrong.receipt.ordinaryOutputFingerprint[0] = wrong.receipt.ordinaryOutputFingerprint[0]! ^ 1;
    await rejected(f.registry.runCurrentOutputRepair({...f.run, repairBinding: wrong}), "signed authority");
    expect(f.calls).not.toContain("claim");
  });

  test("caller binding mutation during issuer lookup cannot change signed scope", async () => {
    const f = await fixture(); let changed = false;
    await rejected(f.registry.runCurrentOutputRepair({...f.run, resolveCurrentIssuer: context => {
      if (!changed) {changed = true; f.binding.receipt.ordinaryOutputFingerprint.fill(0); (f.binding.outputs as unknown as {objectId: string}[])[0]!.objectId = "evil";}
      return f.run.resolveCurrentIssuer(context);
    }}), "ordinary identity");
    expect(f.calls).toContain("claim"); expect(f.published).toHaveLength(0);
  });

  test("aggregate mismatch fails before encrypted reads or publication and wipes borrowed bytes", async () => {
    const f = await fixture(); const bad = f.plaintexts.map(bytes => bytes.slice()); bad[0]![0] = bad[0]![0]! ^ 1;
    await rejected(f.registry.runCurrentOutputRepair({...f.run, objects: {...f.objects,
      withOrdinaryOutputs: async (_request, use) => use(f.binding.outputs.map((output, index) => ({...output, fingerprintCreatedAt: output.createdAt, plaintext: bad[index]!}))),
    }}), "aggregate");
    expect(bad.every(zeroed)).toBe(true); expect(f.calls).not.toContain("input"); expect(f.published).toHaveLength(0);
  });

  test("ordinary logical identity cannot be substituted", async () => {
    const f = await fixture(); const bytes = f.plaintexts[0]!.slice();
    await rejected(f.registry.runCurrentOutputRepair({...f.run, objects: {...f.objects,
      withOrdinaryOutputs: async (_request, use) => use([{logicalId: "evil", objectId: "output-0", fingerprintCreatedAt: f.binding.outputs[0]!.createdAt, plaintext: bytes},
        {logicalId: "logical-1", objectId: "output-1", fingerprintCreatedAt: f.binding.outputs[1]!.createdAt, plaintext: f.plaintexts[1]!.slice()}]),
    }}), "identity"); expect(zeroed(bytes)).toBe(true);
  });

  test("existing protected plaintext must match the ordinary result", async () => {
    const f = await fixture();
    const metadata = f.binding.outputs[0]!;
    const changed = f.plaintexts[0]!.slice(); changed[0] = changed[0]! ^ 1;
    const encrypted = encryptObjectPayloadV2(f.crypto, {objectId: objectId(metadata.objectId), keyClass: "ai",
      objectType: metadata.objectType, createdAt: unixTimestamp(metadata.createdAt)}, changed);
    const envelope = wrapObjectDekForNamespaceV2(f.crypto, f.namespaceKey, {objectId: objectId(metadata.objectId),
      namespaceId: namespaceId("namespace-1"), keyClass: "ai", keyGeneration: namespaceGeneration(0), bindingRevisionAtWrap: accessRevision(1)}, encrypted.dek);
    encrypted.dek.fill(0);
    f.existing.set(metadata.objectId, {payload: encrypted.payload, envelope});
    await rejected(f.registry.runCurrentOutputRepair(f.run), "parity failed");
    expect(f.published).toHaveLength(0); expect(f.lent.every(zeroed)).toBe(true);
  });

  test("missing output persisted corruption prevents attachment", async () => {
    const f = await fixture();
    await rejected(f.registry.runCurrentOutputRepair({...f.run, objects: {...f.objects,
      openPublishedOutput: async request => {const value = await f.objects.openPublishedOutput(request); value.payload.ciphertext[0] = value.payload.ciphertext[0]! ^ 1; return value;},
    }}), "committed bytes"); expect(f.calls).not.toContain("attach"); expect(f.lent.every(zeroed)).toBe(true);
  });

  test("replay, expiry and revocation prevent ordinary loading", async () => {
    for (const mode of ["replay", "expiry", "revocation"] as const) {
      const f = await fixture();
      const run = {...f.run, claims: {claimExactCredential: async () => {
        if (mode === "expiry") f.expire(); if (mode === "revocation") f.revoke();
        return mode === "replay" ? "already_claimed" as const : "claimed" as const;
      }}};
      if (mode === "replay") expect(await f.registry.runCurrentOutputRepair(run)).toEqual({status: "unavailable", reason: "credential_replayed"});
      else await rejected(f.registry.runCurrentOutputRepair(run));
      expect(f.calls).not.toContain("ordinary");
    }
  });

  test("ordinary callback must run exactly once even if the provider swallows its error", async () => {
    const f = await fixture();
    await rejected(f.registry.runCurrentOutputRepair({...f.run, objects: {...f.objects,
      withOrdinaryOutputs: async (_request, use) => {
        const values = () => f.binding.outputs.map((output, index) => ({...output, fingerprintCreatedAt: output.createdAt, plaintext: f.plaintexts[index]!.slice()}));
        await use(values()); await use(values()).catch(() => {});
      },
    }}), "one-use"); expect(f.published).toHaveLength(0);
  });

  test("late ordinary callback after abort wipes its supplied buffers and cannot publish", async () => {
    const f = await fixture(); let late: Parameters<ProcessorOutputRepairObjectPortV2["withOrdinaryOutputs"]>[1] | undefined;
    await rejected(f.registry.runCurrentOutputRepair({...f.run, objects: {...f.objects,
      withOrdinaryOutputs: (_request, use) => {late = use; f.controller.abort(new Error("stopped")); return new Promise(() => {});},
    }}), "stopped");
    const values = f.binding.outputs.map((output, index) => ({...output, fingerprintCreatedAt: output.createdAt, plaintext: f.plaintexts[index]!.slice()}));
    await rejected(late!(values), "stopped"); expect(values.every(output => zeroed(output.plaintext))).toBe(true); expect(f.published).toHaveLength(0);
  });

  test("abort during attachment immediately wipes the complete borrowed result", async () => {
    const f = await fixture(); const borrowed: Uint8Array[] = [];
    await rejected(f.registry.runCurrentOutputRepair({...f.run, objects: {...f.objects,
      attach: async request => {borrowed.push(...request.outputs.map(output => output.plaintext)); f.controller.abort(new Error("stopped")); return new Promise(() => {});},
    }}), "stopped"); expect(borrowed).toHaveLength(2); expect(borrowed.every(zeroed)).toBe(true); expect(f.registry.size).toBe(0);
  });

  test("attachment requires a fresh one-use current authority permit", async () => {
    for (const mode of ["skip", "revoke", "twice"] as const) {
      const f = await fixture();
      await rejected(f.registry.runCurrentOutputRepair({...f.run, objects: {...f.objects,
        attach: async request => {if (mode === "skip") return; if (mode === "revoke") f.revoke(); await request.authorizeCommit(); if (mode === "twice") await request.authorizeCommit();},
      }})); expect(f.published).toHaveLength(1); expect(f.lent.every(zeroed)).toBe(true);
    }
  });
  test("the portable binding commits every receipt and representation coordinate", async () => {
    const f = await fixture(); const original = outputRepairFingerprintV2(f.crypto, f.binding);
    const first = f.binding.outputs[0]!;
    const receipts = [{...f.binding.receipt, id: "receipt-2"}, {...f.binding.receipt, roomId: "room-2"},
      {...f.binding.receipt, namespaceId: "namespace-2"}, {...f.binding.receipt, rebuildGeneration: 1},
      {...f.binding.receipt, fallbackReason: "authority" as const}];
    for (const receipt of receipts) expect(outputRepairFingerprintV2(f.crypto, {...f.binding, receipt})).not.toEqual(original);
    for (const output of [{...first, logicalId: "logical-other"}, {...first, objectId: "object-other"},
      {...first, createdAt: first.createdAt + 1}, {...first, representationGeneration: 1},
      {...first, ordinaryRepresentationGeneration: 1}, {...first, disposition: "create" as const}]) {
      expect(outputRepairFingerprintV2(f.crypto, {...f.binding, outputs: [output, f.binding.outputs[1]!]})).not.toEqual(original);
    }
    expect(outputRepairFingerprintV2(f.crypto, {...f.binding, outputs: [...f.binding.outputs].reverse()})).not.toEqual(original);
    for (const outputs of [[], [first, first], Array.from({length: 6}, (_, index) => ({...first, logicalId: `logical-${index}`, objectId: `object-${index}`}))]) {
      expect(() => outputRepairFingerprintV2(f.crypto, {...f.binding, outputs})).toThrow();
    }
    expect(() => outputRepairFingerprintV2(f.crypto, {...f.binding, receipt: {...f.binding.receipt, kind: "compaction"}})).toThrow();
    f.registry.close();
  });

  test("signed descriptor inventory must match exact existing IDs and new type/time slots", async () => {
    for (const patch of [{inputBindings: ["other"].map(objectId => ({objectId, namespaceId: "namespace-1"}))}, {outputSlots: [{objectId: "other", objectType: "nautilo.reflection.record.v1" as const, createdAt: 1_700_000_000_001, namespaceIds: ["namespace-1"]}]},
      {outputSlots: [{objectId: "output-1", objectType: "room_event_rollup" as const, createdAt: 1_700_000_000_001, namespaceIds: ["namespace-1"]}]}]) {
      const f = await fixture(["existing", "create"], "extraction", patch);
      await rejected(f.registry.runCurrentOutputRepair(f.run), "signed authority");
      expect(f.calls).not.toContain("claim");
    }
    const f = await fixture();
    expect(() => encodeBackgroundWorkDescriptorV2({...f.descriptor, inputBindings: [].map(objectId => ({objectId, namespaceId: "namespace-1"})), outputSlots: []})).toThrow();
    expect(() => encodeBackgroundWorkDescriptorV2({...f.descriptor, inputBindings: ["a", "b", "c", "d", "e"].map(objectId => ({objectId, namespaceId: "namespace-1"}))})).toThrow();
    f.registry.close();
  });

  test("owned ordinary snapshots survive caller mutation after the loan returns", async () => {
    const f = await fixture();
    expect(await f.registry.runCurrentOutputRepair({...f.run, objects: {...f.objects,
      withOrdinaryOutputs: async (_request, use) => {
        const values = f.binding.outputs.map((output, index) => ({...output, fingerprintCreatedAt: output.createdAt, plaintext: f.plaintexts[index]!.slice()}));
        await use(values);
        expect(values.every(output => zeroed(output.plaintext))).toBe(true);
        values.forEach(output => output.plaintext.fill(99));
      },
    }})).toEqual({status: "executed"});
  });

  test("rechecks authority after releasing the ordinary source transaction", async () => {
    const f = await fixture();
    let sourceTransactionHeld = false;
    let released = false;
    let checkedAfterRelease = false;
    expect(await f.registry.runCurrentOutputRepair({...f.run,
      resolveCurrentIssuer: context => {
        if (sourceTransactionHeld) throw new Error("Nested Room lock acquisition");
        if (released) checkedAfterRelease = true;
        return f.run.resolveCurrentIssuer(context);
      },
      objects: {...f.objects, withOrdinaryOutputs: async (request, use) => {
        sourceTransactionHeld = true;
        try {await f.objects.withOrdinaryOutputs(request, use);}
        finally {sourceTransactionHeld = false; released = true;}
      }, publishOutputs: async request => {
        expect(checkedAfterRelease).toBe(true);
        await f.objects.publishOutputs(request);
      }},
    })).toEqual({status: "executed"});
    expect(checkedAfterRelease).toBe(true);
    expect(f.lent.every(zeroed)).toBe(true);
  });

  test("missing or interrupted ordinary callbacks cannot proceed", async () => {
    for (const mode of ["missing", "revoke"] as const) {
      const f = await fixture();
      await rejected(f.registry.runCurrentOutputRepair({...f.run, objects: {...f.objects,
        withOrdinaryOutputs: async (_request, use) => {
          if (mode === "missing") return;
          const values = f.binding.outputs.map((output, index) => ({...output, fingerprintCreatedAt: output.createdAt, plaintext: f.plaintexts[index]!.slice()}));
          const operation = use(values);
          f.revoke(); await operation;
        },
      }})); expect(f.published).toHaveLength(0);
    }
  });

});
