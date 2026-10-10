import {
  createPostgresJsBridgeConnection,
  getEncryptionTransitionPolicy,
  getSharedDirectCryptoDb,
  type DirectDatabase,
  type PostgresJsBridgeConnection,
} from "@nautilo/db";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  copyTaskScopeMemoryBinding,
  inspectInitialTaskRuntimeNamespaceAuthority,
  type InitialTaskRuntimeNamespaceAuthority,
  type TaskScopeMemoryBinding,
} from "@nautilo/lattice-bridge/server";
import type {
  ProtectedTaskOccurrence,
  ProtectedTaskPredispatchPlan,
} from "@nautilo/runtime";
import {
  findActorByOwnerId,
} from "@nautilo/trust";

import { getServerDirectDb } from "../lib/server-direct-db";
import { createHumanProductTransactionContext } from
  "./human-message-product-store";
import {
  createProtectedTaskRequesterPrivateRoomResolver,
  type ProtectedTaskRequesterPrivateRoomResolver,
} from "./protected-task-requester-private-room";
import type {
  ProtectedTaskRuntimeMemoryPolicy,
} from "./protected-task-runtime-grant-plan";

type ResolverInput = Readonly<{
  occurrence: ProtectedTaskOccurrence;
  predispatch: ProtectedTaskPredispatchPlan;
  namespaceIds: readonly string[];
  scopeMemory?: TaskScopeMemoryBinding;
}>;

type ProductContext = Awaited<ReturnType<
  typeof createHumanProductTransactionContext
>>;

export type ProtectedTaskRuntimeNamespaceAuthorityResolution = Readonly<
  InitialTaskRuntimeNamespaceAuthority & {
    policy: ProtectedTaskRuntimeMemoryPolicy;
  }
>;

export type ProtectedTaskRuntimeNamespaceAuthorityResolverDependencies =
  Readonly<{
    crypto: LatticeCrypto;
    serverScope: string;
    db: DirectDatabase;
    restricted(): PostgresJsBridgeConnection;
    readPolicy(): Promise<Readonly<{
      mode: "plaintext_only" | "shadow_encryption" | "encrypted_only";
      shadowBehavior: "fallback" | "strict";
      revision: number;
    }>>;
    resolveRequesterHuman(userId: string): Promise<Readonly<{
      id: string;
    }> | null>;
    resolveRequesterPrivateRoom: ProtectedTaskRequesterPrivateRoomResolver;
    createProductContext(
      userId: string,
      database: DirectDatabase,
    ): Promise<ProductContext>;
    inspectAuthority: typeof inspectInitialTaskRuntimeNamespaceAuthority;
  }>;

function sameOccurrence(
  left: ProtectedTaskOccurrence,
  right: ProtectedTaskOccurrence,
): boolean {
  return left.task.id === right.task.id
    && left.task.requestorId === right.task.requestorId
    && left.task.agentId === right.task.agentId
    && left.task.contentNamespaceId === right.task.contentNamespaceId
    && left.task.contentRepresentation === right.task.contentRepresentation
    && left.run.id === right.run.id
    && left.run.taskId === right.run.taskId;
}

function executionModeMatchesDefinition(
  representation: ProtectedTaskOccurrence["task"]["contentRepresentation"],
  mode: "plaintext_only" | "shadow_encryption" | "encrypted_only",
): boolean {
  // The current result terminal CAS requires the Task definition and result
  // to share a representation. A retained dual definition cannot execute
  // after a switch to Full until the Task itself has been migrated.
  return representation === "dual"
    ? mode === "shadow_encryption"
    : mode === "encrypted_only";
}

/**
 * Dark production adapter for the initial protected Task Runtime grant.
 * Discovery reads only scalar identities; the lattice-bridge owner then locks
 * and revalidates the Task, requester-private Room, readable Namespace set,
 * policy fence and crypto authority before any fact leaves the transaction.
 */
