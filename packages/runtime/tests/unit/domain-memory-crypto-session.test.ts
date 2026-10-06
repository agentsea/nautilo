import { describe, expect, test } from "bun:test";
import {
  commitMemoryMutationV1,
  deriveMemoryCryptoObjectIdV1,
  encodeMemoryPayloadV1,
  type AgentEntityNamespaceAuthority,
  type AgentObjectProtectionResult,
  type AgentObjectProtectionSource,
  type AgentObjectProtector,
  type MemoryPayloadV1,
} from "@nautilo/lattice-bridge";

import { createDomainMemoryCryptoSession } from
  "../../src/memory/domain-memory-crypto-session";

const SUBJECT_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_ID = "10000000-0000-4000-8000-000000000002";
const MEMORY_ID = "10000000-0000-4000-8000-000000000003";
const NAMESPACE_ID = "10000000-0000-4000-8000-000000000004";

const namespaceAuthority: AgentEntityNamespaceAuthority = Object.freeze({
  namespaceId: NAMESPACE_ID,
  namespaceAccessRevision: 3,
  namespaceKeyGeneration: 4,
  domainId: "domain-memory",
  domainKeyGeneration: 2,
  domainAuthorizationRevision: 1,
  domainHeadDigest: new Uint8Array(32).fill(0x51),
  namespaceHeadDigest: new Uint8Array(32).fill(0x52),
  namespacePublicationDigest: new Uint8Array(32).fill(0x53),
  namespacePublicationSetDigest: new Uint8Array(32).fill(0x54),
  namespaceAudienceFingerprint: new Uint8Array(32).fill(0x55),
});

const authority = Object.freeze({
  mode: "namespace" as const,
  subjectUserId: SUBJECT_ID,
  agentId: AGENT_ID,
  readableNamespaceIds: Object.freeze([NAMESPACE_ID]),
  mutableNamespaceIds: Object.freeze([NAMESPACE_ID]),
  writableNamespaceId: NAMESPACE_ID,
});

function plan(payload: MemoryPayloadV1) {
  return Object.freeze({
    operationId: "memory-operation",
    action: "created" as const,
    mutationKind: "save" as const,
    memoryId: MEMORY_ID,
    contentRevision: 1,
    cryptoAccessRevision: 0,
    expectedPriorAccessRevision: 0,
    cryptoObjectId: deriveMemoryCryptoObjectIdV1({
      memoryId: MEMORY_ID,
      contentRevision: 1,
    }),
    requiredNamespaceIds: Object.freeze([NAMESPACE_ID]),
    reservationDigest: new Uint8Array(32).fill(0x61),
    mutationCommitment: commitMemoryMutationV1({ kind: "save", payload }),
    importance: 0.5,
    createdAt: Date.parse("2027-01-15T08:00:00.000Z"),
  });
}

function setup() {
  const operations: string[] = [];
  const sources: AgentObjectProtectionSource[] = [];
  const opened: MemoryPayloadV1 = Object.freeze({
    formatVersion: 1,
    type: "preference",
    content: "Existing protected Memory",
  });
  const objects: AgentObjectProtector = Object.freeze({
    async protect<Value>(request: Readonly<{
      operationId: string;
      source: AgentObjectProtectionSource;
      decode(plaintextBytes: Uint8Array): Value;
    }>): Promise<AgentObjectProtectionResult<Value>> {
      operations.push(request.operationId);
      sources.push(request.source);
      const bytes = request.source.plaintextBytes?.slice()
        ?? encodeMemoryPayloadV1(opened);
      try {
        return Object.freeze({
          status: "verified" as const,
          objectId: request.source.objectId,
          provenance: request.source.plaintextBytes === null
            ? "existing" as const
            : "repaired" as const,
          verification: "authenticated" as const,
          value: request.decode(bytes),
        });
      } finally {
        bytes.fill(0);
      }
    },
  });
  const factory = createDomainMemoryCryptoSession({
    subjectUserId: SUBJECT_ID,
    agentId: AGENT_ID,
    entrypointId: "foreground.main",
    entities: {
      signal: new AbortController().signal,
      useCurrentSet: async request => ({
        status: "executed" as const,
        value: await request.execute([{
          namespaceKey: new Uint8Array(32).fill(0x62),
          authority: namespaceAuthority,
        }]),
      }),
    },
    objects,
    prepareOperationId: "accepted-domain-publication",
  });
  return { factory, operations, sources };
}

describe("Domain Memory crypto session", () => {
  test("owns canonical open and prepare identities plus factory completion", async () => {
    const state = setup();
    const cryptoObjectId = plan({
      formatVersion: 1,
      type: "preference",
      content: "New protected Memory",
    }).cryptoObjectId;
    expect(await state.factory.session.openMany({
      entrypointId: "foreground.main",
      agentId: AGENT_ID,
      authority,
      candidates: [{
        memoryId: MEMORY_ID,
        contentRevision: 1,
        cryptoAccessRevision: 0,
        cryptoObjectId,
        readNamespaceId: NAMESPACE_ID,
        requiredNamespaceIds: [NAMESPACE_ID],
        importance: 0.5,
        tier: 1,
        score: 0.9,
        createdAt: new Date("2027-01-15T08:00:00.000Z"),
      }],
    })).toEqual({ status: "success", value: [{
      memoryId: MEMORY_ID,
      contentRevision: 1,
      type: "preference",
      content: "Existing protected Memory",
    }] });

    const payload = Object.freeze({
      formatVersion: 1 as const,
      type: "preference" as const,
      content: "New protected Memory",
    });
    const prepared = await state.factory.session.prepare({
      entrypointId: "foreground.main",
      agentId: AGENT_ID,
      authority,
      plan: plan(payload),
      content: { kind: "complete", payload },
    });
    expect(prepared.status).toBe("success");
    if (prepared.status !== "success") throw new Error(prepared.reason);
    expect(state.operations).toEqual([
      `memory-open:${cryptoObjectId}`,
      "accepted-domain-publication",
    ]);
    expect(state.sources.map(source => ({
      existingObjectId: source.existingObjectId,
      namespaceIds: source.namespaceIds,
    }))).toEqual([
      { existingObjectId: cryptoObjectId, namespaceIds: [NAMESPACE_ID] },
      { existingObjectId: null, namespaceIds: [NAMESPACE_ID] },
    ]);
    expect(state.sources[1]!.plaintextBytes?.every(byte => byte === 0)).toBe(
      true,
    );
    expect(state.factory.readPreparedPayload(prepared.value)).toEqual(payload);
    expect(await state.factory.completion.complete(prepared.value)).toBe(
      "duplicate",
    );
    expect(state.factory.completion.complete({ ...prepared.value })).rejects
      .toThrow("Foreground Memory revision belongs to another crypto session");
  });

  test("remains Namespace-only and rejects Scope before object or key use", async () => {
    const state = setup();
    expect(await state.factory.session.openMany({
      entrypointId: "foreground.main",
      agentId: AGENT_ID,
      authority: {
        mode: "scope",
        subjectUserId: SUBJECT_ID,
        agentId: AGENT_ID,
        scopeId: "scope-1",
        originWritableNamespaceId: NAMESPACE_ID,
      },
      candidates: [],
    })).toEqual({ status: "unavailable", reason: "authorization_required" });
    expect(state.operations).toEqual([]);
  });
});
