import {
  commitForegroundMemoryOrdinaryFallback,
  createResumableProtectedAgentMemoryProjectionPort,
  embedTextWithProvenance,
  EmbeddingProviderError,
  lockAtomicProjectionDestinationAuthority,
  MemoryMutationAuthorityError,
  protectedMemoryAuthorityFromEnvelope,
} from "@nautilo/agent";
import { inArray, memories, memoryNamespaces } from "@nautilo/db";
import { randomUUID } from "node:crypto";
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
} from "@nautilo/lattice-bridge";
import {
  attachPostgresForegroundMemoryRepair,
  loadPostgresForegroundMemoryRepairSources,
  PostgresAgentMemoryProductPort,
  PostgresAgentMemoryExactAccessProduct,
  persistForegroundAgentMemoryNativeExactAccess,
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
  type MemoryAccessEnvelope,
} from "@nautilo/trust";
import type {
  ProtectedAgentMemoryAccessPort,
  ProtectedAgentMemoryProjectionPort,
} from "@nautilo/agent";
import { createForegroundProductTransactionContext } from "./foreground-message-product-store";
import { createForegroundMemoryPublicationAuthority } from "./foreground-memory-publication-authority";
import {
  deliverCommittedForegroundMemoryEffect,
  withForegroundMemoryEffectReceipts,
} from "./foreground-memory-effect-receipts";

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
    exact: Readonly<{
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
  }>,
): Promise<ProtectedAgentMemoryAccessPort> {
  if (
    isScopeMemoryEnvelope(input.envelope) ||
    input.envelope.ownerId !== input.domain.subjectUserId ||
    input.envelope.agentId !== input.domain.agentId
  ) {
    throw new TypeError("Foreground Memory access identity is unavailable");
  }
  const authority = await createForegroundProductTransactionContext({
    userId: input.envelope.ownerId,
    agentId: input.envelope.agentId,
  });
  const readableNamespaceIds = [...input.envelope.readableNamespaces].sort();
  const product = new PostgresAgentMemoryExactAccessProduct({
    handle: authority.handle,
    readableNamespaceIds,
    resolveGrantUserNamespace: input.resolveGrantUserNamespace,
  });
  const crypto = createForegroundDomainMemoryExactAccess({
    crypto: input.domain.crypto,
    entities: input.domain.entities,
    runtime: input.domain.publication.runtime,
    signerKeyId: input.domain.publication.signerKeyId,
    agentAuthorizationRevision:
      input.domain.publication.agentAuthorizationRevision,
    read: async (request) => {
      const value = await input.domain.read({
        ...request,
        expectedObjectType: MEMORY_OBJECT_TYPE,
      });
      return value;
    },
  });
  return createForegroundDomainProtectedAgentMemoryAccessPort({
    subjectUserId: input.domain.subjectUserId,
    agentId: input.domain.agentId,
    crypto,
    product,
    persist: (publication) =>
      persistForegroundAgentMemoryNativeExactAccess({
        handle: input.exact.handle,
        crypto: input.domain.crypto,
        publication,
        resolveHistoricalAgentSignerAuthority:
          input.exact.resolveHistoricalAgentSignerAuthority,
        resolveLiveShadowAgentSigner: input.exact.resolveLiveShadowAgentSigner,
        resolveCurrentAgentSigner: input.exact.resolveCurrentAgentSigner,
      }),
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
  }).strict(),
}).strict();
type ProtectedProjectionState = z.infer<typeof projectionContinuationSchema>["state"];
type ProtectedProjectionSource = ProtectedProjectionState["sources"][number];

/** Fresh authorized assembly. The existing checkpoint retains only encrypted
 * exact preparation; no plaintext proposal or old live custody survives here. */
