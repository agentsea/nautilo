import { protectedTaskDefinitionSupportsPolicy } from "@nautilo/db";
import { createHash, randomUUID } from "node:crypto";

import {
  assertProtectedTaskAdditionalAuthorityResumeAcknowledgementV1,
  createResumableProtectedAgentMemoryProjectionPort,
  lockAtomicProjectionDestinationAuthority,
  type ProtectedTaskMemoryProjectionHandoff,
  type ProtectedTaskProjectionAuthorityPlan,
} from "@nautilo/agent";
import {
  canonicalProtectedTaskSemanticAuthorityRequirements,
  inArray,
  memories,
  memoryNamespaces,
  protectedTaskSemanticAuthorityRequirementsDigest,
  type ProtectedTaskSemanticAuthorityRequirements,
} from "@nautilo/db";
import {
  createAgentMemoryProjectionContinuationCapsule,
  commitMemoryMutationV1,
  MEMORY_EMBEDDING_DIMENSIONS,
  type AgentEntityCryptoInvocation,
  type AgentMemoryProjectionContinuationCapsule,
  type ProtectedAgentMemoryEmbeddingPort,
  type ProtectedAgentMemoryProjectionPort,
  type ProtectedAgentMemoryProjectionReference,
  type ProtectedMemoryAuthority,
} from "@nautilo/lattice-bridge";
import {
  PostgresAgentMemoryProductPort,
  bindConversationProductCanonicalTransactionRunner,
  type AgentMemoryPublicationBoundary,
  type ConversationProductCanonicalTransactionConnection,
  type ConversationProductCanonicalTransactionRunner,
  type ConversationProductPostgresExecutor,
  type ConversationProductPostgresHandle,
} from "@nautilo/lattice-bridge/server";
import type { CanonicalTranscriptTx } from "@nautilo/trust";
import type {
  createTaskRuntimeDomainMemoryCryptoSession,
} from "@nautilo/runtime";
import {
  findAuthorizedRoomNameCandidates,
  resolveAuthorizedRoomName,
  userHasCapability,
} from "@nautilo/trust";
import { z } from "zod";

import {
  withCurrentProtectedTaskMemoryAuthority,
  type CurrentProtectedTaskMemoryPolicy,
  type ProtectedTaskMemoryAuthorityInput,
} from "./current-protected-task-memory-authority";
import {
  createProtectedTaskProjectionAuthorityPlan,
  deserializeProtectedTaskProjectionAuthorityPlan,
  sameProtectedTaskProjectionAuthorityPlan,
  serializeProtectedTaskProjectionAuthorityPlan,
  type SerializedProtectedTaskProjectionAuthorityPlan,
} from "./protected-task-memory-projection-plan";

const REQUEST_DOMAIN = "nautilo/protected-task-memory-projection-request/v1";
const AUTHORIZATION_DOMAIN =
  "nautilo/protected-task-memory-projection-authorization/v1";
const TTL_MS = 10 * 60 * 1_000;

type ProjectionPrepareInput = Parameters<
  ProtectedAgentMemoryProjectionPort["prepare"]
>[0];
type ProductContext = Readonly<{
  handle: ConversationProductPostgresHandle;
  canonicalRunner: ConversationProductCanonicalTransactionRunner;
}>;

type TaskMemorySession = ReturnType<
  typeof createTaskRuntimeDomainMemoryCryptoSession
>;

const destinationSchema = z.object({
  roomId: z.string(),
  namespaceId: z.string(),
  label: z.string(),
  kind: z.enum([
    "private", "group", "multi_agent", "subthread", "open", "task", "access",
  ]),
  memberCount: z.number().int().nonnegative(),
  audienceFingerprint: z.string(),
}).strict();