export function createProtectedTaskRuntimeNamespaceAuthorityResolver(
  overrides: Partial<ProtectedTaskRuntimeNamespaceAuthorityResolverDependencies>
    = {},
): (
  input: ResolverInput,
) => Promise<ProtectedTaskRuntimeNamespaceAuthorityResolution> {
  const db = overrides.db ?? getServerDirectDb();
  const crypto = overrides.crypto ?? new LatticeCrypto();
  const serverScope = overrides.serverScope
    ?? (process.env["NAUTILO_PUBLIC_BASE_URL"]?.trim()
      || "http://localhost:3001");
  const restricted = overrides.restricted
    ?? (() => createPostgresJsBridgeConnection(getSharedDirectCryptoDb()));
  const readPolicy = overrides.readPolicy
    ?? (() => getEncryptionTransitionPolicy(db));
  const resolveRequesterHuman = overrides.resolveRequesterHuman
    ?? findActorByOwnerId;
  const resolveRequesterPrivateRoom = overrides.resolveRequesterPrivateRoom
    ?? createProtectedTaskRequesterPrivateRoomResolver(db);
  const createProductContext = overrides.createProductContext
    ?? createHumanProductTransactionContext;
  const inspectAuthority = overrides.inspectAuthority
    ?? inspectInitialTaskRuntimeNamespaceAuthority;

  return async (input) => {
    const { occurrence, predispatch } = input;
    const targetRoomId = predispatch.target.roomId;
    const namespaceIds = Object.freeze([...input.namespaceIds]);
    const scopeMemory = input.scopeMemory === undefined
      ? undefined
      : copyTaskScopeMemoryBinding(input.scopeMemory);
    if (!sameOccurrence(occurrence, predispatch.occurrence)
      || namespaceIds.length < 1
      || !namespaceIds.includes(occurrence.task.contentNamespaceId)
      || namespaceIds.some((id, index) => index > 0
        && namespaceIds[index - 1]! >= id)) {
      throw new TypeError(
        "Protected Task Runtime Namespace authority coordinates are invalid",
      );
    }

    const requesterUserId = occurrence.task.requestorId;
    const [requesterHuman, sourceRoom, policy] = await Promise.all([
      resolveRequesterHuman(requesterUserId),
      resolveRequesterPrivateRoom(
        requesterUserId,
        occurrence.task.agentId,
        occurrence.task.contentNamespaceId,
      ),
      readPolicy(),
    ]);
    if (requesterHuman === null
      || sourceRoom === null
      || sourceRoom.namespaceId !== occurrence.task.contentNamespaceId
      || policy.mode === "plaintext_only"
      || !executionModeMatchesDefinition(
        occurrence.task.contentRepresentation,
        policy.mode,
      )) {
      throw new Error(
        "Protected Task Runtime Namespace authority is unavailable",
      );
    }

    const product = await createProductContext(requesterUserId, db);
    const authority = await inspectAuthority({
      runner: product.canonicalRunner,
      restricted: restricted(),
      crypto,
      serverScope,
      taskId: occurrence.task.id,
      requesterUserId,
      requesterHumanId: requesterHuman.id,
      agentId: occurrence.task.agentId,
      contentNamespaceId: occurrence.task.contentNamespaceId,
      sourceRoomId: sourceRoom.roomId,
      targetRoomId,
      namespaceIds,
      ...(scopeMemory === undefined ? {} : { scopeMemory }),
      expectedPolicyRevision: policy.revision,
    });
    if (authority === null
      || authority.sourceRoomId !== sourceRoom.roomId
      || authority.sourceNamespaceId !== occurrence.task.contentNamespaceId
      || authority.facts.length !== namespaceIds.length
      || authority.facts.some((fact, index) =>
        fact.namespaceId !== namespaceIds[index]
        || fact.expectedPolicyRevision !== policy.revision)) {
      throw new Error(
        "Protected Task Runtime Namespace authority changed",
      );
    }
    return Object.freeze({
      sourceRoomId: authority.sourceRoomId,
      sourceNamespaceId: authority.sourceNamespaceId,
      facts: authority.facts,
      policy: Object.freeze({
        mode: policy.mode,
        shadowBehavior: policy.shadowBehavior,
        revision: policy.revision,
      }),
    });
  };
}
