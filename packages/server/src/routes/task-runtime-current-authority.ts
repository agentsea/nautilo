import { parseProtectedTaskOpenCodeSelection, protectedTaskOpenCodeSelectionProjection, type ProtectedTaskOpenCodeSelection } from "./protected-task-opencode-selection";
import { parseProtectedTaskDeepResearchSelection, protectedTaskDeepResearchSelectionProjection, type ProtectedTaskDeepResearchSelection } from "./protected-task-deep-research-selection";
import { parseProtectedTaskCodexSelection, protectedTaskCodexSelectionProjection, type ProtectedTaskCodexSelection } from "./protected-task-codex-selection";
import { parseProtectedTaskHermesSelection, protectedTaskHermesSelectionProjection, type ProtectedTaskHermesSelection } from "./protected-task-hermes-selection";
import { parseProtectedTaskRepoDocsSelection, protectedTaskRepoDocsSelectionProjection, type ProtectedTaskRepoDocsSelection } from "./protected-task-repo-docs-selection";
import { validateCurrentTaskDefinitionIdentity } from "./protected-task-runtime-definition-identity";
import {
  parseProtectedTaskClaudeSelection,
  protectedTaskClaudeSelectionProjection,
  type ProtectedTaskClaudeSelection,
} from "./protected-task-claude-selection";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";