const sourceSchema = z.object({
  memoryId: z.string(),
  contentRevision: z.number().int().nonnegative(),
  cryptoAccessRevision: z.number().int().nonnegative(),
  cryptoObjectId: z.string(),
  requiredNamespaceIds: z.array(z.string()),
  payloadDigest: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();

const requirementSchema = z.object({
  namespaceId: z.string(),
  operations: z.array(z.enum(["decrypt", "encrypt"])),
}).strict();

const planSchema = z.discriminatedUnion("kind", [
  z.object({
    planVersion: z.literal(1),
    kind: z.literal("current_v1"),
    operationId: z.string(),
    requestDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    semanticAuthorityRequirements: z.array(requirementSchema),
  }).strict(),
  z.object({
    planVersion: z.literal(1),
    kind: z.literal("additional_authority_v1"),
    operationId: z.string(),
    requestDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    semanticAuthorityRequirements: z.array(requirementSchema),
    authorizationRequestId: z.string(),
    effectDisposition: z.literal("not_started_v1"),
  }).strict(),
]);

const preparedSchema = z.object({
  operationId: z.string(),
  toolCallId: z.string(),
  requesterActorId: z.string(),
  authority: z.union([
    z.object({
      mode: z.literal("namespace"), subjectUserId: z.string(), agentId: z.string(),
      readableNamespaceIds: z.array(z.string()), mutableNamespaceIds: z.array(z.string()),
      writableNamespaceId: z.string().nullable(),
    }).strict(),
    z.object({
      mode: z.literal("scope"), subjectUserId: z.string(), agentId: z.string(),
      scopeId: z.string(), originWritableNamespaceId: z.string(),
    }).strict(),
  ]),
  sourceMemoryIds: z.array(z.string()),
  proposedContent: z.string(),
  targetRoomName: z.string(),
  roomChoiceToken: z.string().optional(),
}).strict();

const capsuleSchema = z.object({
  prepared: preparedSchema,
  state: z.object({
    destination: destinationSchema,
    sources: z.array(sourceSchema),
    proposalDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    effectDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    publicationAuthority: planSchema,
  }).strict(),
}).strict();

type ProjectionDestination = Readonly<z.infer<typeof destinationSchema>>;
type ProjectionSource = Readonly<Omit<z.infer<typeof sourceSchema>,
  "requiredNamespaceIds"> & Readonly<{
    requiredNamespaceIds: readonly string[];
  }>>;
type SealedProjectionState = Readonly<{
  destination: ProjectionDestination;
  sources: readonly ProjectionSource[];
  proposalDigest: string;
  effectDigest: string;
  publicationAuthority: z.infer<typeof planSchema>;
}>;
type PreparedProjectionState = Omit<SealedProjectionState, "publicationAuthority">;

export type ProtectedTaskMemoryProjectionInput = Readonly<{
  authority: ProtectedMemoryAuthority;
  policy: Readonly<{
    mode: "shadow_encryption" | "encrypted_only";
    shadowBehavior: "fallback" | "strict";
    revision: number;
  }>;
  current: ProtectedTaskMemoryAuthorityInput;
  agentAuthorizationRevision: number;
  entities: Pick<AgentEntityCryptoInvocation, "signal" | "use" | "useCurrentSet">;
  session: TaskMemorySession;
  sourceProduct: Pick<PostgresAgentMemoryProductPort, "loadExactProjectionSources">;
  product: ProductContext;
  embedding: ProtectedAgentMemoryEmbeddingPort;
}>;

type Dependencies = Readonly<{
  now(): number;
  createReferenceId(): string;
  createResumable: typeof createResumableProtectedAgentMemoryProjectionPort;
  withCurrentAuthority: typeof withCurrentProtectedTaskMemoryAuthority;
  resolveRoom: typeof resolveAuthorizedRoomName;
  findRoomCandidates: typeof findAuthorizedRoomNameCandidates;
  hasCapability: typeof userHasCapability;
  lockDestination: typeof lockAtomicProjectionDestinationAuthority;
  bindProductRunner: typeof bindConversationProductCanonicalTransactionRunner;
  createProduct(input: ConstructorParameters<
    typeof PostgresAgentMemoryProductPort
  >[0]): PostgresAgentMemoryProductPort;
  createCapsule(input: Readonly<{
    crypto: ProtectedTaskMemoryAuthorityInput["crypto"];
    entities: Pick<AgentEntityCryptoInvocation, "signal" | "use" | "useCurrentSet">;
    namespaceId: string;
    current: ProtectedTaskMemoryAuthorityInput;
    policyRevision: number;
    agentAuthorizationRevision: number;
  }>): AgentMemoryProjectionContinuationCapsule;
}>;

function sameAuthority(
  left: ProtectedMemoryAuthority,
  right: ProtectedMemoryAuthority,
): boolean {
  if (left.mode !== right.mode
    || left.subjectUserId !== right.subjectUserId
    || left.agentId !== right.agentId) return false;
  if (left.mode === "scope" && right.mode === "scope") {
    return left.scopeId === right.scopeId
      && left.originWritableNamespaceId === right.originWritableNamespaceId;
  }
  if (left.mode !== "namespace" || right.mode !== "namespace") return false;
  const sameIds = (a: readonly string[], b: readonly string[]) => {
    const first = [...a].sort();
    const second = [...b].sort();
    return first.length === second.length
      && first.every((entry, index) => entry === second[index]);
  };
  return left.writableNamespaceId === right.writableNamespaceId
    && sameIds(left.readableNamespaceIds, right.readableNamespaceIds)
    && sameIds(left.mutableNamespaceIds, right.mutableNamespaceIds);
}

function digest(value: unknown): Uint8Array {
  return new Uint8Array(createHash("sha256").update(JSON.stringify(value)).digest());
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function bytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "hex"));
}

function requirementsFor(
  sources: readonly ProjectionSource[],
  destinationNamespaceId: string,
): ProtectedTaskSemanticAuthorityRequirements {
  const operations = new Map<string, Set<"decrypt" | "encrypt">>();
  for (const source of sources) {
    for (const namespaceId of source.requiredNamespaceIds) {
      const entry = operations.get(namespaceId) ?? new Set();
      entry.add("decrypt");
      operations.set(namespaceId, entry);
    }
  }
  const destination = operations.get(destinationNamespaceId) ?? new Set();
  destination.add("encrypt");
  operations.set(destinationNamespaceId, destination);
  return canonicalProtectedTaskSemanticAuthorityRequirements(
    [...operations].sort(([left], [right]) => left.localeCompare(right))
      .map(([namespaceId, values]) => ({
        namespaceId,
        operations: [...values].sort(),
      })),
  );
}

