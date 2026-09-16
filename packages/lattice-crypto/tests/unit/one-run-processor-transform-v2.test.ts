import {describe, expect, test} from "bun:test";
import {LatticeCrypto} from "../../src/crypto/index.ts";
import {ProcessorTransformRecipientRegistryV1, type ProcessorTransformCapabilityV1} from "../../src/background/one-run-processor-transform-v1.ts";
import type {ProcessorTransformObjectPortV2, ProcessorTransformRunInputV2} from "../../src/background/one-run-processor-transform-v2.ts";
import {createBackgroundAuthorizationResponseV2, verifyProcessorSignerAuthorizationV2} from "../../src/background/processor-authorization-v2.ts";
import {encodeBackgroundWorkDescriptorV2, type BackgroundProcessorWorkDescriptorV2} from "../../src/background/work-descriptor-v2.ts";
import {backgroundProcessorWorkV2Fixture} from "../helpers/background-work-v2-fixture.ts";
import {decryptObjectThroughNamespaceV2, wrapObjectDekForNamespaceV2} from "../../src/object/namespace-envelope.ts";
import {encryptObjectPayloadV2} from "../../src/object/payload.ts";
import {decodeEncryptedPayloadV2, decodeNamespaceObjectEnvelopeV2} from "../../src/format/object-v2.ts";
import {decodeObjectAccessManifestV5, objectAccessManifestSigningBytesV5} from "../../src/format/object-access-manifest-v5.ts";
import {verifyProcessorObjectBytesV1} from "../../src/background/processor-object-signer-v1.ts";
import {accessRevision, authorizationRevision, namespaceId, namespaceGeneration, objectId, unixTimestamp} from "../../src/v2-types/ids.ts";