import {
  actors,
  PROTECTED_TASK_PRESETS,
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
  decodeTaskRuntimeBackgroundAuthorizationRequestBase,
  decodeTaskRuntimeBackgroundAuthorizationResponseV2,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1,
  encodeTaskRuntimeBackgroundAuthorizationRequestV1,
  isTaskRuntimeBackgroundAuthorizationRequestV2Carrier,
  isTaskRuntimeBackgroundAuthorizationRequestV3Carrier,
  type BackgroundAuthorizationIssuerV2,
  type TaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import type {
  DomainForegroundAuthorizationPublicCurrentAuthorityV2,
} from "@nautilo/lattice-crypto/wire";
import {
  cryptoTypedDb,
  executeTypedCryptoQuery,
  withCurrentAcceptedTaskRuntimeAuthority,
  withCurrentAcceptedTaskRuntimeClaimAuthority,
  verifyCryptoPostgresHandle,
  type AcceptedTaskRuntimeAuthorizationV3,
  type ConversationProductCanonicalTransactionRunner,
  type CurrentTaskRuntimeAuthority,
  type TaskRuntimeAuthoritySubject,
} from "@nautilo/lattice-bridge/server";
import {
  isCurrentProtectedTaskRunForGrant,
  TASK_RUNTIME_AUTHORIZATION_ABSOLUTE_LIMIT_MS,
  PostgresBackgroundAuthorizationRepository,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
  type BackgroundAuthorizationTaskRuntimeReplacementRepository,
  type ProtectedTaskAuthorityOccurrence,
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

export type CurrentProtectedTaskRuntimeLifecycleFacts = Readonly<{
  task: CurrentTask;
  run: CurrentRun;
  /** Content-free result of inspecting the locked Task's execution route. */
  nativeExecutionSupported: boolean;
  /** Closed operational selection; never the complete Task metadata. */
  claudeExecutionSelection?: ProtectedTaskClaudeSelection | null;
  codexExecutionSelection?: ProtectedTaskCodexSelection | null;
  hermesExecutionSelection?: ProtectedTaskHermesSelection | null;
  opencodeExecutionSelection?: ProtectedTaskOpenCodeSelection | null;
  deepResearchExecutionSelection?: ProtectedTaskDeepResearchSelection | null;
  repoDocsSelection?: ProtectedTaskRepoDocsSelection | null;
}>;

type CurrentRequesterPrivateRoomFacts = Readonly<{
  requesterPrivateRoom: Readonly<{roomId: string; namespaceId: string}> | null;
}>;

export type CurrentProtectedTaskRuntimeFacts =
  CurrentProtectedTaskRuntimeLifecycleFacts & CurrentRequesterPrivateRoomFacts;

type LoadCurrentLifecycleFacts = (input: Readonly<{
  product: PostgresJsBridgeConnection;
  occurrence: ProtectedTaskAuthorityOccurrence;
}>) => Promise<CurrentProtectedTaskRuntimeLifecycleFacts | null>;

type LoadCurrentRequesterPrivateRoomFacts = (input: Readonly<{
  product: PostgresJsBridgeConnection;
  task: CurrentTask;
}>) => Promise<CurrentRequesterPrivateRoomFacts | null>;

type WithAcceptedAuthority = typeof withCurrentAcceptedTaskRuntimeAuthority;
type WithAcceptedClaimAuthority =
  typeof withCurrentAcceptedTaskRuntimeClaimAuthority;

export type HeldProtectedTaskRuntimeAuthority = Readonly<{
  foreground: DomainForegroundAuthorizationPublicCurrentAuthorityV2;
  namespaceRequirements: CurrentTaskRuntimeAuthority["namespaceRequirements"];
  currentIssuer?: BackgroundAuthorizationIssuerV2;
  /** Absent on legacy/test adapters; native execution must treat absence as false. */
  nativeExecutionSupported?: boolean;
  claudeExecutionSelection?: ProtectedTaskClaudeSelection | null;
  codexExecutionSelection?: ProtectedTaskCodexSelection | null;
  hermesExecutionSelection?: ProtectedTaskHermesSelection | null;
  opencodeExecutionSelection?: ProtectedTaskOpenCodeSelection | null;
  deepResearchExecutionSelection?: ProtectedTaskDeepResearchSelection | null;
  repoDocsSelection?: ProtectedTaskRepoDocsSelection | null;
}>;

export type CurrentProtectedTaskRuntimeAuthorityPort = <Value>(input: Readonly<{
  runner: ConversationProductCanonicalTransactionRunner;
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  serverScope: string;
  subject: TaskRuntimeAuthoritySubject;
  occurrence: ProtectedTaskAuthorityOccurrence;
  record: BackgroundAuthorizationTaskRuntimeRecordV3;
  request: TaskRuntimeBackgroundAuthorizationRequestV1;
  now(): number;
  signal?: AbortSignal;
  use(current: HeldProtectedTaskRuntimeAuthority): Value | Promise<Value>;
}>) => Promise<Value | null>;

export type CurrentProtectedTaskRuntimeClaimAuthorityPort = <Value>(
  input: Readonly<{
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
    use(
      current: HeldProtectedTaskRuntimeAuthority,
      repository: Pick<
        BackgroundAuthorizationTaskRuntimeReplacementRepository,
        "compareAndSwap"
      >,
      claimedAt: number,
      claimExpiresAt: number,
    ): Value | Promise<Value>;
  }>,
) => Promise<Value | null>;

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
  let wrappedResponse: Readonly<{
    authorizationBytes: Uint8Array;
    certificateBytes: Uint8Array;
  }> | undefined;
  try {
    if (isTaskRuntimeBackgroundAuthorizationRequestV2Carrier(record.descriptorBytes)
      || isTaskRuntimeBackgroundAuthorizationRequestV3Carrier(record.descriptorBytes)) {
      wrappedResponse = decodeTaskRuntimeBackgroundAuthorizationResponseV2(
        material.responseBytes,
      );
    }
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
    authorizationBytes: Uint8Array.from(
      wrappedResponse?.authorizationBytes ?? material.responseBytes,
    ),
    authorizationDigest: response.credentialDigest,
    authorizationExpiresAt: material.authorizationExpiresAt,
    issuingHumanId: response.issuingHumanId,
    issuingDeviceId: response.issuingDeviceId,
    issuingDeviceAuthorizationRevision:
      material.issuingDeviceAuthorizationRevision,
    issuerSigningPublicKeyHash:
      Uint8Array.from(material.issuerSigningPublicKeyHash),
    });
  } catch {
    return null;
  } finally {
    wrappedResponse?.authorizationBytes.fill(0);
    wrappedResponse?.certificateBytes.fill(0);
  }
}

