import {
  assertProtectedTaskAdditionalAuthorityResumeAcknowledgementV1,
  commitForegroundMemoryOrdinaryFallback,
  createResumableProtectedAgentMemoryProjectionPort,
  embedTextWithProvenance,
  EmbeddingProviderError,
  lockAtomicProjectionDestinationAuthority,
  MemoryMutationAuthorityError,
  protectedMemoryAuthorityFromEnvelope,
} from "@nautilo/agent";
import { inArray, memories, memoryNamespaces,
  protectedTaskSemanticAuthorityRequirementsDigest,
  type ProtectedTaskSemanticAuthorityRequirements } from "@nautilo/db";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { createForegroundMemoryProjectionCapsule } from "./foreground-memory-projection-capsule";
import {
  commitMemoryMutationV1,
  createInvocationBoundProtectedAgentMemoryRepository,
  deriveMemoryCryptoObjectIdV1,
  fingerprintRequiredMemoryNamespaces,
  MEMORY_EMBEDDING_DIMENSIONS,
  MEMORY_OBJECT_TYPE,
  bindEncryptionDataOperationOwner,
  selectLiveEncryptionRepresentationPolicy,
  type ProtectedAgentMemoryRepository,
  type ProtectedAgentMemoryEmbeddingPort,
  type ProtectedMemoryAuthority,
} from "@nautilo/lattice-bridge";
import {
  type createPostgresForegroundMemoryPublication,
  attachPostgresForegroundMemoryRepair,
  loadPostgresForegroundMemoryRepairSources,
  PostgresAgentMemoryProductPort,
  PostgresAgentMemoryExactAccessProduct,
  bindConversationProductCanonicalTransactionRunner,
  persistForegroundAgentMemoryNativeExactAccess,
  type AgentMemoryPublicationBoundary,
  type ConversationProductCanonicalTransactionConnection,
  type ConversationProductPostgresExecutor,
  type PostgresDomainKeyAuthorityRepository,
  validatePostgresForegroundMemoryRepairSource,
} from "@nautilo/lattice-bridge/server";
import { namespaceId } from "@nautilo/lattice-crypto";
import { type MemoryNativeNamespaceAccessEntryV1 } from "@nautilo/lattice-crypto/wire";
import {
  createForegroundDomainMemoryCryptoSession,
  createForegroundDomainMemoryExactAccess,
  createForegroundDomainProtectedAgentMemoryAccessPort,
  type ForegroundDomainMemoryAccessHead,
  createForegroundMemoryHistoryRepairer,
} from "@nautilo/runtime";
import {
  findAuthorizedRoomNameCandidates,
  resolveAuthorizedRoomName,
  userHasCapability,
  isScopeMemoryEnvelope,
  type CanonicalTranscriptTx,
  type MemoryAccessEnvelope,
} from "@nautilo/trust";
import type {
  ProtectedAgentMemoryAccessPort,
  ProtectedAgentMemoryProjectionPort,
  ProtectedTaskMemoryProjectionHandoff,
  ProtectedTaskProjectionAuthorityPlan,
} from "@nautilo/agent";
import { createForegroundProductTransactionContext } from "./foreground-message-product-store";
import { createForegroundMemoryPublicationAuthority } from "./foreground-memory-publication-authority";
import {
  deliverCommittedForegroundMemoryEffect,
  withForegroundMemoryEffectReceipts,
} from "./foreground-memory-effect-receipts";
import {
  createProtectedTaskProjectionAuthorityPlan,
  deserializeProtectedTaskProjectionAuthorityPlan,
  protectedTaskProjectionDestinationAuthorityDigest,
  sameProtectedTaskProjectionAuthorityPlan,
  semanticAuthorityCovers,
  serializeProtectedTaskProjectionAuthorityPlan,
  type SerializedProtectedTaskProjectionAuthorityPlan,
} from "./protected-task-memory-projection-plan";

type ForegroundMemoryProductContext = Awaited<
  ReturnType<typeof createForegroundProductTransactionContext>
>;

/** Fresh callback-scoped Agent product/crypto owner for one exact-access
 * operation. The assertion must remain backed by the calling authority owner. */
export type ForegroundMemoryCurrentExactAccess = Readonly<{
  productContext: ForegroundMemoryProductContext;
  assertCurrentAuthority(): Promise<void>;
  exact: Readonly<{
    handle: Parameters<typeof persistForegroundAgentMemoryNativeExactAccess>[0]["handle"];
    resolveHistoricalAgentSignerAuthority: Parameters<
      typeof persistForegroundAgentMemoryNativeExactAccess
    >[0]["resolveHistoricalAgentSignerAuthority"];
    resolveLiveShadowAgentSigner: Parameters<
      typeof persistForegroundAgentMemoryNativeExactAccess
    >[0]["resolveLiveShadowAgentSigner"];
    resolveCurrentAgentSigner: Parameters<
      typeof persistForegroundAgentMemoryNativeExactAccess
    >[0]["resolveCurrentAgentSigner"];
    namespaceKeys: Pick<PostgresDomainKeyAuthorityRepository,
      "inspectNamespaceGenerationAuthorityMetadata">;
    read: (request: Readonly<{
      objectId: string;
      expectedAccessRevision: number;
      expectedNamespaceIds: readonly string[];
    }>) => Promise<ForegroundDomainMemoryAccessHead | null>;
  }>;
}>;

export type ForegroundMemoryCurrentExactAccessOwner = <Value>(
  use: (current: ForegroundMemoryCurrentExactAccess) => Promise<Value>,
) => Promise<Value | null>;

const authorityUnavailable = () => Object.freeze({
  status: "unavailable" as const,
  reason: "authorization_required" as const,
});

/** Resolve only the authenticated native descriptors named by the verified
 * ciphertext envelope inventory. Product authorization happens before this
 * trusted-server helper is called. */
export async function resolveForegroundMemoryNativeEntries(
  repository: Pick<
    PostgresDomainKeyAuthorityRepository,
    "inspectNamespaceGenerationAuthorityMetadata"
  >,
  coordinates: readonly Readonly<{
    namespaceId: string;
    generation: number;
    accessRevision: number;
    envelopeHash: Uint8Array;
  }>[],
): Promise<readonly MemoryNativeNamespaceAccessEntryV1[] | null> {
  const entries: MemoryNativeNamespaceAccessEntryV1[] = [];
  for (const coordinate of coordinates) {
    const result = await repository.inspectNamespaceGenerationAuthorityMetadata(
      {
        namespaceId: coordinate.namespaceId,
        keyClass: "ai",
        requested: [
          {
            generation: coordinate.generation,
            accessRevision: coordinate.accessRevision,
          },
        ],
      },
    );
    if (result.status !== "ready") return null;
    const descriptor = result.retainedGenerations.find(
      (entry) =>
        entry.generation === coordinate.generation &&
        entry.accessRevision === coordinate.accessRevision,
    );
    if (descriptor === undefined) return null;
    entries.push(
      Object.freeze({
        namespaceId: namespaceId(coordinate.namespaceId),
        keyGeneration: coordinate.generation,
        namespaceAccessRevision: coordinate.accessRevision,
        headDigest: descriptor.headDigest.slice(),
        publicationDigest: descriptor.publicationDigest.slice(),
        publicationSetDigest: descriptor.publicationSetDigest.slice(),
        audienceFingerprint: descriptor.audienceFingerprint.slice(),
        envelopeHash: coordinate.envelopeHash.slice(),
      }),
    );
  }
  return Object.freeze(entries);
}

