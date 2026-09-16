import {describe, expect, test} from "bun:test";

import {LatticeCrypto} from "../../src/crypto/index.ts";
import {
  ProcessorTransformRecipientRegistryV1,
  type ProcessorTransformObjectPortV1,
} from "../../src/background/one-run-processor-transform-v1.ts";
import type {
  ProcessorReconciliationObjectPortV2,
  ProcessorReconciliationRunInputV2,
} from "../../src/background/one-run-processor-transform-v2.ts";
import {
  publicationReconciliationFingerprintV2,
  type ProcessorPublicationReconciliationBindingV2,
} from "../../src/background/publication-reconciliation-v2.ts";
import {createBackgroundAuthorizationResponseV2} from
  "../../src/background/processor-authorization-v2.ts";
import {
  encodeBackgroundWorkDescriptorV2,
  type BackgroundProcessorWorkDescriptorV2,
} from "../../src/background/work-descriptor-v2.ts";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "../../src/format/object-v2.ts";
import {wrapObjectDekForNamespaceV2} from
  "../../src/object/namespace-envelope.ts";
import {encryptObjectPayloadV2} from "../../src/object/payload.ts";
import {
  accessRevision,
  namespaceGeneration,
  namespaceId,
  objectId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";
import {backgroundProcessorWorkV2Fixture} from
  "../helpers/background-work-v2-fixture.ts";

const NOW = 1_700_000_000_001;

async function expectRejected(
  work: Promise<unknown>,
  message?: string,
): Promise<void> {
  const error = await work.then(() => null, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  if (message !== undefined && error instanceof Error) {
    expect(error.message).toContain(message);
  }
}

function same(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

type MutableBinding = {
  -readonly [Key in keyof ProcessorPublicationReconciliationBindingV2]:
    ProcessorPublicationReconciliationBindingV2[Key];
};

type FixtureOptions = Readonly<{
  zeroOutputs?: boolean;
  mutateBinding?: (
    binding: MutableBinding,
  ) => void;
  mutateDescriptor?: (
    descriptor: BackgroundProcessorWorkDescriptorV2,
  ) => BackgroundProcessorWorkDescriptorV2;
}>;

async function fixture(options: FixtureOptions = {}) {
  const crypto = new LatticeCrypto();
  const device = crypto.generateSigningKeyPair();
  const domainKey = crypto.randomBytes(32);
  const namespaceKey = crypto.randomBytes(32);
  const controller = new AbortController();
  let now = NOW;
  const workId = "reconciliation-work-1";
  const registry = new ProcessorTransformRecipientRegistryV1({
    crypto,
    now: () => now,
  });
  const created = await registry.createAttempt({
    requestId: "reconciliation-request-1",
    workId,
    namespaceId: "namespace-1",
    recipientGeneration: 0,
    recipientKeyId: "reconciliation-recipient-1",
    expiresAt: NOW + 299_999,
  });
  if (created.status !== "created") {
    throw new Error("Reconciliation fixture recipient failed");
  }

  const specifications = options.zeroOutputs === true
    ? []
    : [{
        objectId: "record-committed-1",
        objectType: "nautilo.reflection.record.v1" as const,
        createdAt: NOW - 1,
        plaintext: new TextEncoder().encode("committed reflection"),
      }];
  const stored = specifications.map((specification) => {
    const encrypted = encryptObjectPayloadV2(crypto, {
      objectId: objectId(specification.objectId),
      keyClass: "ai",
      objectType: specification.objectType,
      createdAt: unixTimestamp(specification.createdAt),
    }, specification.plaintext);
    try {
      const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
      const envelopeBytes = encodeNamespaceObjectEnvelopeV2(
        wrapObjectDekForNamespaceV2(crypto, namespaceKey, {
          objectId: objectId(specification.objectId),
          namespaceId: namespaceId("namespace-1"),
          keyClass: "ai",
          keyGeneration: namespaceGeneration(1),
          bindingRevisionAtWrap: accessRevision(2),
        }, encrypted.dek),
      );
      return {
        ...specification,
        payloadBytes,
        envelopeBytes,
      };
    } finally {
      encrypted.dek.fill(0);
    }
  });
  const binding: MutableBinding = {
    originalRequestId: "original-request-1",
    originalWorkId: "original-work-1",
    originalRecipientGeneration: 4,
    originalDescriptorHash: crypto.randomBytes(32),
    attachmentPlanHash: crypto.randomBytes(32),
    outputs: stored.map((output) => ({
      objectId: output.objectId,
      objectType: output.objectType,
      createdAt: output.createdAt,
      payloadHash: crypto.hash(output.payloadBytes),
      envelopeHash: crypto.hash(output.envelopeBytes),
    })),
  };
  options.mutateBinding?.(binding);
  const fingerprint = publicationReconciliationFingerprintV2(crypto, binding);
  const base = backgroundProcessorWorkV2Fixture(created.attempt.recipientPublicKey);
  let descriptor: BackgroundProcessorWorkDescriptorV2 = {
    ...base,
    requestId: created.attempt.requestId,
    workId,
    workKind: "stenographer.publication_reconcile",
    purpose: "journal.reconcile",
    source: {...base.source, fingerprint},
    operations: binding.outputs.length ? ["decrypt"] : [],
    inputBindings: binding.outputs.map((output) => ({objectId: output.objectId, namespaceId: base.anchorNamespaceId})),
    outputSlots: [],
    recipientGeneration: created.attempt.recipientGeneration,
    recipientKeyId: created.attempt.recipientKeyId,
    recipientPublicKey: created.attempt.recipientPublicKey,
    expiresAt: created.attempt.expiresAt,
    idempotencyId: "reconciliation-idempotency-1",
  };
  descriptor = options.mutateDescriptor?.(descriptor) ?? descriptor;
  const responseBytes = await createBackgroundAuthorizationResponseV2(crypto, {
    credentialId: "reconciliation-credential-1",
    descriptorBytes: encodeBackgroundWorkDescriptorV2(descriptor),
    issuer: {
      humanId: "human-1",
      deviceId: "device-1",
      deviceGeneration: 2,
      serverInstanceId: "instance-1",
      lineageGeneration: 3,
      epoch: 4,
      securityRevision: 5,
      headDigest: new Uint8Array(32).fill(8),
      signingPublicKeyHash: crypto.hash(device.publicKey),
    },
    issuerSigningPrivateKey: device.privateKey,
    domainKey,
  });

  const calls: string[] = [];
  let attachCalls = 0;
  let authorizeCalls = 0;
  let attachedOutputs:
    Parameters<ProcessorReconciliationObjectPortV2["attach"]>[0]["outputs"]
    | undefined;
  const objects: ProcessorReconciliationObjectPortV2 = {
    openInput: async ({objectId: requestedObjectId}) => {
      calls.push(`open:${requestedObjectId}`);
      const output = stored.find((candidate) =>
        candidate.objectId === requestedObjectId
      );
      if (output === undefined) throw new Error("Stored output unavailable");
      return {
        payload: decodeEncryptedPayloadV2(output.payloadBytes),
        envelope: decodeNamespaceObjectEnvelopeV2(output.envelopeBytes),
      };
    },
    withNamespaceKey: async (request, use) => {
      calls.push("key");
      expect(request.domainKey).toEqual(domainKey);
      expect(request.authority).toEqual(descriptor.authority);
      expect(request.generation).toBe(1);
      expect(request.accessRevision).toBe(2);
      return use(namespaceKey);
    },
    attach: async (request) => {
      attachCalls += 1;
      calls.push("attach");
      attachedOutputs = request.outputs;
      await request.authorizeCommit();
      authorizeCalls += 1;
    },
  };
  const run: ProcessorReconciliationRunInputV2 = {
    requestId: descriptor.requestId,
    recipientGeneration: descriptor.recipientGeneration,
    recipientKeyId: descriptor.recipientKeyId,
    claimId: "reconciliation-claim-1",
    responseBytes,
    resolveCurrentIssuer: () => {
      calls.push("authority");
      return device.publicKey;
    },
    claims: {
      claimExactCredential: async () => {
        calls.push("claim");
        return "claimed";
      },
    },
    binding,
    objects,
    signal: controller.signal,
  };
  return {
    crypto,
    device,
    domainKey,
    namespaceKey,
    controller,
    registry,
    descriptor,
    responseBytes,
    binding,
    stored,
    objects,
    run,
    calls,
    attachCalls: () => attachCalls,
    authorizeCalls: () => authorizeCalls,
    attachedOutputs: () => attachedOutputs,
    setNow: (value: number) => { now = value; },
  };
}

describe("current V2 processor publication reconciliation", () => {
  test("attaches the exact committed prefix once without model or publication exposure", async () => {
    const f = await fixture();
    let modelCalls = 0;
    let publicationCalls = 0;
    const objects = {
      ...f.objects,
      publishOutputs: async (_request: Parameters<
        ProcessorTransformObjectPortV1["publishOutputs"]
      >[0]) => { publicationCalls += 1; },
    };
    let rejectedCallback: unknown;
    try {
      await f.registry.runCurrentReconciliation({...f.run, objects,
        execute: () => { modelCalls += 1; },
      } as unknown as ProcessorReconciliationRunInputV2);
    } catch (error) {rejectedCallback = error;}
    expect(rejectedCallback).toBeInstanceOf(TypeError);
    const result = await f.registry.runCurrentReconciliation({...f.run, objects});

    expect(result).toEqual({status: "executed"});
    expect(f.attachCalls()).toBe(1);
    expect(f.authorizeCalls()).toBe(1);
    expect(modelCalls).toBe(0);
    expect(publicationCalls).toBe(0);
    expect(f.calls.indexOf("claim")).toBeLessThan(f.calls.indexOf("key"));
    const attached = f.attachedOutputs();
    expect(attached?.map((output) => output.objectId)).toEqual([
      "record-committed-1",
    ]);
    const borrowedPlaintext = attached?.[0]?.plaintext;
    expect(borrowedPlaintext?.every((byte) => byte === 0)).toBe(true);
    expect(f.namespaceKey.some((byte) => byte !== 0)).toBe(true);
    expect(f.registry.size).toBe(0);
    expect(await f.registry.runCurrentReconciliation(f.run)).toEqual({
      status: "unavailable",
      reason: "recipient_unavailable",
    });
  });

  test("the zero-output marker still crosses the one-use attachment boundary", async () => {
    const f = await fixture({zeroOutputs: true});
    expect(await f.registry.runCurrentReconciliation(f.run)).toEqual({
      status: "executed",
    });
    expect(f.attachCalls()).toBe(1);
    expect(f.authorizeCalls()).toBe(1);
    expect(f.attachedOutputs()).toEqual([]);
    expect(f.calls.some((call) => call.startsWith("open:"))).toBe(false);
    expect(f.calls).not.toContain("key");
  });

  test("rejects substitution between execution and reconciliation descriptor kinds", async () => {
    {
      const f = await fixture({
        mutateDescriptor: (descriptor) => ({
          ...descriptor,
          workKind: "stenographer.extraction",
          purpose: "journal.extract",
          operations: ["decrypt", "encrypt"],
          inputBindings: ["source-message-1"].map(objectId => ({objectId, namespaceId: "namespace-1"})),
          outputSlots: [{
            objectId: "record-new-1",
            objectType: "nautilo.reflection.record.v1",
            createdAt: NOW, namespaceIds: [descriptor.anchorNamespaceId],
          }],
        }),
      });
      await expectRejected(
        f.registry.runCurrentReconciliation(f.run),
        "separate gates",
      );
      expect(f.attachCalls()).toBe(0);
    }
    {
      const f = await fixture();
      let modelCalls = 0;
      const {binding: _binding, ...withoutBinding} = f.run;
      await expectRejected(f.registry.runCurrent({
        ...withoutBinding,
        objects: {
          ...f.objects,
          openPublishedOutput: f.objects.openInput,
          publishOutputs: async () => { throw new Error("must not publish"); },
        },
        execute: () => { modelCalls += 1; },
      }), "separate gates");
      expect(modelCalls).toBe(0);
      expect(f.attachCalls()).toBe(0);
    }
  });

  test("fingerprint changes with original receipt and attachment coordinates", async () => {
    const f = await fixture();
    const original = publicationReconciliationFingerprintV2(
      f.crypto,
      f.binding,
    );
    const changedPlan = f.binding.attachmentPlanHash.slice();
    changedPlan[0]! ^= 1;
    const changed = publicationReconciliationFingerprintV2(f.crypto, {
      ...f.binding,
      attachmentPlanHash: changedPlan,
    });
    expect(original).toHaveLength(32);
    expect(changed).toHaveLength(32);
    expect(same(original, changed)).toBe(false);
    original.fill(0);
    changed.fill(0);
    changedPlan.fill(0);
  });

  test("rejects a descriptor fingerprint that does not commit its binding", async () => {
    const f = await fixture({
      mutateDescriptor: (descriptor) => ({
        ...descriptor,
        source: {
          ...descriptor.source,
          fingerprint: new Uint8Array(32).fill(99),
        },
      }),
    });
    await expectRejected(
      f.registry.runCurrentReconciliation(f.run),
      "signed authority",
    );
    expect(f.calls).not.toContain("claim");
    expect(f.attachCalls()).toBe(0);
  });

  test("rejects stored hashes and metadata outside the signed binding", async () => {
    for (const mutation of [
      (binding: MutableBinding) => {
        binding.outputs[0]!.payloadHash[0]! ^= 1;
      },
      (binding: MutableBinding) => {
        binding.outputs = [{...binding.outputs[0]!, createdAt: NOW - 2}];
      },
      (binding: MutableBinding) => {
        binding.outputs = [{
          ...binding.outputs[0]!,
          objectType: "room_event_rollup",
        }];
      },
    ]) {
      const f = await fixture({mutateBinding: mutation});
      await expectRejected(
        f.registry.runCurrentReconciliation(f.run),
        "stored output differs",
      );
      expect(f.attachCalls()).toBe(0);
    }
  });

  test("rejects changed output inventory coordinates", async () => {
    const f = await fixture({
      mutateDescriptor: (descriptor) => ({
        ...descriptor,
        inputBindings: ["different-committed-record"].map(objectId => ({objectId, namespaceId: "namespace-1"})),
      }),
    });
    await expectRejected(
      f.registry.runCurrentReconciliation(f.run),
      "signed authority",
    );
    expect(f.calls).not.toContain("claim");
    expect(f.attachCalls()).toBe(0);
  });

  test("snapshots a caller binding before asynchronous authority lookup", async () => {
    const f = await fixture();
    let entered: (() => void) | undefined;
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let lookup = 0;
    const operation = f.registry.runCurrentReconciliation({
      ...f.run,
      resolveCurrentIssuer: async () => {
        if (lookup++ === 0) {
          entered?.();
          await gate;
        }
        return f.device.publicKey;
      },
    });
    await waiting;
    f.binding.originalDescriptorHash.fill(77);
    f.binding.attachmentPlanHash.fill(78);
    f.binding.outputs[0]!.payloadHash.fill(79);
    f.binding.outputs[0]!.envelopeHash.fill(80);
    release?.();

    expect(await operation).toEqual({status: "executed"});
    expect(f.attachCalls()).toBe(1);
    expect(f.binding.originalDescriptorHash.every((byte) => byte === 77))
      .toBe(true);
    expect(f.binding.outputs[0]!.payloadHash.every((byte) => byte === 79))
      .toBe(true);
  });

  test("cancellation wipes borrowed plaintext and copied Namespace keys", async () => {
    const f = await fixture();
    let borrowedPlaintext: Uint8Array | undefined;
    let copiedNamespaceKey: Uint8Array | undefined;
    const realOpen = f.crypto.aeadOpen.bind(f.crypto);
    f.crypto.aeadOpen = (key, sealed, aad) => {
      if (key !== f.namespaceKey && same(key, f.namespaceKey)) {
        copiedNamespaceKey = key;
      }
      return realOpen(key, sealed, aad);
    };
    const operation = f.registry.runCurrentReconciliation({
      ...f.run,
      objects: {
        ...f.objects,
        attach: async (request) => {
          borrowedPlaintext = request.outputs[0]!.plaintext;
          f.controller.abort(new Error("cancel reconciliation"));
          await new Promise<never>(() => {});
        },
      },
    });
    await expectRejected(operation, "cancel reconciliation");
    expect(borrowedPlaintext?.every((byte) => byte === 0)).toBe(true);
    expect(copiedNamespaceKey?.every((byte) => byte === 0)).toBe(true);
    expect(f.namespaceKey.some((byte) => byte !== 0)).toBe(true);
    expect(f.registry.size).toBe(0);
  });

  test("duplicate credentials are denied before stored output or key access", async () => {
    const f = await fixture();
    const result = await f.registry.runCurrentReconciliation({
      ...f.run,
      claims: {claimExactCredential: async () => "already_claimed"},
    });
    expect(result).toEqual({
      status: "unavailable",
      reason: "credential_replayed",
    });
    expect(f.calls.some((call) => call.startsWith("open:"))).toBe(false);
    expect(f.calls).not.toContain("key");
    expect(f.attachCalls()).toBe(0);
  });

  test("attachment must invoke commit authorization exactly once", async () => {
    for (const calls of [0, 2]) {
      const f = await fixture();
      await expectRejected(f.registry.runCurrentReconciliation({
        ...f.run,
        objects: {
          ...f.objects,
          attach: async (request) => {
            for (let index = 0; index < calls; index += 1) {
              await request.authorizeCommit();
            }
          },
        },
      }), calls === 0 ? "skipped attachment authorization" : "one-use");
      expect(f.registry.size).toBe(0);
    }
  });
});