export function destroyAcceptedTaskRuntimeRecord(
  accepted: AcceptedTaskRuntimeAuthorizationV3,
): void {
  accepted.descriptorBytes.fill(0);
  accepted.authorizationBytes.fill(0);
  accepted.issuerSigningPublicKeyHash.fill(0);
}

export function copyProtectedTaskRuntimeAuthority(
  authority: CurrentTaskRuntimeAuthority,
  nativeExecutionSupported: boolean,
  claudeExecutionSelection?: ProtectedTaskClaudeSelection | null,
  codexExecutionSelection?: ProtectedTaskCodexSelection | null,
  hermesExecutionSelection?: ProtectedTaskHermesSelection | null,
  deepResearchExecutionSelection?: ProtectedTaskDeepResearchSelection | null,
  repoDocsSelection?: ProtectedTaskRepoDocsSelection | null,
  opencodeExecutionSelection?: ProtectedTaskOpenCodeSelection | null,
): HeldProtectedTaskRuntimeAuthority {
  const plan = authority.plan;
  const signingPublicKeyHash = new Uint8Array(
    createHash("sha256").update(authority.device.signingPublicKey).digest(),
  );
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
    currentIssuer: Object.freeze({
      humanId: authority.device.humanActorId,
      deviceId: authority.device.deviceId,
      deviceGeneration: authority.device.deviceGeneration,
      serverInstanceId: authority.device.serverInstanceId,
      lineageGeneration: authority.device.lineageGeneration,
      epoch: authority.device.epoch,
      securityRevision: authority.device.securityRevision,
      headDigest: Uint8Array.from(authority.device.headDigest),
      signingPublicKeyHash,
    }),
    nativeExecutionSupported,
    ...(claudeExecutionSelection === undefined ? {} : {
      claudeExecutionSelection: claudeExecutionSelection === null ? null
        : Object.freeze({ ...claudeExecutionSelection }),
    }),
    ...(codexExecutionSelection === undefined ? {} : { codexExecutionSelection: parseProtectedTaskCodexSelection(codexExecutionSelection) }),
    ...(opencodeExecutionSelection === undefined ? {} : { opencodeExecutionSelection: parseProtectedTaskOpenCodeSelection(opencodeExecutionSelection) }),
    ...(hermesExecutionSelection === undefined ? {} : { hermesExecutionSelection: parseProtectedTaskHermesSelection(hermesExecutionSelection) }),
    ...(deepResearchExecutionSelection === undefined ? {} : { deepResearchExecutionSelection: parseProtectedTaskDeepResearchSelection(deepResearchExecutionSelection) }),
    ...(repoDocsSelection === undefined ? {} : { repoDocsSelection: parseProtectedTaskRepoDocsSelection(repoDocsSelection) }),
  });
}

export function destroyProtectedTaskRuntimeAuthority(authority: HeldProtectedTaskRuntimeAuthority): void {
  authority.foreground.committerDeviceSigningPublicKey.fill(0);
  for (const domain of authority.foreground.domains) {
    domain.participantDigest.fill(0);
    domain.headDigest.fill(0);
    domain.activeNamespaceBindingSetDigest.fill(0);
  }
  authority.currentIssuer?.headDigest.fill(0);
  authority.currentIssuer?.signingPublicKeyHash.fill(0);
}

