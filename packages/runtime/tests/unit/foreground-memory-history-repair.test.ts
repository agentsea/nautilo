import { describe, expect, test } from "bun:test";
import {
  agentId,
  agentRuntimeGeneration,
  deriveAgentRuntimeObjectSignerPublic,
  LatticeCrypto,
  type AgentRuntimeKeyGeneration,
} from "@nautilo/lattice-crypto";
import { decodeNamespaceObjectEnvelopeV2 } from
  "@nautilo/lattice-crypto/wire";
import {
  encodeMemoryPayloadV1,
  type VerifiedForegroundAgentObject,
} from "@nautilo/lattice-bridge";

import { createForegroundMemoryHistoryRepairer } from
  "../../src/conversation/foreground-memory-history-repair";
import { readPreparedDeviceWrappedAgentObjectSnapshot } from
  "../../../lattice-bridge/src/object/device-wrapped-agent-object-crypto";

const MEMORY_ID = "10000000-0000-4000-8000-000000000031";
const NAMESPACE_ID = "10000000-0000-4000-8000-000000000032";

function seededRng(seed: number) {
  let state = seed >>> 0;
  return (length: number): Uint8Array => {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      bytes[index] = state & 0xff;
    }
    return bytes;
  };
}

describe("foreground Memory history repair", () => {
  test("retries when a selected Memory changes before its source loads", async () => {
    const crypto = new LatticeCrypto({ bytes: seededRng(0x311_16) });
    const memory = Object.freeze({
      id: MEMORY_ID,
      type: "fact",
      content: "changed concurrently",
      importance: 0.5,
      tier: 1,
      createdAt: new Date("2027-01-15T08:00:00.000Z"),
    });
    const service = createForegroundMemoryHistoryRepairer({
      crypto,
      entities: {} as never,
      publication: {} as never,
      loadSources: () => Promise.resolve([]),
      persist: () => Promise.reject(new Error("must not persist")),
      read: () => Promise.reject(new Error("must not read")),
      validateExisting: () => Promise.reject(new Error("must not validate")),
      attach: () => Promise.reject(new Error("must not attach")),
    });

    expect(await service.protect({ memories: [memory] })).toEqual({
      status: "waiting_for_authority",
      reason: "memory_product_changed",
    });
  });

  test("protected-only Memory loading fails without ciphertext before crypto", async () => {
    const memory = Object.freeze({
      id: MEMORY_ID,
      type: "fact",
      content: "upstream selection still carries ordinary content",
      importance: 0.5,
      tier: 1,
      createdAt: new Date("2027-01-15T08:00:00.000Z"),
    });
    let cryptoUses = 0;
    let reverseRepairs = 0;
    const service = createForegroundMemoryHistoryRepairer({
      crypto: new LatticeCrypto({ bytes: seededRng(0x318_16) }),
      sourceRepresentationMode: "protected-only",
      entities: {
        signal: new AbortController().signal,
        use: () => {
          cryptoUses += 1;
          return Promise.reject(new Error("must not decrypt"));
        },
        useCurrentSet: () => {
          cryptoUses += 1;
          return Promise.reject(new Error("must not encrypt"));
        },
      },
      publication: {} as never,
      loadSources: (_selected, mode) => {
        expect(mode).toBe("protected-only");
        return Promise.resolve([Object.freeze({
          memory: Object.freeze({ ...memory, type: null, content: null }),
          representationMode: "protected-only" as const,
          expectedContentRevision: 2,
          targetContentRevision: 2,
          existingObjectId: null,
          expectedAccessRevision: 0,
          accessNamespaceIds: [NAMESPACE_ID],
          createdAt: memory.createdAt.getTime(),
          plaintextBytes: null,
          requestCommitment: new Uint8Array(32),
        })]);
      },
      persist: () => Promise.reject(new Error("must not persist")),
      read: () => Promise.resolve(null),
      validateExisting: () => Promise.reject(new Error("must not validate")),
      attach: () => Promise.reject(new Error("must not attach")),
      restoreOrdinary: () => {
        reverseRepairs += 1;
        return Promise.resolve("restored");
      },
    });

    expect(await service.protect({ memories: [memory] })).toEqual({
      status: "failed",
      reason: "protected_representation_missing",
    });
    expect(cryptoUses).toBe(0);
    expect(reverseRepairs).toBe(0);
  });

  test("repairs and reopens one selected Memory through the live gateway", async () => {
    const crypto = new LatticeCrypto({ bytes: seededRng(0x311_06) });
    const runtime = Object.freeze({
      agentId: agentId("agent-memory-repair"),
      keyClass: "runtime" as const,
      generation: agentRuntimeGeneration(2),
      key: new Uint8Array(32).fill(0x71),
    }) as AgentRuntimeKeyGeneration;
    const signer = deriveAgentRuntimeObjectSignerPublic(crypto, runtime);
    const namespaceKey = new Uint8Array(32).fill(0x72);
    const authority = Object.freeze({
      namespaceId: NAMESPACE_ID,
      namespaceAccessRevision: 3,
      namespaceKeyGeneration: 4,
      domainId: "domain-memory-repair",
      domainKeyGeneration: 2,
      domainAuthorizationRevision: 1,
      domainHeadDigest: new Uint8Array(32).fill(0x72),
      namespaceHeadDigest: new Uint8Array(32).fill(0x73),
      namespacePublicationDigest: new Uint8Array(32).fill(0x74),
      namespacePublicationSetDigest: new Uint8Array(32).fill(0x75),
      namespaceAudienceFingerprint: new Uint8Array(32).fill(0x76),
    });
    const memory = Object.freeze({
      id: MEMORY_ID,
      type: "preference",
      content: "The Human prefers concise test reports.",
      importance: 0.8,
      tier: 1,
      createdAt: new Date("2027-01-15T08:00:00.000Z"),
      score: 0.9,
    });
    let durable: VerifiedForegroundAgentObject | null = null;
    let attached = 0;
    let restored = 0;
    let existing = false;
    let ordinaryType: string | null = null;
    const service = createForegroundMemoryHistoryRepairer({
      crypto,
      entities: {
        signal: new AbortController().signal,
        useCurrentSet: async (request) => ({
          status: "executed" as const,
          value: await request.execute([{ namespaceKey, authority }]),
        }),
        use: async (request) => ({
          status: "executed" as const,
          value: await request.execute({ namespaceKey, authority }),
        }),
      },
      publication: {
        operationId: "operation-memory-repair",
        grantId: "grant-memory-repair",
        grantDigest: new Uint8Array(32).fill(0x77),
        recipientKeyId: "recipient-memory-repair",
        runtime,
        signerKeyId: signer.principal.signerKeyId,
        signerPublicKey: signer.publicKey,
        agentAuthorizationRevision: 1,
        policyRevision: 7,
      },
      loadSources: () => Promise.resolve([Object.freeze({
        memory: existing
          ? Object.freeze({ ...memory, type: ordinaryType, content: null })
          : memory,
        representationMode: existing
          ? "protected-only" as const
          : "ordinary-and-protected" as const,
        expectedContentRevision: 0,
        targetContentRevision: 1,
        existingObjectId: existing ? durable!.objectId : null,
        expectedAccessRevision: 0,
        accessNamespaceIds: Object.freeze([NAMESPACE_ID]),
        createdAt: memory.createdAt.getTime(),
        plaintextBytes: existing ? null : encodeMemoryPayloadV1({
          formatVersion: 1,
          type: memory.type,
          content: memory.content,
        }),
        requestCommitment: new Uint8Array(32).fill(0x78),
      })]),
      persist: async (prepared) => {
        const snapshot = readPreparedDeviceWrappedAgentObjectSnapshot(prepared);
        durable = Object.freeze({
          objectId: prepared.objectId,
          accessRevision: 0,
          payloadBytes: snapshot.object.payloadBytes.ciphertext.slice(),
          namespaceEnvelopes: Object.freeze(
            snapshot.access.envelopeBytes.map((bytes) => {
              const envelope = decodeNamespaceObjectEnvelopeV2(bytes);
              return Object.freeze({
                namespaceId: envelope.context.namespaceId,
                keyGeneration: envelope.context.keyGeneration,
                bindingRevisionAtWrap:
                  envelope.context.bindingRevisionAtWrap,
                envelopeBytes: bytes.slice(),
              });
            }),
          ),
        });
        return "created";
      },
      read: () => Promise.resolve(durable === null ? null : Object.freeze({
        ...durable,
        payloadBytes: durable.payloadBytes.slice(),
        namespaceEnvelopes: Object.freeze(durable.namespaceEnvelopes.map(
          (entry) => Object.freeze({
            ...entry,
            envelopeBytes: entry.envelopeBytes.slice(),
          }),
        )),
      })),
      validateExisting: () => Promise.resolve(existing),
      attach: () => {
        attached += 1;
        existing = true;
        return Promise.resolve("attached");
      },
      restoreOrdinary: (request) => {
        expect(request.expectedPolicyRevision).toBe(7);
        expect(request.type).toBe(memory.type);
        expect(request.content).toBe(memory.content);
        restored += 1;
        return Promise.resolve("restored");
      },
    });

    expect(await service.protect({ memories: [memory] })).toEqual({
      status: "verified",
      memories: [memory],
      provenance: "repaired",
      repairedCount: 1,
      verification: "authenticated",
      ordinaryRestoredCount: 0,
    });
    expect(attached).toBe(1);
    expect(await service.protect({ memories: [memory] })).toEqual({
      status: "verified",
      memories: [memory],
      provenance: "existing",
      repairedCount: 0,
      verification: "authenticated",
      ordinaryRestoredCount: 1,
    });
    expect(restored).toBe(1);

    // An independently present authored type is still a parity obligation;
    // missing ordinary content is not permission to overwrite a mismatch.
    ordinaryType = "a different authored type";
    expect(await service.protect({ memories: [memory] })).toEqual({
      status: "failed",
      reason: "memory_payload_parity_mismatch",
    });
    expect(restored).toBe(1);
  });
});