export async function createForegroundMemoryAccessPort(
  input: Readonly<{
    envelope: MemoryAccessEnvelope;
    domain: Omit<
      Parameters<typeof createForegroundDomainMemoryCryptoSession>[0],
      "read"
    > &
      Readonly<{
        read(
          request: Parameters<
            Parameters<
              typeof createForegroundDomainMemoryCryptoSession
            >[0]["read"]
          >[0],
        ): Promise<ForegroundDomainMemoryAccessHead | null>;
      }>;
    resolveGrantUserNamespace: ConstructorParameters<
      typeof PostgresAgentMemoryExactAccessProduct
    >[0]["resolveGrantUserNamespace"];
    exact?: Readonly<{
      handle: Parameters<
        typeof persistForegroundAgentMemoryNativeExactAccess
      >[0]["handle"];
      resolveHistoricalAgentSignerAuthority: Parameters<
        typeof persistForegroundAgentMemoryNativeExactAccess
      >[0]["resolveHistoricalAgentSignerAuthority"];
      resolveLiveShadowAgentSigner: Parameters<
        typeof persistForegroundAgentMemoryNativeExactAccess
      >[0]["resolveLiveShadowAgentSigner"];
      resolveCurrentAgentSigner: Parameters<
        typeof persistForegroundAgentMemoryNativeExactAccess
      >[0]["resolveCurrentAgentSigner"];
      namespaceKeys: Pick<
        PostgresDomainKeyAuthorityRepository,
        "inspectNamespaceGenerationAuthorityMetadata"
      >;
    }>;
    withCurrentExactAccess?: ForegroundMemoryCurrentExactAccessOwner;
  }>,
): Promise<ProtectedAgentMemoryAccessPort> {
  if (
    isScopeMemoryEnvelope(input.envelope) ||
    input.envelope.ownerId !== input.domain.subjectUserId ||
    input.envelope.agentId !== input.domain.agentId ||
    input.exact === undefined && input.withCurrentExactAccess === undefined
  ) {
    throw new TypeError("Foreground Memory access identity is unavailable");
  }
  const readableNamespaceIds = [...input.envelope.readableNamespaces].sort();
  const fixed = input.withCurrentExactAccess === undefined
    ? await createForegroundProductTransactionContext({
        userId: input.envelope.ownerId,
        agentId: input.envelope.agentId,
      })
    : null;
  const currentStore = input.withCurrentExactAccess === undefined
    ? null
    : new AsyncLocalStorage<ForegroundMemoryCurrentExactAccess>();
  const exactProduct = (current?: ForegroundMemoryCurrentExactAccess) =>
    new PostgresAgentMemoryExactAccessProduct({
    handle: fixed?.handle ?? current!.productContext.handle,
    readableNamespaceIds,
    resolveGrantUserNamespace: input.resolveGrantUserNamespace,
    ...(current === undefined ? {} : {
      assertCurrentAuthority: current.assertCurrentAuthority,
    }),
  });
  const withCurrent = async <Value, Fallback>(
    use: (current?: ForegroundMemoryCurrentExactAccess) => Promise<Value>,
    unavailable: Fallback,
  ): Promise<Value | Fallback> => {
    if (input.withCurrentExactAccess === undefined) return use();
    const retained = currentStore?.getStore();
    if (retained !== undefined) return use(retained);
    return await input.withCurrentExactAccess((current) =>
      currentStore!.run(current, () => use(current)))
      ?? unavailable;
  };
  const product: Pick<PostgresAgentMemoryExactAccessProduct,
    "planNativeChange" | "commitNativePrepared" | "reconcileNativeCommitted"> = {
    planNativeChange: (request) => withCurrent(
      (current) => exactProduct(current).planNativeChange(request),
      authorityUnavailable(),
    ),
    commitNativePrepared: (request) => withCurrent(
      (current) => exactProduct(current).commitNativePrepared(request),
      authorityUnavailable(),
    ),
    reconcileNativeCommitted: (request) =>
      withCurrent(
        (current) => exactProduct(current).reconcileNativeCommitted(request),
        false,
      ),
  };
  const crypto = createForegroundDomainMemoryExactAccess({
    crypto: input.domain.crypto,
    entities: input.domain.entities,
    runtime: input.domain.publication.runtime,
    signerKeyId: input.domain.publication.signerKeyId,
    agentAuthorizationRevision:
      input.domain.publication.agentAuthorizationRevision,
    read: (request) => withCurrent(
      (current) => (current?.exact.read ?? input.domain.read)({
          ...request,
          expectedObjectType: MEMORY_OBJECT_TYPE,
        }),
      null,
    ),
  });
  return createForegroundDomainProtectedAgentMemoryAccessPort({
    subjectUserId: input.domain.subjectUserId,
    agentId: input.domain.agentId,
    crypto,
    product,
    persist: (publication) => withCurrent(async (current) => {
      const exact = current?.exact ?? input.exact!;
      return persistForegroundAgentMemoryNativeExactAccess({
          handle: exact.handle,
          crypto: input.domain.crypto,
          publication,
          resolveHistoricalAgentSignerAuthority:
            exact.resolveHistoricalAgentSignerAuthority,
          resolveLiveShadowAgentSigner: exact.resolveLiveShadowAgentSigner,
          resolveCurrentAgentSigner: exact.resolveCurrentAgentSigner,
        });
      }, "stale"),
  });
}

const projectionContinuationSchema = z.object({
  prepared: z.object({
    operationId: z.string(), toolCallId: z.string(), requesterActorId: z.string(),
    authority: z.object({ mode: z.literal("namespace"), subjectUserId: z.string(),
      agentId: z.string(), readableNamespaceIds: z.array(z.string()),
      mutableNamespaceIds: z.array(z.string()), writableNamespaceId: z.string().nullable() }).strict(),
    sourceMemoryIds: z.array(z.string()), proposedContent: z.string(),
    targetRoomName: z.string(), roomChoiceToken: z.string().optional(),
  }).strict(),
  state: z.object({
    destination: z.object({ roomId: z.string(), namespaceId: z.string(), label: z.string(),
      kind: z.enum(["private", "group", "multi_agent", "subthread", "open", "task", "access"]),
      memberCount: z.number().int().nonnegative(), audienceFingerprint: z.string() }).strict(),
    sources: z.array(z.object({ memoryId: z.string(), contentRevision: z.number().int().nonnegative(),
      cryptoAccessRevision: z.number().int().nonnegative(), cryptoObjectId: z.string(),
      requiredNamespaceIds: z.array(z.string()), payloadDigest: z.string() }).strict()),
    proposalDigest: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
    effectDigest: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
    publicationAuthority: z.object({ planVersion: z.literal(1),
      kind: z.enum(["current_v1", "additional_authority_v1"]),
      operationId: z.string(), requestDigest: z.string().regex(/^[0-9a-f]{64}$/u),
      semanticAuthorityRequirements: z.array(z.object({ namespaceId: z.string(),
        operations: z.array(z.enum(["decrypt", "encrypt"])) }).strict()),
      authorizationRequestId: z.string().optional(),
      effectDisposition: z.literal("not_started_v1").optional() }).strict().optional(),
    destinationAuthorityDigest: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  }).strict(),
}).strict();
type ProtectedProjectionState = z.infer<typeof projectionContinuationSchema>["state"];
type ProtectedProjectionSource = ProtectedProjectionState["sources"][number];

export type ForegroundMemoryProjectionDestination =
  ProtectedProjectionState["destination"];

/** Callback-scoped current Human owner for a destination already present in
 * the immutable foreground grant. Agent transactions reached through `use`
 * lock Memory rows only while this owner retains the Room authority facts. */
export type ForegroundMemoryCurrentProjectionOwner = <Value>(
  input: Readonly<{
    destination: ForegroundMemoryProjectionDestination;
    targetAuthority: ProtectedMemoryAuthority;
    mutation: boolean;
    use(assertCurrent: () => Promise<void>): Promise<Value>;
  }>,
) => Promise<Value | null>;

export type ForegroundProtectedTaskProjectionSourceOwner = <Value>(
  use: (assertCurrent: () => Promise<void>) => Promise<Value>,
) => Promise<Value | null>;

export type ForegroundProtectedTaskProjectionDestinationPlanner = (
  input: Readonly<{
    destination: ForegroundMemoryProjectionDestination;
    targetAuthority: ProtectedMemoryAuthority;
  }>,
) => Promise<Readonly<{ destinationAuthorityDigest: Uint8Array }> | null>;