export async function loadCurrentProtectedTaskRuntimeLifecycleFacts(input: Readonly<{
  product: PostgresJsBridgeConnection;
  occurrence: ProtectedTaskAuthorityOccurrence;
}>): Promise<CurrentProtectedTaskRuntimeLifecycleFacts | null> {
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
    native_execution_supported: sql<boolean>`case
      when jsonb_typeof(${tasks.metadata}) = 'object' then coalesce(
        ${inArray(tasks.preset, PROTECTED_TASK_PRESETS)}
        and (${tasks.metadata} - 'preparation' - 'lastInterruption') = '{}'::jsonb,
        false
      )
      else false
    end`.as("native_execution_supported"),
    claude_execution_selection: protectedTaskClaudeSelectionProjection(),
    codex_execution_selection: protectedTaskCodexSelectionProjection(),
    hermes_execution_selection: protectedTaskHermesSelectionProjection(),
    opencode_execution_selection: protectedTaskOpenCodeSelectionProjection(),
    deep_research_execution_selection: protectedTaskDeepResearchSelectionProjection(),
    repo_docs_selection: protectedTaskRepoDocsSelectionProjection(),
  }).from(tasks).where(eq(tasks.id, input.occurrence.task.id))
    .limit(2)
    // Exclude Task edits/deletes while permitting FK-only usage accounting.
    .for("no key update"));
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
  if (input.occurrence.task.definitionHistoricalRepair != null
    && !await validateCurrentTaskDefinitionIdentity({ product: input.product, task: input.occurrence.task })) return null;
  return Object.freeze({
    task: Object.freeze(task),
    run: Object.freeze(run),
    nativeExecutionSupported: taskRow.native_execution_supported === true,
    claudeExecutionSelection: parseProtectedTaskClaudeSelection(taskRow.claude_execution_selection),
    codexExecutionSelection: parseProtectedTaskCodexSelection(taskRow.codex_execution_selection),
    hermesExecutionSelection: parseProtectedTaskHermesSelection(taskRow.hermes_execution_selection),
    opencodeExecutionSelection: parseProtectedTaskOpenCodeSelection(taskRow.opencode_execution_selection),
    deepResearchExecutionSelection: parseProtectedTaskDeepResearchSelection(taskRow.deep_research_execution_selection),
    repoDocsSelection: parseProtectedTaskRepoDocsSelection(taskRow.repo_docs_selection),
  });
}

export async function loadCurrentProtectedTaskRuntimeRequesterRoomFacts(
  input: Readonly<{
    product: PostgresJsBridgeConnection;
    task: CurrentTask;
  }>,
): Promise<CurrentRequesterPrivateRoomFacts | null> {
  const { task } = input;
  let requesterPrivateRoom: CurrentRequesterPrivateRoomFacts["requesterPrivateRoom"] = null;
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
      || memberRows.filter((member) => member.kind === "agent").length !== 1) return null;
    requesterPrivateRoom = Object.freeze({
      roomId: room.id,
      namespaceId: room.namespace_id,
    });
  }
  return Object.freeze({ requesterPrivateRoom });
}

type CurrentAuthorityInput = Omit<Parameters<
  CurrentProtectedTaskRuntimeAuthorityPort
>[0], "use">;

type CurrentAuthorityDependencies = Readonly<{
  loadCurrentLifecycleFacts?: LoadCurrentLifecycleFacts;
  loadCurrentRequesterPrivateRoomFacts?: LoadCurrentRequesterPrivateRoomFacts;
  withAcceptedAuthority?: WithAcceptedAuthority;
  withAcceptedClaimAuthority?: WithAcceptedClaimAuthority;
}>;