export async function createForegroundMemoryProjectionPort(
  input: Readonly<{
    envelope: MemoryAccessEnvelope;
    policy: Parameters<
      typeof createForegroundMemoryPublicationAuthority
    >[0]["policy"];
    domain: Parameters<typeof createForegroundDomainMemoryCryptoSession>[0];
    wakeEffectRecovery: () => void;
  }>,
): Promise<ProtectedAgentMemoryProjectionPort> {
  if (
    isScopeMemoryEnvelope(input.envelope) ||
    input.envelope.actorId === null ||
    input.envelope.ownerId !== input.domain.subjectUserId ||
    input.envelope.agentId !== input.domain.agentId
  ) {
    throw new TypeError("Foreground Memory projection identity is unavailable");
  }
  const requesterActorId = input.envelope.actorId;
  const checkpointNamespaceId = input.envelope.writableNamespaces[0];
  if (!checkpointNamespaceId || input.envelope.writableNamespaces.length !== 1) {
    throw new TypeError("Foreground Memory projection Namespace is unavailable");
  }
  const capsule = createForegroundMemoryProjectionCapsule({
    crypto: input.domain.crypto, entities: input.domain.entities,
    namespaceId: checkpointNamespaceId, envelope: input.envelope,
    policyRevision: input.policy.revision,
    agentAuthorizationRevision: input.domain.publication.agentAuthorizationRevision,
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
  const sourceProduct = new PostgresAgentMemoryProductPort({
    ...context,
    readableNamespaceIds,
    cryptoCompletion: domain.completion,
    publication:
      basePublication.representation === "protected_only"
        ? { ...basePublication, representation: "protected_only" }
        : {
            ...basePublication,
            representation: "ordinary_and_protected",
            readPreparedPayload: domain.readPreparedPayload,
          },
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
  const openSources = async (
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
  return createResumableProtectedAgentMemoryProjectionPort<ProtectedProjectionState>({
    now: Date.now,
    createReferenceId: randomUUID,
    ttlMs: 10 * 60 * 1_000,
    requesterUserId: input.envelope.ownerId, requesterActorId,
    agentId: input.envelope.agentId,
    seal: ({ reference, prepared, state }) => capsule.seal(reference, { prepared, state }),
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
      const stale = await context.canonicalRunner.transaction((transaction) =>
        lockAtomicProjectionDestinationAuthority(transaction, {
          roomId: snapshot.destination.roomId, namespaceId: snapshot.destination.namespaceId,
          roomLabel: snapshot.destination.label, roomKind: snapshot.destination.kind,
          requesterActorId, userId: input.envelope.ownerId,
          audienceFingerprint: snapshot.destination.audienceFingerprint,
        }), { isolationLevel: "serializable" });
      if (stale !== null) return { status: "unavailable", reason: "stale_revision" };
      return { status: "success", value: { proposedContent: prepared.proposedContent,
        roomLabel: snapshot.destination.label, roomKind: snapshot.destination.kind,
        memberCount: snapshot.destination.memberCount } };
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
      return {
        status: "success" as const,
        value: {
          kind: "prepared" as const,
          state: { destination: resolution.destination, sources },
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
      const embedding = await embedTextWithProvenance(
        prepared.proposedContent,
        input.domain.entities.signal,
      );
      if (embedding.dimensions !== MEMORY_EMBEDDING_DIMENSIONS)
        return {
          status: "unavailable" as const,
          reason: "embedding_unavailable" as const,
        };
      const targetAuthority = Object.freeze({
        mode: "namespace" as const,
        subjectUserId: input.domain.subjectUserId,
        agentId: input.domain.agentId,
        readableNamespaceIds: Object.freeze([snapshot.destination.namespaceId]),
        mutableNamespaceIds: Object.freeze([snapshot.destination.namespaceId]),
        writableNamespaceId: snapshot.destination.namespaceId,
      });
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
      const beforePublication: typeof projectionBeforeLocks = async (request) => {
        if (Date.now() >= reference.expiresAt) throw new Error("Projection approval expired");
        await projectionBeforeLocks(request);
        if (Date.now() >= reference.expiresAt) throw new Error("Projection approval expired");
      };
      const targetProduct = new PostgresAgentMemoryProductPort({
        ...context,
        readableNamespaceIds: [snapshot.destination.namespaceId],
        cryptoCompletion: domain.completion,
        publication:
          basePublication.representation === "protected_only"
            ? {
                representation: "protected_only",
                beforeLocks: beforePublication,
              }
            : {
                representation: "ordinary_and_protected",
                readPreparedPayload: domain.readPreparedPayload,
                beforeLocks: beforePublication,
              },
      });
      const provenance = {
        vector: embedding.vector,
        provider: embedding.provider,
        canonicalModel: embedding.canonicalModel,
        dimensions: MEMORY_EMBEDDING_DIMENSIONS,
        contractVersion: embedding.contractVersion,
      } as const;
      const commitment = commitMemoryMutationV1({
        kind: "save",
        payload: {
          formatVersion: 1,
          type: "fact",
          content: prepared.proposedContent,
        },
      });
      const plan = await targetProduct.planProjectionCreate({
        operationId: prepared.operationId,
        authority: targetAuthority,
        embedding: provenance,
        importance: 0.8,
        mutationCommitment: commitment,
      });
      if (plan.status === "unavailable") return plan;
      const encrypted = await domain.session.prepare({
        entrypointId: input.domain.entrypointId,
        agentId: input.domain.agentId,
        authority: targetAuthority,
        plan: plan.value,
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
      const sourceNamespaceIds = [
        ...new Set(
          snapshot.sources.flatMap((source) => source.requiredNamespaceIds),
        ),
      ].sort();
      const sourceLease = await input.domain.entities.useCurrentSet({
        operations: ["decrypt"],
        namespaceIds: sourceNamespaceIds,
        execute: () =>
          domain.session.authorizeCommit({
            entrypointId: input.domain.entrypointId,
            agentId: input.domain.agentId,
            authority: targetAuthority,
            target: plan.value,
            operation: "publish",
            commit: () =>
              targetProduct.publishPrepared({
                authority: targetAuthority,
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
      try {
        const effect = await deliverCommittedForegroundMemoryEffect({
          canonicalRunner: context.canonicalRunner,
          beforeLocks: projectionBeforeLocks,
          authority: targetAuthority,
          operationId: prepared.operationId,
          memoryId: plan.value.memoryId,
        });
        if (effect === "pending") input.wakeEffectRecovery();
      } catch {
        input.wakeEffectRecovery();
      }
      return result;
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
  }>,
) {
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
  const product = new PostgresAgentMemoryProductPort({
    ...authority,
    readableNamespaceIds,
    cryptoCompletion: domain.completion,
    publication:
      publication.representation === "protected_only"
        ? { ...publication, representation: "protected_only" }
        : {
            ...publication,
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
    embedding: {
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
