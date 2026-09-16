import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  ProcessorTransformRecipientRegistry,
} from "@nautilo/lattice-crypto";

import {
  advanceBackgroundAuthorizationGeneration,
  createBackgroundAuthorizationRequestV2,
} from "../../src/protected-execution/background-authorization/lifecycle";
import { prepareProcessorRecipient } from "../../src/protected-execution/background-authorization/prepare-processor-recipient";
import {
  InMemoryBackgroundAuthorizationRepository,
  type BackgroundAuthorizationRecord,
} from "../../src/protected-execution/background-authorization/repository";

const NOW = 1_800_000_000_000;

function reflectionRecord(): BackgroundAuthorizationRecord {
  return {
    snapshot: createBackgroundAuthorizationRequestV2({
      requestId: "reflection_request",
      workId: "reflection_work",
      namespaceId: "namespace_room",
      credentialSubject: {
        kind: "processor",
        processorKind: "reflection",
        processorVersion: 1,
      },
      now: NOW,
    }),
    workIdentityHash: new Uint8Array(32).fill(0x51),
    idempotencyKey: "reflection_idempotency",
    workKind: "reflection.authority_reproject",
    purpose: "record.reproject",
    domainId: "domain_room",
    processorAuthorizationRevision: null,
    expectedDomainEpoch: null,
    expectedNamespaceAccessRevision: 3,
    expectedPolicyRevision: 4,
    descriptorBytes: null,
    acceptedMaterial: null,
    finishedAt: null,
  };
}

