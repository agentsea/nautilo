import { and, eq } from "drizzle-orm";

import {
  actors,
  rooms,
  roomMembers,
  taskRuns,
  tasks,
  type PostgresJsBridgeConnection,
  type Task,
  type TaskRun,
} from "@nautilo/db";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  encodeTaskRuntimeBackgroundAuthorizationRequestV1,
  type TaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import type {
  DomainForegroundAuthorizationPublicCurrentAuthorityV2,
} from "@nautilo/lattice-crypto/wire";
import {
  cryptoTypedDb,
  executeTypedCryptoQuery,
  withCurrentAcceptedTaskRuntimeAuthority,
  type AcceptedTaskRuntimeAuthorizationV3,
  type ConversationProductCanonicalTransactionRunner,
  type CurrentTaskRuntimeAuthority,
  type TaskRuntimeAuthoritySubject,
} from "@nautilo/lattice-bridge/server";
import {
  isCurrentProtectedTaskRunForGrant,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
  type ProtectedTaskOccurrence,
} from "@nautilo/runtime";

type CurrentTask = Pick<Task,
  | "id" | "ownerId" | "requestorId" | "agentId" | "callingRoomId"
  | "status" | "scheduleKind" | "contentRepresentation" | "contentNamespaceId"
  | "contentRevision" | "cryptoObjectId" | "cryptoAccessRevision"
  | "cryptoRequiredNamespaceFingerprint" | "cryptoMappingState"
>;

type CurrentRun = Pick<TaskRun,
  | "id" | "taskId" | "jobId" | "graphThreadId" | "status"
  | "resultRepresentation" | "resultContentNamespaceId" | "resultRevision"
  | "resultCryptoObjectId" | "resultCryptoAccessRevision"
  | "resultCryptoRequiredNamespaceFingerprint" | "resultCryptoMappingState"
>;

export type CurrentProtectedTaskRuntimeFacts = Readonly<{
  task: CurrentTask;
  run: CurrentRun;
  requesterPrivateRoom: Readonly<{roomId: string; namespaceId: string}> | null;
}>;

type LoadCurrentFacts = (input: Readonly<{
  product: PostgresJsBridgeConnection;
  occurrence: ProtectedTaskOccurrence;
}>) => Promise<CurrentProtectedTaskRuntimeFacts | null>;

type WithAcceptedAuthority = typeof withCurrentAcceptedTaskRuntimeAuthority;

export type HeldProtectedTaskRuntimeAuthority = Readonly<{
  foreground: DomainForegroundAuthorizationPublicCurrentAuthorityV2;
  namespaceRequirements: CurrentTaskRuntimeAuthority["namespaceRequirements"];
}>;

export type CurrentProtectedTaskRuntimeAuthorityPort = <Value>(input: Readonly<{
  runner: ConversationProductCanonicalTransactionRunner;
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  serverScope: string;
  subject: TaskRuntimeAuthoritySubject;
  occurrence: ProtectedTaskOccurrence;
  record: BackgroundAuthorizationTaskRuntimeRecordV3;
  request: TaskRuntimeBackgroundAuthorizationRequestV1;
  now(): number;
  signal?: AbortSignal;
  use(current: HeldProtectedTaskRuntimeAuthority): Value | Promise<Value>;
}>) => Promise<Value | null>;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function acceptedTaskRuntimeRecord(
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
): AcceptedTaskRuntimeAuthorizationV3 | null {
  const snapshot = record.snapshot;
  const response = snapshot.acceptedResponse;
  const recipient = snapshot.recipient;
  const material = record.acceptedMaterial;
  if (record.descriptorBytes === null
    || snapshot.descriptorDigest === null
    || response === null
    || response.kind !== "runtime"
    || recipient === null
    || material === null) return null;
  return Object.freeze({
    descriptorBytes: Uint8Array.from(record.descriptorBytes),
    descriptorDigest: snapshot.descriptorDigest,
    requestId: snapshot.requestId,
    workId: snapshot.workId,
    workKind: record.workKind as TaskRuntimeBackgroundAuthorizationRequestV1["workKind"],
    workPurpose: record.purpose as TaskRuntimeBackgroundAuthorizationRequestV1["workPurpose"],
    recipientGeneration: snapshot.recipientGeneration,
    recipientKeyId: recipient.recipientKeyId,
    recipientPublicKeyBase64url: recipient.recipientPublicKey,
    expectedPolicyRevision: record.expectedPolicyRevision,
    namespaceRequirements: record.authoritySet.namespaceRequirements,
    domainRequirements: record.authoritySet.domainRequirements,
    authorizationId: material.credentialId,
    authorizationBytes: Uint8Array.from(material.responseBytes),
    authorizationDigest: response.responseDigest,
    authorizationExpiresAt: material.authorizationExpiresAt,
    issuingHumanId: response.issuingHumanId,
    issuingDeviceId: response.issuingDeviceId,
    issuingDeviceAuthorizationRevision:
      material.issuingDeviceAuthorizationRevision,
    issuerSigningPublicKeyHash:
      Uint8Array.from(material.issuerSigningPublicKeyHash),
  });
}

