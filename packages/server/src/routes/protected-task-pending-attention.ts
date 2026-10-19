import { resolveProtectedTaskCheckpointAadBinding } from "./protected-task-checkpoint-aad-binding";
import {
  createDedicatedEncryptedCheckpointPool,
  protectedTaskApprovalAllowedVerbs,
} from "@nautilo/agent";
import {
  createPostgresJsBridgeConnection,
  getEncryptionTransitionPolicy, type DirectDatabase, type PostgresJsBridgeConnection,
  sealProtectedTaskHumanApprovalPolicy,
  type ProtectedTaskPendingAttentionCandidate,
} from "@nautilo/db";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import type { EncryptionDataOperationOwner } from "@nautilo/lattice-bridge";
import {
  createHumanTaskCheckpointCellReader,
  inspectDomainKeyV2CryptoAuthority,
  LIVE_SHADOW_FOREGROUND_AUTHORIZATION_TTL_MS,
  PostgresDomainKeyAuthorityRepository, PostgresNamespaceProductAuthority,
  verifyCryptoPostgresHandle,
  type LiveShadowRecipientRegistry,
} from "@nautilo/lattice-bridge/server";
import { PostgresBackgroundAuthorizationRepository, patchTaskApprovalEvent, readProtectedPendingInterruptEvents } from "@nautilo/runtime";
import { envelopeReadableNamespaces, getPolicyResolver } from "@nautilo/trust";
import type { ServerEvent } from "@nautilo/types";
import {
  createCheckpointReadAuthority, type CheckpointReadBinding,
  type CheckpointReadSnapshot,
} from "./foreground-checkpoint-read-authority";
import { createProtectedTaskPendingAttentionMetadata } from "./protected-task-pending-attention-metadata";
import { createProtectedTaskRequesterPrivateRoomResolver } from "./protected-task-requester-private-room";

type AttentionEvent = Extract<ServerEvent, {
  type: "approval.ask" | "prove_it.challenge" | "identity.challenge";
}>;
type Locator = Readonly<{
  candidate: ProtectedTaskPendingAttentionCandidate;
  checkpointThreadId: string;
  topLevelRoomId: string;
  namespaceId: string;
}>;
type Checkpoint = Parameters<typeof readProtectedPendingInterruptEvents>[0]["checkpoint"];
type Metadata = ReturnType<typeof createProtectedTaskPendingAttentionMetadata>;

/** Project only the recipient's exact sealed interrupts, never arbitrary graph events. */
export function protectedTaskAttentionEvents(
  events: readonly ServerEvent[], candidate: ProtectedTaskPendingAttentionCandidate,
  userId: string,
): readonly AttentionEvent[] {
  const taskId = candidate.occurrence.task.id;
  const threadId = candidate.occurrence.run.graphThreadId;
  const selected = events.filter((event): event is AttentionEvent =>
    (event.type === "approval.ask" || event.type === "prove_it.challenge"
      || event.type === "identity.challenge")
    && event.threadId === threadId
    && event.laneKey === `task:${taskId}`).map(event => event.type !== "approval.ask"
      ? event
      : Object.freeze({ ...event, allowedVerbs: protectedTaskApprovalAllowedVerbs({
          ...event,
          type: "approval_ask",
        }) }));
  const coordinates = candidate.pendingAttentionInterrupts;
  if (selected.length !== coordinates.length
    || !coordinates.every(coordinate => selected.filter(event => {
      if (coordinate.kind === "approval") return event.type === "approval.ask"
        && event.approvalId === coordinate.requestId
        && (coordinate.allowedVerbs === undefined
          || event.allowedVerbs.length === coordinate.allowedVerbs.length
            && event.allowedVerbs.every((verb, index) =>
              verb === coordinate.allowedVerbs![index]));
      if (coordinate.kind === "prove_it") return event.type === "prove_it.challenge"
        && event.challengeId === coordinate.id;
      return event.type === "identity.challenge"
        && (coordinate.requestId === undefined || event.challengeId === coordinate.requestId);
    }).length === 1)) {
    throw new TypeError("Task attention no longer matches its sealed interrupts");
  }
  return Object.freeze(selected.map(event => {
    const patched = patchTaskApprovalEvent(event, { taskId,
      taskRunId: candidate.occurrence.run.id, ownerId: candidate.occurrence.task.ownerId,
      approvalRecipientId: userId, hasRoom: candidate.occurrence.task.targetRoomId !== null });
    if (patched.type !== "approval.ask" && patched.type !== "prove_it.challenge"
      && patched.type !== "identity.challenge") throw new TypeError("Task attention event changed type");
    return Object.freeze(patched);
  }));
}