describe("prepareProcessorRecipient", () => {
  test("prepares a Reflection V2 recipient and wakes only after durable attachment", async () => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    const record = reflectionRecord();
    await repository.create(record);
    const recipients = new ProcessorTransformRecipientRegistry({
      crypto: new LatticeCrypto(),
      now: () => NOW,
    });
    const descriptorBytes = new Uint8Array([4, 5, 6]);
    const descriptorHash = createHash("sha256")
      .update(descriptorBytes)
      .digest();
    const wakes: BackgroundAuthorizationRecord[] = [];
    try {
      const result = await prepareProcessorRecipient(record.snapshot.requestId, {
        repository,
        recipients,
        descriptors: {
          create: () => Promise.resolve({ descriptorBytes, descriptorHash }),
        },
        now: () => NOW,
        recipientKeyId: () => "reflection_recipient_key",
        authorizationRequested: async (stored) => { wakes.push(stored); },
        retryExpired: () => Promise.resolve({ status: "stale" }),
      });

      expect(result).toMatchObject({
        status: "device_authorization_required",
        requestId: record.snapshot.requestId,
        recipientGeneration: 0,
      });
      expect(wakes).toHaveLength(1);
      expect(wakes[0]!.snapshot.state).toBe("awaiting_device");
      expect(wakes[0]!.snapshot.credentialSubject).toEqual({
        kind: "processor",
        processorKind: "reflection",
        processorVersion: 1,
      });
      const stored = await repository.get(record.snapshot.requestId);
      expect(stored?.descriptorBytes).toEqual(descriptorBytes);
      expect(stored?.snapshot.descriptorDigest).toBe(
        Buffer.from(descriptorHash).toString("hex"),
      );
    } finally {
      recipients.close();
    }
  });

  test("does not let a second server take over a live Reflection recipient", async () => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    const record = reflectionRecord();
    await repository.create(record);
    const owner = new ProcessorTransformRecipientRegistry({
      crypto: new LatticeCrypto(),
      now: () => NOW,
    });
    const peer = new ProcessorTransformRecipientRegistry({
      crypto: new LatticeCrypto(),
      now: () => NOW,
    });
    const descriptorBytes = new Uint8Array([7, 8, 9]);
    const descriptorHash = createHash("sha256")
      .update(descriptorBytes)
      .digest();
    const common = {
      repository,
      descriptors: {
        create: () => Promise.resolve({ descriptorBytes, descriptorHash }),
      },
      now: () => NOW,
      recipientKeyId: () => "reflection_recipient_key",
      retryExpired: () => Promise.resolve({ status: "stale" as const }),
    };
    try {
      expect((await prepareProcessorRecipient(record.snapshot.requestId, {
        ...common,
        recipients: owner,
      })).status).toBe("device_authorization_required");
      expect(await prepareProcessorRecipient(record.snapshot.requestId, {
        ...common,
        recipients: peer,
      })).toEqual({ status: "not_due" });
    } finally {
      owner.close();
      peer.close();
    }
  });

  test("a restarted Reflection server rotates the recipient only at exact expiry", async () => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    const record = reflectionRecord();
    await repository.create(record);
    let clock = NOW;
    const owner = new ProcessorTransformRecipientRegistry({
      crypto: new LatticeCrypto(),
      now: () => clock,
    });
    const restarted = new ProcessorTransformRecipientRegistry({
      crypto: new LatticeCrypto(),
      now: () => clock,
    });
    const retryCandidates: BackgroundAuthorizationRecord[] = [];
    const options = {
      repository,
      descriptors: {
        create: (_input: unknown) => {
          const currentGeneration = retryCandidates.length;
          const descriptorBytes = new Uint8Array([7, 8, 9, currentGeneration]);
          return Promise.resolve({
            descriptorBytes,
            descriptorHash: createHash("sha256").update(descriptorBytes).digest(),
          });
        },
      },
      now: () => clock,
      recipientKeyId: (current: BackgroundAuthorizationRecord) =>
        `reflection_recipient_key_${current.snapshot.recipientGeneration}`,
      retryExpired: async (current: BackgroundAuthorizationRecord) => {
        const candidate = {
          ...current,
          snapshot: advanceBackgroundAuthorizationGeneration(current.snapshot, {
            reason: "attempt_expired",
            now: clock,
            nextAttemptAt: clock,
          }),
          descriptorBytes: null,
          acceptedMaterial: null,
        };
        retryCandidates.push(candidate);
        const updated = await repository.compareAndSwap({
          expectedRequestRevision: current.snapshot.requestRevision,
          next: candidate,
        });
        return { status: updated.status === "updated" ? "retry_scheduled" as const : "stale" as const };
      },
    };
    try {
      expect(await prepareProcessorRecipient(record.snapshot.requestId, {
        ...options,
        recipients: owner,
      })).toMatchObject({
        status: "device_authorization_required",
        recipientGeneration: 0,
      });
      const original = await repository.get(record.snapshot.requestId);
      if (original?.snapshot.recipient === null || original === null) {
        throw new Error("Reflection recipient was not attached");
      }
      owner.close();

      clock = original.snapshot.recipient.expiresAt - 1;
      expect(await prepareProcessorRecipient(record.snapshot.requestId, {
        ...options,
        recipients: restarted,
      })).toEqual({ status: "not_due" });
      expect(await repository.get(record.snapshot.requestId)).toEqual(original);
      expect(retryCandidates).toEqual([]);

      clock = original.snapshot.recipient.expiresAt;
      expect(await prepareProcessorRecipient(record.snapshot.requestId, {
        ...options,
        recipients: restarted,
      })).toMatchObject({
        status: "device_authorization_required",
        recipientGeneration: 1,
      });
      expect(retryCandidates).toHaveLength(1);
      expect(retryCandidates[0]).toMatchObject({
        snapshot: {
          state: "awaiting_recipient",
          recipientGeneration: 1,
          retryCount: 0,
          lastRetryReason: "attempt_expired",
          recipient: null,
        },
        descriptorBytes: null,
        acceptedMaterial: null,
      });
      expect(await repository.get(record.snapshot.requestId)).toMatchObject({
        snapshot: {
          state: "awaiting_device",
          recipientGeneration: 1,
          retryCount: 0,
          lastRetryReason: "attempt_expired",
          recipient: { recipientKeyId: "reflection_recipient_key_1" },
        },
        descriptorBytes: new Uint8Array([7, 8, 9, 1]),
        acceptedMaterial: null,
      });
    } finally {
      owner.close();
      restarted.close();
    }
  });
});