export function destroyAcceptedTaskRuntimeRecord(
  accepted: AcceptedTaskRuntimeAuthorizationV3,
): void {
  accepted.descriptorBytes.fill(0);
  accepted.authorizationBytes.fill(0);
  accepted.issuerSigningPublicKeyHash.fill(0);
}

function copyHeldAuthority(
  authority: CurrentTaskRuntimeAuthority,
): HeldProtectedTaskRuntimeAuthority {
  const plan = authority.plan;
  return Object.freeze({
    foreground: Object.freeze({
      authorizationId: plan.authorizationId,
      policyRevision: authority.policyRevision,
      sessionId: plan.sessionId,
      roomId: plan.roomId,
      subjectHumanId: plan.subjectHumanId,
      committerDeviceId: plan.committerDeviceId,
      committerDeviceSigningGeneration:
        plan.committerDeviceSigningGeneration,
      committerDeviceSigningPublicKey:
        Uint8Array.from(authority.device.signingPublicKey),
      committerDeviceActive: true,
      hostAuthorizationRevision: plan.hostAuthorizationRevision,
      recipientKind: plan.recipientKind,
      recipientPrincipalId: plan.recipientPrincipalId,
      recipientAuthorizationRevision: plan.recipientAuthorizationRevision,
      recipientRuntimeGeneration: plan.recipientRuntimeGeneration,
      recipientKeyId: plan.recipientKeyId,
      recipientAuthorized: true,
      domains: Object.freeze(authority.domains.map((domain) => Object.freeze({
        ...domain,
        participantDigest: Uint8Array.from(domain.participantDigest),
        headDigest: Uint8Array.from(domain.headDigest),
        activeNamespaceBindingSetDigest:
          Uint8Array.from(domain.activeNamespaceBindingSetDigest),
      }))),
    }),
    namespaceRequirements: Object.freeze(
      authority.namespaceRequirements.map((requirement) => Object.freeze({
        ...requirement,
        operations: Object.freeze([...requirement.operations]),
      })),
    ),
  });
}

function destroyHeldAuthority(authority: HeldProtectedTaskRuntimeAuthority): void {
  authority.foreground.committerDeviceSigningPublicKey.fill(0);
  for (const domain of authority.foreground.domains) {
    domain.participantDigest.fill(0);
    domain.headDigest.fill(0);
    domain.activeNamespaceBindingSetDigest.fill(0);
  }
}