type ForegroundMemoryProjectionInput = Readonly<{
  publication: ReturnType<typeof createPostgresForegroundMemoryPublication>;
  envelope: MemoryAccessEnvelope;
  policy: Parameters<typeof createForegroundMemoryPublicationAuthority>[0]["policy"];
  domain: Parameters<typeof createForegroundDomainMemoryCryptoSession>[0];
  wakeEffectRecovery: () => void;
  withCurrentPublication?: NonNullable<AgentMemoryPublicationBoundary["withCurrentPublication"]>;
  withCurrentProjection?: ForegroundMemoryCurrentProjectionOwner;
}>;

export type ForegroundProtectedTaskMemoryProjectionInput =
  ForegroundMemoryProjectionInput & Readonly<{
    task: Readonly<{ taskId: string; taskRunId: string; graphThreadId: string }>;
    originalCapsuleBinding: Readonly<{ policyRevision: number; agentAuthorizationRevision: number }>;
    currentSemanticAuthorityRequirements: ProtectedTaskSemanticAuthorityRequirements;
    continuedAdditionalAuthority?: Readonly<{
      authorizationRequestId: string;
      effectDisposition: "not_started_v1";
      operationId: string;
      requestDigest: Uint8Array;
      requiredAuthorityDigest: Uint8Array;
    }>;
    withCurrentSource: ForegroundProtectedTaskProjectionSourceOwner;
    planDestination: ForegroundProtectedTaskProjectionDestinationPlanner;
    withCurrentProjection: ForegroundMemoryCurrentProjectionOwner;
    onAdditionalAuthority?(
      plan: Extract<ProtectedTaskProjectionAuthorityPlan, { kind: "additional_authority_v1" }>,
      destination: Readonly<{ destinationRoomId: string; namespaceId: string;
        destinationAuthorityDigest: Uint8Array }>,
    ): void | Promise<void>;
  }>;

type ProtectedAssembly = Readonly<{
  input: ForegroundProtectedTaskMemoryProjectionInput;
}>;

/** Fresh authorized assembly. The existing checkpoint retains only encrypted
 * exact preparation; no plaintext proposal or old live custody survives here. */
