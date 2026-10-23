import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import { protectedTaskSemanticAuthorityRequirementsDigest } from "@nautilo/db";
import type {
  ForegroundAgentEntityCryptoInvocation,
  ForegroundAgentEntityNamespaceAuthority,
  ProtectedMemoryAuthority,
} from "@nautilo/lattice-bridge";
import type { NamespaceMemoryEnvelope } from "@nautilo/trust";

const realAgent = await import("@nautilo/agent");
const realBridgeServer = await import("@nautilo/lattice-bridge/server");
const realRuntime = await import("@nautilo/runtime");
const realTrust = await import("@nautilo/trust");
const realProductStore = await import(
  "../../src/routes/foreground-message-product-store.ts"
);
const realPublication = await import(
  "../../src/routes/foreground-memory-publication-authority.ts"
);
const realEffects = await import(
  "../../src/routes/foreground-memory-effect-receipts.ts"
);

const CHECKPOINT_NS = "10000000-0000-4000-8000-000000000001";
const SOURCE_NS = "10000000-0000-4000-8000-000000000002";
const DESTINATION_NS = "10000000-0000-4000-8000-000000000003";
const SOURCE_MEMORY_ID = "20000000-0000-4000-8000-000000000001";
const DESTINATION_ROOM_ID = "30000000-0000-4000-8000-000000000001";
const PROJECTED_MEMORY_ID = "40000000-0000-4000-8000-000000000001";

const envelope: NamespaceMemoryEnvelope = Object.freeze({
  memoryMode: "namespace" as const,
  ownerId: "user-1",
  actorId: "actor-1",
  agentId: "agent-1",
  roomId: "room-1",
  readableNamespaces: Object.freeze([CHECKPOINT_NS, SOURCE_NS]) as string[],
  mutableNamespaces: Object.freeze([CHECKPOINT_NS, SOURCE_NS]) as string[],
  writableNamespaces: Object.freeze([CHECKPOINT_NS]) as string[],
  toolPolicy: Object.freeze({}),
});

const destination = Object.freeze({
  roomId: DESTINATION_ROOM_ID,
  namespaceId: DESTINATION_NS,
  label: "Exact destination",
  kind: "private" as const,
  memberCount: 2,
  audienceFingerprint: "audience-v1",
});

let now = 1_800_000_000_000;
let sourceRevision = 7;
let destinationStale: string | null = null;
let targetPublishCalls = 0;
let embeddingCalls = 0;
let encryptionCalls = 0;
let effectCalls = 0;
let effectCompleted = 0;
let wakeRecoveryCalls = 0;
let expireDuringEffect = false;
let expireDuringEmbedding = false;
let capturedPlanInput: Record<string, unknown> | null = null;
let capturedPreparedContent: unknown = null;
let capturedPublicationBeforeLocks:
  | ((input: { transaction: unknown; authority: ProtectedMemoryAuthority; mutation: boolean }) => Promise<void>)
  | null = null;
let capturedEffectBeforeLocks:
  | ((input: { transaction: unknown; authority: ProtectedMemoryAuthority; mutation: boolean }) => Promise<void>)
  | null = null;
const committedOperations = new Set<string>();
const reservedOperations = new Map<string, Record<string, unknown>>();
const currentProjectionCalls: Readonly<{
  destination: unknown;
  authority: ProtectedMemoryAuthority;
  mutation: boolean;
}>[] = [];
let projectionAuthorized = true;

function sourceCandidate() {
  return Object.freeze({
    memoryId: SOURCE_MEMORY_ID,
    contentRevision: sourceRevision,
    cryptoAccessRevision: 3,
    cryptoObjectId: "memory-object-1",
    requiredNamespaceIds: Object.freeze([SOURCE_NS]),
  });
}

function fakeTransaction() {
  let selection = 0;
  return {
    select() {
      selection += 1;
      const rows = selection === 1
        ? [{
            id: SOURCE_MEMORY_ID,
            contentRevision: sourceRevision,
            cryptoAccessRevision: 3,
            cryptoObjectId: "memory-object-1",
          }]
        : [{ memoryId: SOURCE_MEMORY_ID, namespaceId: SOURCE_NS }];
      const chain = {
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        for: async () => rows,
      };
      return chain;
    },
  };
}