export async function loadCurrentProtectedTaskRuntimeFacts(input: Readonly<{
  product: PostgresJsBridgeConnection;
  occurrence: ProtectedTaskOccurrence;
}>): Promise<CurrentProtectedTaskRuntimeFacts | null> {
  const taskRows = await executeTypedCryptoQuery(input.product, cryptoTypedDb.select({
    id: tasks.id,
    owner_id: tasks.ownerId,
    requestor_id: tasks.requestorId,
    agent_id: tasks.agentId,
    calling_room_id: tasks.callingRoomId,
    status: tasks.status,
    schedule_kind: tasks.scheduleKind,
    content_representation: tasks.contentRepresentation,
    content_namespace_id: tasks.contentNamespaceId,
    content_revision: tasks.contentRevision,
    crypto_object_id: tasks.cryptoObjectId,
    crypto_access_revision: tasks.cryptoAccessRevision,
    crypto_required_namespace_fingerprint:
      tasks.cryptoRequiredNamespaceFingerprint,
    crypto_mapping_state: tasks.cryptoMappingState,
  }).from(tasks).where(eq(tasks.id, input.occurrence.task.id))
    .limit(2).for("update"));
  if (taskRows.length !== 1) return null;
  const taskRow = taskRows[0]!;
  const task: CurrentTask = {
    id: taskRow.id,
    ownerId: taskRow.owner_id,
    requestorId: taskRow.requestor_id,
    agentId: taskRow.agent_id,
    callingRoomId: taskRow.calling_room_id,
    status: taskRow.status,
    scheduleKind: taskRow.schedule_kind,
    contentRepresentation: taskRow.content_representation,
    contentNamespaceId: taskRow.content_namespace_id,
    contentRevision: taskRow.content_revision,
    cryptoObjectId: taskRow.crypto_object_id,
    cryptoAccessRevision: taskRow.crypto_access_revision,
    cryptoRequiredNamespaceFingerprint:
      taskRow.crypto_required_namespace_fingerprint === null
        ? null
        : Uint8Array.from(taskRow.crypto_required_namespace_fingerprint),
    cryptoMappingState: taskRow.crypto_mapping_state,
  };
  const runRows = await executeTypedCryptoQuery(input.product, cryptoTypedDb.select({
    id: taskRuns.id,
    task_id: taskRuns.taskId,
    job_id: taskRuns.jobId,
    graph_thread_id: taskRuns.graphThreadId,
    status: taskRuns.status,
    result_representation: taskRuns.resultRepresentation,
    result_content_namespace_id: taskRuns.resultContentNamespaceId,
    result_revision: taskRuns.resultRevision,
    result_crypto_object_id: taskRuns.resultCryptoObjectId,
    result_crypto_access_revision: taskRuns.resultCryptoAccessRevision,
    result_crypto_required_namespace_fingerprint:
      taskRuns.resultCryptoRequiredNamespaceFingerprint,
    result_crypto_mapping_state: taskRuns.resultCryptoMappingState,
  }).from(taskRuns).where(and(
    eq(taskRuns.id, input.occurrence.run.id),
    eq(taskRuns.taskId, input.occurrence.task.id),
  )).limit(2).for("update"));
  if (runRows.length !== 1) return null;
  const runRow = runRows[0]!;
  const run: CurrentRun = {
    id: runRow.id,
    taskId: runRow.task_id,
    jobId: runRow.job_id,
    graphThreadId: runRow.graph_thread_id,
    status: runRow.status,
    resultRepresentation: runRow.result_representation,
    resultContentNamespaceId: runRow.result_content_namespace_id,
    resultRevision: runRow.result_revision,
    resultCryptoObjectId: runRow.result_crypto_object_id,
    resultCryptoAccessRevision: runRow.result_crypto_access_revision,
    resultCryptoRequiredNamespaceFingerprint:
      runRow.result_crypto_required_namespace_fingerprint === null
        ? null
        : Uint8Array.from(runRow.result_crypto_required_namespace_fingerprint),
    resultCryptoMappingState: runRow.result_crypto_mapping_state,
  };
  let requesterPrivateRoom: CurrentProtectedTaskRuntimeFacts["requesterPrivateRoom"] = null;
  if (task.contentNamespaceId !== null) {
    const humanRows = await executeTypedCryptoQuery(input.product,
      cryptoTypedDb.select({actor_id: actors.id}).from(actors).where(and(
        eq(actors.ownerId, task.requestorId),
        eq(actors.kind, "user"),
      )).limit(2).for("update"));
    if (humanRows.length !== 1) return null;
    const humanActorId = humanRows[0]!.id;
    const roomRows = await executeTypedCryptoQuery(input.product,
      cryptoTypedDb.select({room_id: rooms.id, namespace_id: rooms.namespaceId,
        human_actor_ids: rooms.humanActorIds})
        .from(rooms).where(and(
          eq(rooms.type, "private"),
          eq(rooms.kind, "private"),
          eq(rooms.namespaceId, task.contentNamespaceId),
        )).limit(2).for("update"));
    const room = roomRows[0];
    if (roomRows.length !== 1 || room === undefined
      || room.human_actor_ids.length !== 1
      || room.human_actor_ids[0] !== humanActorId) return null;
    const memberRows = await executeTypedCryptoQuery(input.product,
      cryptoTypedDb.select({actor_id: actors.id, kind: actors.kind,
        agent_id: actors.agentId}).from(roomMembers)
        .innerJoin(actors, eq(actors.id, roomMembers.actorId))
        .where(eq(roomMembers.roomId, room.id)).limit(3).for("update"));
    if (memberRows.length !== 2
      || memberRows.filter((member) => member.kind === "user"
        && member.id === humanActorId).length !== 1
      || memberRows.filter((member) => member.kind === "agent"
        && member.agent_id === task.agentId).length !== 1) return null;
    requesterPrivateRoom = Object.freeze({
      roomId: room.id,
      namespaceId: room.namespace_id,
    });
  }
  return Object.freeze({task: Object.freeze(task), run: Object.freeze(run), requesterPrivateRoom});
}