async function createForegroundMemoryProjectionAssembly(
  input: ForegroundMemoryProjectionInput,
  protectedAssembly?: ProtectedAssembly,
): Promise<Readonly<{ port: ProtectedAgentMemoryProjectionPort;
  openProtected(reference: Parameters<ProtectedAgentMemoryProjectionPort["publish"]>[0]["reference"]):
    Promise<Readonly<{ state: ProtectedProjectionState;
      plan: ProtectedTaskProjectionAuthorityPlan; destinationAuthorityDigest: Uint8Array }> | null>;
  withContinuedReference<Value>(
    reference: Parameters<ProtectedAgentMemoryProjectionPort["publish"]>[0]["reference"],
    use: () => Promise<Value>,
  ): Promise<Value>;
}>> {
  if (
    isScopeMemoryEnvelope(input.envelope) ||
    input.envelope.actorId === null ||
    input.envelope.ownerId !== input.domain.subjectUserId ||
    input.envelope.agentId !== input.domain.agentId
  ) {
    throw new TypeError("Foreground Memory projection identity is unavailable");
  }
  const requesterActorId = input.envelope.actorId;
  type ProjectionReference = Parameters<ProtectedAgentMemoryProjectionPort["publish"]>[0]["reference"];
  const continuedReference = new AsyncLocalStorage<ProjectionReference>();
  const projectionNow = () => {
    const reference = continuedReference.getStore();
    return reference === undefined
      ? Date.now()
      : Math.min(Date.now(), reference.expiresAt - 1);
  };
  const checkpointNamespaceId = input.envelope.writableNamespaces[0];
  if (!checkpointNamespaceId || input.envelope.writableNamespaces.length !== 1) {
    throw new TypeError("Foreground Memory projection Namespace is unavailable");
  }
  const capsule = createForegroundMemoryProjectionCapsule({
    crypto: input.domain.crypto, entities: input.domain.entities,
    namespaceId: checkpointNamespaceId, envelope: input.envelope,
    policyRevision: protectedAssembly?.input.originalCapsuleBinding.policyRevision
      ?? input.policy.revision,
    agentAuthorizationRevision:
      protectedAssembly?.input.originalCapsuleBinding.agentAuthorizationRevision
      ?? input.domain.publication.agentAuthorizationRevision,
  });
  const sourceAuthority = protectedMemoryAuthorityFromEnvelope(input.envelope);
  if (sourceAuthority === null) {
    throw new TypeError(
      "Foreground Memory projection authority is unavailable",
    );
  }
  const readableNamespaceIds = Object.freeze(
    [...input.envelope.readableNamespaces].sort(),
  );
  const context = await createForegroundProductTransactionContext({
    userId: input.envelope.ownerId,
    agentId: input.envelope.agentId,
  });
  const domain = createForegroundDomainMemoryCryptoSession(input.domain);
  const basePublication = createForegroundMemoryPublicationAuthority({
    envelope: input.envelope,
    policy: input.policy,
  });
  const publication = (
    held: NonNullable<
      AgentMemoryPublicationBoundary["withCurrentPublication"]
    > | undefined,
  ): AgentMemoryPublicationBoundary =>
    basePublication.representation === "protected_only"
      ? held === undefined
        ? { ...basePublication, representation: "protected_only" }
        : { representation: "protected_only", withCurrentPublication: held }
      : held === undefined
        ? {
            ...basePublication,
            representation: "ordinary_and_protected",
            readPreparedPayload: domain.readPreparedPayload,
          }
        : {
            representation: "ordinary_and_protected",
            readPreparedPayload: domain.readPreparedPayload,
            withCurrentPublication: held,
          };
  const sourceProduct = new PostgresAgentMemoryProductPort({
    ...context,
    readableNamespaceIds,
    cryptoCompletion: domain.completion,
    publication: publication(input.withCurrentPublication),
  });
  const choices = new Map<
    string,
    Readonly<{
      userId: string;
      query: string;
      roomId: string;
      expiresAt: number;
    }>
  >();
  const openSourcesUnowned = async (
    authority: Parameters<
      ProtectedAgentMemoryProjectionPort["prepare"]
    >[0]["authority"],
    memoryIds: readonly string[],
  ) => {
    const selected = await sourceProduct.loadExactProjectionSources({
      authority,
      memoryIds,
    });
    if (selected.status === "unavailable") return null;
    const opened = await domain.session.openMany({
      entrypointId: input.domain.entrypointId,
      agentId: input.domain.agentId,
      authority,
      candidates: selected.value,
    });
    if (
      opened.status === "unavailable" ||
      opened.value.length !== memoryIds.length
    )
      return null;
    const byId = new Map(opened.value.map((value) => [value.memoryId, value]));
    const sources: ProtectedProjectionSource[] = [];
    for (const candidate of selected.value) {
      const value = byId.get(candidate.memoryId);
      if (
        value === undefined ||
        value.contentRevision !== candidate.contentRevision
      )
        return null;
      sources.push(
        Object.freeze({
          memoryId: candidate.memoryId,
          contentRevision: candidate.contentRevision,
          cryptoAccessRevision: candidate.cryptoAccessRevision,
          cryptoObjectId: candidate.cryptoObjectId,
          requiredNamespaceIds: [
            ...candidate.requiredNamespaceIds,
          ],
          payloadDigest: Buffer.from(commitMemoryMutationV1({
            kind: "save",
            payload: {
              formatVersion: 1,
              type: value.type,
              content: value.content,
            },
          })).toString("hex"),
        }),
      );
    }
    return sources;
  };
  const openSources = async (
    authority: Parameters<ProtectedAgentMemoryProjectionPort["prepare"]>[0]["authority"],
    memoryIds: readonly string[],
  ) => {
    if (protectedAssembly === undefined) return openSourcesUnowned(authority, memoryIds);
    return protectedAssembly.input.withCurrentSource(async assertCurrent => {
      await assertCurrent();
      const opened = await openSourcesUnowned(authority, memoryIds);
      await assertCurrent();
      return opened;
    });
  };
  const targetAuthority = (
    destination: ForegroundMemoryProjectionDestination,
  ): ProtectedMemoryAuthority => Object.freeze({
    mode: "namespace" as const,
    subjectUserId: input.domain.subjectUserId,
    agentId: input.domain.agentId,
    readableNamespaceIds: Object.freeze([destination.namespaceId]),
    mutableNamespaceIds: Object.freeze([destination.namespaceId]),
    writableNamespaceId: destination.namespaceId,
  });
  const sameTargetAuthority = (
    candidate: ProtectedMemoryAuthority,
    expected: ProtectedMemoryAuthority,
  ) => candidate.mode === "namespace" && expected.mode === "namespace"
    && candidate.subjectUserId === expected.subjectUserId
    && candidate.agentId === expected.agentId
    && candidate.writableNamespaceId === expected.writableNamespaceId
    && candidate.readableNamespaceIds.length === 1
    && candidate.readableNamespaceIds[0] === expected.readableNamespaceIds[0]
    && candidate.mutableNamespaceIds.length === 1
    && candidate.mutableNamespaceIds[0] === expected.mutableNamespaceIds[0];
  const withProjection = async <Value>(
    destination: ForegroundMemoryProjectionDestination,
    authority: ProtectedMemoryAuthority,
    mutation: boolean,
    use: (assertCurrent: () => Promise<void>) => Promise<Value>,
  ): Promise<Value | null> => {
    if (input.withCurrentProjection === undefined) return null;
    return input.withCurrentProjection({
      destination,
      targetAuthority: authority,
      mutation,
      use: async assertCurrent => {
        if (!sameTargetAuthority(authority, targetAuthority(destination))) {
          throw new TypeError("Foreground Memory projection target changed");
        }
        await assertCurrent();
        const value = await use(async () => {
          if (!sameTargetAuthority(authority, targetAuthority(destination))) {
            throw new TypeError("Foreground Memory projection target changed");
          }
          await assertCurrent();
        });
        await assertCurrent();
        return value;
      },
    });
  };
  const port = createResumableProtectedAgentMemoryProjectionPort<ProtectedProjectionState>({
    now: projectionNow,
    createReferenceId: randomUUID,
    ttlMs: 10 * 60 * 1_000,
    requesterUserId: input.envelope.ownerId, requesterActorId,
    agentId: input.envelope.agentId,
    async seal({ reference, prepared, state }) {
      if (protectedAssembly === undefined) return capsule.seal(reference, { prepared, state });
      if (state.proposalDigest === undefined || state.effectDigest === undefined) {
        throw new TypeError("Protected foreground projection preparation is incomplete");
      }
      const expectedDestinationDigest = protectedTaskProjectionDestinationAuthorityDigest(
        state.destination,
      );
      const planned = await protectedAssembly.input.planDestination({
        destination: state.destination,
        targetAuthority: targetAuthority(state.destination),
      });
      if (planned === null || planned.destinationAuthorityDigest.length !== 32
        || !planned.destinationAuthorityDigest.every((entry, index) =>
          entry === expectedDestinationDigest[index])) {
        throw new TypeError("Protected foreground projection destination changed");
      }
      const plan = createProtectedTaskProjectionAuthorityPlan({
        ...protectedAssembly.input.task,
        reference,
        operationId: prepared.operationId,
        sources: state.sources,
        destination: state.destination,
        proposalDigest: state.proposalDigest,
        effectDigest: state.effectDigest,
        availableAuthority: protectedAssembly.input.currentSemanticAuthorityRequirements,
      });
      return capsule.seal(reference, { prepared, state: { ...state,
        publicationAuthority: serializeProtectedTaskProjectionAuthorityPlan(plan),
        destinationAuthorityDigest: Buffer.from(expectedDestinationDigest).toString("hex") } });
    },
    async open(reference) {
      const decoded = projectionContinuationSchema.safeParse(await capsule.open(reference));
      if (!decoded.success) return null;
      const { roomChoiceToken, ...prepared } = decoded.data.prepared;
      return { state: decoded.data.state, prepared: { ...prepared,
        ...(roomChoiceToken === undefined ? {} : { roomChoiceToken }) } };
    },
    async validate({ authority, prepared, state: snapshot }) {
      const reopened = await openSources(authority, prepared.sourceMemoryIds);
      if (reopened === null || JSON.stringify(reopened) !== JSON.stringify(snapshot.sources)) {
        return { status: "unavailable", reason: "stale_revision" };
      }
      const preview = { proposedContent: prepared.proposedContent,
        roomLabel: snapshot.destination.label, roomKind: snapshot.destination.kind,
        memberCount: snapshot.destination.memberCount };
      if (protectedAssembly !== undefined) {
        const planned = await protectedAssembly.input.planDestination({
          destination: snapshot.destination,
          targetAuthority: targetAuthority(snapshot.destination),
        });
        const expected = protectedTaskProjectionDestinationAuthorityDigest(snapshot.destination);
        return planned !== null && planned.destinationAuthorityDigest.length === 32
          && planned.destinationAuthorityDigest.every((entry, index) => entry === expected[index])
          ? { status: "success", value: preview }
          : { status: "unavailable", reason: "authorization_required" };
      }
      if (input.withCurrentProjection !== undefined) {
        const current = await withProjection(snapshot.destination,
          targetAuthority(snapshot.destination), false,
          () => Promise.resolve(preview));
        return current === null
          ? { status: "unavailable", reason: "authorization_required" }
          : { status: "success", value: current };
      }
      const stale = await context.canonicalRunner.transaction((transaction) =>
        lockAtomicProjectionDestinationAuthority(transaction, {
          roomId: snapshot.destination.roomId, namespaceId: snapshot.destination.namespaceId,
          roomLabel: snapshot.destination.label, roomKind: snapshot.destination.kind,
          requesterActorId, userId: input.envelope.ownerId,
          audienceFingerprint: snapshot.destination.audienceFingerprint,
        }), { isolationLevel: "serializable" });
      return stale === null
        ? { status: "success", value: preview }
        : { status: "unavailable", reason: "stale_revision" };
    },
    async prepare(request) {
      const sources = await openSources(
        request.authority,
        request.sourceMemoryIds,
      );
      if (sources === null)
        return {
          status: "unavailable" as const,
          reason: "authorization_required" as const,
        };
      const resolution = await resolveAuthorizedRoomName(
        {
          requesterUserId: input.envelope.ownerId,
          requesterActorId,
          targetRoomName: request.targetRoomName,
          ...(request.roomChoiceToken === undefined
            ? {}
            : {
                roomChoiceToken: request.roomChoiceToken,
              }),
        },
        {
          findAuthorizedRoomNameCandidates,
          userHasCapability,
          choiceTokenCodec: {
            issue(value) {
              const token = randomUUID();
              choices.set(token, {
                userId: value.requesterUserId,
                query: value.normalizedQuery,
                roomId: value.roomId,
                expiresAt: Date.now() + 10 * 60 * 1_000,
              });
              const expiry = setTimeout(
                () => choices.delete(token),
                10 * 60 * 1_000,
              );
              expiry.unref?.();
              return token;
            },
            verify(value) {
              const found = choices.get(value.token);
              return found !== undefined &&
                found.expiresAt > Date.now() &&
                found.userId === value.requesterUserId &&
                found.query === value.normalizedQuery &&
                value.candidateRoomIds.includes(found.roomId)
                ? found.roomId
                : null;
            },
          },
        },
      );
      if (resolution.status === "needs_disambiguation")
        return {
          status: "success" as const,
          value: {
            kind: "needs_disambiguation" as const,
            candidates: resolution.candidates.map((candidate) => ({
              choiceToken: candidate.choiceToken,
              label: candidate.label,
              roomKind: candidate.kind,
              memberCount: candidate.memberCount,
            })),
          },
        };
      if (resolution.status !== "resolved")
        return {
          status: "unavailable" as const,
          reason: "authorization_required" as const,
        };
      if (protectedAssembly !== undefined) {
        const planned = await protectedAssembly.input.planDestination({
          destination: resolution.destination,
          targetAuthority: targetAuthority(resolution.destination),
        });
        const expected = protectedTaskProjectionDestinationAuthorityDigest(resolution.destination);
        if (planned === null || planned.destinationAuthorityDigest.length !== 32
          || !planned.destinationAuthorityDigest.every((entry, index) => entry === expected[index])) {
          return { status: "unavailable" as const, reason: "authorization_required" as const };
        }
      } else if (input.withCurrentProjection !== undefined) {
        const current = await withProjection(
          resolution.destination,
          targetAuthority(resolution.destination),
          false,
          () => Promise.resolve(true),
        );
        if (current === null) return {
          status: "unavailable" as const,
          reason: "authorization_required" as const,
        };
      }
      return {
        status: "success" as const,
        value: {
          kind: "prepared" as const,
          state: { destination: resolution.destination, sources,
            ...(protectedAssembly === undefined ? {} : {
              proposalDigest: Buffer.from(new Uint8Array(createHash("sha256")
                .update(JSON.stringify([
                  "nautilo/protected-task-memory-projection-request/v1",
                  "proposal", request.proposedContent,
                ])).digest())).toString("hex"),
              effectDigest: Buffer.from(commitMemoryMutationV1({ kind: "save",
                payload: { formatVersion: 1, type: "fact",
                  content: request.proposedContent } })).toString("hex"),
            }) },
          preview: {
          proposedContent: request.proposedContent,
          roomLabel: resolution.destination.label,
          roomKind: resolution.destination.kind,
          memberCount: resolution.destination.memberCount,
          },
        },
      };
    },
    async publish({ authority, prepared, state: snapshot, reference }) {
      const reopened = await openSources(authority, prepared.sourceMemoryIds);
      if (
        reopened === null ||
        reopened.length !== snapshot.sources.length ||
        reopened.some((value, index) => {
          const prior = snapshot.sources[index]!;
          return (
            value.memoryId !== prior.memoryId ||
            value.contentRevision !== prior.contentRevision ||
            value.cryptoAccessRevision !== prior.cryptoAccessRevision ||
            value.cryptoObjectId !== prior.cryptoObjectId ||
            value.payloadDigest !== prior.payloadDigest
          );
        })
      )
        return {
          status: "unavailable" as const,
          reason: "stale_revision" as const,
        };
      const projectionAuthority = targetAuthority(snapshot.destination);
      if (input.withCurrentProjection !== undefined) {
        const current = await withProjection(snapshot.destination,
          projectionAuthority, false, () => Promise.resolve(true));
        if (current === null) return {
          status: "unavailable" as const,
          reason: "authorization_required" as const,
        };
      }
      const lockProjectionSources = async (
        transaction: CanonicalTranscriptTx,
      ) => {
        const rows = await transaction
          .select({
            id: memories.id,
            contentRevision: memories.contentRevision,
            cryptoAccessRevision: memories.cryptoAccessRevision,
            cryptoObjectId: memories.cryptoObjectId,
          })
          .from(memories)
          .where(inArray(memories.id, [...prepared.sourceMemoryIds]))
          .orderBy(memories.id)
          .for("share", { of: memories });
        if (
          rows.length !== snapshot.sources.length ||
          rows.some(
            (row, index) =>
              row.id !== snapshot.sources[index]!.memoryId ||
              row.contentRevision !==
                snapshot.sources[index]!.contentRevision ||
              row.cryptoAccessRevision !==
                snapshot.sources[index]!.cryptoAccessRevision ||
              row.cryptoObjectId !== snapshot.sources[index]!.cryptoObjectId,
          )
        ) {
          throw new Error("Projection source changed");
        }
        const edges = await transaction
          .select({
            memoryId: memoryNamespaces.memoryId,
            namespaceId: memoryNamespaces.namespaceId,
          })
          .from(memoryNamespaces)
          .where(
            inArray(memoryNamespaces.memoryId, [...prepared.sourceMemoryIds]),
          )
          .orderBy(memoryNamespaces.memoryId, memoryNamespaces.namespaceId)
          .for("share", { of: memoryNamespaces });
        if (
          snapshot.sources.some(
            (source) =>
              !edges.some(
                (edge) =>
                  edge.memoryId === source.memoryId &&
                  readableNamespaceIds.includes(edge.namespaceId),
              ),
          )
        ) {
          throw new Error("Projection source authority changed");
        }
      };
      const projectionBeforeLocks: Parameters<
        typeof deliverCommittedForegroundMemoryEffect
      >[0]["beforeLocks"] = async ({ transaction }) => {
        await basePublication.beforeLocks({
          transaction,
          authority: sourceAuthority,
          mutation: false,
        });
        const stale = await lockAtomicProjectionDestinationAuthority(
          transaction,
          {
            roomId: snapshot.destination.roomId,
            namespaceId: snapshot.destination.namespaceId,
            roomLabel: snapshot.destination.label,
            roomKind: snapshot.destination.kind,
            requesterActorId,
            userId: input.envelope.ownerId,
            audienceFingerprint: snapshot.destination.audienceFingerprint,
          },
        );
        if (stale !== null) throw new Error(`Projection ${stale}`);
        await lockProjectionSources(transaction);
      };
      const beforePublication: typeof projectionBeforeLocks = async (request) => {
        if (projectionNow() >= reference.expiresAt) throw new Error("Projection approval expired");
        await projectionBeforeLocks(request);
        if (projectionNow() >= reference.expiresAt) throw new Error("Projection approval expired");
      };
      const heldPublication: NonNullable<
        AgentMemoryPublicationBoundary["withCurrentPublication"]
      > | undefined = input.withCurrentProjection === undefined
        ? undefined
        : async request => {
            if (!sameTargetAuthority(request.authority, projectionAuthority)) {
              throw new TypeError("Foreground Memory projection target changed");
            }
            let completed: Awaited<ReturnType<typeof request.use>> | null = null;
            try {
              const current = await withProjection(snapshot.destination,
                projectionAuthority, request.mutation, async assertCurrent => {
                  if (projectionNow() >= reference.expiresAt) {
                    throw new Error("Projection approval expired");
                  }
                  const receipt = await request.use(async () => {
                    await assertCurrent();
                    if (projectionNow() >= reference.expiresAt) {
                      throw new Error("Projection approval expired");
                    }
                  });
                  completed = receipt;
                  return receipt;
                });
              if (current !== null) return current;
              if (request.mutation && completed !== null) return completed;
              throw new TypeError(
                "Foreground Memory projection authority is unavailable",
              );
            } catch (error) {
              if (request.mutation && completed !== null) return completed;
              throw error;
            }
          };
      const lockedConnection: ConversationProductCanonicalTransactionConnection =
        Object.freeze({
          transaction: <Result>(
            use: (
              transaction: CanonicalTranscriptTx,
              executor: ConversationProductPostgresExecutor,
            ) => Promise<Result>,
            options: Parameters<
              ConversationProductCanonicalTransactionConnection["transaction"]
            >[1],
          ): Promise<Result> => context.canonicalRunner.transaction(
            async (transaction, executor) => {
              await lockProjectionSources(transaction);
              return use(transaction, executor);
            },
            options,
          ),
        });
      const productContext = input.withCurrentProjection === undefined
        ? context
        : {
            ...context,
            canonicalRunner: bindConversationProductCanonicalTransactionRunner(
              context.handle,
              lockedConnection,
            ),
          };
      let publicationDomain = domain;
      const targetProduct = new PostgresAgentMemoryProductPort({
        ...productContext,
        readableNamespaceIds: [snapshot.destination.namespaceId],
        cryptoCompletion: { complete: revision => publicationDomain.completion.complete(revision) },
        publication: heldPublication === undefined
          ? basePublication.representation === "protected_only"
            ? { representation: "protected_only", beforeLocks: beforePublication }
            : { representation: "ordinary_and_protected",
                readPreparedPayload: revision => publicationDomain.readPreparedPayload(revision),
                beforeLocks: beforePublication }
          : basePublication.representation === "protected_only"
            ? { representation: "protected_only", withCurrentPublication: heldPublication }
            : { representation: "ordinary_and_protected", withCurrentPublication: heldPublication,
                readPreparedPayload: revision => publicationDomain.readPreparedPayload(revision) },
      });
      const commitment = commitMemoryMutationV1({
        kind: "save",
        payload: {
          formatVersion: 1,
          type: "fact",
          content: prepared.proposedContent,
        },
      });
      const deliverEffect = async (memoryId: string) => {
        try {
          const deliver = (beforeLocks: Parameters<
            typeof deliverCommittedForegroundMemoryEffect
          >[0]["beforeLocks"]) => deliverCommittedForegroundMemoryEffect({
            canonicalRunner: context.canonicalRunner,
            beforeLocks,
            authority: projectionAuthority,
            operationId: prepared.operationId,
            memoryId,
          });
          const effect = input.withCurrentProjection === undefined
            ? await deliver(projectionBeforeLocks)
            : await withProjection(snapshot.destination, projectionAuthority,
                false, assertCurrent => deliver(async () => assertCurrent()));
          if (effect === null || effect === "pending") input.wakeEffectRecovery();
        } catch { input.wakeEffectRecovery(); }
      };
      // The committed product receipt already binds this exact proposal. Replay
      // it before acquiring new ciphertext or invoking an embedding provider.
      const replay = await targetProduct.replayCompleted({
        operationId: prepared.operationId,
        authority: projectionAuthority,
        mutationKind: "save",
        importance: 0.8,
        mutationCommitment: commitment,
      });
      if (replay.status === "unavailable") return replay;
      if (replay.value !== null) {
        await deliverEffect(replay.value.memoryId);
        return { status: "success" as const, value: {
          status: "replayed" as const,
          memoryId: replay.value.memoryId,
          roomLabel: snapshot.destination.label,
        } };
      }
      const embedding = await embedTextWithProvenance(
        prepared.proposedContent,
        input.domain.entities.signal,
      );
      if (embedding.dimensions !== MEMORY_EMBEDDING_DIMENSIONS)
        return {
          status: "unavailable" as const,
          reason: "embedding_unavailable" as const,
        };
      const provenance = {
        vector: embedding.vector,
        provider: embedding.provider,
        canonicalModel: embedding.canonicalModel,
        dimensions: MEMORY_EMBEDDING_DIMENSIONS,
        contractVersion: embedding.contractVersion,
      } as const;
      const plan = await targetProduct.planProjectionCreate({
        operationId: prepared.operationId,
        authority: projectionAuthority,
        embedding: provenance,
        importance: 0.8,
        mutationCommitment: commitment,
      });
      if (plan.status === "unavailable") return plan;
      const reservation = await targetProduct.inspectFreshProjectionReservation({
        authority: projectionAuthority, plan: plan.value,
        payload: { formatVersion: 1, type: "fact", content: prepared.proposedContent },
      });
      if (reservation === null) return authorityUnavailable();
      publicationDomain = createForegroundDomainMemoryCryptoSession({
        ...input.domain, freshPublication: input.publication.forReservation(reservation),
      });
      const prepareEncrypted = () => publicationDomain.session.prepare({
          entrypointId: input.domain.entrypointId,
          agentId: input.domain.agentId,
          authority: projectionAuthority,
          plan: plan.value,
          content: {
            kind: "complete" as const,
            payload: {
              formatVersion: 1 as const,
              type: "fact",
              content: prepared.proposedContent,
            },
          },
        });
      const encrypted = input.withCurrentProjection === undefined
        ? await prepareEncrypted()
        : await withProjection(snapshot.destination, projectionAuthority,
            true, prepareEncrypted);
      if (encrypted === null) return {
        status: "unavailable" as const,
        reason: "authorization_required" as const,
      };
      if (encrypted.status === "unavailable") return encrypted;
      const sourceNamespaceIds = [
        ...new Set(
          snapshot.sources.flatMap((source) => source.requiredNamespaceIds),
        ),
      ].sort();
      const sourceLease = await input.domain.entities.useCurrentSet({
        operations: ["decrypt"],
        namespaceIds: sourceNamespaceIds,
        execute: () =>
          publicationDomain.session.authorizeCommit({
            entrypointId: input.domain.entrypointId,
            agentId: input.domain.agentId,
            authority: projectionAuthority,
            target: plan.value,
            operation: "publish",
            commit: () =>
              targetProduct.publishPrepared({
                authority: projectionAuthority,
                plan: plan.value,
                prepared: encrypted.value,
                embedding: provenance,
              }),
          }),
      });
      if (sourceLease.status !== "executed")
        return {
          status: "unavailable" as const,
          reason: "authorization_required" as const,
        };
      const committed = sourceLease.value;
      if (
        committed.status === "unavailable" ||
        committed.value === "stale" ||
        committed.value === "deleted"
      )
        return {
          status: "unavailable" as const,
          reason: "stale_revision" as const,
        };
      const result = {
        status: "success" as const,
        value: {
          status:
            committed.value === "replayed"
              ? ("replayed" as const)
              : ("created" as const),
          memoryId: plan.value.memoryId,
          roomLabel: snapshot.destination.label,
        },
      };
      await deliverEffect(plan.value.memoryId);
      return result;
    },
  });
  const openProtected = async (
    reference: Parameters<ProtectedAgentMemoryProjectionPort["publish"]>[0]["reference"],
  ) => {
    const decoded = projectionContinuationSchema.safeParse(await capsule.open(reference));
    const state = decoded.success ? decoded.data.state : null;
    if (state === null || state.publicationAuthority === undefined
      || state.destinationAuthorityDigest === undefined) return null;
    let plan: ProtectedTaskProjectionAuthorityPlan;
    try {
      plan = deserializeProtectedTaskProjectionAuthorityPlan(
        state.publicationAuthority as SerializedProtectedTaskProjectionAuthorityPlan,
      );
    } catch { return null; }
    return Object.freeze({ state, plan,
      destinationAuthorityDigest: new Uint8Array(Buffer.from(
        state.destinationAuthorityDigest, "hex")) });
  };
  return Object.freeze({ port, openProtected,
    withContinuedReference: <Value>(reference: ProjectionReference,
      use: () => Promise<Value>) => continuedReference.run(reference, use),
  });
}

