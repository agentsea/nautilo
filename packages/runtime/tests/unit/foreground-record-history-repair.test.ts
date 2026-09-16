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
import type { VerifiedForegroundAgentObject } from
  "@nautilo/lattice-bridge";
import { encodeRecordPayloadV1 } from "@nautilo/reflection-bridge";

import {
  createForegroundRecordHistoryRepairer,
  deterministicForegroundRecordObjectId,
} from
  "../../src/conversation/foreground-record-history-repair";
import { readPreparedDeviceWrappedAgentObjectSnapshot } from
  "../../../lattice-bridge/src/object/device-wrapped-agent-object-crypto";

const RECORD_ID = "10000000-0000-4000-8000-000000000021";
const ROOM_ID = "10000000-0000-4000-8000-000000000022";
const NAMESPACE_ID = "10000000-0000-4000-8000-000000000023";

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

describe("foreground Reflection Record repair", () => {
  test("retries when a selected Record changes before its source loads", async () => {
    const service = createForegroundRecordHistoryRepairer({
      crypto: new LatticeCrypto({ bytes: seededRng(0x311_17) }),
      entities: {} as never,
      publication: {} as never,
      loadSources: () => Promise.resolve([]),
      persist: () => Promise.reject(new Error("must not persist")),
      read: () => Promise.reject(new Error("must not read")),
      validateExisting: () => Promise.reject(new Error("must not validate")),
      attach: () => Promise.reject(new Error("must not attach")),
    });

    expect(await service.protect({ records: [{
      recordRef: RECORD_ID,
      statement: "changed concurrently",
      lifecycle: "current",
      structuralHeight: 0,
    }] })).toEqual({
      status: "waiting_for_authority",
      reason: "record_product_changed",
    });
  });

  test("changes repair identity when product or audience authority changes", () => {
    const crypto = new LatticeCrypto({ bytes: seededRng(0x311_15) });
    const coordinates = {
      recordRef: RECORD_ID,
      representationGeneration: 1,
      ordinaryRepresentationGeneration: 2,
      authorityProjectionGeneration: 3,
      lifecycle: "current" as const,
      structuralHeight: 0,
      processingGeneration: 4,
      accessNamespaceIds: [NAMESPACE_ID],
    };
    const original = deterministicForegroundRecordObjectId(
      crypto,
      coordinates,
    );
    expect(deterministicForegroundRecordObjectId(crypto, coordinates)).toBe(
      original,
    );
    expect(deterministicForegroundRecordObjectId(crypto, {
      ...coordinates,
      authorityProjectionGeneration: 4,
    })).not.toBe(original);
    expect(deterministicForegroundRecordObjectId(crypto, {
      ...coordinates,
      accessNamespaceIds: [...coordinates.accessNamespaceIds, ROOM_ID],
    })).not.toBe(original);
    expect(deterministicForegroundRecordObjectId(crypto, {
      ...coordinates,
      lifecycle: "stale",
    })).not.toBe(original);
  });

  test("returns only a verified reopened statement and attaches once", async () => {
    const crypto = new LatticeCrypto({ bytes: seededRng(0x311_05) });
    const runtime = Object.freeze({
      agentId: agentId("agent-record-repair"),
      keyClass: "runtime" as const,
      generation: agentRuntimeGeneration(2),
      key: new Uint8Array(32).fill(0x61),
    }) as AgentRuntimeKeyGeneration;
    const signer = deriveAgentRuntimeObjectSignerPublic(crypto, runtime);
    const namespaceKey = new Uint8Array(32).fill(0x62);
    const authority = Object.freeze({
      namespaceId: NAMESPACE_ID,
      namespaceAccessRevision: 3,
      namespaceKeyGeneration: 4,
      domainId: "domain-record-repair",
      domainKeyGeneration: 2,
      domainAuthorizationRevision: 1,
      domainHeadDigest: new Uint8Array(32).fill(0x62),
      namespaceHeadDigest: new Uint8Array(32).fill(0x63),
      namespacePublicationDigest: new Uint8Array(32).fill(0x64),
      namespacePublicationSetDigest: new Uint8Array(32).fill(0x65),
      namespaceAudienceFingerprint: new Uint8Array(32).fill(0x66),
    });
    const statement = "Only the reopened Record may enter the prompt.";
    const plaintextBytes = encodeRecordPayloadV1({
      formatVersion: 1,
      posture: "derived",
      observedContentFingerprint: "sha256:record",
      sourceOwnedKind: "memory:fact",
      observedLogicalObjectRef: RECORD_ID,
      observedRevision: "record-v1",
      statement,
      sourceDependencies: [{
        sourceKind: "message",
        logicalObjectRef: "message-1",
        observedRevision: "0",
        observedContentFingerprint: "sha256:message-1",
        terminalAuthorityLeafHandle: "message-leaf-1",
        authorityBearing: true,
      }],
      anchors: [{ kind: "room", anchorRef: ROOM_ID, role: "origin" }],
      childRecordIds: [],
      producer: { producerRef: "reflection", policyVersion: "v1" },
      terminalAuthorityLeafHandles: ["message-leaf-1"],
    });
    let durable: VerifiedForegroundAgentObject | null = null;
    let attached = 0;
    let existing = false;
    const service = createForegroundRecordHistoryRepairer({
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
        operationId: "operation-record-repair",
        grantId: "grant-record-repair",
        grantDigest: new Uint8Array(32).fill(0x67),
        recipientKeyId: "recipient-record-repair",
        runtime,
        signerKeyId: signer.principal.signerKeyId,
        signerPublicKey: signer.publicKey,
        agentAuthorizationRevision: 1,
        policyRevision: 9,
      },
      loadSources: () => Promise.resolve([Object.freeze({
        recordRef: RECORD_ID,
        expectedStatement: existing ? null : statement,
        representationMode: existing
          ? "protected-only" as const
          : "ordinary-and-protected" as const,
        lifecycle: "current" as const,
        structuralHeight: 0,
        processingGeneration: 1,
        existingObjectId: existing ? durable!.objectId : null,
        accessNamespaceIds: Object.freeze([NAMESPACE_ID]),
        ordinaryRepresentationGeneration: 1,
        representationGeneration: 1,
        authorityProjectionGeneration: 1,
        createdAt: Date.parse("2027-01-15T08:00:00.000Z"),
        plaintextBytes: existing ? null : plaintextBytes.slice(),
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
        expect(request.expectedPolicyRevision).toBe(9);
        expect(request.payloadBytes).toBeInstanceOf(Uint8Array);
        return Promise.resolve("restored");
      },
    });

    expect(await service.protect({ records: [{
      recordRef: RECORD_ID,
      statement,
      lifecycle: "current",
      structuralHeight: 0,
    }] })).toEqual({
      status: "verified",
      records: [{
        recordRef: RECORD_ID,
        statement,
        lifecycle: "current",
        structuralHeight: 0,
      }],
      provenance: "repaired",
      repairedCount: 1,
      verification: "authenticated",
      ordinaryRestoredCount: 0,
    });
    expect(attached).toBe(1);
    expect(await service.protect({ records: [{
      recordRef: RECORD_ID,
      statement,
      lifecycle: "current",
      structuralHeight: 0,
    }] })).toEqual({
      status: "verified",
      records: [{
        recordRef: RECORD_ID,
        statement,
        lifecycle: "current",
        structuralHeight: 0,
      }],
      provenance: "existing",
      repairedCount: 0,
      verification: "authenticated",
      ordinaryRestoredCount: 1,
    });
  });
});