function evidenceCovers(
  current: ProtectedTaskMemoryAuthorityInput,
  requirements: ProtectedTaskSemanticAuthorityRequirements,
): boolean {
  return requirements.every(requirement => {
    const matching = current.evidence.namespaceRequirements.filter(
      candidate => candidate.namespaceId === requirement.namespaceId,
    );
    return matching.length === 1 && requirement.operations.every(
      operation => matching[0]!.operations.includes(operation),
    );
  });
}

function serializePlan(plan: ProtectedTaskProjectionAuthorityPlan) {
  return serializeProtectedTaskProjectionAuthorityPlan(plan);
}

function deserializePlan(
  value: z.infer<typeof planSchema>,
): ProtectedTaskProjectionAuthorityPlan {
  return deserializeProtectedTaskProjectionAuthorityPlan(
    value as SerializedProtectedTaskProjectionAuthorityPlan,
  );
}

function samePlan(
  left: ProtectedTaskProjectionAuthorityPlan,
  right: ProtectedTaskProjectionAuthorityPlan,
): boolean {
  return sameProtectedTaskProjectionAuthorityPlan(left, right);
}

function planBase(input: Readonly<{
  reference: ProtectedAgentMemoryProjectionReference;
  prepared: ProjectionPrepareInput;
  state: PreparedProjectionState;
  current: ProtectedTaskMemoryAuthorityInput;
}>) {
  const requirements = requirementsFor(
    input.state.sources,
    input.state.destination.namespaceId,
  );
  const task = input.current.occurrence.task;
  const run = input.current.occurrence.run;
  const requestDigest = digest([
    REQUEST_DOMAIN,
    task.id,
    run.id,
    run.graphThreadId,
    input.reference.referenceId,
    input.reference.toolCallId,
    input.reference.requesterUserId,
    input.reference.requesterActorId,
    input.reference.agentId,
    input.reference.createdAt,
    input.reference.expiresAt,
    input.prepared.operationId,
    input.state.sources.map(source => [
      source.memoryId,
      source.contentRevision,
      source.cryptoAccessRevision,
      source.cryptoObjectId,
      source.requiredNamespaceIds,
      source.payloadDigest,
    ]),
    [
      input.state.destination.roomId,
      input.state.destination.namespaceId,
      input.state.destination.label,
      input.state.destination.kind,
      input.state.destination.memberCount,
      input.state.destination.audienceFingerprint,
    ],
    input.state.proposalDigest,
    input.state.effectDigest,
    requirements.map(requirement => [
      requirement.namespaceId,
      requirement.operations,
    ]),
  ]);
  return Object.freeze({
    planVersion: 1 as const,
    operationId: input.prepared.operationId,
    requestDigest,
    semanticAuthorityRequirements: requirements,
  });
}

function additionalPlan(
  common: ReturnType<typeof planBase>,
  taskRunId: string,
): Extract<ProtectedTaskProjectionAuthorityPlan,
  { kind: "additional_authority_v1" }> {
  const authorizationRequestId = `task.memory.projection:${hex(digest([
    AUTHORIZATION_DOMAIN,
    taskRunId,
    hex(common.requestDigest),
  ]))}`;
  return Object.freeze({
    ...common,
    kind: "additional_authority_v1" as const,
    authorizationRequestId,
    effectDisposition: "not_started_v1" as const,
  });
}

function makePlan(input: Readonly<{
  reference: ProtectedAgentMemoryProjectionReference;
  prepared: ProjectionPrepareInput;
  state: PreparedProjectionState;
  current: ProtectedTaskMemoryAuthorityInput;
}>): ProtectedTaskProjectionAuthorityPlan {
  return createProtectedTaskProjectionAuthorityPlan({
    taskId: input.current.occurrence.task.id,
    taskRunId: input.current.occurrence.run.id,
    graphThreadId: input.current.occurrence.run.graphThreadId,
    reference: input.reference,
    operationId: input.prepared.operationId,
    sources: input.state.sources,
    destination: input.state.destination,
    proposalDigest: input.state.proposalDigest,
    effectDigest: input.state.effectDigest,
    availableAuthority: input.current.evidence.namespaceRequirements,
  });
}