/**
 * Revalidates an accepted Task grant before claim or while running, then
 * releases every database lock before exposing the public authority snapshot.
 * Recipient binding is a separate awaiting-phase owner and cannot use this
 * accepted-execution boundary before a signed response exists.
 */
export function createCurrentProtectedTaskRuntimeAuthorityPort(
  dependencies: Readonly<{
    loadCurrentFacts?: LoadCurrentFacts;
    withAcceptedAuthority?: WithAcceptedAuthority;
  }> = {},
): CurrentProtectedTaskRuntimeAuthorityPort {
  const loadCurrentFacts = dependencies.loadCurrentFacts
    ?? loadCurrentProtectedTaskRuntimeFacts;
  const withAcceptedAuthority = dependencies.withAcceptedAuthority
    ?? withCurrentAcceptedTaskRuntimeAuthority;
  return async input => {
    const phase = input.record.snapshot.state === "grant_ready"
      ? "awaiting" as const
      : input.record.snapshot.state === "claimed"
        || input.record.snapshot.state === "running"
        ? "running" as const : null;
    if (phase === null) return null;
    const accepted = acceptedTaskRuntimeRecord(input.record);
    if (accepted === null || input.record.descriptorBytes === null) return null;
    let requestBytes: Uint8Array;
    try {
      requestBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV1(
        input.request,
      );
    } catch {
      destroyAcceptedTaskRuntimeRecord(accepted);
      return null;
    }
    const exactRequest = sameBytes(requestBytes, input.record.descriptorBytes);
    requestBytes.fill(0);
    if (!exactRequest) {
      destroyAcceptedTaskRuntimeRecord(accepted);
      return null;
    }
    let held: HeldProtectedTaskRuntimeAuthority | null;
    try {
      held = await withAcceptedAuthority({
        runner: input.runner,
        restricted: input.restricted,
        crypto: input.crypto,
        serverScope: input.serverScope,
        subject: input.subject,
        accepted,
        now: input.now,
        ...(input.signal === undefined ? {} : {signal: input.signal}),
        use: async (authority, product) => {
          const facts = await loadCurrentFacts({
            product,
            occurrence: input.occurrence,
          });
          if (facts === null || !isCurrentProtectedTaskRunForGrant({
            occurrence: input.occurrence,
            task: facts.task,
            run: facts.run,
            requestorUserId: input.subject.userId,
            requestWorkId: input.request.workId,
            sourceRoomId: input.request.sourceRoomId,
            requesterPrivateRoom: facts.requesterPrivateRoom,
            phase,
          })) return null;
          return copyHeldAuthority(authority);
        },
      });
    } finally {
      destroyAcceptedTaskRuntimeRecord(accepted);
    }
    if (held === null) return null;
    try {
      input.signal?.throwIfAborted();
      return await input.use(held);
    } finally {
      destroyHeldAuthority(held);
    }
  };
}