async function withLockedCurrentProtectedTaskRuntimeAuthority<Value>(
  input: CurrentAuthorityInput,
  phase: "awaiting" | "running",
  dependencies: CurrentAuthorityDependencies,
  use: (
    authority: CurrentTaskRuntimeAuthority,
    facts: CurrentProtectedTaskRuntimeLifecycleFacts,
    restricted: PostgresJsBridgeConnection,
  ) => Value | Promise<Value>,
  validateBeforeCommit?: () => void | Promise<void>,
): Promise<Value | null> {
  const accepted = acceptedTaskRuntimeRecord(input.record);
  if (accepted === null || input.record.descriptorBytes === null) return null;
  let expectedRequestBytes: Uint8Array | undefined;
  let descriptorRequestBytes: Uint8Array | undefined;
  let descriptorRequest: TaskRuntimeBackgroundAuthorizationRequestV1 | null = null;
  try {
    expectedRequestBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV1(
      input.request,
    );
    descriptorRequest = decodeTaskRuntimeBackgroundAuthorizationRequestBase(
      input.crypto,
      input.record.descriptorBytes,
    );
    if (descriptorRequest !== null) {
      descriptorRequestBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV1(
        descriptorRequest,
      );
    }
  } catch {
    destroyAcceptedTaskRuntimeRecord(accepted);
    return null;
  } finally {
    if (descriptorRequest !== null) {
      destroyTaskRuntimeBackgroundAuthorizationRequestV1(descriptorRequest);
    }
  }
  const exactRequest = expectedRequestBytes !== undefined
    && descriptorRequestBytes !== undefined
    && sameBytes(expectedRequestBytes, descriptorRequestBytes);
  expectedRequestBytes?.fill(0);
  descriptorRequestBytes?.fill(0);
  if (!exactRequest) {
    destroyAcceptedTaskRuntimeRecord(accepted);
    return null;
  }
  const loadLifecycle = dependencies.loadCurrentLifecycleFacts
    ?? loadCurrentProtectedTaskRuntimeLifecycleFacts;
  const loadRequesterRoom = dependencies.loadCurrentRequesterPrivateRoomFacts
    ?? loadCurrentProtectedTaskRuntimeRequesterRoomFacts;
  let lifecycle: CurrentProtectedTaskRuntimeLifecycleFacts | null = null;
  const validateCurrentProduct = async (
    product: PostgresJsBridgeConnection,
  ): Promise<boolean> => {
    lifecycle = await loadLifecycle({
      product,
      occurrence: input.occurrence,
    });
    return lifecycle !== null;
  };
  const useCurrent = async (
    authority: CurrentTaskRuntimeAuthority,
    product: PostgresJsBridgeConnection,
    restricted: PostgresJsBridgeConnection,
  ): Promise<Value | null> => {
    if (lifecycle === null) return null;
    const room = await loadRequesterRoom({
      product,
      task: lifecycle.task,
    });
    if (room === null || !isCurrentProtectedTaskRunForGrant({
      occurrence: input.occurrence,
      task: lifecycle.task,
      run: lifecycle.run,
      requestorUserId: input.subject.userId,
      requestWorkId: input.request.workId,
      sourceRoomId: input.request.sourceRoomId,
      requesterPrivateRoom: room.requesterPrivateRoom,
      phase,
    })) return null;
    return use(authority, lifecycle, restricted);
  };
  try {
    const ownerInput = {
      runner: input.runner,
      restricted: input.restricted,
      crypto: input.crypto,
      serverScope: input.serverScope,
      subject: input.subject,
      accepted,
      now: input.now,
      ...(input.signal === undefined ? {} : {signal: input.signal}),
      validateCurrentProduct,
      use: useCurrent,
    };
    if (validateBeforeCommit !== undefined) {
      const withAcceptedClaimAuthority =
        dependencies.withAcceptedClaimAuthority
        ?? withCurrentAcceptedTaskRuntimeClaimAuthority;
      return await withAcceptedClaimAuthority({
        ...ownerInput,
        validateBeforeCommit,
      });
    }
    const withAcceptedAuthority = dependencies.withAcceptedAuthority
      ?? withCurrentAcceptedTaskRuntimeAuthority;
    return await withAcceptedAuthority(ownerInput);
  } finally {
    destroyAcceptedTaskRuntimeRecord(accepted);
  }
}

/**
 * Revalidates an accepted Task grant, copies its public authority, and releases
 * every database lock before the execution callback begins.
 */