class FakeAgentMemoryProductPort {
  readonly options: Record<string, unknown>;

  constructor(options: Record<string, unknown>) {
    this.options = options;
    const readable = options["readableNamespaceIds"];
    if (Array.isArray(readable) && readable.length === 1 && readable[0] === DESTINATION_NS) {
      const publication = options["publication"] as {
        beforeLocks: typeof capturedPublicationBeforeLocks;
      };
      capturedPublicationBeforeLocks = publication.beforeLocks;
    }
  }

  async #current<Value>(authority: ProtectedMemoryAuthority, mutation: boolean,
    use: () => Promise<Value>): Promise<Value> {
    const publication = this.options["publication"] as {
      withCurrentPublication?: (input: Readonly<{
        authority: ProtectedMemoryAuthority;
        mutation: boolean;
        use(assertCurrent: () => Promise<void>): Promise<unknown>;
      }>) => Promise<unknown>;
    };
    if (publication.withCurrentPublication === undefined) return use();
    let value: Value | undefined;
    await publication.withCurrentPublication({ authority, mutation,
      use: async assertCurrent => {
        await assertCurrent();
        value = await use();
        return Object.freeze({ value });
      } });
    if (value === undefined) throw new Error("fixture publication did not run");
    return value;
  }

  async loadExactProjectionSources(input: { authority: ProtectedMemoryAuthority;
    memoryIds: readonly string[] }) {
    return this.#current(input.authority, false, async () =>
      input.memoryIds.length === 1 && input.memoryIds[0] === SOURCE_MEMORY_ID
        ? { status: "success" as const, value: [sourceCandidate()] }
        : { status: "unavailable" as const,
            reason: "authorization_required" as const });
  }

  async replayCompleted(input: Record<string, unknown>) {
    const authority = input["authority"] as ProtectedMemoryAuthority;
    return this.#current(authority, false, async () => {
      await capturedPublicationBeforeLocks?.({ transaction: fakeTransaction(),
        authority, mutation: false });
      const operationId = input["operationId"] as string;
      if (!committedOperations.has(operationId)) return {
        status: "success" as const, value: null,
      };
      const reserved = reservedOperations.get(operationId)!;
      if (JSON.stringify(reserved["mutationCommitment"]) !== JSON.stringify(input["mutationCommitment"])
        || JSON.stringify(reserved["authority"]) !== JSON.stringify(authority)) return {
        status: "unavailable" as const, reason: "authorization_required" as const,
      };
      return { status: "success" as const,
        value: { mutationKind: "save" as const, memoryId: PROJECTED_MEMORY_ID,
          action: "created" as const } };
    });
  }

  async inspectFreshProjectionReservation() { return Object.freeze({}); }

  async planProjectionCreate(input: Record<string, unknown>) {
    return this.#current(input["authority"] as ProtectedMemoryAuthority,
      true, async () => {
        capturedPlanInput = input;
        reservedOperations.set(input["operationId"] as string, input);
        return {
          status: "success" as const,
          value: Object.freeze({
            operationId: input["operationId"],
            memoryId: PROJECTED_MEMORY_ID,
          }),
        };
      });
  }

  async publishPrepared(input: Record<string, unknown>) {
    const authority = input["authority"] as ProtectedMemoryAuthority;
    return this.#current(authority, true, async () => {
      targetPublishCalls += 1;
      await capturedPublicationBeforeLocks?.({
        transaction: fakeTransaction(),
        authority,
        mutation: true,
      });
      const operationId = (input["plan"] as { operationId: string }).operationId;
      const replayed = committedOperations.has(operationId);
      committedOperations.add(operationId);
      return {
        status: "success" as const,
        value: replayed ? "replayed" as const : "inserted" as const,
      };
    });
  }
}