export function protectedTaskLegacyApprovalPolicies(
  events: readonly AttentionEvent[],
  candidate: ProtectedTaskPendingAttentionCandidate,
) {
  return Object.freeze(candidate.pendingAttentionInterrupts.flatMap(interrupt => {
    if (interrupt.kind !== "approval" || interrupt.requestId === undefined
      || interrupt.allowedVerbs !== undefined) return [];
    const event = events.find(
      (value): value is Extract<AttentionEvent, { type: "approval.ask" }> =>
        value.type === "approval.ask" && value.approvalId === interrupt.requestId,
    );
    if (event === undefined) {
      throw new TypeError("Task approval policy no longer matches its sealed interrupt");
    }
    const allowedVerbs = protectedTaskApprovalAllowedVerbs({
      ...event,
      type: "approval_ask",
    });
    return [Object.freeze({ interruptId: interrupt.id,
      requestId: interrupt.requestId,
      allowedVerbs: Object.freeze(allowedVerbs) })];
  }));
}

/** One page admits one checkpoint read; continuation is explicit and never truncated. */
export function createProtectedTaskPendingAttention(input: Readonly<{
  db: DirectDatabase;
  restricted: PostgresJsBridgeConnection;
  serverScope: string;
  owner: EncryptionDataOperationOwner;
  recipients: LiveShadowRecipientRegistry;
}>, overrides: Partial<Readonly<{
  metadata: Metadata;
  resolveSourceRoom: ReturnType<typeof createProtectedTaskRequesterPrivateRoomResolver>;
  readPolicy: typeof getEncryptionTransitionPolicy;
  inspect(binding: CheckpointReadBinding, locator: Locator): Promise<CheckpointReadSnapshot | null>;
  readEvents: typeof readProtectedPendingInterruptEvents;
  sealPolicy: typeof sealProtectedTaskHumanApprovalPolicy;
  now(): number;
}>> = {}) {
  const crypto = new LatticeCrypto();
  const now = overrides.now ?? Date.now;
  const metadata = overrides.metadata ?? createProtectedTaskPendingAttentionMetadata({
    db: input.db, createDedicatedPool: createDedicatedEncryptedCheckpointPool,
  });
  const resolveSourceRoom = overrides.resolveSourceRoom
    ?? createProtectedTaskRequesterPrivateRoomResolver(input.db);
  const { restricted, serverScope } = input;
  const readPolicy = overrides.readPolicy ?? getEncryptionTransitionPolicy;
  const readEvents = overrides.readEvents ?? readProtectedPendingInterruptEvents;
  const sealPolicy = overrides.sealPolicy ?? sealProtectedTaskHumanApprovalPolicy;
  const viewer = (binding: CheckpointReadBinding) => ({ userId: binding.userId, humanActorId: binding.humanActorId });

  const locate = async (candidate: ProtectedTaskPendingAttentionCandidate): Promise<Locator | null> => {
    const task = candidate.occurrence.task;
    // Runtime checkpoint custody uses the Task content Namespace, including Wide
    // Tasks; Memory bring-back has its own independent write Namespace.
    const source = await resolveSourceRoom(task.requestorId, task.agentId, task.contentNamespaceId);
    if (source === null || source.namespaceId !== task.contentNamespaceId) return null;
    return Object.freeze({ candidate, checkpointThreadId: candidate.occurrence.run.graphThreadId,
      namespaceId: task.contentNamespaceId, topLevelRoomId: source.roomId });
  };

  const inspect = overrides.inspect ?? (async (binding: CheckpointReadBinding, locator: Locator) => {
    const productAuthority = new PostgresNamespaceProductAuthority(createPostgresJsBridgeConnection(input.db));
    const repository = new PostgresDomainKeyAuthorityRepository(restricted, crypto, serverScope);
    const task = locator.candidate.occurrence.task;
    const policy = await readPolicy(input.db);
    const inspected = await inspectDomainKeyV2CryptoAuthority({
      productAuthority, repository, exactNamespaceOnly: true,
      planInput: { authority: viewer(binding), clientDeviceId: binding.clientDeviceId },
      product: { roomId: locator.topLevelRoomId, namespaceId: locator.namespaceId, agentId: task.agentId },
      topLevelRoomId: locator.topLevelRoomId,
      resolveReadableNamespaces: async coordinates => {
        const resolver = getPolicyResolver();
        if (resolver === null) throw new Error("Task attention policy unavailable");
        const envelope = await resolver.buildEnvelope(coordinates.humanActorId,
          `task:${task.id}`, coordinates.agentId, coordinates.roomId);
        if (envelope.ownerId !== binding.userId || envelope.actorId !== binding.humanActorId) {
          throw new Error("Task attention viewer changed");
        }
        return envelopeReadableNamespaces(envelope);
      },
    });
    if (inspected.status !== "ready") return null;
    const authority = inspected.authority;
    let transferred = false;
    try {
      const signingKey = await repository.inspectForegroundDeviceSigningAuthority({
        userId: binding.userId, subjectHumanId: binding.humanActorId, deviceId: binding.clientDeviceId,
        generation: authority.committerDeviceSigningKeyGeneration, revision: authority.hostAuthorizationRevision,
      });
      if (signingKey === null) return null;
      transferred = true;
      return { policyRevision: policy.revision, namespaceAuthority: authority.room,
        domains: authority.domains, committerDeviceId: authority.committerDeviceId,
        committerDeviceSigningKeyGeneration: authority.committerDeviceSigningKeyGeneration,
        hostAuthorizationRevision: authority.hostAuthorizationRevision,
        committerDeviceSigningPublicKey: signingKey };
    } finally {
      if (!transferred) {
        for (const value of Object.values(authority.room)) if (value instanceof Uint8Array) value.fill(0);
        for (const domain of authority.domains) {
          domain.participantDigest.fill(0); domain.headDigest.fill(0); domain.activeNamespaceBindingSetDigest.fill(0);
        }
      }
    }
  });
  const resolveCurrent = (binding: CheckpointReadBinding, locator: Locator) => {
    const current = async () => {
      const candidate = await metadata.readCurrent({ viewer: viewer(binding),
        taskId: locator.candidate.occurrence.task.id, taskRunId: locator.candidate.occurrence.run.id,
        expected: locator.candidate });
      if (candidate === null) return null;
      const located = await locate(candidate);
      if (located === null || located.topLevelRoomId !== locator.topLevelRoomId
        || located.namespaceId !== locator.namespaceId
        || located.checkpointThreadId !== locator.checkpointThreadId) return null;
      return inspect(binding, located);
    };
    return input.owner.selectReadMetadata({ ordinary: () => Promise.resolve(null),
      fallback: current, protected: current });
  };
  const reads = createCheckpointReadAuthority<Locator, Checkpoint>({
    crypto, recipients: input.recipients, now, resolveCurrent,
    withCheckpoint: async (context, use) => {
      const { candidate } = context.locator;
      const namespace = context.snapshot.namespaceAuthority;
      const checkpointAadBinding = await resolveProtectedTaskCheckpointAadBinding(candidate,
        { get: async requestId => new PostgresBackgroundAuthorizationRepository(
          await verifyCryptoPostgresHandle(restricted)).get(requestId) });
      if (checkpointAadBinding === null) throw new TypeError("Task checkpoint retained ciphertext binding is unavailable");
      const cell = createHumanTaskCheckpointCellReader({
        checkpointAadBinding,
        crypto, owner: input.owner, restricted, serverScope,
        domains: context.domains, signal: context.signal,
        deadlineAt: context.deadlineAt, now, assertCurrentTaskAuthority: context.assertCurrentAuthority,
        identity: { taskId: candidate.occurrence.task.id, taskRunId: candidate.occurrence.run.id,
          sourceRoomId: context.locator.topLevelRoomId, graphThreadId: context.locator.checkpointThreadId,
          namespaceId: context.locator.namespaceId, domainId: namespace.domainId,
          expectedAccessRevision: namespace.namespaceAccessRevision,
          expectedPolicyRevision: context.snapshot.policyRevision },
      });
      if (cell.scope.authorizationSession === null
        || typeof cell.scope.authorizationSession !== "object") {
        throw new TypeError("Task checkpoint read session is invalid");
      }
      return use({ crypto: cell.crypto, namespaceId: cell.scope.namespaceId,
        namespaceAccessRevision: cell.scope.expectedAccessRevision,
        agentAuthorizationRevision: cell.scope.expectedPolicyRevision,
        authorizationSession: cell.scope.authorizationSession });
    },
  });
  return Object.freeze({
    async page(binding: CheckpointReadBinding, cursor?: string) {
      const page = async () => {
        const found = await metadata.list({ viewer: viewer(binding), limit: 1,
          ...(cursor === undefined ? {} : { cursor }) });
        const candidate = found.candidates[0];
        if (candidate === undefined) return { status: "ready" as const, nextCursor: found.nextCursor };
        const locator = await locate(candidate);
        if (locator === null) return { status: "unavailable" as const, nextCursor: found.nextCursor };
        const challenge = await reads.plan({ binding, locator,
          deadlineAt: now() + LIVE_SHADOW_FOREGROUND_AUTHORIZATION_TTL_MS });
        if (challenge.status !== "authorization_required") {
          return { status: "unavailable" as const, nextCursor: found.nextCursor };
        }
        try {
          return { status: "ready" as const, nextCursor: found.nextCursor, challenge: {
            challengeId: challenge.challengeId, taskId: candidate.occurrence.task.id,
            taskRunId: candidate.occurrence.run.id, roomId: locator.topLevelRoomId,
            authorizationPlanBytesBase64url: Buffer.from(challenge.authorizationPlanBytes).toString("base64url"),
            recipientPublicKeyBase64url: Buffer.from(challenge.recipientPublicKey).toString("base64url"),
            deadlineAt: challenge.deadlineAt,
          } };
        } finally { challenge.authorizationPlanBytes.fill(0); challenge.recipientPublicKey.fill(0); }
      };
      return input.owner.selectReadMetadata<Awaited<ReturnType<typeof page>>>({ ordinary: () => Promise.resolve({ status: "unavailable" as const, nextCursor: null }),
        fallback: page, protected: page });
    },
    async read(binding: CheckpointReadBinding, taskId: string, taskRunId: string,
      challengeId: string, authorizationBytes: Uint8Array) {
      const result = await reads.read({ binding, challengeId, authorizationBytes,
        execute: async (checkpoint, locator) => {
          const candidate = locator.candidate;
          if (candidate.occurrence.task.id !== taskId || candidate.occurrence.run.id !== taskRunId) {
            throw new Error("Task attention read identity changed");
          }
          const events = await readEvents({ checkpoint, logicalThreadId: locator.checkpointThreadId,
            laneKey: `task:${taskId}` });
          return Object.freeze({ candidate,
            events: protectedTaskAttentionEvents(events, candidate, binding.userId) });
        },
      });
      if (result.status !== "read") {
        return { status: "unavailable" as const, events: [] as readonly AttentionEvent[] };
      }
      const legacyApprovals = result.value.candidate.pendingAttentionInterrupts.filter(
        (interrupt): interrupt is typeof interrupt & Readonly<{
          kind: "approval"; requestId: string;
        }> => interrupt.kind === "approval"
          && interrupt.requestId !== undefined
          && interrupt.allowedVerbs === undefined,
      );
      if (legacyApprovals.length > 0) {
        const current = await metadata.readCurrent({ viewer: viewer(binding), taskId,
          taskRunId, expected: result.value.candidate });
        if (current === null) {
          return { status: "unavailable" as const, events: [] as readonly AttentionEvent[] };
        }
        const policies = protectedTaskLegacyApprovalPolicies(
          result.value.events,
          result.value.candidate,
        );
        const sealed = await input.owner.runMutation({
          protected: () => sealPolicy(input.db, { viewer: viewer(binding),
            candidate: current, policies }),
          dual: () => sealPolicy(input.db, { viewer: viewer(binding),
            candidate: current, policies }),
        });
        if (sealed.status === "rejected") {
          return { status: "unavailable" as const, events: [] as readonly AttentionEvent[] };
        }
      }
      return { status: "read" as const, events: result.value.events };
    },
    cancelForDevice: reads.cancelForDevice,
    cancelForClientSession: reads.cancelForClientSession,
    cancelForHuman: reads.cancelForHuman,
    close: reads.close,
  });
}