export function createCurrentProtectedTaskRuntimeAuthorityPort(
  dependencies: CurrentAuthorityDependencies = {},
): CurrentProtectedTaskRuntimeAuthorityPort {
  return async input => {
    const phase = input.record.snapshot.state === "grant_ready"
      ? "awaiting" as const
      : input.record.snapshot.state === "claimed"
        || input.record.snapshot.state === "running"
        ? "running" as const : null;
    if (phase === null) return null;
    const held = await withLockedCurrentProtectedTaskRuntimeAuthority(
      input,
      phase,
      dependencies,
      (authority, facts) =>
        copyProtectedTaskRuntimeAuthority(authority, facts.nativeExecutionSupported,
          facts.claudeExecutionSelection, facts.codexExecutionSelection,
          facts.hermesExecutionSelection, facts.deepResearchExecutionSelection,
          facts.repoDocsSelection, facts.opencodeExecutionSelection),
    );
    if (held === null) return null;
    try {
      input.signal?.throwIfAborted();
      return await input.use(held);
    } finally {
      destroyProtectedTaskRuntimeAuthority(held);
    }
  };
}

/** Claim-only owner. The CAS repository and authority expire with its callback. */
export function createCurrentProtectedTaskRuntimeClaimAuthorityPort(
  dependencies: CurrentAuthorityDependencies & Readonly<{
    repository?(restricted: PostgresJsBridgeConnection): Promise<Pick<
      BackgroundAuthorizationTaskRuntimeReplacementRepository,
      "compareAndSwap"
    >>;
  }> = {},
): CurrentProtectedTaskRuntimeClaimAuthorityPort {
  const repository = dependencies.repository ?? (async restricted =>
    new PostgresBackgroundAuthorizationRepository(
      await verifyCryptoPostgresHandle(restricted),
    ));
  return async input => {
    if (input.record.snapshot.state !== "grant_ready"
      || input.occurrence.run.status !== "awaiting"
      || input.occurrence.run.jobId !== null) return null;
    let claimExpiresAt: number | null = null;
    return withLockedCurrentProtectedTaskRuntimeAuthority(
      input,
      "awaiting",
      dependencies,
      async (authority, facts, restricted) => {
        const scopedRepository = await repository(restricted);
        const claimedAt = input.now();
        const recipient = input.record.snapshot.recipient;
        const material = input.record.acceptedMaterial;
        if (!Number.isSafeInteger(claimedAt)
          || claimedAt < input.request.issuedAt
          || recipient === null
          || material === null
          || claimedAt >= input.request.deadlineAt
          || claimedAt >= recipient.expiresAt
          || claimedAt >= material.authorizationExpiresAt) return null;
        claimExpiresAt = Math.min(
          input.request.deadlineAt,
          recipient.expiresAt,
          material.authorizationExpiresAt,
        );
        if (claimExpiresAt - claimedAt
          > TASK_RUNTIME_AUTHORIZATION_ABSOLUTE_LIMIT_MS) return null;
        const held = copyProtectedTaskRuntimeAuthority(
          authority,
          facts.nativeExecutionSupported,
          facts.claudeExecutionSelection, facts.codexExecutionSelection,
          facts.hermesExecutionSelection, facts.deepResearchExecutionSelection,
          facts.repoDocsSelection, facts.opencodeExecutionSelection,
        );
        try {
          const value = await input.use(
            held,
            scopedRepository,
            claimedAt,
            claimExpiresAt,
          );
          return value;
        } finally {
          destroyProtectedTaskRuntimeAuthority(held);
        }
      },
      () => {
        if (claimExpiresAt === null) return;
        const finishedAt = input.now();
        if (!Number.isSafeInteger(finishedAt)
          || finishedAt >= claimExpiresAt) {
          throw new Error(
            "Task Runtime claim authority expired before commit",
          );
        }
      },
    );
  };
}
