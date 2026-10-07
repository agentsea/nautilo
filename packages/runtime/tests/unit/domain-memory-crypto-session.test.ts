import { describe, expect, test } from "bun:test";
import {
  commitMemoryMutationV1,
  deriveMemoryCryptoObjectIdV1,
  encodeMemoryPayloadV1,
  type AgentEntityNamespaceAuthority,
  type AgentObjectProtectionResult,
  type AgentObjectProtectionSource,
  type MemoryPayloadV1,
} from "@nautilo/lattice-bridge";

import {
  createDomainMemoryCryptoSession,
  type DomainMemoryObjectProtectionRequest,
  type DomainMemoryObjectProtector,
} from
  "../../src/memory/domain-memory-crypto-session";

const SUBJECT_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_ID = "10000000-0000-4000-8000-000000000002";
const MEMORY_ID = "10000000-0000-4000-8000-000000000003";
const NAMESPACE_ID = "10000000-0000-4000-8000-000000000004";
const HISTORIC_NAMESPACE_ID = "10000000-0000-4000-8000-000000000005";
const SEED_NAMESPACE_ID = "10000000-0000-4000-8000-000000000006";
const SCOPE_ID = "10000000-0000-4000-8000-000000000007";
const OUTSIDE_ID = "10000000-0000-4000-8000-000000000008";

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

