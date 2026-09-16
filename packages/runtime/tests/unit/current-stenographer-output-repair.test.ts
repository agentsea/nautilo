import {describe, expect, test} from "bun:test";
import {
  LatticeCrypto,
  type ProcessorTransformRecipientAttempt,
} from "@nautilo/lattice-crypto";
import {
  decodeBackgroundProcessorWorkDescriptorV2,
  outputRepairFingerprintV2,
} from "@nautilo/lattice-crypto/background";
import type {StenographerOutputRepairPlan} from "@nautilo/lattice-bridge";

import {
  allocateCurrentStenographerOutputRepairPlan,
  createCurrentStenographerOutputRepairRecord,
  currentStenographerOutputRepairDescriptor,
} from "../../src/stenographer/current-stenographer-output-repair";
import type {CurrentProtectedStenographerAuthority} from
  "../../src/stenographer/protected-stenographer-work-composition";

const NOW = 1_800_000_000_000;
const ROOM = "10000000-0000-4000-8000-000000000001";
const NAMESPACE = "20000000-0000-4000-8000-000000000001";
const BATCH = "30000000-0000-4000-8000-000000000001";
const EVENT_ONE = "40000000-0000-4000-8000-000000000001";
const EVENT_TWO = "40000000-0000-4000-8000-000000000002";
const EXISTING_OBJECT = `journal/event/${EVENT_ONE}`;

function authority(
  patch: Partial<CurrentProtectedStenographerAuthority["namespace"]> = {},
): CurrentProtectedStenographerAuthority {
  return Object.freeze({
    policyRevision: 13,
    namespace: Object.freeze({
      serverId: "https://nautilo.example",
      roomId: ROOM,
      namespaceId: NAMESPACE,
      namespaceAccessRevision: 11,
      namespaceKeyGeneration: 3,
      namespaceHeadDigest: new Uint8Array(32).fill(1),
      domainId: "domain-room-1",
      domainKeyGeneration: 4,
      domainAuthorizationRevision: 5,
      domainHeadDigest: new Uint8Array(32).fill(2),
      bundleRevision: 6,
      bundleDigest: new Uint8Array(32).fill(3),
      ...patch,
    }),
  });
}

function plan(input: Readonly<{
  placeholder?: string;
  rebuildGeneration?: number;
  fallbackReason?: "device" | "authority";
  fingerprintByte?: number;
}> = {}): StenographerOutputRepairPlan {
  const rebuildGeneration = input.rebuildGeneration ?? 4;
  const fallbackReason = input.fallbackReason ?? "device";
  return {
    version: 2,
    binding: {
      receipt: {
        kind: "extraction",
        id: BATCH,
        roomId: ROOM,
        namespaceId: NAMESPACE,
        rebuildGeneration,
        fallbackReason,
        ordinaryOutputFingerprint: new Uint8Array(32).fill(
          input.fingerprintByte ?? 7,
        ),
      },
      outputs: [{
        logicalId: EVENT_ONE,
        objectId: EXISTING_OBJECT,
        objectType: "nautilo.reflection.record.v1",
        createdAt: NOW - 2_000,
        disposition: "existing",
        representationGeneration: 3,
        ordinaryRepresentationGeneration: 2,
      }, {
        logicalId: EVENT_TWO,
        objectId: input.placeholder ?? "repair-placeholder",
        objectType: "nautilo.reflection.record.v1",
        createdAt: NOW - 1_000,
        disposition: "create",
        representationGeneration: 1,
        ordinaryRepresentationGeneration: 2,
      }],
    },
    snapshot: {
      roomId: ROOM,
      namespaceId: NAMESPACE,
      rebuildGeneration,
      rollup: null,
      events: [{
        kind: "event",
        rebuildGeneration,
        status: "superseded",
        binding: {
          eventId: EVENT_ONE,
          roomId: ROOM,
          namespaceId: NAMESPACE,
          sequence: 21,
          kind: "fact",
          supersedesEventId: null,
          resolvesEventId: null,
          sourceMessageIds: [7],
          sourceBatchId: BATCH,
          batchLocalOrdinal: 0,
          extractorVersion: "m219-v1",
          createdAt: new Date(NOW - 2_000).toISOString(),
        },
        payload: {
          kind: "reflection_record",
          recordId: EVENT_ONE,
          lifecycle: "superseded",
          structuralHeight: 0,
          processingGeneration: 2,
          ordinaryRepresentationGeneration: 2,
          protectedMapping: {
            status: "mapped",
            representationGeneration: 3,
            cryptoObjectId: EXISTING_OBJECT,
          },
        },
      }, {
        kind: "event",
        rebuildGeneration,
        status: "active",
        binding: {
          eventId: EVENT_TWO,
          roomId: ROOM,
          namespaceId: NAMESPACE,
          sequence: 22,
          kind: "decision",
          supersedesEventId: null,
          resolvesEventId: null,
          sourceMessageIds: [8],
          sourceBatchId: BATCH,
          batchLocalOrdinal: 1,
          extractorVersion: "m219-v1",
          createdAt: new Date(NOW - 1_000).toISOString(),
        },
        payload: {
          kind: "reflection_record",
          recordId: EVENT_TWO,
          lifecycle: "current",
          structuralHeight: 0,
          processingGeneration: 2,
          ordinaryRepresentationGeneration: 2,
          protectedMapping: {status: "missing"},
        },
      }],
    },
  };
}

