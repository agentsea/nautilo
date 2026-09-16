import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  accessRevision,
  encryptObjectPayload,
  namespaceGeneration,
  namespaceId,
  objectId,
  unixTimestamp,
  wrapObjectDekForNamespace,
} from "@nautilo/lattice-crypto";
import {
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";

import {
  encodeRoomEventPayloadV1,
  type ProtectedJournalProductRecord,
} from "../../src/index.ts";
import type {
  ProtectedCheckpointNamespaceMaterial,
} from "../../src/checkpoint/protected-checkpoint-cell-crypto.ts";
import {
  createProtectedJournalAgentContentOpener,
  type ProtectedJournalAgentContentAuthorityPort,
  type ProtectedJournalProcessorObjectVerifierPort,
} from "../../src/server/journal/protected-journal-agent-content-opener.ts";

const EVENT_ID = "10000000-0000-4000-8000-000000000001";
const ROOM_ID = "10000000-0000-4000-8000-000000000002";
const NAMESPACE_ID = "10000000-0000-4000-8000-000000000003";
const BATCH_ID = "10000000-0000-4000-8000-000000000004";
const DOMAIN_ID = "domain-journal-reader";
const OBJECT_ID = "journal:event:1";

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

function fixture() {
  const crypto = new LatticeCrypto(
    { bytes: seededRng(0x241_06) },
    { now: () => 1_800_000_000_000 },
  );
  const key = new Uint8Array(32).fill(0x41);
  const payload = {
    eventId: EVENT_ID,
    roomId: ROOM_ID,
    namespaceId: NAMESPACE_ID,
    sequence: 9,
    kind: "decision" as const,
    statement: "Use the protected journal.",
    supersedesEventId: null,
    resolvesEventId: null,
    sourceMessageIds: [41, 42],
    sourceBatchId: BATCH_ID,
    batchLocalOrdinal: 0,
    extractorVersion: "stenographer-v1",
    createdAt: "2027-01-15T08:00:00.000Z",
  };
  const encrypted = encryptObjectPayload(
    crypto,
    {
      objectId: objectId(OBJECT_ID),
      keyClass: "ai",
      objectType: "nautilo-room-event-v1",
      createdAt: unixTimestamp(1_800_000_000_000),
    },
    encodeRoomEventPayloadV1(payload),
  );
  const envelope = wrapObjectDekForNamespace(
    crypto,
    key,
    {
      objectId: objectId(OBJECT_ID),
      namespaceId: namespaceId(NAMESPACE_ID),
      keyClass: "ai",
      keyGeneration: namespaceGeneration(3),
      bindingRevisionAtWrap: accessRevision(5),
    },
    encrypted.dek,
  );
  const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
  const envelopeBytes = encodeNamespaceObjectEnvelopeV2(envelope);
  const { statement: _statement, ...binding } = payload;
  const record: ProtectedJournalProductRecord = Object.freeze({
    kind: "event",
    cryptoObjectId: OBJECT_ID,
    rebuildGeneration: 7,
    status: "active",
    binding: Object.freeze(binding),
  });
  const material: ProtectedCheckpointNamespaceMaterial = Object.freeze({
    namespaceId: NAMESPACE_ID,
    domainId: DOMAIN_ID,
    accessRevision: 5,
    agentAuthorizationRevision: 9,
    currentGeneration: 3,
    generations: Object.freeze([
      Object.freeze({ generation: 3, key }),
    ]),
  });
  return { crypto, record, material, payloadBytes, envelopeBytes };
}

function authority(
  material: ProtectedCheckpointNamespaceMaterial,
): ProtectedJournalAgentContentAuthorityPort {
  return Object.freeze({
    execute: async <Value>(input: Parameters<
      ProtectedJournalAgentContentAuthorityPort["execute"]
    >[0]) => {
      const controller = new AbortController();
      return Object.freeze({
        status: "executed" as const,
        value: await input.execute(Object.freeze({
          material,
          signal: controller.signal,
          assertActive: () => {
            if (controller.signal.aborted) {
              throw new Error("foreground authority expired");
            }
          },
        })) as Value,
      });
    },
  });
}

function verifier(
  state: ReturnType<typeof fixture>,
  overrides: Readonly<Record<string, unknown>> = {},
): ProtectedJournalProcessorObjectVerifierPort {
  return Object.freeze({
    verify: async (
      { objectId: requested }: Parameters<
        ProtectedJournalProcessorObjectVerifierPort["verify"]
      >[0],
    ) => Object.freeze({
      objectId: requested,
      namespaceId: NAMESPACE_ID,
      domainId: DOMAIN_ID,
      workId: "journal-work-1",
      rebuildGeneration: 7,
      outputOrdinal: 0,
      authorizedOutputObjectIds: Object.freeze([OBJECT_ID]),
      publisherNamespaceAccessRevision: 5,
      payloadBytes: state.payloadBytes.slice(),
      namespaceEnvelopeBytes: state.envelopeBytes.slice(),
      ...overrides,
    }),
  });
}

function request(
  state: ReturnType<typeof fixture>,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    authorizationSession: Object.freeze({ session: "foreground" }),
    entrypointId: "foreground.main" as const,
    namespaceId: NAMESPACE_ID,
    domainId: DOMAIN_ID,
    rebuildGeneration: 7,
    expectedAccessRevision: 5,
    expectedPolicyRevision: 9,
    records: [state.record],
    execute: (opened: readonly unknown[]) => opened,
    ...overrides,
  };
}