function setup(scopeBinding?: Readonly<{
  scopeId: string;
  originWritableNamespaceId: string;
  readableNamespaceIds: readonly string[];
}>) {
  const operations: string[] = [];
  const keyRequests: Readonly<{
    operations: readonly string[];
    namespaceIds: readonly string[];
  }>[] = [];
  const coordinates: Readonly<{
    memoryId: string;
    contentRevision: number;
  }>[] = [];
  const sources: AgentObjectProtectionSource[] = [];
  const opened: MemoryPayloadV1 = Object.freeze({
    formatVersion: 1,
    type: "preference",
    content: "Existing protected Memory",
  });
  const objects: DomainMemoryObjectProtector = Object.freeze({
    async protect<Value>(
      request: DomainMemoryObjectProtectionRequest<Value>,
    ): Promise<AgentObjectProtectionResult<Value>> {
      operations.push(request.operationId);
      coordinates.push(Object.freeze({
        memoryId: request.memoryId,
        contentRevision: request.contentRevision,
      }));
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
        value: await (async () => {
          keyRequests.push(Object.freeze({
            operations: Object.freeze([...request.operations]),
            namespaceIds: Object.freeze([...request.namespaceIds]),
          }));
          return request.execute([{
            namespaceKey: new Uint8Array(32).fill(0x62),
            authority: namespaceAuthority,
          }]);
        })(),
      }),
    },
    objects,
    prepareOperationId: "accepted-domain-publication",
    ...(scopeBinding === undefined ? {} : { scopeBinding }),
  });
  return { factory, operations, coordinates, sources, keyRequests };
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
    expect(state.coordinates).toEqual([
      { memoryId: MEMORY_ID, contentRevision: 1 },
      { memoryId: MEMORY_ID, contentRevision: 1 },
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

  test("binds Scope reads to the frozen inventory and writes to the current origin", async () => {
    const mutableReadable = [
      NAMESPACE_ID,
      HISTORIC_NAMESPACE_ID,
      SEED_NAMESPACE_ID,
    ];
    const state = setup({
      scopeId: SCOPE_ID,
      originWritableNamespaceId: NAMESPACE_ID,
      readableNamespaceIds: mutableReadable,
    });
    mutableReadable[1] = OUTSIDE_ID;
    const scopeAuthority = Object.freeze({
      mode: "scope" as const,
      subjectUserId: SUBJECT_ID,
      agentId: AGENT_ID,
      scopeId: SCOPE_ID,
      originWritableNamespaceId: NAMESPACE_ID,
    });
    const cryptoObjectId = deriveMemoryCryptoObjectIdV1({
      memoryId: MEMORY_ID,
      contentRevision: 1,
    });
    const candidate = (readNamespaceId: string) => Object.freeze({
      memoryId: MEMORY_ID,
      contentRevision: 1,
      cryptoAccessRevision: 0,
      cryptoObjectId,
      readNamespaceId,
      requiredNamespaceIds: Object.freeze([
        HISTORIC_NAMESPACE_ID,
        SEED_NAMESPACE_ID,
      ]),
      importance: 0.5,
      tier: 1,
      score: 0.9,
      createdAt: new Date("2027-01-15T08:00:00.000Z"),
    });

    for (const readNamespaceId of [
      HISTORIC_NAMESPACE_ID,
      SEED_NAMESPACE_ID,
    ]) {
      expect(await state.factory.session.openMany({
        entrypointId: "foreground.main",
        agentId: AGENT_ID,
        authority: scopeAuthority,
        candidates: [candidate(readNamespaceId)],
      })).toEqual({ status: "success", value: [{
        memoryId: MEMORY_ID,
        contentRevision: 1,
        type: "preference",
        content: "Existing protected Memory",
      }] });
    }
    expect(state.sources.map(source => source.namespaceIds)).toEqual([
      [HISTORIC_NAMESPACE_ID, SEED_NAMESPACE_ID],
      [HISTORIC_NAMESPACE_ID, SEED_NAMESPACE_ID],
    ]);

    expect(await state.factory.session.openMany({
      entrypointId: "foreground.main",
      agentId: AGENT_ID,
      authority: scopeAuthority,
      candidates: [candidate(OUTSIDE_ID)],
    })).toEqual({ status: "unavailable", reason: "incomplete_access_set" });
    expect(await state.factory.session.openMany({
      entrypointId: "foreground.main",
      agentId: AGENT_ID,
      authority: { ...scopeAuthority, scopeId: OUTSIDE_ID },
      candidates: [],
    })).toEqual({ status: "unavailable", reason: "authorization_required" });

    const payload = Object.freeze({
      formatVersion: 1 as const,
      type: "preference" as const,
      content: "Current Scope origin only",
    });
    const originPlan = plan(payload);
    expect((await state.factory.session.prepare({
      entrypointId: "foreground.main",
      agentId: AGENT_ID,
      authority: scopeAuthority,
      plan: originPlan,
      content: { kind: "complete", payload },
    })).status).toBe("success");
    expect(await state.factory.session.prepare({
      entrypointId: "foreground.main",
      agentId: AGENT_ID,
      authority: scopeAuthority,
      plan: {
        ...originPlan,
        requiredNamespaceIds: [HISTORIC_NAMESPACE_ID],
      },
      content: { kind: "complete", payload },
    })).toEqual({ status: "unavailable", reason: "incomplete_access_set" });

    let commits = 0;
    expect(await state.factory.session.authorizeCommit({
      entrypointId: "foreground.main",
      agentId: AGENT_ID,
      authority: scopeAuthority,
      target: originPlan,
      operation: "publish",
      commit: () => ++commits,
    })).toEqual({ status: "success", value: 1 });
    expect(state.keyRequests).toEqual([{
      operations: ["encrypt"],
      namespaceIds: [NAMESPACE_ID],
    }]);
    expect(await state.factory.session.authorizeCommit({
      entrypointId: "foreground.main",
      agentId: AGENT_ID,
      authority: scopeAuthority,
      target: {
        ...originPlan,
        requiredNamespaceIds: [HISTORIC_NAMESPACE_ID],
      },
      operation: "publish",
      commit: () => ++commits,
    })).toEqual({ status: "unavailable", reason: "incomplete_access_set" });
    expect(commits).toBe(1);
    expect(state.keyRequests).toHaveLength(1);
  });

  test("rejects malformed Scope bindings without weakening Namespace defaults", () => {
    const invalid: readonly Readonly<{
      scopeId: string;
      originWritableNamespaceId: string;
      readableNamespaceIds: readonly string[];
    }>[] = [
      {
        scopeId: SCOPE_ID,
        originWritableNamespaceId: NAMESPACE_ID,
        readableNamespaceIds: [HISTORIC_NAMESPACE_ID],
      },
      {
        scopeId: SCOPE_ID,
        originWritableNamespaceId: NAMESPACE_ID,
        readableNamespaceIds: [NAMESPACE_ID, NAMESPACE_ID],
      },
      {
        scopeId: SCOPE_ID,
        originWritableNamespaceId: NAMESPACE_ID,
        readableNamespaceIds: [HISTORIC_NAMESPACE_ID, NAMESPACE_ID],
      },
      {
        scopeId: "not-a-uuid",
        originWritableNamespaceId: NAMESPACE_ID,
        readableNamespaceIds: [NAMESPACE_ID],
      },
      {
        scopeId: SCOPE_ID,
        originWritableNamespaceId: NAMESPACE_ID,
        readableNamespaceIds: [NAMESPACE_ID],
        substituted: OUTSIDE_ID,
      } as unknown as Readonly<{
        scopeId: string;
        originWritableNamespaceId: string;
        readableNamespaceIds: readonly string[];
      }>,
    ];
    for (const scopeBinding of invalid) {
      expect(() => setup(scopeBinding)).toThrow("Scope Memory binding is invalid");
    }
    expect(setup().factory).toBeDefined();
  });
});