async function expectRejected(work: Promise<unknown>, message?: string): Promise<void> {
  const error: unknown = await work.then(() => null, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  if (message !== undefined && error instanceof Error) expect(error.message).toContain(message);
}

async function fixture(patch: Partial<BackgroundProcessorWorkDescriptorV2> = {}) {
  const crypto = new LatticeCrypto();
  const device = crypto.generateSigningKeyPair();
  const domainKey = crypto.randomBytes(32);
  const namespaceKey = crypto.randomBytes(32);
  const controller = new AbortController();
  let now = 1_700_000_000_001;
  let expire: (() => void) | undefined;
  const registry = new ProcessorTransformRecipientRegistryV1({crypto, now: () => now,
    scheduler: {scheduleAt: (_deadline, callback) => {expire = callback; return {cancel: () => {expire = undefined;}};}}});
  const created = await registry.createAttempt({requestId: "request-1", workId: "work-1", namespaceId: "namespace-1",
    recipientGeneration: 0, recipientKeyId: "recipient-1", expiresAt: 1_700_000_300_000});
  if (created.status !== "created") throw new Error("Fixture recipient failed");
  const descriptor = {...backgroundProcessorWorkV2Fixture(created.attempt.recipientPublicKey), inputBindings: ["message-10"].map(objectId => ({objectId, namespaceId: "namespace-1"})), ...patch};
  const responseBytes = await createBackgroundAuthorizationResponseV2(crypto, {
    credentialId: "credential-1", descriptorBytes: encodeBackgroundWorkDescriptorV2(descriptor),
    issuer: {humanId: "human-1", deviceId: "device-1", deviceGeneration: 2,
      serverInstanceId: "instance-1", lineageGeneration: 3, epoch: 4, securityRevision: 5,
      headDigest: new Uint8Array(32), signingPublicKeyHash: crypto.hash(device.publicKey)},
    issuerSigningPrivateKey: device.privateKey, domainKey,
  });
  const plaintext = new TextEncoder().encode("source message");
  const encrypted = encryptObjectPayloadV2(crypto, {objectId: objectId("message-10"), keyClass: "ai",
    objectType: "message", createdAt: unixTimestamp(descriptor.issuedAt)}, plaintext);
  const envelope = wrapObjectDekForNamespaceV2(crypto, namespaceKey, {
    objectId: objectId("message-10"), namespaceId: namespaceId("namespace-1"), keyClass: "ai",
    keyGeneration: namespaceGeneration(0), bindingRevisionAtWrap: accessRevision(1),
  }, encrypted.dek);
  encrypted.dek.fill(0);
  const calls: string[] = [];
  let available = true;
  const published: Pick<Parameters<ProcessorTransformObjectPortV2["publishOutputs"]>[0], "outputs">[] = [];
  const objects: ProcessorTransformObjectPortV2 = {
    openPublishedOutput: async ({objectId}) => {
      calls.push("reopen");
      const value = published[0]?.outputs.find((output) => output.objectId === objectId);
      if (value === undefined) throw new Error("Published output unavailable");
      return {payload: decodeEncryptedPayloadV2(value.payloadBytes), envelope: decodeNamespaceObjectEnvelopeV2(value.envelopeBytes)};
    },
    openInput: async () => {calls.push("body"); return {payload: encrypted.payload, envelope};},
    withNamespaceKey: async (request, use) => {
      calls.push(`key:${request.generation}:${request.accessRevision}`);
      expect(request.domainKey).toEqual(domainKey);
      expect(request.authority).toEqual(descriptor.authority);
      expect(request.keyClass).toBe("ai");
      return use(namespaceKey);
    },
    publishOutputs: async (request) => {
      calls.push("publish");
      await request.authorizeCommit();
      published.push(structuredClone({outputs: request.outputs}));
    },
  };
  const run: ProcessorTransformRunInputV2 = {
    requestId: descriptor.requestId, recipientGeneration: 0, recipientKeyId: descriptor.recipientKeyId,
    claimId: "claim-1", responseBytes, objects, signal: controller.signal,
    resolveCurrentIssuer: () => {calls.push("authority"); return available ? device.publicKey : null;},
    claims: {claimExactCredential: async () => {calls.push("claim"); return "claimed";}},
    execute: async (capability) => {
      await capability.openInputs();
      await capability.publishOutputs([{objectId: "record-1", plaintext: new TextEncoder().encode("reflection")}]);
    },
  };
  return {crypto, registry, descriptor, responseBytes, device, domainKey, namespaceKey, plaintext,
    run, objects, calls, published, controller,
    revoke: () => {available = false;}, setNow: (value: number) => {now = value;},
    expire: () => {if (!expire) throw new Error("No active deadline"); expire();}};
}

describe("current Domain-key one-run processor gate", () => {
  test("claims before body/key use, opens retained AI generations, and publishes signed current-generation outputs", async () => {
    const f = await fixture();
    let capabilityAfter: ProcessorTransformCapabilityV1 | undefined;
    let borrowed: Uint8Array | undefined;
    const result = await f.registry.runCurrent({...f.run, execute: async (capability) => {
      capabilityAfter = capability;
      const inputs = await capability.openInputs();
      borrowed = inputs[0]!.plaintext;
      expect(borrowed).toEqual(f.plaintext);
      await capability.publishOutputs([{objectId: "record-1", plaintext: new TextEncoder().encode("reflection")}]);
    }});
    expect(result).toEqual({status: "executed"});
    expect(f.calls.indexOf("claim")).toBeLessThan(f.calls.indexOf("body"));
    expect(f.calls).toContain("key:0:1");
    expect(f.calls).toContain("key:1:2");
    expect(borrowed?.every((byte) => byte === 0)).toBe(true);
    expect(f.namespaceKey.some((byte) => byte !== 0)).toBe(true);
    expect(f.registry.size).toBe(0);
    await expectRejected(capabilityAfter!.openInputs());
    const output = f.published[0]!.outputs[0]!;
    const payload = decodeEncryptedPayloadV2(output.payloadBytes);
    const envelope = decodeNamespaceObjectEnvelopeV2(output.envelopeBytes);
    expect(new TextDecoder().decode(decryptObjectThroughNamespaceV2(f.crypto, f.namespaceKey, envelope, payload))).toBe("reflection");
    const manifest = decodeObjectAccessManifestV5(output.manifestBytes);
    const tombstone = decodeObjectAccessManifestV5(output.tombstoneManifestBytes);
    const certificate = verifyProcessorSignerAuthorizationV2(f.crypto, {
      authorizationBytes: output.signerAuthorizationBytes, issuerSigningPublicKey: f.device.publicKey,
    });
    expect(manifest.hostAuthorizationRevision).toBe(authorizationRevision(5));
    expect(manifest.signerAuthorizationHash).toEqual(f.crypto.hash(output.signerAuthorizationBytes));
    expect(tombstone.previousManifestHash).toEqual(f.crypto.hash(output.manifestBytes));
    expect(tombstone.envelopeHashes).toEqual([]);
    const {formatVersion: _version, signature, ...unsigned} = manifest;
    expect(verifyProcessorObjectBytesV1(f.crypto, {principal: certificate.signer,
      signerPublicKey: certificate.signerPublicKey, signature,
      message: objectAccessManifestSigningBytesV5(unsigned)})).toBe(true);
    expect(await f.registry.runCurrent(f.run)).toEqual({status: "unavailable", reason: "recipient_unavailable"});
  });

  test("replayed credentials never open their sealed secret or an input body", async () => {
    const f = await fixture();
    let opened = false;
    f.crypto.openSealed = async () => {opened = true; throw new Error("Must not open");};
    expect(await f.registry.runCurrent({...f.run, claims: {claimExactCredential: async () => "already_claimed"}}))
      .toEqual({status: "unavailable", reason: "credential_replayed"});
    expect(opened).toBe(false);
    expect(f.calls).not.toContain("body");
    expect(f.registry.size).toBe(0);
  });

  test("revocation while body loading prevents the Namespace key callback", async () => {
    const f = await fixture();
    await expectRejected(f.registry.runCurrent({...f.run, objects: {...f.objects,
      openInput: async (request) => {const result = await f.objects.openInput(request); f.revoke(); return result;},
    }}));
    expect(f.calls.some((call) => call.startsWith("key:"))).toBe(false);
    expect(f.published).toHaveLength(0);
  });

  test("wrong Namespace inputs fail before opening a key", async () => {
    const f = await fixture();
    await expectRejected(f.registry.runCurrent({...f.run, objects: {...f.objects,
      openInput: async (request) => {
        const value = await f.objects.openInput(request);
        return {...value, envelope: {...value.envelope, context: {...value.envelope.context, namespaceId: namespaceId("other")}}};
      },
    }}), "does not match");
    expect(f.calls.some((call) => call.startsWith("key:"))).toBe(false);
  });

  test("rejects output widening and wipes transferred plaintext", async () => {
    const f = await fixture();
    const output = new Uint8Array([1, 2, 3]);
    await expectRejected(f.registry.runCurrent({...f.run, execute: async (capability) => {
      await capability.openInputs();
      await capability.publishOutputs([{objectId: "unapproved", plaintext: output}]);
    }}));
    expect(output.every((byte) => byte === 0)).toBe(true);
    expect(f.published).toHaveLength(0);
  });

  test("publication must reauthorize at commit and cannot commit after revocation", async () => {
    for (const skip of [true, false]) {
      const f = await fixture();
      await expectRejected(f.registry.runCurrent({...f.run, objects: {...f.objects,
        publishOutputs: async (request) => {if (!skip) {f.revoke(); await request.authorizeCommit();}},
      }}));
      expect(f.published).toHaveLength(0);
    }
  });

  test("expiry during current-authority lookup prevents key use", async () => {
    const f = await fixture();
    await expectRejected(f.registry.runCurrent({...f.run, resolveCurrentIssuer: async () => {
      f.setNow(f.descriptor.expiresAt); return f.device.publicKey;
    }}));
    expect(f.calls).not.toContain("claim");
    expect(f.calls).not.toContain("body");
  });

  test("deadline releases the registry and wipes plaintext even if the model never settles", async () => {
    const f = await fixture();
    let borrowed: Uint8Array | undefined;
    await expectRejected(f.registry.runCurrent({...f.run, execute: async (capability) => {
      borrowed = (await capability.openInputs())[0]!.plaintext;
      f.expire();
      return new Promise<void>(() => {});
    }}), "timed out");
    expect(borrowed?.every((byte) => byte === 0)).toBe(true);
    expect(f.registry.size).toBe(0);
  });

  test("a late Namespace callback after abort cannot open plaintext", async () => {
    const f = await fixture();
    let late: (() => Promise<unknown>) | undefined;
    await expectRejected(f.registry.runCurrent({...f.run, objects: {...f.objects,
      withNamespaceKey: async (_request, use) => {
        late = async () => use(f.namespaceKey);
        f.controller.abort(new Error("Stopped"));
        return new Promise<never>(() => {});
      },
    }}), "Stopped");
    await expectRejected(late!());
    expect(f.registry.size).toBe(0);
    expect(f.published).toHaveLength(0);
  });

  test("an empty canonical output prefix succeeds", async () => {
    const f = await fixture();
    expect(await f.registry.runCurrent({...f.run, execute: async (capability) => {
      await capability.openInputs();
      await capability.publishOutputs([]);
    }})).toEqual({status: "executed"});
    expect(f.published[0]!.outputs).toEqual([]);
  });

  test("input ciphertext and plaintext budgets fail before Namespace key use", async () => {
    for (const patch of [{maximumCiphertextBytes: 1}, {maximumPlaintextBytes: 1}]) {
      const f = await fixture(patch);
      await expectRejected(f.registry.runCurrent(f.run), "budget");
      expect(f.calls.some((call) => call.startsWith("key:"))).toBe(false);
      expect(f.published).toHaveLength(0);
    }
  });

  test("output plaintext budget failure wipes the offered output", async () => {
    const f = await fixture({maximumPlaintextBytes: 14});
    const output = new TextEncoder().encode("reflection");
    await expectRejected(f.registry.runCurrent({...f.run, execute: async (capability) => {
      await capability.openInputs();
      await capability.publishOutputs([{objectId: "record-1", plaintext: output}]);
    }}), "budget");
    expect(output.every((byte) => byte === 0)).toBe(true);
    expect(f.published).toHaveLength(0);
  });

  test("publication bytes and claim hashes are borrowed and wiped after ownership ends", async () => {
    const f = await fixture();
    const bytes: Uint8Array[] = [];
    await f.registry.runCurrent({...f.run,
      claims: {claimExactCredential: async (claim) => {bytes.push(claim.credentialHash, claim.workDescriptorHash); return "claimed";}},
      objects: {...f.objects, publishOutputs: async (request) => {
        for (const output of request.outputs) bytes.push(output.payloadBytes, output.envelopeBytes,
          output.manifestBytes, output.tombstoneManifestBytes, output.signerAuthorizationBytes);
        await f.objects.publishOutputs(request);
      }},
    });
    expect(bytes.length).toBe(7);
    expect(bytes.every((value) => value.every((byte) => byte === 0))).toBe(true);
  });

  test("Namespace adapter return values cannot substitute plaintext produced by the gate", async () => {
    const f = await fixture();
    await f.registry.runCurrent({...f.run, objects: {...f.objects,
      withNamespaceKey: async (_request, use) => {
        await use(f.namespaceKey);
        return new Uint8Array([99]) as never;
      },
    }, execute: async (capability) => {
      expect((await capability.openInputs())[0]!.plaintext).toEqual(f.plaintext);
      await capability.publishOutputs([]);
    }});
  });

  test("a Namespace adapter cannot swallow failed ciphertext decryption", async () => {
    const f = await fixture();
    await expectRejected(f.registry.runCurrent({...f.run, objects: {...f.objects,
      withNamespaceKey: async (_request, use) => {
        try {await use(new Uint8Array(32));} catch {
          // Deliberately model an adapter incorrectly swallowing crypto failure.
        }
        return new Uint8Array([99]) as never;
      },
    }}), "failed to open");
    expect(f.published).toHaveLength(0);
  });
});


describe("current processor persisted output parity and scoped borrow", () => {
  test("automatically proves persisted output before publish resolves and lends a fresh one-use plaintext scope", async () => {
    const f = await fixture();
    const original = new TextEncoder().encode("reflection");
    let borrowed: Uint8Array | undefined;
    let saved: ProcessorTransformCapabilityV1 | undefined;
    const result = await f.registry.runCurrent({...f.run, execute: async (capability) => {
      saved = capability;
      await capability.openInputs();
      await capability.publishOutputs([{objectId: "record-1", plaintext: original}]);
      expect(original.every((byte) => byte === 0)).toBe(true);
      expect(f.calls.filter((call) => call === "reopen")).toHaveLength(1);
      const returned = await capability.withPublishedOutputs!((outputs) => {
        expect(outputs.map((output) => output.objectId)).toEqual(["record-1"]);
        borrowed = outputs[0]!.plaintext;
        expect(new TextDecoder().decode(borrowed)).toBe("reflection");
        return borrowed;
      });
      expect(returned.every((byte) => byte === 0)).toBe(true);
      expect(borrowed?.every((byte) => byte === 0)).toBe(true);
      expect(f.calls.filter((call) => call === "reopen")).toHaveLength(2);
    }});
    expect(result).toEqual({status: "executed"});
    expect(f.namespaceKey.some((byte) => byte !== 0)).toBe(true);
    expect(f.published[0]!.outputs[0]!.payloadBytes.some((byte) => byte !== 0)).toBe(true);
    await expectRejected(saved!.withPublishedOutputs!(() => "late"));
  });

  test("tampered persisted payload or envelope cannot return publication success", async () => {
    for (const target of ["payload", "envelope"] as const) {
      const f = await fixture(); const original = new TextEncoder().encode("reflection");
      let resolved = false;
      await expectRejected(f.registry.runCurrent({...f.run, objects: {...f.objects,
        openPublishedOutput: async (request) => {
          const loaded = await f.objects.openPublishedOutput(request);
          return target === "payload" ? {...loaded, payload: {...loaded.payload, context: {...loaded.payload.context, objectType: "changed"}}}
            : {...loaded, envelope: {...loaded.envelope, context: {...loaded.envelope.context, namespaceId: namespaceId("other")}}};
        },
      }, execute: async (capability) => {
        await capability.openInputs(); await capability.publishOutputs([{objectId: "record-1", plaintext: original}]); resolved = true;
      }}), "differs from its committed bytes");
      expect(resolved).toBe(false); expect(original.every((byte) => byte === 0)).toBe(true);
      expect(f.published).toHaveLength(1);
    }
  });

  test("the exact persisted ciphertext must also reopen with the currently borrowed Namespace key", async () => {
    const f = await fixture();
    await expectRejected(f.registry.runCurrent({...f.run, objects: {...f.objects,
      withNamespaceKey: async (request, use) => f.published.length === 0
        ? f.objects.withNamespaceKey(request, use) : use(new Uint8Array(32)),
    }}), "failed to reopen");
    expect(f.published).toHaveLength(1);
  });

  test("a callback rereads persisted material and refuses changes after the automatic proof", async () => {
    const f = await fixture(); let invoked = false;
    await expectRejected(f.registry.runCurrent({...f.run, execute: async (capability) => {
      await capability.openInputs(); await capability.publishOutputs([{objectId: "record-1", plaintext: new TextEncoder().encode("reflection")}]);
      f.published[0]!.outputs[0]!.payloadBytes[f.published[0]!.outputs[0]!.payloadBytes.length - 1]! ^= 1;
      await capability.withPublishedOutputs!(() => {invoked = true;});
    }}), "differs from its committed bytes");
    expect(invoked).toBe(false);
  });

  test("revocation after commit prevents borrowing persisted plaintext", async () => {
    const f = await fixture(); let invoked = false;
    await expectRejected(f.registry.runCurrent({...f.run, execute: async (capability) => {
      await capability.openInputs(); await capability.publishOutputs([{objectId: "record-1", plaintext: new TextEncoder().encode("reflection")}]);
      f.revoke(); await capability.withPublishedOutputs!(() => {invoked = true;});
    }}));
    expect(invoked).toBe(false); expect(f.published).toHaveLength(1);
  });

  test("revocation while the borrow callback runs prevents success and wipes its plaintext", async () => {
    const f = await fixture(); let borrowed: Uint8Array | undefined;
    await expectRejected(f.registry.runCurrent({...f.run, execute: async (capability) => {
      await capability.openInputs(); await capability.publishOutputs([{objectId: "record-1", plaintext: new TextEncoder().encode("reflection")}]);
      await capability.withPublishedOutputs!((outputs) => {borrowed = outputs[0]!.plaintext; f.revoke(); return "completed";});
    }}));
    expect(borrowed?.every((byte) => byte === 0)).toBe(true);
  });

  test("repeated borrowing and publication are both closed without widening original input authority", async () => {
    for (const action of ["borrow", "publish"] as const) {
      const f = await fixture(); let invoked = 0;
      await expectRejected(f.registry.runCurrent({...f.run, execute: async (capability) => {
        await capability.openInputs(); await capability.publishOutputs([{objectId: "record-1", plaintext: new TextEncoder().encode("reflection")}]);
        await capability.withPublishedOutputs!(() => {invoked++;});
        if (action === "borrow") await capability.withPublishedOutputs!(() => {invoked++;});
        else await capability.publishOutputs([]);
      }}));
      expect(invoked).toBe(1); expect(f.published).toHaveLength(1);
      expect(f.calls.filter((call) => call === "body")).toHaveLength(1);
    }
  });

  test("borrowing before commit fails closed", async () => {
    const f = await fixture(); let invoked = false;
    await expectRejected(f.registry.runCurrent({...f.run, execute: async (capability) => {
      await capability.openInputs(); await capability.withPublishedOutputs!(() => {invoked = true;});
    }}), "unavailable");
    expect(invoked).toBe(false); expect(f.published).toHaveLength(0);
  });

  test("abort wipes a borrowed plaintext scope even when its callback never settles", async () => {
    const f = await fixture(); let borrowed: Uint8Array | undefined;
    await expectRejected(f.registry.runCurrent({...f.run, execute: async (capability) => {
      await capability.openInputs(); await capability.publishOutputs([{objectId: "record-1", plaintext: new TextEncoder().encode("reflection")}]);
      await capability.withPublishedOutputs!(async (outputs) => {
        borrowed = outputs[0]!.plaintext; f.expire(); await new Promise<never>(() => {});
      });
    }}));
    expect(borrowed?.every((byte) => byte === 0)).toBe(true); expect(f.registry.size).toBe(0);
  });

  test("late persisted reads after abort cannot reopen a Namespace key", async () => {
    const f = await fixture();
    let release: ((value: Awaited<ReturnType<ProcessorTransformObjectPortV2["openPublishedOutput"]>>) => void) | undefined;
    await expectRejected(f.registry.runCurrent({...f.run, objects: {...f.objects,
      openPublishedOutput: () => new Promise((resolve) => {release = resolve; f.expire();}),
    }}));
    const calls = f.calls.length;
    const stored = f.published[0]!.outputs[0]!;
    release!({payload: decodeEncryptedPayloadV2(stored.payloadBytes), envelope: decodeNamespaceObjectEnvelopeV2(stored.envelopeBytes)});
    await Promise.resolve(); await Promise.resolve();
    expect(f.calls).toHaveLength(calls); expect(f.registry.size).toBe(0);
  });

  test("empty publication retains its commit path and lends an empty verified prefix", async () => {
    const f = await fixture();
    expect(await f.registry.runCurrent({...f.run, execute: async (capability) => {
      await capability.openInputs(); await capability.publishOutputs([]);
      expect(await capability.withPublishedOutputs!((outputs) => outputs.length)).toBe(0);
    }})).toEqual({status: "executed"});
    expect(f.published).toHaveLength(1); expect(f.calls).not.toContain("reopen");
  });
});