mock.module("@nautilo/agent", () => ({
  ...realAgent,
  embedTextWithProvenance: async (content: string) => {
    embeddingCalls += 1;
    if (expireDuringEmbedding) now += 10 * 60 * 1_000 + 1;
    return {
      vector: new Array(1536).fill(0.01),
      provider: "openai" as const,
      canonicalModel: "fixture-embedding",
      dimensions: 1536 as const,
      contractVersion: 1,
      content,
    };
  },
  lockAtomicProjectionDestinationAuthority: async (
    _transaction: unknown,
    input: { roomId: string; namespaceId: string },
  ) => input.roomId === destination.roomId
    && input.namespaceId === destination.namespaceId
    ? destinationStale
    : "destination_changed",
}));

mock.module("@nautilo/lattice-bridge/server", () => ({
  ...realBridgeServer,
  PostgresAgentMemoryProductPort: FakeAgentMemoryProductPort,
  bindConversationProductCanonicalTransactionRunner: (
    _handle: unknown,
    connection: { transaction: unknown },
  ) => ({ role: "nautilo_agent", transaction: connection.transaction }),
}));

mock.module("@nautilo/trust", () => ({
  ...realTrust,
  findAuthorizedRoomNameCandidates: async () => [],
  userHasCapability: async () => true,
  resolveAuthorizedRoomName: async () => ({
    status: "resolved" as const,
    destination,
  }),
}));

mock.module("../../src/routes/foreground-message-product-store.ts", () => ({
  ...realProductStore,
  createForegroundProductTransactionContext: async () => ({
    handle: Object.freeze({}),
    canonicalRunner: Object.freeze({
      role: "nautilo_agent" as const,
      transaction: async <Value>(
        execute: (transaction: unknown) => Promise<Value> | Value,
      ) => execute(fakeTransaction()),
    }),
  }),
}));

mock.module("../../src/routes/foreground-memory-publication-authority.ts", () => ({
  ...realPublication,
  createForegroundMemoryPublicationAuthority: () => ({
    representation: "protected_only" as const,
    allowOrdinaryFallback: false,
    beforeLocks: async () => {},
  }),
}));

mock.module("../../src/routes/foreground-memory-effect-receipts.ts", () => ({
  ...realEffects,
  deliverCommittedForegroundMemoryEffect: async (input: {
    beforeLocks: typeof capturedEffectBeforeLocks;
    authority: ProtectedMemoryAuthority;
  }) => {
    effectCalls += 1;
    capturedEffectBeforeLocks = input.beforeLocks;
    if (expireDuringEffect) now += 10 * 60 * 1_000 + 1;
    await input.beforeLocks?.({
      transaction: fakeTransaction(),
      authority: input.authority,
      mutation: false,
    });
    effectCompleted += 1;
    return "acknowledged" as const;
  },
}));

mock.module("@nautilo/runtime", () => ({
  ...realRuntime,
  createForegroundDomainMemoryCryptoSession: (input: {
    session: Record<string, unknown>;
  }) => ({
    session: input.session,
    completion: Object.freeze({}),
    readPreparedPayload: () => null,
  }),
}));

const { createForegroundMemoryProjectionPort,
  createForegroundProtectedTaskMemoryProjection } = await import(
  "../../src/routes/foreground-memory-repository.ts"
);
const { protectedTaskProjectionDestinationAuthorityDigest } = await import(
  "../../src/routes/protected-task-memory-projection-plan.ts"
);

function namespaceAuthority(
  namespaceId: string,
): ForegroundAgentEntityNamespaceAuthority {
  return Object.freeze({
    namespaceId,
    namespaceAccessRevision: 5,
    // Newly initialized Namespaces start at generation zero in production.
    namespaceKeyGeneration: 0,
    domainId: "domain-1",
    domainKeyGeneration: 1,
    domainAuthorizationRevision: 9,
    domainHeadDigest: new Uint8Array(32).fill(1),
    namespaceHeadDigest: new Uint8Array(32).fill(2),
    namespacePublicationDigest: new Uint8Array(32).fill(3),
    namespacePublicationSetDigest: new Uint8Array(32).fill(4),
    namespaceAudienceFingerprint: new Uint8Array(32).fill(5),
  });
}