function record(
  crypto: LatticeCrypto,
  repairPlan: StenographerOutputRepairPlan,
  currentAuthority = authority(),
  requestId = "repair-request-1",
) {
  return createCurrentStenographerOutputRepairRecord({
    crypto,
    plan: repairPlan,
    authority: currentAuthority,
    requestId,
    now: NOW,
  });
}

describe("current Stenographer output repair metadata", () => {
  test("allocates deterministic missing IDs independently of placeholders and preserves existing mappings", () => {
    const crypto = new LatticeCrypto();
    const first = allocateCurrentStenographerOutputRepairPlan({
      crypto,
      plan: plan({placeholder: "first-placeholder"}),
      authority: authority(),
    });
    const second = allocateCurrentStenographerOutputRepairPlan({
      crypto,
      plan: plan({placeholder: "second-placeholder"}),
      authority: authority(),
    });

    expect(first).toEqual(second);
    expect(first.binding.outputs[0]?.objectId).toBe(EXISTING_OBJECT);
    expect(first.binding.outputs[1]?.objectId).toMatch(
      /^stenographer-repair:[0-9a-f]{64}:1$/u,
    );
    expect(first.binding.outputs[1]?.objectId).not.toContain("placeholder");

    const firstRecord = record(crypto, first, authority(), "request-one");
    const secondRecord = record(crypto, second, authority(), "request-two");
    expect(firstRecord.idempotencyKey).toBe(secondRecord.idempotencyKey);
    expect(firstRecord.workIdentityHash).toEqual(secondRecord.workIdentityHash);
  });

  test("changes coalescing and created IDs when authority, generation, or provenance changes", () => {
    const crypto = new LatticeCrypto();
    const baseAuthority = authority();
    const base = allocateCurrentStenographerOutputRepairPlan({
      crypto,
      plan: plan(),
      authority: baseAuthority,
    });
    const variants = [
      {
        authority: authority({namespaceAccessRevision: 12}),
        plan: plan(),
      },
      {
        authority: baseAuthority,
        plan: plan({rebuildGeneration: 5}),
      },
      {
        authority: baseAuthority,
        plan: plan({fallbackReason: "authority", fingerprintByte: 8}),
      },
    ];
    const baseRecord = record(crypto, base, baseAuthority);
    for (const variant of variants) {
      const allocated = allocateCurrentStenographerOutputRepairPlan({
        crypto,
        plan: variant.plan,
        authority: variant.authority,
      });
      const changed = record(crypto, allocated, variant.authority);
      expect(allocated.binding.outputs[0]?.objectId).toBe(EXISTING_OBJECT);
      expect(allocated.binding.outputs[1]?.objectId)
        .not.toBe(base.binding.outputs[1]?.objectId);
      expect(changed.idempotencyKey).not.toBe(baseRecord.idempotencyKey);
      expect(changed.workIdentityHash).not.toEqual(baseRecord.workIdentityHash);
    }
  });

  test("binds the exact existing-input and missing-output union into the descriptor", async () => {
    const crypto = new LatticeCrypto();
    const currentAuthority = authority();
    const allocated = allocateCurrentStenographerOutputRepairPlan({
      crypto,
      plan: plan(),
      authority: currentAuthority,
    });
    const queued = record(crypto, allocated, currentAuthority);
    const recipient = await crypto.generateEncryptionKeyPair();
    const attempt: ProcessorTransformRecipientAttempt = {
      requestId: queued.snapshot.requestId,
      workId: queued.snapshot.workId,
      namespaceId: queued.snapshot.namespaceId,
      recipientGeneration: queued.snapshot.recipientGeneration,
      recipientKeyId: "recipient-1",
      recipientPublicKey: recipient.publicKey,
      expiresAt: NOW + 300_000,
    };
    try {
      const encoded = currentStenographerOutputRepairDescriptor({
        crypto,
        plan: allocated,
        authority: currentAuthority,
        record: queued,
        attempt,
        now: NOW + 1,
      });
      const descriptor = decodeBackgroundProcessorWorkDescriptorV2(
        encoded.descriptorBytes,
      );
      expect(encoded.descriptorHash).toEqual(crypto.hash(encoded.descriptorBytes));
      expect(descriptor.authority).toEqual(currentAuthority.namespace);
      expect(descriptor.policyRevision).toBe(currentAuthority.policyRevision);
      expect(descriptor.inputBindings).toEqual([{objectId: EXISTING_OBJECT, namespaceId: NAMESPACE}]);
      expect(descriptor.outputSlots).toEqual([{
        objectId: allocated.binding.outputs[1]!.objectId,
        objectType: "nautilo.reflection.record.v1",
        createdAt: NOW - 1_000,
        namespaceIds: [NAMESPACE],
      }]);
      expect(descriptor.source).toEqual({
        kind: "stenographer_work",
        startSequence: 0,
        endSequence: 0,
        rebuildGeneration: 4,
        fingerprint: outputRepairFingerprintV2(crypto, allocated.binding),
      });
    } finally {
      recipient.privateKey.fill(0);
    }
  });

  test("rejects changed plans, current authority, and recipient coordinates", async () => {
    const crypto = new LatticeCrypto();
    const currentAuthority = authority();
    const allocated = allocateCurrentStenographerOutputRepairPlan({
      crypto,
      plan: plan(),
      authority: currentAuthority,
    });
    const queued = record(crypto, allocated, currentAuthority);
    const recipient = await crypto.generateEncryptionKeyPair();
    const attempt: ProcessorTransformRecipientAttempt = {
      requestId: queued.snapshot.requestId,
      workId: queued.snapshot.workId,
      namespaceId: queued.snapshot.namespaceId,
      recipientGeneration: queued.snapshot.recipientGeneration,
      recipientKeyId: "recipient-1",
      recipientPublicKey: recipient.publicKey,
      expiresAt: NOW + 300_000,
    };
    try {
      const changes = [
        {
          plan: allocateCurrentStenographerOutputRepairPlan({
            crypto,
            plan: plan({fingerprintByte: 8}),
            authority: currentAuthority,
          }),
          authority: currentAuthority,
          attempt,
        },
        {
          plan: allocated,
          authority: authority({namespaceAccessRevision: 12}),
          attempt,
        },
        {
          plan: allocated,
          authority: currentAuthority,
          attempt: {...attempt, recipientGeneration: attempt.recipientGeneration + 1},
        },
        {
          plan: allocated,
          authority: currentAuthority,
          attempt: {...attempt, requestId: "different-request"},
        },
      ];
      for (const changed of changes) {
        expect(() => currentStenographerOutputRepairDescriptor({
          crypto,
          record: queued,
          now: NOW + 1,
          ...changed,
        })).toThrow("changed");
      }
    } finally {
      recipient.privateKey.fill(0);
    }
  });

  test("keeps zero-output repair outside the background crypto codec", () => {
    const crypto = new LatticeCrypto();
    const full = plan();
    const empty: StenographerOutputRepairPlan = {
      ...full,
      binding: {...full.binding, outputs: []},
      snapshot: {...full.snapshot, events: []},
    };
    expect(() => allocateCurrentStenographerOutputRepairPlan({
      crypto,
      plan: empty,
      authority: authority(),
    })).toThrow("outputs");
  });
});