export async function createForegroundMemoryProjectionPort(
  input: ForegroundMemoryProjectionInput,
): Promise<ProtectedAgentMemoryProjectionPort> {
  return (await createForegroundMemoryProjectionAssembly(input)).port;
}

/** Protected wake adapter. Its sealed foreground capsule fixes the original
 * authority decision; a later grant may satisfy it but cannot turn an
 * additional-authority preparation into a current-authority publication. */
export async function createForegroundProtectedTaskMemoryProjection(
  input: ForegroundProtectedTaskMemoryProjectionInput,
): Promise<ProtectedTaskMemoryProjectionHandoff> {
  const assembly = await createForegroundMemoryProjectionAssembly(input, { input });
  const sameBytes = (left: Uint8Array, right: Uint8Array) =>
    left.length === right.length
    && left.every((entry, index) => entry === right[index]);
  const continuedPlan = (plan: ProtectedTaskProjectionAuthorityPlan) => {
    const continuation = input.continuedAdditionalAuthority;
    if (continuation === undefined || plan.kind !== "additional_authority_v1"
      || continuation.effectDisposition !== "not_started_v1"
      || plan.authorizationRequestId !== continuation.authorizationRequestId
      || plan.operationId !== continuation.operationId
      || !sameBytes(plan.requestDigest, continuation.requestDigest)) return false;
    const required = protectedTaskSemanticAuthorityRequirementsDigest(
      plan.semanticAuthorityRequirements,
    );
    try { return sameBytes(required, continuation.requiredAuthorityDigest); }
    finally { required.fill(0); }
  };
  const recover = async (
    authority: ProtectedMemoryAuthority,
    reference: Parameters<ProtectedAgentMemoryProjectionPort["publish"]>[0]["reference"],
  ) => {
    const opened = await assembly.openProtected(reference);
    if (opened === null || opened.state.proposalDigest === undefined
      || opened.state.effectDigest === undefined) return null;
    const continued = input.continuedAdditionalAuthority !== undefined;
    if (continued && !continuedPlan(opened.plan)) return null;
    const restore = () => assembly.port.restore!({ authority, reference });
    const restored = continued
      ? await assembly.withContinuedReference(reference, restore)
      : await restore();
    if (restored.status === "unavailable") return null;
    const rederived = createProtectedTaskProjectionAuthorityPlan({
      ...input.task, reference,
      operationId: opened.plan.operationId,
      sources: opened.state.sources,
      destination: opened.state.destination,
      proposalDigest: opened.state.proposalDigest,
      effectDigest: opened.state.effectDigest,
      // Re-derivation must preserve the sealed kind. Supplying its own exact
      // requirements here prevents a fresh wider grant from rewriting it.
      availableAuthority: opened.plan.kind === "current_v1"
        ? opened.plan.semanticAuthorityRequirements : Object.freeze([]),
    });
    if (!sameProtectedTaskProjectionAuthorityPlan(opened.plan, rederived)) return null;
    const expectedDigest = protectedTaskProjectionDestinationAuthorityDigest(opened.state.destination);
    const planned = await input.planDestination({ destination: opened.state.destination,
      targetAuthority: Object.freeze({ mode: "namespace" as const,
        subjectUserId: input.domain.subjectUserId, agentId: input.domain.agentId,
        readableNamespaceIds: Object.freeze([opened.state.destination.namespaceId]),
        mutableNamespaceIds: Object.freeze([opened.state.destination.namespaceId]),
        writableNamespaceId: opened.state.destination.namespaceId }) });
    if (planned === null || expectedDigest.length !== opened.destinationAuthorityDigest.length
      || !expectedDigest.every((entry, index) => entry === opened.destinationAuthorityDigest[index])
      || !expectedDigest.every((entry, index) => entry === planned.destinationAuthorityDigest[index])) return null;
    return Object.freeze({ ...opened, destinationAuthorityDigest: expectedDigest,
      restored, continued });
  };
  return Object.freeze({
    prepare: request => assembly.port.prepare(request),
    async restore({ authority, reference }) {
      const opened = await recover(authority, reference);
      return opened?.restored ?? authorityUnavailable();
    },
    async planPublication({ authority, reference }) {
      const opened = await recover(authority, reference);
      if (opened === null) return authorityUnavailable();
      if (opened.plan.kind === "additional_authority_v1") {
        await input.onAdditionalAuthority?.(Object.freeze({ ...opened.plan,
          requestDigest: Uint8Array.from(opened.plan.requestDigest),
          semanticAuthorityRequirements: opened.plan.semanticAuthorityRequirements }),
        Object.freeze({ destinationRoomId: opened.state.destination.roomId,
          namespaceId: opened.state.destination.namespaceId,
          destinationAuthorityDigest: Uint8Array.from(opened.destinationAuthorityDigest) }));
      }
      return Object.freeze({ status: "success" as const, value: opened.plan });
    },
    async publishAuthorized({ authority, reference, authorization }) {
      const opened = await recover(authority, reference);
      if (opened === null || authorization.kind !== opened.plan.kind
        || !sameProtectedTaskProjectionAuthorityPlan(authorization.plan, opened.plan)
        || !semanticAuthorityCovers(input.currentSemanticAuthorityRequirements,
          opened.plan.semanticAuthorityRequirements)) return authorityUnavailable();
      if (authorization.kind === "additional_authority_v1") {
        if (opened.plan.kind !== "additional_authority_v1") return authorityUnavailable();
        const requiredAuthorityDigest = protectedTaskSemanticAuthorityRequirementsDigest(
          opened.plan.semanticAuthorityRequirements,
        );
        try {
          assertProtectedTaskAdditionalAuthorityResumeAcknowledgementV1(
            authorization.acknowledgement, {
              authorizationRequestId: opened.plan.authorizationRequestId,
              effectDisposition: "not_started_v1", operationId: opened.plan.operationId,
              requestDigest: opened.plan.requestDigest, requiredAuthorityDigest,
            },
          );
        } catch { return authorityUnavailable(); }
        finally { requiredAuthorityDigest.fill(0); }
      }
      const publish = () => assembly.port.publish({ authority, reference });
      return opened.continued
        ? assembly.withContinuedReference(reference, publish)
        : publish();
    },
  });
}