const keys = new Map([
  [CHECKPOINT_NS, new Uint8Array(32).fill(0x31)],
  [SOURCE_NS, new Uint8Array(32).fill(0x32)],
]);

function entities(): Pick<
  ForegroundAgentEntityCryptoInvocation,
  "signal" | "use" | "useCurrentSet"
> {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    async use(input) {
      const key = keys.get(input.entity.namespaceId);
      if (key === undefined) return {
        status: "unavailable" as const,
        reason: "content_unavailable" as const,
      };
      const authority = namespaceAuthority(input.entity.namespaceId);
      if (
        input.entity.keyGeneration !== authority.namespaceKeyGeneration
        || input.entity.accessRevision !== authority.namespaceAccessRevision
      ) return {
        status: "unavailable" as const,
        reason: "content_unavailable" as const,
      };
      return {
        status: "executed" as const,
        value: await input.execute({ namespaceKey: key.slice(), authority }),
      };
    },
    async useCurrentSet(input) {
      const items = input.namespaceIds.map((namespaceId) => {
        const key = keys.get(namespaceId);
        if (key === undefined) throw new Error("fixture key unavailable");
        return {
          namespaceKey: key.slice(),
          authority: namespaceAuthority(namespaceId),
        };
      });
      return {
        status: "executed" as const,
        value: await input.execute(items),
      };
    },
  };
}

function domain() {
  const crypto = new LatticeCrypto({
    bytes: (length) => new Uint8Array(length).fill(0x41),
  });
  const entityPort = entities();
  return {
    subjectUserId: envelope.ownerId,
    agentId: envelope.agentId,
    entrypointId: "foreground.main" as const,
    crypto,
    entities: entityPort,
    publication: {
      agentAuthorizationRevision: 12,
      runtime: Object.freeze({}),
      signerKeyId: "signer-1",
    },
    session: {
      async openMany(input: { candidates: readonly ReturnType<typeof sourceCandidate>[] }) {
        return {
          status: "success" as const,
          value: input.candidates.map((candidate) => ({
            memoryId: candidate.memoryId,
            contentRevision: candidate.contentRevision,
            type: "fact",
            content: "private source content",
          })),
        };
      },
      async prepare(input: { content: unknown }) {
        encryptionCalls += 1;
        capturedPreparedContent = input.content;
        return { status: "success" as const, value: Object.freeze({}) };
      },
      async authorizeCommit(input: { commit: () => Promise<unknown> }) {
        return input.commit();
      },
    },
  };
}

async function port(held = false) {
  type Input = Parameters<typeof createForegroundMemoryProjectionPort>[0];
  const withCurrentPublication: NonNullable<Input["withCurrentPublication"]> =
    request => request.use(() => Promise.resolve());
  const withCurrentProjection: NonNullable<Input["withCurrentProjection"]> = async request => {
    currentProjectionCalls.push({ destination: request.destination,
      authority: request.targetAuthority, mutation: request.mutation });
    return projectionAuthorized ? request.use(() => Promise.resolve()) : null;
  };
  return createForegroundMemoryProjectionPort({
    publication: { forReservation: () => ({ recover: async () => null, persist: async () => "created" as const }) },
    envelope,
    policy: {
      mode: "encrypted_only",
      shadowBehavior: "strict",
      revision: 4,
    },
    domain: domain() as never,
    wakeEffectRecovery() { wakeRecoveryCalls += 1; },
    ...(held ? {
      withCurrentPublication,
      withCurrentProjection,
    } : {}),
  });
}

const sourceRequirements = Object.freeze([
  Object.freeze({ namespaceId: SOURCE_NS, operations: ["decrypt"] as const }),
]);
const fullProjectionRequirements = Object.freeze([
  ...sourceRequirements,
  Object.freeze({ namespaceId: DESTINATION_NS, operations: ["encrypt"] as const }),
]);