function createProjectionCapsule(input: Readonly<{
  crypto: ProtectedTaskMemoryAuthorityInput["crypto"];
  entities: Pick<AgentEntityCryptoInvocation, "signal" | "use" | "useCurrentSet">;
  namespaceId: string;
  current: ProtectedTaskMemoryAuthorityInput;
  policyRevision: number;
  agentAuthorizationRevision: number;
}>): AgentMemoryProjectionContinuationCapsule {
  return createAgentMemoryProjectionContinuationCapsule({
    crypto: input.crypto,
    entities: input.entities,
    namespaceId: input.namespaceId,
    identity: Object.freeze({
      kind: "protected_task_v1" as const,
      taskId: input.current.occurrence.task.id,
      taskRunId: input.current.occurrence.run.id,
      graphThreadId: input.current.occurrence.run.graphThreadId,
      subjectUserId: input.current.subject.userId,
      humanActorId: input.current.subject.humanActorId,
      agentId: input.current.occurrence.task.agentId,
      contentNamespaceId: input.current.occurrence.task.contentNamespaceId,
      policyRevision: input.policyRevision,
      agentAuthorizationRevision: input.agentAuthorizationRevision,
    }),
  });
}

const productionDependencies: Dependencies = Object.freeze({
  now: Date.now,
  createReferenceId: randomUUID,
  createResumable: createResumableProtectedAgentMemoryProjectionPort,
  withCurrentAuthority: withCurrentProtectedTaskMemoryAuthority,
  resolveRoom: resolveAuthorizedRoomName,
  findRoomCandidates: findAuthorizedRoomNameCandidates,
  hasCapability: userHasCapability,
  lockDestination: lockAtomicProjectionDestinationAuthority,
  bindProductRunner: bindConversationProductCanonicalTransactionRunner,
  createProduct: input => new PostgresAgentMemoryProductPort(input),
  createCapsule: createProjectionCapsule,
});

function unavailable(reason: "authorization_required" | "stale_revision"
  | "embedding_unavailable" | "integrity_failure"
  | "target_encryption_not_ready") {
  return Object.freeze({ status: "unavailable" as const, reason });
}

/**
 * Build the restart-safe dynamic projection handoff for one protected Task
 * segment. The graph keeps its original source authority; a destination is
 * writable only through the exact fresh Task grant sealed by this owner.
 */
