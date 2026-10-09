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
  createAgentObjectProtector,
  type AgentObjectPreparationSource,
  type VerifiedAgentObject,
} from "../../src/object/agent-object-protector.ts";
import {
  prepareDeviceWrappedAgentObject,
  readPreparedDeviceWrappedAgentObjectSnapshot,
} from "../../src/object/device-wrapped-agent-object-crypto.ts";
import { createForegroundAgentObjectRepairer } from
  "../../src/object/foreground-agent-object-repair.ts";

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

describe("Agent object protector", () => {
  test("delegates exact preparation and authenticates the durable object", async () => {
    const crypto = new LatticeCrypto({ bytes: seededRng(0x411_01) });
    const runtime = Object.freeze({
      agentId: agentId("agent-object-protector"),
      keyClass: "runtime" as const,
      generation: agentRuntimeGeneration(2),
      key: new Uint8Array(32).fill(0x31),
    }) as AgentRuntimeKeyGeneration;
    const signer = deriveAgentRuntimeObjectSignerPublic(crypto, runtime);
    const namespaceKey = new Uint8Array(32).fill(0x41);
    const authority = Object.freeze({
      namespaceId: "namespace-object-protector",
      namespaceAccessRevision: 3,
      namespaceKeyGeneration: 4,
      domainId: "domain-object-protector",
      domainKeyGeneration: 2,
      domainAuthorizationRevision: 1,
      domainHeadDigest: new Uint8Array(32).fill(0x42),
      namespaceHeadDigest: new Uint8Array(32).fill(0x43),
      namespacePublicationDigest: new Uint8Array(32).fill(0x44),
      namespacePublicationSetDigest: new Uint8Array(32).fill(0x45),
      namespaceAudienceFingerprint: new Uint8Array(32).fill(0x46),
    });
    let durable: VerifiedAgentObject | null = null;
    const openedForReads: VerifiedAgentObject[] = [];
    const preparedOperationIds: string[] = [];
    const protector = createAgentObjectProtector({
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
      prepareAndPersist: ({ operationId, source, opened }) => {
        preparedOperationIds.push(operationId);
        const prepared = prepareDeviceWrappedAgentObject({
          crypto,
          objectId: source.objectId,
          objectType: source.objectType,
          plaintextBytes: source.plaintextBytes,
          createdAt: source.createdAt,
          namespaceSet: opened.map((item) => ({
            namespaceId: item.authority.namespaceId,
            accessRevision: item.authority.namespaceAccessRevision,
            keyGeneration: item.authority.namespaceKeyGeneration,
            domainId: item.authority.domainId,
            domainKeyGeneration: item.authority.domainKeyGeneration,
            domainAuthorizationRevision:
              item.authority.domainAuthorizationRevision,
            domainHeadDigest: item.authority.domainHeadDigest,
            headDigest: item.authority.namespaceHeadDigest,
            publicationDigest: item.authority.namespacePublicationDigest,
            publicationSetDigest:
              item.authority.namespacePublicationSetDigest,
            audienceFingerprint:
              item.authority.namespaceAudienceFingerprint,
            key: item.namespaceKey,
          })),
          operationId,
          grant: {
            grantId: "grant-object-protector",
            grantHash: new Uint8Array(32).fill(0x47),
            recipientKeyId: "recipient-object-protector",
          },
          runtime,
          signerKeyId: signer.principal.signerKeyId,
          signerPublicKey: signer.publicKey,
          agentAuthorizationRevision: 1,
        });
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
        return Promise.resolve("created" as const);
      },
      read: () => {
        if (durable === null) return Promise.resolve(null);
        const openedForRead = Object.freeze({
          ...durable,
          payloadBytes: durable.payloadBytes.slice(),
          namespaceEnvelopes: durable.namespaceEnvelopes.map((entry) =>
            Object.freeze({ ...entry, envelopeBytes: entry.envelopeBytes.slice() })
          ),
        });
        openedForReads.push(openedForRead);
        return Promise.resolve(openedForRead);
      },
    });

    expect(await protector.protect({
      operationId: "operation-object-protector",
      source: {
        objectId: "agent-object-protector:1",
        objectType: "nautilo.reflection.record.v1",
        existingObjectId: null,
        createdAt: 1_800_000_000_000,
        namespaceIds: [authority.namespaceId],
        plaintextBytes: new TextEncoder().encode("protected record"),
      },
      decode: (bytes) => new TextDecoder().decode(bytes),
    })).toEqual({
      status: "verified",
      objectId: "agent-object-protector:1",
      provenance: "repaired",
      verification: "authenticated",
      value: "protected record",
    });
    expect(preparedOperationIds).toEqual(["operation-object-protector"]);
    expect(openedForReads[0]!.payloadBytes.every((byte) => byte === 0)).toBe(true);
    expect(
      openedForReads[0]!.namespaceEnvelopes.every((entry) =>
        entry.envelopeBytes.every((byte) => byte === 0)
      ),
    ).toBe(true);
  });

  test("keeps cancellation ahead of reads and publication", async () => {
    const controller = new AbortController();
    controller.abort();
    let usedAuthority = false;
    let read = false;
    const protector = createAgentObjectProtector({
      crypto: new LatticeCrypto({ bytes: seededRng(0x411_02) }),
      entities: {
        signal: controller.signal,
        use: async () => {
          usedAuthority = true;
          return { status: "unavailable", reason: "authorization_unavailable" };
        },
        useCurrentSet: async () => {
          usedAuthority = true;
          return { status: "unavailable", reason: "authorization_unavailable" };
        },
      },
      prepareAndPersist: () => {
        usedAuthority = true;
        return Promise.resolve("created");
      },
      read: () => {
        read = true;
        return Promise.resolve(null);
      },
    });

    expect(await protector.protect({
      operationId: "operation-cancelled",
      source: {
        objectId: "agent-object-protector:cancelled",
        objectType: "room_event",
        existingObjectId: null,
        createdAt: 1,
        namespaceIds: ["namespace-cancelled"],
        plaintextBytes: new Uint8Array([1]),
      },
      decode: () => "must-not-run",
    })).toEqual({
      status: "waiting_for_authority",
      reason: "authorization_cancelled",
    });
    expect(read).toBe(false);
    expect(usedAuthority).toBe(false);
  });

  test("captures repair identity and plaintext before awaiting authority", async () => {
    const originalPlaintext = new Uint8Array([1, 2, 3]);
    const source = {
      objectId: "agent-object-protector:captured",
      objectType: "room_event",
      existingObjectId: null,
      createdAt: 1,
      namespaceIds: ["namespace-captured"],
      plaintextBytes: originalPlaintext,
    };
    const preparedSources: AgentObjectPreparationSource[] = [];
    const protector = createAgentObjectProtector({
      crypto: new LatticeCrypto({ bytes: seededRng(0x411_04) }),
      entities: {
        signal: new AbortController().signal,
        useCurrentSet: async (request) => {
          source.objectId = "agent-object-protector:mutated";
          source.plaintextBytes = new Uint8Array([9]);
          return {
            status: "executed" as const,
            value: await request.execute([]),
          };
        },
        use: async () => ({
          status: "unavailable" as const,
          reason: "authorization_unavailable" as const,
        }),
      },
      prepareAndPersist: (request) => {
        preparedSources.push(request.source);
        return Promise.resolve("stale");
      },
      read: () => Promise.resolve(null),
    });

    expect(await protector.protect({
      operationId: "operation-captured",
      source,
      decode: () => "must-not-run",
    })).toEqual({
      status: "waiting_for_authority",
      reason: "entity_namespace_authority_unavailable",
    });
    expect(preparedSources).toHaveLength(1);
    expect(preparedSources[0]!.objectId).toBe(
      "agent-object-protector:captured",
    );
    expect(preparedSources[0]!.plaintextBytes).toBe(originalPlaintext);
  });

  test("keeps the foreground operation bound against extra runtime fields", async () => {
    const crypto = new LatticeCrypto({ bytes: seededRng(0x411_03) });
    const runtime = Object.freeze({
      agentId: agentId("agent-object-protector-bound-operation"),
      keyClass: "runtime" as const,
      generation: agentRuntimeGeneration(1),
      key: new Uint8Array(32).fill(0x51),
    }) as AgentRuntimeKeyGeneration;
    const signer = deriveAgentRuntimeObjectSignerPublic(crypto, runtime);
    const namespaceKey = new Uint8Array(32).fill(0x52);
    const authority = Object.freeze({
      namespaceId: "namespace-object-protector-bound-operation",
      namespaceAccessRevision: 1,
      namespaceKeyGeneration: 1,
      domainId: "domain-object-protector-bound-operation",
      domainKeyGeneration: 1,
      domainAuthorizationRevision: 1,
      domainHeadDigest: new Uint8Array(32).fill(0x53),
      namespaceHeadDigest: new Uint8Array(32).fill(0x54),
      namespacePublicationDigest: new Uint8Array(32).fill(0x55),
      namespacePublicationSetDigest: new Uint8Array(32).fill(0x56),
      namespaceAudienceFingerprint: new Uint8Array(32).fill(0x57),
    });
    const preparedOperationIds: string[] = [];
    const repairer = createForegroundAgentObjectRepairer({
      crypto,
      entities: {
        signal: new AbortController().signal,
        useCurrentSet: async (request) => ({
          status: "executed" as const,
          value: await request.execute([{ namespaceKey, authority }]),
        }),
        use: async () => ({
          status: "unavailable" as const,
          reason: "authorization_unavailable" as const,
        }),
      },
      publication: {
        operationId: "bound-foreground-operation",
        grantId: "grant-bound-foreground-operation",
        grantDigest: new Uint8Array(32).fill(0x58),
        recipientKeyId: "recipient-bound-foreground-operation",
        runtime,
        signerKeyId: signer.principal.signerKeyId,
        signerPublicKey: signer.publicKey,
        agentAuthorizationRevision: 1,
      },
      persist: (prepared) => {
        preparedOperationIds.push(
          readPreparedDeviceWrappedAgentObjectSnapshot(prepared)
            .access.authority.operationId,
        );
        return Promise.resolve("stale");
      },
      read: () => Promise.resolve(null),
    });
    const requestWithUnexpectedOperation = {
      operationId: "untrusted-runtime-operation",
      source: {
        objectId: "agent-object-protector:bound-operation",
        objectType: "room_event",
        existingObjectId: null,
        createdAt: 1,
        namespaceIds: [authority.namespaceId],
        plaintextBytes: new Uint8Array([1]),
      },
      decode: () => "must-not-run",
    };

    expect(await repairer.protect(requestWithUnexpectedOperation)).toEqual({
      status: "waiting_for_authority",
      reason: "entity_namespace_authority_unavailable",
    });
    expect(preparedOperationIds).toEqual(["bound-foreground-operation"]);
  });
});