async function protectedHandoff(continuedAdditionalAuthority?: Readonly<{
  authorizationRequestId: string;
  effectDisposition: "not_started_v1";
  operationId: string;
  requestDigest: Uint8Array;
  requiredAuthorityDigest: Uint8Array;
}>) {
  type Input = Parameters<typeof createForegroundProtectedTaskMemoryProjection>[0];
  const withCurrentPublication: NonNullable<Input["withCurrentPublication"]> =
    request => request.use(() => Promise.resolve());
  const withCurrentProjection: Input["withCurrentProjection"] = request =>
    projectionAuthorized ? request.use(() => Promise.resolve()) : Promise.resolve(null);
  return createForegroundProtectedTaskMemoryProjection({
    publication: { forReservation: () => ({ recover: async () => null, persist: async () => "created" as const }) },
    envelope,
    policy: { mode: "encrypted_only", shadowBehavior: "strict", revision: 4 },
    domain: domain() as never,
    wakeEffectRecovery() { wakeRecoveryCalls += 1; },
    withCurrentPublication,
    withCurrentProjection,
    withCurrentSource: use => use(() => Promise.resolve()),
    planDestination: request => Promise.resolve(projectionAuthorized ? {
      destinationAuthorityDigest:
        protectedTaskProjectionDestinationAuthorityDigest(request.destination),
    } : null),
    task: { taskId: "task-1", taskRunId: "run-1", graphThreadId: "thread-1" },
    originalCapsuleBinding: { policyRevision: 4, agentAuthorizationRevision: 12 },
    currentSemanticAuthorityRequirements: continuedAdditionalAuthority === undefined
      ? sourceRequirements : fullProjectionRequirements,
    ...(continuedAdditionalAuthority === undefined ? {} : {
      continuedAdditionalAuthority,
    }),
  });
}

const authority: ProtectedMemoryAuthority = Object.freeze({
  mode: "namespace" as const,
  subjectUserId: envelope.ownerId,
  agentId: envelope.agentId,
  readableNamespaceIds: Object.freeze([...envelope.readableNamespaces]),
  mutableNamespaceIds: Object.freeze([...envelope.mutableNamespaces]),
  writableNamespaceId: CHECKPOINT_NS,
});

const prepareInput = Object.freeze({
  operationId: "memory:v1:projection-operation",
  toolCallId: "tool-call-1",
  authority,
  requesterActorId: envelope.actorId,
  sourceMemoryIds: Object.freeze([SOURCE_MEMORY_ID]),
  proposedContent: "Exact approved projection content",
  targetRoomName: destination.label,
});