export function createProtectedTaskMemoryProjection(
  input: ProtectedTaskMemoryProjectionInput,
  overrides: Partial<Dependencies> = {},
): ProtectedTaskMemoryProjectionHandoff {
  const dependencies = Object.freeze({ ...productionDependencies, ...overrides });
  const { current } = input;
  const task = current.occurrence.task;
  const run = current.occurrence.run;
  if (input.policy.revision !== current.evidence.policyRevision
    || input.authority.subjectUserId !== current.subject.userId
    || input.authority.agentId !== task.agentId
    || current.subject.humanActorId.length === 0
    || task.contentNamespaceId.length === 0
    || run.graphThreadId.length === 0
    || !protectedTaskDefinitionSupportsPolicy(task.contentRepresentation, input.policy.mode)) {
    throw new TypeError("Protected Task projection identity is unavailable");
  }
  const fixedAuthority = input.authority;
  const policy: CurrentProtectedTaskMemoryPolicy = Object.freeze({
    mode: input.policy.mode,
    shadowBehavior: input.policy.shadowBehavior,
    revision: input.policy.revision,
  });
  const capsule = dependencies.createCapsule({
    crypto: current.crypto,
    entities: input.entities,
    namespaceId: task.contentNamespaceId,
    current,
    policyRevision: policy.revision,
    agentAuthorizationRevision: input.agentAuthorizationRevision,
  });
  const choices = new Map<string, Readonly<{
    userId: string;
    query: string;
    roomId: string;
    expiresAt: number;
  }>>();

  const assertBaseFresh = async (): Promise<void> => {
    const result = await dependencies.withCurrentAuthority(current, async held => {
      await held.assertCurrent();
      const valid = held.policy.mode === policy.mode
        && held.policy.shadowBehavior === policy.shadowBehavior
        && held.policy.revision === policy.revision;
      await held.assertCurrent();
      return valid;
    });
    if (result !== true) {
      throw new TypeError("Protected Task projection authority is unavailable");
    }
  };
  const assertFresh = async (
    requirements: ProtectedTaskSemanticAuthorityRequirements,
  ): Promise<void> => {
    await assertBaseFresh();
    if (!evidenceCovers(current, requirements)) {
      throw new TypeError("Protected Task projection authority is unavailable");
    }
  };

  const openSources = async (
    authority: ProtectedMemoryAuthority,
    memoryIds: readonly string[],
  ): Promise<readonly ProjectionSource[] | null> => {
    if (!sameAuthority(authority, fixedAuthority)
      || memoryIds.length === 0
      || new Set(memoryIds).size !== memoryIds.length) return null;
    const selected = await input.sourceProduct.loadExactProjectionSources({
      authority,
      memoryIds,
    });
    if (selected.status === "unavailable") return null;
    const opened = await input.session.session.openMany({
      entrypointId: "subagent.scope",
      agentId: task.agentId,
      authority,
      candidates: selected.value,
    });
    if (opened.status === "unavailable"
      || opened.value.length !== memoryIds.length
      || selected.value.length !== memoryIds.length) return null;
    const byId = new Map(opened.value.map(value => [value.memoryId, value]));
    const sources: ProjectionSource[] = [];
    for (const candidate of selected.value) {
      const openedValue = byId.get(candidate.memoryId);
      const requiredNamespaceIds = [...candidate.requiredNamespaceIds].sort();
      if (openedValue === undefined
        || openedValue.contentRevision !== candidate.contentRevision
        || requiredNamespaceIds.length === 0
        || new Set(requiredNamespaceIds).size !== requiredNamespaceIds.length) {
        return null;
      }
      sources.push(Object.freeze({
        memoryId: candidate.memoryId,
        contentRevision: candidate.contentRevision,
        cryptoAccessRevision: candidate.cryptoAccessRevision,
        cryptoObjectId: candidate.cryptoObjectId,
        requiredNamespaceIds: Object.freeze(requiredNamespaceIds),
        payloadDigest: hex(commitMemoryMutationV1({
          kind: "save",
          payload: {
            formatVersion: 1,
            type: openedValue.type,
            content: openedValue.content,
          },
        })),
      }));
    }
    sources.sort((left, right) => left.memoryId.localeCompare(right.memoryId));
    return Object.freeze(sources);
  };

  const validateSnapshot = async (
    authority: ProtectedMemoryAuthority,
    prepared: ProjectionPrepareInput,
    snapshot: SealedProjectionState,
  ) => {
    await assertBaseFresh();
    const reopened = await openSources(authority, prepared.sourceMemoryIds);
    if (reopened === null
      || JSON.stringify(reopened) !== JSON.stringify(snapshot.sources)) {
      return unavailable("stale_revision");
    }
    const stale = await input.product.canonicalRunner.transaction(
      transaction => dependencies.lockDestination(transaction, {
        roomId: snapshot.destination.roomId,
        namespaceId: snapshot.destination.namespaceId,
        roomLabel: snapshot.destination.label,
        roomKind: snapshot.destination.kind,
        requesterActorId: current.subject.humanActorId,
        userId: current.subject.userId,
        audienceFingerprint: snapshot.destination.audienceFingerprint,
      }),
      { isolationLevel: "serializable" },
    );
    if (stale !== null) return unavailable("stale_revision");
    await assertBaseFresh();
    return Object.freeze({
      status: "success" as const,
      value: Object.freeze({
        proposedContent: prepared.proposedContent,
        roomLabel: snapshot.destination.label,
        roomKind: snapshot.destination.kind,
        memberCount: snapshot.destination.memberCount,
      }),
    });
  };

  const parseCapsule = async (
    reference: ProtectedAgentMemoryProjectionReference,
  ): Promise<Readonly<{
    prepared: ProjectionPrepareInput;
    state: SealedProjectionState;
    plan: ProtectedTaskProjectionAuthorityPlan;
  }> | null> => {
    const decoded = capsuleSchema.safeParse(await capsule.open(reference));
    if (!decoded.success) return null;
    const { roomChoiceToken, ...rest } = decoded.data.prepared;
    const prepared = Object.freeze({
      ...rest,
      ...(roomChoiceToken === undefined ? {} : { roomChoiceToken }),
    }) as ProjectionPrepareInput;
    const state = Object.freeze({
      ...decoded.data.state,
      sources: Object.freeze(decoded.data.state.sources.map(source =>
        Object.freeze({ ...source,
          requiredNamespaceIds: Object.freeze([
            ...source.requiredNamespaceIds,
          ]),
        }))),
      publicationAuthority: decoded.data.state.publicationAuthority,
    }) as SealedProjectionState;
    const proposalDigest = hex(digest([
      REQUEST_DOMAIN,
      "proposal",
      prepared.proposedContent,
    ]));
    const effectDigest = hex(commitMemoryMutationV1({
      kind: "save",
      payload: {
        formatVersion: 1,
        type: "fact",
        content: prepared.proposedContent,
      },
    }));
    if (state.proposalDigest !== proposalDigest
      || state.effectDigest !== effectDigest) return null;
    const plan = deserializePlan(state.publicationAuthority);
    const common = planBase({ reference, prepared, state, current });
    const rederived: ProtectedTaskProjectionAuthorityPlan =
      plan.kind === "current_v1"
        ? Object.freeze({ ...common, kind: "current_v1" as const })
        : additionalPlan(common, run.id);
    if (!samePlan(plan, rederived)) return null;
    return Object.freeze({ prepared, state, plan });
  };

  type InternalState = PreparedProjectionState | SealedProjectionState;
  const resumable = dependencies.createResumable<InternalState>({
    now: dependencies.now,
    createReferenceId: dependencies.createReferenceId,
    ttlMs: TTL_MS,
    requesterUserId: current.subject.userId,
    requesterActorId: current.subject.humanActorId,
    agentId: task.agentId,
    async seal({ reference, prepared, state }) {
      if ("publicationAuthority" in state) {
        throw new TypeError("Protected Task projection was already sealed");
      }
      await assertBaseFresh();
      const plan = makePlan({ reference, prepared, state, current });
      const sealed = await capsule.seal(reference, {
        prepared,
        state: {
          ...state,
          publicationAuthority: serializePlan(plan),
        },
      });
      await assertBaseFresh();
      return sealed;
    },
    async open(reference) {
      const opened = await parseCapsule(reference);
      return opened === null ? null : Object.freeze({
        prepared: opened.prepared,
        state: opened.state,
      });
    },
    async validate({ authority, prepared, state }) {
      if (!("publicationAuthority" in state)) {
        return unavailable("integrity_failure");
      }
      return validateSnapshot(authority, prepared, state);
    },
    async prepare(request) {
      if (!sameAuthority(request.authority, fixedAuthority)
        || request.requesterActorId !== current.subject.humanActorId) {
        return unavailable("authorization_required");
      }
      await assertBaseFresh();
      const sources = await openSources(request.authority, request.sourceMemoryIds);
      if (sources === null) return unavailable("authorization_required");
      const resolution = await dependencies.resolveRoom({
        requesterUserId: current.subject.userId,
        requesterActorId: current.subject.humanActorId,
        targetRoomName: request.targetRoomName,
        ...(request.roomChoiceToken === undefined
          ? {}
          : { roomChoiceToken: request.roomChoiceToken }),
      }, {
        findAuthorizedRoomNameCandidates: dependencies.findRoomCandidates,
        userHasCapability: dependencies.hasCapability,
        choiceTokenCodec: {
          issue(value) {
            const token = dependencies.createReferenceId();
            choices.set(token, Object.freeze({
              userId: value.requesterUserId,
              query: value.normalizedQuery,
              roomId: value.roomId,
              expiresAt: dependencies.now() + TTL_MS,
            }));
            return token;
          },
          verify(value) {
            const found = choices.get(value.token);
            return found !== undefined
              && found.expiresAt > dependencies.now()
              && found.userId === value.requesterUserId
              && found.query === value.normalizedQuery
              && value.candidateRoomIds.includes(found.roomId)
              ? found.roomId
              : null;
          },
        },
      });
      if (resolution.status === "needs_disambiguation") {
        return Object.freeze({
          status: "success" as const,
          value: Object.freeze({
            kind: "needs_disambiguation" as const,
            candidates: resolution.candidates.map(candidate => Object.freeze({
              choiceToken: candidate.choiceToken,
              label: candidate.label,
              roomKind: candidate.kind,
              memberCount: candidate.memberCount,
            })),
          }),
        });
      }
      if (resolution.status !== "resolved") {
        return unavailable("authorization_required");
      }
      await assertBaseFresh();
      const effectDigest = commitMemoryMutationV1({
        kind: "save",
        payload: { formatVersion: 1, type: "fact", content: request.proposedContent },
      });
      return Object.freeze({
        status: "success" as const,
        value: Object.freeze({
          kind: "prepared" as const,
          state: Object.freeze({
            destination: resolution.destination,
            sources,
            proposalDigest: hex(digest([
              REQUEST_DOMAIN,
              "proposal",
              request.proposedContent,
            ])),
            effectDigest: hex(effectDigest),
          }),
          preview: Object.freeze({
            proposedContent: request.proposedContent,
            roomLabel: resolution.destination.label,
            roomKind: resolution.destination.kind,
            memberCount: resolution.destination.memberCount,
          }),
        }),
      });
    },
    publish: () => Promise.resolve(unavailable("authorization_required")),
  });

  const referenceBound = (
    authority: ProtectedMemoryAuthority,
    reference: ProtectedAgentMemoryProjectionReference,
  ): boolean => reference.referenceVersion === 1
    && reference.referenceId.length > 0
    && reference.referenceId.length <= 256
    && reference.referenceId.trim() === reference.referenceId
    && reference.toolCallId.length > 0
    && reference.requesterUserId === current.subject.userId
    && reference.requesterActorId === current.subject.humanActorId
    && reference.agentId === task.agentId
    && reference.createdAt <= dependencies.now()
    && dependencies.now() < reference.expiresAt
    && typeof reference.sealedPreparation === "string"
    && reference.sealedPreparation.length > 0
    && sameAuthority(authority, fixedAuthority);

  const recoverRaw = async (
    authority: ProtectedMemoryAuthority,
    reference: ProtectedAgentMemoryProjectionReference,
  ) => {
    if (!referenceBound(authority, reference)) return null;
    const opened = await parseCapsule(reference);
    if (opened === null
      || !referenceBound(authority, reference)
      || !sameAuthority(opened.prepared.authority, fixedAuthority)
      || opened.prepared.toolCallId !== reference.toolCallId
      || opened.prepared.requesterActorId !== current.subject.humanActorId) return null;
    return opened;
  };

  const recoverValidated = async (
    authority: ProtectedMemoryAuthority,
    reference: ProtectedAgentMemoryProjectionReference,
  ) => {
    if (!referenceBound(authority, reference)) return null;
    const restored = await resumable.restore?.({ authority, reference });
    if (restored === undefined || restored.status === "unavailable") return null;
    return recoverRaw(authority, reference);
  };

  const publicationBoundary = (
    snapshot: SealedProjectionState,
    targetAuthority: ProtectedMemoryAuthority,
  ): AgentMemoryPublicationBoundary => {
    const exactTarget = (candidate: ProtectedMemoryAuthority) => {
      if (!sameAuthority(candidate, targetAuthority)) {
        throw new TypeError("Protected Task projection target changed");
      }
    };
    const withCurrentPublication: Exclude<
      AgentMemoryPublicationBoundary["withCurrentPublication"], undefined
    > = async request => {
      exactTarget(request.authority);
      let completed: Awaited<ReturnType<typeof request.use>> | null = null;
      try {
        const result = await dependencies.withCurrentAuthority(current, async held => {
          const assertCurrent = async () => {
            exactTarget(request.authority);
            await held.assertCurrent();
            if (held.policy.mode !== policy.mode
              || held.policy.shadowBehavior !== policy.shadowBehavior
              || held.policy.revision !== policy.revision
              || !evidenceCovers(current,
                deserializePlan(snapshot.publicationAuthority)
                  .semanticAuthorityRequirements)) {
              throw new TypeError("Protected Task projection authority changed");
            }
            exactTarget(request.authority);
          };
          await assertCurrent();
          const receipt = await request.use(assertCurrent);
          completed = receipt;
          await assertCurrent();
          return receipt;
        });
        if (result === null) {
          if (request.mutation && completed !== null) return completed;
          throw new TypeError("Protected Task projection authority is unavailable");
        }
        return result;
      } catch (error) {
        if (request.mutation && completed !== null) return completed;
        throw error;
      }
    };
    return input.policy.mode === "shadow_encryption"
      ? Object.freeze({
          representation: "ordinary_and_protected" as const,
          withCurrentPublication,
          readPreparedPayload: input.session.readPreparedPayload,
        })
      : Object.freeze({
          representation: "protected_only" as const,
          withCurrentPublication,
        });
  };

  const publish = async (
    opened: NonNullable<Awaited<ReturnType<typeof recoverRaw>>>,
    reference: ProtectedAgentMemoryProjectionReference,
  ): Promise<ReturnType<ProtectedAgentMemoryProjectionPort["publish"]> extends Promise<infer R> ? R : never> => {
    const { prepared, state: snapshot, plan } = opened;
    const reopened = await openSources(fixedAuthority, prepared.sourceMemoryIds);
    if (reopened === null
      || JSON.stringify(reopened) !== JSON.stringify(snapshot.sources)) {
      return unavailable("stale_revision");
    }
    await assertFresh(plan.semanticAuthorityRequirements);
    const embedded = await input.embedding.embed({
      purpose: "memory.content_embedding",
      plaintext: prepared.proposedContent,
      signal: input.entities.signal,
    });
    if (embedded.status === "unavailable"
      || embedded.value.dimensions !== MEMORY_EMBEDDING_DIMENSIONS) {
      return unavailable("embedding_unavailable");
    }
    await assertFresh(plan.semanticAuthorityRequirements);
    const targetAuthority = Object.freeze({
      mode: "namespace" as const,
      subjectUserId: current.subject.userId,
      agentId: task.agentId,
      readableNamespaceIds: Object.freeze([snapshot.destination.namespaceId]),
      mutableNamespaceIds: Object.freeze([snapshot.destination.namespaceId]),
      writableNamespaceId: snapshot.destination.namespaceId,
    });
    const lockedConnection: ConversationProductCanonicalTransactionConnection =
      Object.freeze({
      transaction: async <Result>(
        use: (
          transaction: CanonicalTranscriptTx,
          executor: ConversationProductPostgresExecutor,
        ) => Promise<Result>,
        options: Parameters<ConversationProductCanonicalTransactionConnection["transaction"]>[1],
      ): Promise<Result> => input.product.canonicalRunner.transaction(
        async (transaction, executor) => {
          if (dependencies.now() >= reference.expiresAt) {
            throw new TypeError("Protected Task projection expired");
          }
          const stale = await dependencies.lockDestination(transaction, {
            roomId: snapshot.destination.roomId,
            namespaceId: snapshot.destination.namespaceId,
            roomLabel: snapshot.destination.label,
            roomKind: snapshot.destination.kind,
            requesterActorId: current.subject.humanActorId,
            userId: current.subject.userId,
            audienceFingerprint: snapshot.destination.audienceFingerprint,
          });
          if (stale !== null) throw new TypeError(`Projection ${stale}`);
          const rows = await transaction.select({
            id: memories.id,
            contentRevision: memories.contentRevision,
            cryptoAccessRevision: memories.cryptoAccessRevision,
            cryptoObjectId: memories.cryptoObjectId,
          }).from(memories)
            .where(inArray(memories.id, [...prepared.sourceMemoryIds]))
            .orderBy(memories.id).for("share", { of: memories });
          if (rows.length !== snapshot.sources.length
            || rows.some((row, index) => {
              const source = snapshot.sources[index]!;
              return row.id !== source.memoryId
                || row.contentRevision !== source.contentRevision
                || row.cryptoAccessRevision !== source.cryptoAccessRevision
                || row.cryptoObjectId !== source.cryptoObjectId;
            })) throw new TypeError("Projection source changed");
          const edges = await transaction.select({
            memoryId: memoryNamespaces.memoryId,
            namespaceId: memoryNamespaces.namespaceId,
          }).from(memoryNamespaces)
            .where(inArray(memoryNamespaces.memoryId,
              [...prepared.sourceMemoryIds]))
            .orderBy(memoryNamespaces.memoryId, memoryNamespaces.namespaceId)
            .for("share", { of: memoryNamespaces });
          for (const source of snapshot.sources) {
            const actual = edges.filter(edge => edge.memoryId === source.memoryId)
              .map(edge => edge.namespaceId);
            if (actual.length !== source.requiredNamespaceIds.length
              || actual.some((namespaceId, index) =>
                namespaceId !== source.requiredNamespaceIds[index])) {
              throw new TypeError("Projection source authority changed");
            }
          }
          const value: Result = await use(transaction, executor);
          if (dependencies.now() >= reference.expiresAt) {
            throw new TypeError("Protected Task projection expired");
          }
          return value;
        },
        options,
      ),
    });
    const lockedRunner = dependencies.bindProductRunner(
      input.product.handle,
      lockedConnection,
    );
    const product = dependencies.createProduct({
      handle: input.product.handle,
      canonicalRunner: lockedRunner,
      readableNamespaceIds: [snapshot.destination.namespaceId],
      cryptoCompletion: input.session.completion,
      publication: publicationBoundary(snapshot, targetAuthority),
    });
    const commitment = bytes(snapshot.effectDigest);
    const reserved = await product.planProjectionCreate({
      operationId: prepared.operationId,
      authority: targetAuthority,
      embedding: embedded.value,
      importance: 0.8,
      mutationCommitment: commitment,
      signal: input.entities.signal,
    });
    commitment.fill(0);
    if (reserved.status === "unavailable") return reserved;
    const encrypted = await input.session.session.prepare({
      entrypointId: "subagent.scope",
      agentId: task.agentId,
      authority: targetAuthority,
      plan: reserved.value,
      content: {
        kind: "complete",
        payload: {
          formatVersion: 1,
          type: "fact",
          content: prepared.proposedContent,
        },
      },
    });
    if (encrypted.status === "unavailable") return encrypted;
    const committed = await input.session.session.authorizeCommit({
      entrypointId: "subagent.scope",
      agentId: task.agentId,
      authority: targetAuthority,
      target: reserved.value,
      operation: "publish",
      signal: input.entities.signal,
      commit: () => product.publishPrepared({
        authority: targetAuthority,
        plan: reserved.value,
        prepared: encrypted.value,
        embedding: embedded.value,
        signal: input.entities.signal,
      }),
    });
    if (committed.status === "unavailable"
      || committed.value === "stale"
      || committed.value === "deleted") return unavailable("stale_revision");
    return Object.freeze({
      status: "success" as const,
      value: Object.freeze({
        status: committed.value === "replayed" ? "replayed" as const : "created" as const,
        memoryId: reserved.value.memoryId,
        roomLabel: snapshot.destination.label,
      }),
    });
  };

  return Object.freeze({
    prepare: request => resumable.prepare(request),
    restore: request => resumable.restore!(request),
    async planPublication({ authority, reference }) {
      const opened = await recoverValidated(authority, reference);
      return opened === null
        ? unavailable("authorization_required")
        : Object.freeze({ status: "success" as const, value: opened.plan });
    },
    async publishAuthorized({ authority, reference, authorization }) {
      const opened = await recoverRaw(authority, reference);
      if (opened === null || !samePlan(opened.plan, authorization.plan)
        || authorization.kind !== opened.plan.kind) {
        return unavailable("authorization_required");
      }
      if (authorization.kind === "additional_authority_v1") {
        const requiredAuthorityDigest =
          protectedTaskSemanticAuthorityRequirementsDigest(
            opened.plan.semanticAuthorityRequirements,
          );
        try {
          assertProtectedTaskAdditionalAuthorityResumeAcknowledgementV1(
            authorization.acknowledgement,
            {
              authorizationRequestId: authorization.plan.authorizationRequestId,
              effectDisposition: "not_started_v1",
              operationId: authorization.plan.operationId,
              requestDigest: authorization.plan.requestDigest,
              requiredAuthorityDigest,
            },
          );
        } catch {
          return unavailable("authorization_required");
        } finally {
          requiredAuthorityDigest.fill(0);
        }
      }
      if (!evidenceCovers(current, opened.plan.semanticAuthorityRequirements)) {
        return unavailable("authorization_required");
      }
      const validated = await validateSnapshot(
        authority,
        opened.prepared,
        opened.state,
      );
      if (validated.status === "unavailable") return validated;
      return publish(opened, reference);
    },
  });
}
