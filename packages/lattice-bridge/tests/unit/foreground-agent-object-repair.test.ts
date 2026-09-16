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
  readPreparedDeviceWrappedAgentObjectSnapshot,
} from "../../src/object/device-wrapped-agent-object-crypto.ts";
import {
  createForegroundAgentObjectRepairer,
  type VerifiedForegroundAgentObject,
} from "../../src/object/foreground-agent-object-repair.ts";

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

describe("foreground Agent object repair", () => {
  test("publishes the complete audience and reopens through one visible Namespace", async () => {
    const crypto = new LatticeCrypto({ bytes: seededRng(0x311_02) });
    const runtime = Object.freeze({
      agentId: agentId("agent-object-repair"),
      keyClass: "runtime" as const,
      generation: agentRuntimeGeneration(2),
      key: new Uint8Array(32).fill(0x31),
    }) as AgentRuntimeKeyGeneration;
    const signer = deriveAgentRuntimeObjectSignerPublic(crypto, runtime);
    const hiddenNamespaceKey = new Uint8Array(32).fill(0x40);
    const namespaceKey = new Uint8Array(32).fill(0x41);
    const hiddenNamespaceAuthority = Object.freeze({
      namespaceId: "namespace-object-repair-a",
      namespaceAccessRevision: 3,
      namespaceKeyGeneration: 4,
      domainId: "domain-object-repair-a",
      domainKeyGeneration: 2,
      domainAuthorizationRevision: 1,
      domainHeadDigest: new Uint8Array(32).fill(0x51),
      namespaceHeadDigest: new Uint8Array(32).fill(0x52),
      namespacePublicationDigest: new Uint8Array(32).fill(0x53),
      namespacePublicationSetDigest: new Uint8Array(32).fill(0x54),
      namespaceAudienceFingerprint: new Uint8Array(32).fill(0x55),
    });
    const namespaceAuthority = Object.freeze({
      namespaceId: "namespace-object-repair-b",
      namespaceAccessRevision: 3,
      namespaceKeyGeneration: 4,
      domainId: "domain-object-repair-b",
      domainKeyGeneration: 2,
      domainAuthorizationRevision: 1,
      domainHeadDigest: new Uint8Array(32).fill(0x41),
      namespaceHeadDigest: new Uint8Array(32).fill(0x42),
      namespacePublicationDigest: new Uint8Array(32).fill(0x43),
      namespacePublicationSetDigest: new Uint8Array(32).fill(0x44),
      namespaceAudienceFingerprint: new Uint8Array(32).fill(0x45),
    });
    let durable: VerifiedForegroundAgentObject | null = null;
    const service = createForegroundAgentObjectRepairer({
      crypto,
      entities: {
        signal: new AbortController().signal,
        useCurrentSet: async (request) => ({
          status: "executed" as const,
          value: await request.execute([
            {
              namespaceKey: hiddenNamespaceKey,
              authority: hiddenNamespaceAuthority,
            },
            { namespaceKey, authority: namespaceAuthority },
          ]),
        }),
        use: async (request) =>
          request.entity.namespaceId === hiddenNamespaceAuthority.namespaceId
            ? {
              status: "unavailable" as const,
              reason: "authorization_unavailable" as const,
            }
            : {
              status: "executed" as const,
              value: await request.execute({
                namespaceKey,
                authority: namespaceAuthority,
              }),
            },
      },
      publication: {
        operationId: "foreground-object-repair",
        grantId: "grant-object-repair",
        grantDigest: new Uint8Array(32).fill(0x46),
        recipientKeyId: "recipient-object-repair",
        runtime,
        signerKeyId: signer.principal.signerKeyId,
        signerPublicKey: signer.publicKey,
        agentAuthorizationRevision: 1,
      },
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
        return "created" as const;
      },
      read: () => Promise.resolve(durable === null ? null : Object.freeze({
        ...durable,
        payloadBytes: durable.payloadBytes.slice(),
        namespaceEnvelopes: durable.namespaceEnvelopes.map((entry) =>
          Object.freeze({ ...entry, envelopeBytes: entry.envelopeBytes.slice() })
        ),
      })),
    });
    const plaintext = new TextEncoder().encode("verified record statement");

    expect(await service.protect({
      source: {
        objectId: "foreground-object-repair:1",
        objectType: "nautilo.reflection.record.v1",
        existingObjectId: null,
        createdAt: 1_800_000_000_000,
        namespaceIds: [
          hiddenNamespaceAuthority.namespaceId,
          namespaceAuthority.namespaceId,
        ],
        plaintextBytes: plaintext,
      },
      decode: (bytes) => new TextDecoder().decode(bytes),
    })).toEqual({
      status: "verified",
      objectId: "foreground-object-repair:1",
      provenance: "repaired",
      verification: "authenticated",
      value: "verified record statement",
    });

    expect(await service.protect({
      source: {
        objectId: "ignored-for-mapped-object",
        objectType: "nautilo.reflection.record.v1",
        existingObjectId: "foreground-object-repair:1",
        createdAt: 1_800_000_000_000,
        namespaceIds: [
          hiddenNamespaceAuthority.namespaceId,
          namespaceAuthority.namespaceId,
        ],
        plaintextBytes: null,
      },
      decode: (bytes) => new TextDecoder().decode(bytes),
    })).toEqual({
      status: "verified",
      objectId: "foreground-object-repair:1",
      provenance: "existing",
      verification: "authenticated",
      value: "verified record statement",
    });

    expect(await service.protect({
      source: {
        objectId: "ignored-for-mapped-object",
        objectType: "nautilo.reflection.record.v1",
        existingObjectId: "foreground-object-repair:1",
        createdAt: 1_800_000_000_000,
        namespaceIds: [
          hiddenNamespaceAuthority.namespaceId,
          namespaceAuthority.namespaceId,
        ],
        plaintextBytes: plaintext,
      },
      decode: (bytes) => new TextDecoder().decode(bytes),
    })).toMatchObject({
      status: "verified",
      provenance: "existing",
      verification: "independent_parity",
    });

    expect(await service.protect({
      source: {
        objectId: "ignored-for-mapped-object",
        objectType: "nautilo.reflection.record.v1",
        existingObjectId: "foreground-object-repair:1",
        createdAt: 1_800_000_000_000,
        namespaceIds: [
          hiddenNamespaceAuthority.namespaceId,
          namespaceAuthority.namespaceId,
        ],
        plaintextBytes: new TextEncoder().encode("wrong ordinary sibling"),
      },
      decode: () => "must-not-run",
    })).toEqual({
      status: "failed",
      reason: "entity_parity_mismatch",
    });

    const validPayload = durable!.payloadBytes;
    durable = Object.freeze({
      ...durable!,
      payloadBytes: validPayload.map((byte, index) =>
        index === validPayload.length - 1 ? byte ^ 1 : byte
      ),
    });
    expect(await service.protect({
      source: {
        objectId: "ignored-for-mapped-object",
        objectType: "nautilo.reflection.record.v1",
        existingObjectId: "foreground-object-repair:1",
        createdAt: 1_800_000_000_000,
        namespaceIds: [
          hiddenNamespaceAuthority.namespaceId,
          namespaceAuthority.namespaceId,
        ],
        plaintextBytes: null,
      },
      decode: () => "must-not-run",
    })).toEqual({
      status: "failed",
      reason: "entity_decryption_failed",
    });
  });

  test("reopens the concurrent winner when deterministic publication conflicts", async () => {
    const crypto = new LatticeCrypto({ bytes: seededRng(0x311_04) });
    const runtime = Object.freeze({
      agentId: agentId("agent-object-repair-race"),
      keyClass: "runtime" as const,
      generation: agentRuntimeGeneration(2),
      key: new Uint8Array(32).fill(0x61),
    }) as AgentRuntimeKeyGeneration;
    const signer = deriveAgentRuntimeObjectSignerPublic(crypto, runtime);
    const namespaceKey = new Uint8Array(32).fill(0x62);
    const authority = Object.freeze({
      namespaceId: "namespace-object-repair-race",
      namespaceAccessRevision: 3,
      namespaceKeyGeneration: 4,
      domainId: "domain-object-repair-race",
      domainKeyGeneration: 2,
      domainAuthorizationRevision: 1,
      domainHeadDigest: new Uint8Array(32).fill(0x62),
      namespaceHeadDigest: new Uint8Array(32).fill(0x63),
      namespacePublicationDigest: new Uint8Array(32).fill(0x64),
      namespacePublicationSetDigest: new Uint8Array(32).fill(0x65),
      namespaceAudienceFingerprint: new Uint8Array(32).fill(0x66),
    });
    let reads = 0;
    let winner: VerifiedForegroundAgentObject | null = null;
    const service = createForegroundAgentObjectRepairer({
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
        operationId: "foreground-object-repair-race",
        grantId: "grant-object-repair-race",
        grantDigest: new Uint8Array(32).fill(0x67),
        recipientKeyId: "recipient-object-repair-race",
        runtime,
        signerKeyId: signer.principal.signerKeyId,
        signerPublicKey: signer.publicKey,
        agentAuthorizationRevision: 1,
      },
      persist: async (prepared) => {
        const snapshot = readPreparedDeviceWrappedAgentObjectSnapshot(prepared);
        winner = Object.freeze({
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
        throw new Error("concurrent encrypted object won");
      },
      read: () => Promise.resolve(reads++ === 0 ? null : winner),
    });
    const plaintext = new TextEncoder().encode("converged record statement");

    expect(await service.protect({
      source: {
        objectId: "foreground-object-repair:race",
        objectType: "nautilo.reflection.record.v1",
        existingObjectId: null,
        createdAt: 1_800_000_000_000,
        namespaceIds: [authority.namespaceId],
        plaintextBytes: plaintext,
      },
      decode: (bytes) => new TextDecoder().decode(bytes),
    })).toEqual({
      status: "verified",
      objectId: "foreground-object-repair:race",
      provenance: "repaired",
      verification: "authenticated",
      value: "converged record statement",
    });
    expect(reads).toBe(2);
  });

  test("does not replace a mapped entity whose durable object is missing", async () => {
    const crypto = new LatticeCrypto({ bytes: seededRng(0x311_03) });
    let published = false;
    const service = createForegroundAgentObjectRepairer({
      crypto,
      entities: {
        signal: new AbortController().signal,
        useCurrentSet: async () => {
          published = true;
          return { status: "unavailable", reason: "content_unavailable" };
        },
        use: async () => ({
          status: "unavailable",
          reason: "content_unavailable",
        }),
      },
      publication: {
        operationId: "foreground-object-repair",
        grantId: "grant-object-repair",
        grantDigest: new Uint8Array(32),
        recipientKeyId: "recipient-object-repair",
        runtime: Object.freeze({
          agentId: agentId("agent-object-repair-missing"),
          keyClass: "runtime" as const,
          generation: agentRuntimeGeneration(1),
          key: new Uint8Array(32).fill(1),
        }) as AgentRuntimeKeyGeneration,
        signerKeyId: "unused",
        signerPublicKey: new Uint8Array(32),
        agentAuthorizationRevision: 1,
      },
      persist: () => Promise.resolve("created"),
      read: () => Promise.resolve(null),
    });

    expect(await service.protect({
      source: {
        objectId: "deterministic-object",
        objectType: "room_event",
        existingObjectId: "mapped-object",
        createdAt: 1,
        namespaceIds: ["namespace-1"],
        plaintextBytes: new Uint8Array([1]),
      },
      decode: () => "must-not-run",
    })).toEqual({
      status: "failed",
      reason: "mapped_entity_crypto_incomplete",
    });
    expect(published).toBe(false);
  });

  test("fails without encryption when both representations are absent", async () => {
    const crypto = new LatticeCrypto({ bytes: seededRng(0x318_01) });
    let encrypted = false;
    const service = createForegroundAgentObjectRepairer({
      crypto,
      entities: {
        signal: new AbortController().signal,
        useCurrentSet: async () => {
          encrypted = true;
          return { status: "unavailable", reason: "content_unavailable" };
        },
        use: async () => ({
          status: "unavailable",
          reason: "content_unavailable",
        }),
      },
      publication: {
        operationId: "foreground-object-open-missing",
        grantId: "grant-object-open-missing",
        grantDigest: new Uint8Array(32),
        recipientKeyId: "recipient-object-open-missing",
        runtime: Object.freeze({
          agentId: agentId("agent-object-open-missing"),
          keyClass: "runtime" as const,
          generation: agentRuntimeGeneration(1),
          key: new Uint8Array(32).fill(1),
        }) as AgentRuntimeKeyGeneration,
        signerKeyId: "unused",
        signerPublicKey: new Uint8Array(32),
        agentAuthorizationRevision: 1,
      },
      persist: () => {
        encrypted = true;
        return Promise.resolve("created");
      },
      read: () => Promise.resolve(null),
    });

    expect(await service.protect({
      source: {
        objectId: "missing-object",
        objectType: "room_event",
        existingObjectId: null,
        createdAt: 1,
        namespaceIds: ["namespace-1"],
        plaintextBytes: null,
      },
      decode: () => "must-not-run",
    })).toEqual({
      status: "failed",
      reason: "protected_representation_missing",
    });
    expect(encrypted).toBe(false);
  });
});