/** Production Memory writer using the current turn's Domain grant and product identity. */
export async function createForegroundMemoryRepository(
  input: Readonly<{
    envelope: MemoryAccessEnvelope;
    policy: Parameters<
      typeof createForegroundMemoryPublicationAuthority
    >[0]["policy"];
    domain: Parameters<typeof createForegroundDomainMemoryCryptoSession>[0];
    wakeEffectRecovery: () => void;
    resolvePolicy(): Promise<
      Readonly<{
        mode: "plaintext_only" | "shadow_encryption" | "encrypted_only";
        shadowBehavior: "fallback" | "strict";
        revision: number;
      }>
    >;
    /** A trusted current owner wraps each genuine Agent product transaction. */
    withCurrentPublication?: NonNullable<
      Extract<AgentMemoryPublicationBoundary, {
        withCurrentPublication: unknown;
      }>["withCurrentPublication"]
    >;
    embedding?: ProtectedAgentMemoryEmbeddingPort;
  }>,
): Promise<ProtectedAgentMemoryRepository> {
  if (
    isScopeMemoryEnvelope(input.envelope) ||
    input.envelope.ownerId !== input.domain.subjectUserId ||
    input.envelope.agentId !== input.domain.agentId ||
    input.domain.entrypointId !== "foreground.main"
  ) {
    throw new TypeError(
      "Foreground Memory requires this Room's current Human and Agent authority",
    );
  }
  const publication = createForegroundMemoryPublicationAuthority(input);
  const representation = selectLiveEncryptionRepresentationPolicy(input.policy);
  const authority = await createForegroundProductTransactionContext({
    userId: input.envelope.ownerId,
    agentId: input.envelope.agentId,
  });
  const domain = createForegroundDomainMemoryCryptoSession(input.domain);
  const readableNamespaceIds = [...input.envelope.readableNamespaces].sort();
  const productAuthority = input.withCurrentPublication === undefined
    ? publication
    : Object.freeze({
        representation: publication.representation,
        withCurrentPublication: input.withCurrentPublication,
      });
  const product = new PostgresAgentMemoryProductPort({
    ...authority,
    readableNamespaceIds,
    cryptoCompletion: domain.completion,
    publication:
      productAuthority.representation === "protected_only"
        ? { ...productAuthority, representation: "protected_only" }
        : {
            ...productAuthority,
            representation: "ordinary_and_protected",
            readPreparedPayload: domain.readPreparedPayload,
          },
  });
  const repository = createInvocationBoundProtectedAgentMemoryRepository({
    owner: bindEncryptionDataOperationOwner({
      policy: {
        resolve: async () => {
          const current = await input.resolvePolicy();
          return { policy: current, revalidationToken: current.revision };
        },
        revalidate: async (revision) => {
          const current = await input.resolvePolicy();
          if (current.revision !== revision) {
            throw new MemoryMutationAuthorityError("memory_unavailable");
          }
        },
      },
    }),
    subjectUserId: input.domain.subjectUserId,
    agentId: input.domain.agentId,
    entrypointId: input.domain.entrypointId,
    signal: input.domain.entities.signal,
    product,
    loadExactOrdinary: async ({
      authority: memoryAuthority,
      candidates,
      signal,
    }) => {
      signal?.throwIfAborted();
      if (memoryAuthority.mode !== "namespace") return {
        status: "unavailable" as const,
        reason: "authorization_required" as const,
      };
      try {
        return await authority.canonicalRunner.transaction(
          async (transaction) => {
            await publication.beforeLocks({
              transaction,
              authority: memoryAuthority,
              mutation: false,
            });
            const ids = candidates.map((candidate) => candidate.memoryId);
            const [rows, edges] = await Promise.all([
              transaction
                .select({
                  id: memories.id,
                  type: memories.type,
                  content: memories.content,
                  importance: memories.importance,
                  tier: memories.tier,
                  createdAt: memories.createdAt,
                  contentRevision: memories.contentRevision,
                  cryptoAccessRevision: memories.cryptoAccessRevision,
                  cryptoObjectId: memories.cryptoObjectId,
                })
                .from(memories)
                .where(inArray(memories.id, ids))
                .for("share", { of: memories }),
              transaction
                .select({
                  memoryId: memoryNamespaces.memoryId,
                  namespaceId: memoryNamespaces.namespaceId,
                })
                .from(memoryNamespaces)
                .where(inArray(memoryNamespaces.memoryId, ids))
                .for("share", { of: memoryNamespaces }),
            ]);
            const byId = new Map(rows.map((row) => [row.id, row]));
            const opened = candidates.map((candidate) => {
              const row = byId.get(candidate.memoryId);
              if (
                row === undefined ||
                row.contentRevision !== candidate.contentRevision ||
                row.cryptoAccessRevision !== candidate.cryptoAccessRevision ||
                row.cryptoObjectId !== candidate.cryptoObjectId ||
                typeof row.type !== "string" ||
                typeof row.content !== "string" ||
                !edges.some(
                  (edge) =>
                    edge.memoryId === candidate.memoryId &&
                    memoryAuthority.readableNamespaceIds.includes(
                      edge.namespaceId,
                    ),
                )
              ) {
                throw new MemoryMutationAuthorityError("source_changed");
              }
              return Object.freeze({
                memoryId: row.id,
                contentRevision: row.contentRevision,
                type: row.type,
                content: row.content,
              });
            });
            signal?.throwIfAborted();
            return Object.freeze({
              status: "success" as const,
              value: Object.freeze(opened),
            });
          },
          { isolationLevel: "serializable" },
        );
      } catch (error) {
        if (error instanceof MemoryMutationAuthorityError) {
          return {
            status: "unavailable" as const,
            reason:
              error.reason === "source_changed"
                ? ("stale_revision" as const)
                : ("authorization_required" as const),
          };
        }
        throw error;
      }
    },
    crypto: domain.session,
    repairExactCandidate: async ({ operationId, selection, signal }) => {
      // A structural dedup candidate does not grant permission to load its
      // ordinary body. Full must stop before assembling the repair reader.
      if (!representation.allowForwardRepair) {
        return {
          status: "unavailable" as const,
          reason: "encryption_pending" as const,
        };
      }
      const repairer = createForegroundMemoryHistoryRepairer({
        crypto: input.domain.crypto,
        entities: input.domain.entities,
        sourceRepresentationMode: "ordinary-and-protected",
        publication: {
          operationId,
          ...input.domain.publication,
        },
        loadSources: (memories, representationMode) =>
          loadPostgresForegroundMemoryRepairSources({
            product: authority.handle,
            crypto: input.domain.crypto,
            memories,
            ...(representationMode === undefined ? {} : { representationMode }),
          }),
        persist: input.domain.persist,
        read: input.domain.read,
        validateExisting: (request) =>
          validatePostgresForegroundMemoryRepairSource({
            product: authority.handle,
            ...request,
          }),
        attach: (request) =>
          attachPostgresForegroundMemoryRepair({
            product: authority.handle,
            ...request,
          }),
      });
      const repaired = await repairer.protect({
        memories: [selection.repair],
        ...(signal === undefined ? {} : { signal }),
      });
      return repaired.status === "verified" &&
        repaired.memories.length === 1 &&
        repaired.memories[0]?.id === selection.memoryId
        ? { status: "success" as const, value: undefined }
        : {
            status: "unavailable" as const,
            reason:
              repaired.status === "waiting_for_authority"
                ? ("authorization_required" as const)
                : ("integrity_failure" as const),
          };
    },
    fallbackOrdinary: async ({
      authority: memoryAuthority,
      plan,
      embedding,
      content,
      reason,
    }) => {
      if (
        !publication.allowOrdinaryFallback ||
        memoryAuthority.mode !== "namespace"
      ) {
        return { status: "unavailable" as const, reason };
      }
      if (
        embedding.provider !== "openai" &&
        embedding.provider !== "openrouter" &&
        embedding.provider !== "venice"
      ) {
        return { status: "unavailable" as const, reason };
      }
      const embeddingProvider = embedding.provider;
      try {
        const value = await authority.canonicalRunner.transaction(
          async (transaction) => {
            await publication.beforeLocks({
              transaction,
              authority: memoryAuthority,
              mutation: true,
            });
            return commitForegroundMemoryOrdinaryFallback(transaction, {
              operationId: plan.operationId,
              agentId: input.domain.agentId,
              memoryId: plan.memoryId,
              expectedContentRevision: plan.contentRevision - 1,
              resultContentRevision: plan.contentRevision,
              expectedAccessRevision: plan.expectedPriorAccessRevision,
              expectedCryptoObjectId:
                plan.contentRevision === 1
                  ? null
                  : deriveMemoryCryptoObjectIdV1({
                      memoryId: plan.memoryId,
                      contentRevision: plan.contentRevision - 1,
                    }),
              expectedRequiredNamespaceFingerprint:
                plan.contentRevision === 1
                  ? null
                  : fingerprintRequiredMemoryNamespaces(
                      plan.requiredNamespaceIds,
                    ),
              reservationDigest: plan.reservationDigest,
              reservedCryptoObjectId: plan.cryptoObjectId,
              action: content.kind === "complete" ? "save" : "replace",
              ...(content.kind === "complete"
                ? {
                    type: content.payload.type,
                    content: content.payload.content,
                    ...(plan.action === "created"
                      ? { namespaceId: plan.requiredNamespaceIds[0] }
                      : {}),
                    expectedDedupId:
                      plan.action === "updated" ? plan.memoryId : null,
                  }
                : { content: content.content }),
              importance: plan.importance,
              embedding: embedding.vector,
              embeddingProvider,
              embeddingModel: embedding.canonicalModel,
              embeddingDimensions: embedding.dimensions,
              embeddingContractVersion: embedding.contractVersion,
              reason,
            });
          },
          { isolationLevel: "serializable" },
        );
        return { status: "success" as const, value, fallbackReason: reason };
      } catch (error) {
        if (error instanceof MemoryMutationAuthorityError) {
          return {
            status: "unavailable" as const,
            reason:
              error.reason === "source_changed"
                ? ("stale_revision" as const)
                : ("authorization_required" as const),
          };
        }
        // Storage, cancellation and programming failures are not key sync.
        throw error;
      }
    },
    embedding: input.embedding ?? {
      embed: async ({ plaintext, signal }) => {
        signal?.throwIfAborted();
        try {
          const embedded = await embedTextWithProvenance(plaintext, signal);
          signal?.throwIfAborted();
          if (embedded.dimensions !== MEMORY_EMBEDDING_DIMENSIONS) {
            return {
              status: "unavailable" as const,
              reason: "embedding_unavailable" as const,
            };
          }
          return {
            status: "success" as const,
            value: { ...embedded, dimensions: MEMORY_EMBEDDING_DIMENSIONS },
          };
        } catch (error) {
          signal?.throwIfAborted();
          if (error instanceof EmbeddingProviderError) {
            return {
              status: "unavailable" as const,
              reason: "embedding_unavailable" as const,
            };
          }
          throw error;
        }
      },
    },
  });
  return withForegroundMemoryEffectReceipts({
    repository,
    wakeRecovery: input.wakeEffectRecovery,
    deliver: ({ authority: memoryAuthority, operationId, memoryId }) =>
      deliverCommittedForegroundMemoryEffect({
        canonicalRunner: authority.canonicalRunner,
        beforeLocks: publication.beforeLocks,
        authority: memoryAuthority,
        operationId,
        memoryId,
      }),
  });
}
