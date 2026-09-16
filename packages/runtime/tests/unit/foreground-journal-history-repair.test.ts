import { describe, expect, test } from "bun:test";
import {
  agentId,
  agentRuntimeGeneration,
  deriveAgentRuntimeObjectSignerPublic,
  LatticeCrypto,
  type AgentRuntimeKeyGeneration,
} from "@nautilo/lattice-crypto";
import {
  decodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";
import {
  type ForegroundJournalSelectionSnapshot,
  type VerifiedForegroundAgentObject,
} from "@nautilo/lattice-bridge";
import {
  FOREGROUND_REFLECTION_RECORD_OBJECT_TYPE,
} from "@nautilo/lattice-bridge/server";
import {
  buildStenographerRecordPublication,
  encodeDurableRecordEnvelope,
} from "@nautilo/reflection-bridge/server";

import { createForegroundJournalHistoryRepairer } from
  "../../src/conversation/foreground-journal-history-repair";
import { readPreparedDeviceWrappedAgentObjectSnapshot } from
  "../../../lattice-bridge/src/object/device-wrapped-agent-object-crypto";

const ROOM_ID = "10000000-0000-4000-8000-000000000001";
const NAMESPACE_ID = "10000000-0000-4000-8000-000000000002";
const EVENT_ID = "10000000-0000-4000-8000-000000000003";
const BATCH_ID = "10000000-0000-4000-8000-000000000004";

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

describe("foreground Journal history repair", () => {
  test("retries when the selected Journal changes before its sources load", async () => {
    const service = createForegroundJournalHistoryRepairer({
      crypto: new LatticeCrypto({ bytes: seededRng(0x311_18) }),
      entities: {} as never,
      room: { roomId: ROOM_ID, namespaceId: NAMESPACE_ID },
      publication: {} as never,
      selection: {
        selectCurrent: () => Promise.resolve(Object.freeze({
          roomId: ROOM_ID,
          namespaceId: NAMESPACE_ID,
          rebuildGeneration: 1,
          rollup: Object.freeze({}) as never,
          events: Object.freeze([]),
        })),
      },
      loadSources: () => Promise.resolve([]),
      persist: () => Promise.reject(new Error("must not persist")),
      read: () => Promise.reject(new Error("must not read")),
      validateExisting: () => Promise.reject(new Error("must not validate")),
      attach: () => Promise.reject(new Error("must not attach")),
    });

    expect(await service.protect({ maximumEvents: 8 })).toEqual({
      status: "waiting_for_authority",
      reason: "journal_product_changed",
      selectedCount: 1,
    });
  });

  test.each([
    { label: "ordinary", metadataCount: 0, eventCount: 1, oversized: false, wrongBinding: false },
    { label: "large metadata and fitting rendered text", metadataCount: 600, eventCount: 1, oversized: false, wrongBinding: false },
    { label: "oversized rendered text", metadataCount: 0, eventCount: 160, oversized: true, wrongBinding: false },
    { label: "wrong source binding", metadataCount: 0, eventCount: 1, oversized: false, wrongBinding: true },
  ])("repairs native Journal Records with $label", async ({ metadataCount, eventCount, oversized, wrongBinding }) => {
    const crypto = new LatticeCrypto({ bytes: seededRng(0x311_04) });
    const runtime = Object.freeze({
      agentId: agentId("agent-journal-repair"),
      keyClass: "runtime" as const,
      generation: agentRuntimeGeneration(2),
      key: new Uint8Array(32).fill(0x51),
    }) as AgentRuntimeKeyGeneration;
    const signer = deriveAgentRuntimeObjectSignerPublic(crypto, runtime);
    const namespaceKey = new Uint8Array(32).fill(0x52);
    const authority = Object.freeze({
      namespaceId: NAMESPACE_ID,
      namespaceAccessRevision: 3,
      namespaceKeyGeneration: 4,
      domainId: "domain-journal-repair",
      domainKeyGeneration: 2,
      domainAuthorizationRevision: 1,
      domainHeadDigest: new Uint8Array(32).fill(0x52),
      namespaceHeadDigest: new Uint8Array(32).fill(0x53),
      namespacePublicationDigest: new Uint8Array(32).fill(0x54),
      namespacePublicationSetDigest: new Uint8Array(32).fill(0x55),
      namespaceAudienceFingerprint: new Uint8Array(32).fill(0x56),
    });
    const sourceMessageIds = Object.freeze(metadataCount > 0
      ? Array.from({length: 16}, (_, index) => index + 10)
      : [1]);
    const binding = Object.freeze({
      eventId: EVENT_ID,
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      sequence: 1,
      kind: "fact" as const,
      supersedesEventId: null,
      resolvesEventId: null,
      sourceMessageIds,
      sourceBatchId: BATCH_ID,
      batchLocalOrdinal: 0,
      extractorVersion: "stenographer-v1",
      createdAt: "2027-01-15T08:00:00.000Z",
    });
    const selectedEvent = Object.freeze({
      kind: "event" as const,
      rebuildGeneration: 1,
      status: "active" as const,
      binding,
      payload: Object.freeze({
        kind: "reflection_record" as const,
        recordId: EVENT_ID,
        lifecycle: "current" as const,
        structuralHeight: 0,
        processingGeneration: 2,
        ordinaryRepresentationGeneration: 1,
        protectedMapping: Object.freeze({ status: "missing" as const }),
      }),
    });
    const selectedEvents = Array.from({ length: eventCount }, (_, index) => {
      const eventId = index === 0 ? EVENT_ID : `10000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`;
      return {
        ...selectedEvent,
        binding: { ...binding, eventId, sequence: index + 1 },
        payload: { ...selectedEvent.payload, recordId: eventId },
      };
    });
    const snapshot: ForegroundJournalSelectionSnapshot = Object.freeze({
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      rebuildGeneration: 1,
      rollup: null,
      events: Object.freeze(selectedEvents),
    });
    const statement = oversized ? "x".repeat(500) : "This statement came from one protected Record.";
    const recordBytes = (selected: typeof selectedEvents[number]) =>
      encodeDurableRecordEnvelope(buildStenographerRecordPublication({
        eventId: selected.binding.eventId,
        roomId: wrongBinding
          ? "20000000-0000-4000-8000-000000000001"
          : selected.binding.roomId,
        namespaceId: selected.binding.namespaceId,
        kind: selected.binding.kind,
        statement,
        sources: selected.binding.sourceMessageIds.map((messageId) => ({
          messageId,
          editRevision: 0,
          observedContentFingerprint: metadataCount > 0
            ? `sha256:${"a".repeat(249)}`
            : `sha256:message-${messageId}`,
        })),
        sourceBatchId: selected.binding.sourceBatchId,
        batchLocalOrdinal: selected.binding.batchLocalOrdinal,
        extractorVersion: selected.binding.extractorVersion,
        rebuildGeneration: selected.rebuildGeneration,
        transition: {operation: "append"},
        publicationBindingRef:
          `journal:namespace:${selected.binding.namespaceId}:protected:v1`,
      }).record);
    const plaintextBytes = recordBytes(selectedEvents[0]!);
    if (metadataCount > 0) expect(plaintextBytes.length).toBeGreaterThan(4_096);
    const durable = new Map<string, VerifiedForegroundAgentObject>();
    const objectIds = new Map<string, string>();
    let persisted = 0;
    let attached = 0;
    let restored = 0;
    let restoredBytes: Uint8Array | undefined;
    let existing = false;
    const serviceInput = {
      sourceRepresentationMode: "ordinary-and-protected" as
        "ordinary-and-protected" | "protected-only",
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
      room: { roomId: ROOM_ID, namespaceId: NAMESPACE_ID },
      publication: {
        operationId: "operation-journal-repair",
        grantId: "grant-journal-repair",
        grantDigest: new Uint8Array(32).fill(0x57),
        recipientKeyId: "recipient-journal-repair",
        runtime,
        signerKeyId: signer.principal.signerKeyId,
        signerPublicKey: signer.publicKey,
        agentAuthorizationRevision: 1,
        policyRevision: 9,
      },
      selection: { selectCurrent: () => Promise.resolve(snapshot) },
      loadSources: () => Promise.resolve(selectedEvents.map((selected) => Object.freeze({
        representationMode: existing
          ? "protected-only" as const
          : "ordinary-and-protected" as const,
        kind: "event" as const,
        authorityKind: "journal_source" as const,
        logicalId: selected.binding.eventId,
        objectType: FOREGROUND_REFLECTION_RECORD_OBJECT_TYPE,
        existingObjectId: existing ? objectIds.get(selected.binding.eventId)! : null,
        createdAt: Date.parse(binding.createdAt),
        plaintextBytes: existing ? null : recordBytes(selected),
        accessNamespaceIds: Object.freeze([NAMESPACE_ID]),
        representationGeneration: 1,
        ordinaryRepresentationGeneration: existing ? null : 1,
        authorityProjectionGeneration: null,
        ordinaryText: null,
        selection: selected,
      }))),
      persist: async (prepared) => {
        persisted += 1;
        const preparedSnapshot =
          readPreparedDeviceWrappedAgentObjectSnapshot(prepared);
        durable.set(prepared.objectId, Object.freeze({
          objectId: prepared.objectId,
          accessRevision: 0,
          payloadBytes:
            preparedSnapshot.object.payloadBytes.ciphertext.slice(),
          namespaceEnvelopes: Object.freeze(
            preparedSnapshot.access.envelopeBytes.map((bytes) => {
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
        }));
        return "created";
      },
      read: (request) => {
        const stored = durable.get(request.objectId);
        return Promise.resolve(stored === undefined ? null : Object.freeze({
          ...stored,
          payloadBytes: stored.payloadBytes.slice(),
          namespaceEnvelopes: Object.freeze(stored.namespaceEnvelopes.map(
            (entry) => Object.freeze({
              ...entry,
              envelopeBytes: entry.envelopeBytes.slice(),
            }),
          )),
        }));
      },
      validateExisting: () => Promise.resolve(existing),
      attach: (request) => {
        attached += 1;
        objectIds.set(request.source.logicalId, request.objectId);
        existing = true;
        return Promise.resolve("attached");
      },
      restoreOrdinary: (request) => {
        expect(request.expectedPolicyRevision).toBe(9);
        expect(request.payloadBytes).toEqual(recordBytes(selectedEvents[0]!));
        restored += 1;
        restoredBytes = request.payloadBytes;
        return Promise.resolve("restored");
      },
    } satisfies Parameters<
      typeof createForegroundJournalHistoryRepairer
    >[0];
    const service = createForegroundJournalHistoryRepairer(serviceInput);

    const result = await service.protect({ maximumEvents: 256 });
    if (wrongBinding) {
      expect(result).toEqual({
        status: "failed",
        reason: "entity_repair_failed",
        selectedCount: 1,
      });
      expect(persisted).toBe(1);
      expect(attached).toBe(0);
      return;
    }
    if (oversized) {
      expect(result).toEqual({ status: "failed", reason: "journal_selection_oversized", selectedCount: eventCount });
      expect(persisted).toBe(eventCount);
      expect(attached).toBe(eventCount);
      return;
    }
    expect(result).toMatchObject({
      status: "verified",
      provenance: "repaired",
      repairedCount: 1,
      includesReflectionRecord: true,
      journal: {
        rollup: null,
        events: [{
          id: EVENT_ID,
          statement,
        }],
      },
    });
    expect(persisted).toBe(1);
    expect(attached).toBe(1);
    expect(await service.protect({ maximumEvents: 8 })).toMatchObject({
      status: "verified",
      provenance: "existing",
      ordinaryRestoredCount: 1,
    });
    expect(restored).toBe(1);
    expect(restoredBytes?.every((byte) => byte === 0)).toBe(true);
    expect(persisted).toBe(1);
    expect(attached).toBe(1);
    serviceInput.sourceRepresentationMode = "protected-only";
    expect(await service.protect({ maximumEvents: 8 })).toEqual({
      status: "verified",
      provenance: "existing",
      repairedCount: 0,
      includesReflectionRecord: true,
      verification: "authenticated",
      ordinaryRestoredCount: 0,
      journal: {
        rollup: null,
        events: [{
          id: EVENT_ID,
          roomId: ROOM_ID,
          sequence: 1,
          kind: "fact",
          statement,
          status: "active",
          supersedesEventId: null,
          resolvesEventId: null,
        }],
      },
    });
  });

  test("classifies an unmapped legacy Journal event as unsupported before publication", async () => {
    const crypto = new LatticeCrypto({ bytes: seededRng(0x311_05) });
    const runtime = Object.freeze({
      agentId: agentId("agent-legacy-journal"),
      keyClass: "runtime" as const,
      generation: agentRuntimeGeneration(1),
      key: new Uint8Array(32).fill(0x61),
    }) as AgentRuntimeKeyGeneration;
    const signer = deriveAgentRuntimeObjectSignerPublic(crypto, runtime);
    const binding = Object.freeze({
      eventId: EVENT_ID,
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      sequence: 1,
      kind: "fact" as const,
      supersedesEventId: null,
      resolvesEventId: null,
      sourceMessageIds: Object.freeze([1]),
      sourceBatchId: BATCH_ID,
      batchLocalOrdinal: 0,
      extractorVersion: "stenographer-v1",
      createdAt: "2027-01-15T08:00:00.000Z",
    });
    const selectedEvent = Object.freeze({
      kind: "event" as const,
      rebuildGeneration: 1,
      status: "active" as const,
      binding,
      payload: Object.freeze({
        kind: "legacy_event" as const,
        protectedMapping: Object.freeze({ status: "missing" as const }),
      }),
    });
    const plaintextBytes = new TextEncoder().encode("legacy event bytes");
    let publications = 0;
    const service = createForegroundJournalHistoryRepairer({
      crypto,
      entities: {
        signal: new AbortController().signal,
        use: () => Promise.reject(new Error("must not open")),
        useCurrentSet: () => Promise.reject(new Error("must not encrypt")),
      },
      room: { roomId: ROOM_ID, namespaceId: NAMESPACE_ID },
      publication: {
        operationId: "operation-legacy-journal",
        grantId: "grant-legacy-journal",
        grantDigest: new Uint8Array(32).fill(0x62),
        recipientKeyId: "recipient-legacy-journal",
        runtime,
        signerKeyId: signer.principal.signerKeyId,
        signerPublicKey: signer.publicKey,
        agentAuthorizationRevision: 1,
      },
      selection: {
        selectCurrent: () => Promise.resolve(Object.freeze({
          roomId: ROOM_ID,
          namespaceId: NAMESPACE_ID,
          rebuildGeneration: 1,
          rollup: null,
          events: Object.freeze([selectedEvent]),
        })),
      },
      loadSources: () => Promise.resolve([Object.freeze({
        kind: "event" as const,
        authorityKind: "journal_source" as const,
        logicalId: EVENT_ID,
        objectType: "room_event",
        existingObjectId: null,
        createdAt: Date.parse(binding.createdAt),
        plaintextBytes,
        accessNamespaceIds: Object.freeze([NAMESPACE_ID]),
        representationGeneration: 1,
        ordinaryRepresentationGeneration: null,
        authorityProjectionGeneration: null,
        ordinaryText: "legacy event bytes",
        selection: selectedEvent,
      })]),
      persist: () => {
        publications += 1;
        return Promise.resolve("created");
      },
      read: () => Promise.reject(new Error("must not read")),
      validateExisting: () => Promise.reject(new Error("must not validate")),
      attach: () => Promise.reject(new Error("must not attach")),
    });

    expect(await service.protect({ maximumEvents: 8 })).toEqual({
      status: "unsupported",
      reason: "legacy_journal_protected_representation_unavailable",
      selectedCount: 1,
    });
    expect(publications).toBe(0);
  });
});