describe("protected foreground journal object opener", () => {
  test("opens only the exact processor-verified mapping under foreground authority", async () => {
    const state = fixture();
    const requested: string[] = [];
    const checked = verifier(state);
    const result = await createProtectedJournalAgentContentOpener({
      crypto: state.crypto,
      authority: authority(state.material),
      verifiedObjects: {
        verify: async (input) => {
          requested.push(input.objectId);
          return checked.verify(input);
        },
      },
    }).openBatch(request(state));

    expect(requested).toEqual([OBJECT_ID]);
    expect(result.status).toBe("executed");
    if (result.status !== "executed") throw new Error("expected execution");
    expect(result.value).toEqual([{
      kind: "event",
      cryptoObjectId: OBJECT_ID,
      payload: {
        ...state.record.binding,
        statement: "Use the protected journal.",
      },
    }]);
  });

  test.each([
    ["object substitution", { objectId: "journal:event:other" }],
    ["Namespace substitution", { namespaceId: "namespace-other" }],
    ["Domain substitution", { domainId: "domain-other" }],
    ["generation substitution", { rebuildGeneration: 8 }],
    ["ordinal substitution", { outputOrdinal: 1 }],
    ["authorization-list substitution", {
      authorizedOutputObjectIds: ["journal:event:other"],
    }],
    ["publisher access-revision substitution", {
      publisherNamespaceAccessRevision: 6,
    }],
  ])("fails closed on %s in verified processor evidence", async (
    _label,
    substitution,
  ) => {
    const state = fixture();
    let callbackCalls = 0;
    const result = await createProtectedJournalAgentContentOpener({
      crypto: state.crypto,
      authority: authority(state.material),
      verifiedObjects: verifier(state, substitution),
    }).openBatch(request(state, {
      execute: () => {
        callbackCalls += 1;
        return null;
      },
    }));

    expect(result).toEqual({
      status: "unavailable",
      reason: "content_invalid",
    });
    expect(callbackCalls).toBe(0);
  });

  test("fails closed on missing signer/manifest verification and stale authority", async () => {
    const state = fixture();
    const missing = await createProtectedJournalAgentContentOpener({
      crypto: state.crypto,
      authority: authority(state.material),
      verifiedObjects: { verify: async () => null },
    }).openBatch(request(state));
    expect(missing).toEqual({
      status: "unavailable",
      reason: "content_invalid",
    });

    const staleAuthority: ProtectedJournalAgentContentAuthorityPort = {
      execute: async () => ({
        status: "unavailable",
        reason: "authorization_unavailable",
      }),
    };
    const stale = await createProtectedJournalAgentContentOpener({
      crypto: state.crypto,
      authority: staleAuthority,
      verifiedObjects: verifier(state),
    }).openBatch(request(state));
    expect(stale).toEqual({
      status: "unavailable",
      reason: "authorization_unavailable",
    });
  });

  test("authenticates confidential payload metadata against product binding", async () => {
    const state = fixture();
    const substituted = {
      ...state.record,
      binding: {
        ...state.record.binding,
        sequence: 10,
      },
    };
    const result = await createProtectedJournalAgentContentOpener({
      crypto: state.crypto,
      authority: authority(state.material),
      verifiedObjects: verifier(state),
    }).openBatch(request(state, { records: [substituted] }));

    expect(result).toEqual({
      status: "unavailable",
      reason: "content_invalid",
    });
  });

  test("keeps valid historical processor output readable under newer current authority", async () => {
    const state = fixture();
    const currentMaterial = Object.freeze({
      ...state.material,
      accessRevision: 6,
    });
    const result = await createProtectedJournalAgentContentOpener({
      crypto: state.crypto,
      authority: authority(currentMaterial),
      verifiedObjects: verifier(state),
    }).openBatch(request(state, { expectedAccessRevision: 6 }));

    expect(result.status).toBe("executed");
  });

  test("does not disguise an authorized consumer failure as corrupt content", async () => {
    const state = fixture();
    const failure = new Error("foreground consumer failed");
    const result = createProtectedJournalAgentContentOpener({
      crypto: state.crypto,
      authority: authority(state.material),
      verifiedObjects: verifier(state),
    }).openBatch(request(state, {
      execute: () => {
        throw failure;
      },
    }));

    expect(await result.catch((cause: unknown) => cause)).toBe(failure);
  });
});