beforeEach(() => {
  now = 1_800_000_000_000;
  sourceRevision = 7;
  destinationStale = null;
  targetPublishCalls = 0;
  embeddingCalls = 0;
  encryptionCalls = 0;
  effectCalls = 0;
  effectCompleted = 0;
  wakeRecoveryCalls = 0;
  expireDuringEffect = false;
  expireDuringEmbedding = false;
  capturedPlanInput = null;
  capturedPreparedContent = null;
  capturedPublicationBeforeLocks = null;
  capturedEffectBeforeLocks = null;
  committedOperations.clear();
  reservedOperations.clear();
  currentProjectionCalls.length = 0;
  projectionAuthorized = true;
  spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(() => {
  mock.restore();
});

async function copiedReference() {
  const first = await port();
  const prepared = await first.prepare(prepareInput);
  if (prepared.status !== "success" || prepared.value.kind !== "prepared") {
    throw new Error("fixture projection was not prepared");
  }
  return JSON.parse(JSON.stringify(prepared.value.reference)) as
    typeof prepared.value.reference;
}

describe("foreground Memory projection production resume", () => {
  test("uses the held destination owner for a current-grant target without Room locks in Agent callbacks", async () => {
    destinationStale = "destination_membership_changed";
    const current = await port(true);
    const prepared = await current.prepare(prepareInput);
    expect(prepared.status).toBe("success");
    if (prepared.status !== "success" || prepared.value.kind !== "prepared") {
      throw new Error("fixture projection was not prepared");
    }
    expect(await current.publish({ authority,
      reference: prepared.value.reference })).toMatchObject({
        status: "success",
        value: { status: "created", memoryId: PROJECTED_MEMORY_ID },
      });
    expect(currentProjectionCalls.map(value => value.mutation)).toEqual([
      false, false, false, false, true, true, true, false,
    ]);
    expect(currentProjectionCalls.map(value => value.destination)).toEqual(
      new Array(currentProjectionCalls.length).fill(destination),
    );
    expect(currentProjectionCalls.every(value =>
      value.authority.mode === "namespace"
      && value.authority.readableNamespaceIds.length === 1
      && value.authority.readableNamespaceIds[0] === DESTINATION_NS
      && value.authority.mutableNamespaceIds.length === 1
      && value.authority.mutableNamespaceIds[0] === DESTINATION_NS
      && value.authority.writableNamespaceId === DESTINATION_NS)).toBeTrue();
    expect(capturedPublicationBeforeLocks).toBeUndefined();
    expect(effectCompleted).toBe(1);
  });

  test("rejects an out-of-grant destination before target planning or mutation", async () => {
    projectionAuthorized = false;
    const current = await port(true);
    expect(await current.prepare(prepareInput)).toEqual({
      status: "unavailable",
      reason: "authorization_required",
    });
    expect(capturedPlanInput).toBeNull();
    expect(targetPublishCalls).toBe(0);
    expect(effectCalls).toBe(0);
    expect(currentProjectionCalls).toHaveLength(1);
  });

  test("restores and idempotently publishes the exact checkpointed plan under fresh custody", async () => {
    const reference = await copiedReference();
    const serialized = JSON.stringify(reference);
    expect(serialized).not.toContain(prepareInput.proposedContent);
    expect(serialized).not.toContain(SOURCE_MEMORY_ID);
    expect(serialized).not.toContain(DESTINATION_ROOM_ID);
    expect(serialized).not.toContain(DESTINATION_NS);

    const resumed = await port();
    expect(await resumed.restore?.({ authority, reference })).toEqual({
      status: "success",
      value: {
        proposedContent: prepareInput.proposedContent,
        roomLabel: destination.label,
        roomKind: destination.kind,
        memberCount: destination.memberCount,
      },
    });
    expect(await resumed.publish({ authority, reference })).toEqual({
      status: "success",
      value: {
        status: "created",
        memoryId: PROJECTED_MEMORY_ID,
        roomLabel: destination.label,
      },
    });
    expect(capturedPlanInput?.["operationId"]).toBe(prepareInput.operationId);
    expect(capturedPreparedContent).toEqual({
      kind: "complete",
      payload: {
        formatVersion: 1,
        type: "fact",
        content: prepareInput.proposedContent,
      },
    });
    expect(targetPublishCalls).toBe(1);

    expect(await resumed.publish({ authority, reference })).toMatchObject({
      status: "success",
      value: { status: "replayed", memoryId: PROJECTED_MEMORY_ID },
    });
    expect(targetPublishCalls).toBe(1);
    expect(embeddingCalls).toBe(1);
    expect(encryptionCalls).toBe(1);
  });

  test("replays a committed operation in fresh custody without provider or encryption, and rejects drift", async () => {
    const reference = await copiedReference();
    const first = await port();
    expect(await first.publish({ authority, reference })).toMatchObject({
      status: "success", value: { status: "created" },
    });
    const restarted = await port();
    expect(await restarted.publish({ authority, reference })).toMatchObject({
      status: "success", value: { status: "replayed" },
    });
    expect(embeddingCalls).toBe(1);
    expect(encryptionCalls).toBe(1);
    expect(targetPublishCalls).toBe(1);

    sourceRevision += 1;
    expect(await restarted.publish({ authority, reference })).toMatchObject({ status: "unavailable" });
    sourceRevision -= 1;
    destinationStale = "destination_membership_changed";
    expect(await restarted.publish({ authority, reference })).toMatchObject({ status: "unavailable" });
    destinationStale = null;
    const changed = await restarted.prepare({ ...prepareInput, proposedContent: "Different proposal" });
    if (changed.status !== "success" || changed.value.kind !== "prepared") throw new Error("fixture preparation failed");
    expect(await restarted.publish({ authority, reference: changed.value.reference })).toMatchObject({
      status: "unavailable", reason: "authorization_required",
    });
    expect(embeddingCalls).toBe(1);
    expect(encryptionCalls).toBe(1);
    expect(targetPublishCalls).toBe(1);
  });

  test("continues an exact protected additional-authority projection after its UI expiry", async () => {
    const initial = await protectedHandoff();
    const prepared = await initial.prepare(prepareInput);
    expect(prepared.status).toBe("success");
    if (prepared.status !== "success" || prepared.value.kind !== "prepared") {
      throw new Error("fixture protected projection was not prepared");
    }
    const reference = prepared.value.reference;
    const planned = await initial.planPublication({ authority, reference });
    expect(planned.status).toBe("success");
    if (planned.status !== "success" || planned.value.kind !== "additional_authority_v1") {
      throw new Error("fixture projection did not require additional authority");
    }
    const plan = planned.value;
    const requiredAuthorityDigest =
      protectedTaskSemanticAuthorityRequirementsDigest(
        plan.semanticAuthorityRequirements,
      );
    const continuation = Object.freeze({
      authorizationRequestId: plan.authorizationRequestId,
      effectDisposition: "not_started_v1" as const,
      operationId: plan.operationId,
      requestDigest: Uint8Array.from(plan.requestDigest),
      requiredAuthorityDigest: Uint8Array.from(requiredAuthorityDigest),
    });
    requiredAuthorityDigest.fill(0);

    now = reference.expiresAt + 1;
    expect(await initial.restore({ authority, reference })).toEqual({
      status: "unavailable",
      reason: "authorization_required",
    });

    const resumed = await protectedHandoff(continuation);
    expect(await resumed.restore({ authority, reference })).toMatchObject({
      status: "success",
      value: { proposedContent: prepareInput.proposedContent },
    });
    expect(await resumed.planPublication({ authority, reference })).toEqual({
      status: "success",
      value: plan,
    });
    const authorization = Object.freeze({
      kind: "additional_authority_v1" as const,
      plan,
      acknowledgement: Object.freeze({
        type: "protected_task_additional_authority_granted_v1" as const,
        ...continuation,
      }),
    });
    expect(await resumed.publishAuthorized({ authority, reference,
      authorization })).toMatchObject({
        status: "success",
        value: { status: "created", memoryId: PROJECTED_MEMORY_ID },
      });
    expect(await resumed.publishAuthorized({ authority, reference,
      authorization })).toMatchObject({
        status: "success",
        value: { status: "replayed", memoryId: PROJECTED_MEMORY_ID },
      });
    expect(targetPublishCalls).toBe(1);
    expect(embeddingCalls).toBe(1);
    expect(encryptionCalls).toBe(1);
  });

  test("does not bypass expiry for substituted protected continuation coordinates", async () => {
    const initial = await protectedHandoff();
    const prepared = await initial.prepare(prepareInput);
    if (prepared.status !== "success" || prepared.value.kind !== "prepared") {
      throw new Error("fixture protected projection was not prepared");
    }
    const reference = prepared.value.reference;
    const planned = await initial.planPublication({ authority, reference });
    if (planned.status !== "success" || planned.value.kind !== "additional_authority_v1") {
      throw new Error("fixture projection did not require additional authority");
    }
    const plan = planned.value;
    const requiredAuthorityDigest =
      protectedTaskSemanticAuthorityRequirementsDigest(
        plan.semanticAuthorityRequirements,
      );
    const exact = Object.freeze({
      authorizationRequestId: plan.authorizationRequestId,
      effectDisposition: "not_started_v1" as const,
      operationId: plan.operationId,
      requestDigest: Uint8Array.from(plan.requestDigest),
      requiredAuthorityDigest: Uint8Array.from(requiredAuthorityDigest),
    });
    requiredAuthorityDigest.fill(0);
    now = reference.expiresAt + 1;

    const substitutions = [
      { ...exact, authorizationRequestId: `${exact.authorizationRequestId}:other` },
      { ...exact, operationId: `${exact.operationId}:other` },
      { ...exact, requestDigest: new Uint8Array(32).fill(0xaa) },
      { ...exact, requiredAuthorityDigest: new Uint8Array(32).fill(0xbb) },
    ];
    for (const substituted of substitutions) {
      const resumed = await protectedHandoff(Object.freeze(substituted));
      expect(await resumed.restore({ authority, reference })).toEqual({
        status: "unavailable",
        reason: "authorization_required",
      });
    }
    const exactResume = await protectedHandoff(exact);
    expect(await exactResume.restore({ authority, reference: Object.freeze({
      ...reference,
      toolCallId: `${reference.toolCallId}:substituted`,
    }) })).toEqual({
      status: "unavailable",
      reason: "authorization_required",
    });
    expect(targetPublishCalls).toBe(0);
  });

  test("revalidates protected source and destination after continued expiry", async () => {
    const initial = await protectedHandoff();
    const prepared = await initial.prepare(prepareInput);
    if (prepared.status !== "success" || prepared.value.kind !== "prepared") {
      throw new Error("fixture protected projection was not prepared");
    }
    const reference = prepared.value.reference;
    const planned = await initial.planPublication({ authority, reference });
    if (planned.status !== "success" || planned.value.kind !== "additional_authority_v1") {
      throw new Error("fixture projection did not require additional authority");
    }
    const requiredAuthorityDigest =
      protectedTaskSemanticAuthorityRequirementsDigest(
        planned.value.semanticAuthorityRequirements,
      );
    const resumed = await protectedHandoff(Object.freeze({
      authorizationRequestId: planned.value.authorizationRequestId,
      effectDisposition: "not_started_v1" as const,
      operationId: planned.value.operationId,
      requestDigest: Uint8Array.from(planned.value.requestDigest),
      requiredAuthorityDigest: Uint8Array.from(requiredAuthorityDigest),
    }));
    requiredAuthorityDigest.fill(0);
    now = reference.expiresAt + 1;

    sourceRevision += 1;
    expect(await resumed.restore({ authority, reference })).toEqual({
      status: "unavailable",
      reason: "authorization_required",
    });
    sourceRevision -= 1;
    projectionAuthorized = false;
    expect(await resumed.planPublication({ authority, reference })).toEqual({
      status: "unavailable",
      reason: "authorization_required",
    });
    expect(targetPublishCalls).toBe(0);
  });

  test("rejects changed source revision and destination before publication", async () => {
    const reference = await copiedReference();
    const resumed = await port();

    sourceRevision += 1;
    expect(await resumed.restore?.({ authority, reference })).toEqual({
      status: "unavailable",
      reason: "stale_revision",
    });
    expect(targetPublishCalls).toBe(0);

    sourceRevision -= 1;
    destinationStale = "destination_membership_changed";
    expect(await resumed.publish({ authority, reference })).toEqual({
      status: "unavailable",
      reason: "stale_revision",
    });
    expect(targetPublishCalls).toBe(0);
  });

  test("expires primary publication but not the effect of an already committed projection", async () => {
    const reference = await copiedReference();
    const resumed = await port();
    expireDuringEffect = true;

    expect(await resumed.publish({ authority, reference })).toMatchObject({
      status: "success",
      value: { status: "created" },
    });
    expect(targetPublishCalls).toBe(1);
    expect(effectCalls).toBe(1);
    expect(effectCompleted).toBe(1);
    expect(wakeRecoveryCalls).toBe(0);
    expect(capturedPublicationBeforeLocks).not.toBeNull();
    expect(capturedEffectBeforeLocks).not.toBeNull();
    expect(now).toBeGreaterThan(reference.expiresAt);
    expect(capturedPublicationBeforeLocks!({
      transaction: fakeTransaction(),
      authority,
      mutation: true,
    })).rejects.toThrow("Projection approval expired");
  });

  test("does not commit when approval expires while embedding is prepared", async () => {
    const reference = await copiedReference();
    const resumed = await port();
    expireDuringEmbedding = true;

    expect(resumed.publish({ authority, reference }))
      .rejects.toThrow("Projection approval expired");
    expect(targetPublishCalls).toBe(1);
    expect(committedOperations).toHaveLength(0);
    expect(effectCalls).toBe(0);
    expect(effectCompleted).toBe(0);
    expect(wakeRecoveryCalls).toBe(0);
  });
});
