import {
  and,
  conversationSharedAgentShadowExecutions,
  conversationSharedAgentShadowInvocations,
  createPostgresJsBridgeConnection,
  createPostgresJsCanonicalBridgeConnection,
  eq,
  getEncryptionTransitionPolicy,
  getSharedDirectCryptoDb,
} from "@nautilo/db";
import {
  LatticeCrypto,
  decryptObjectThroughNamespace,
  deriveAgentRuntimeObjectSignerPublic,
  domainForegroundAuthoritySetDigest,
  withOpenedDomainForegroundAuthorization,
  type ForegroundSessionLiveShadowMessagePlan,
  decodeHumanAiReadableLiveShadowMessagePlan,
} from "@nautilo/lattice-crypto";
import {
  decodeLiveShadowMessagePlanV4,
  decodeHumanPeerLiveShadowMessagePlanV1,
  decodeHumanPeerLiveShadowAcknowledgementV1,
  decodeHumanAiReadableLiveShadowAcknowledgementV1,
  decodeSharedAgentLiveShadowMessagePlanV1,
  decodeSharedAgentLiveShadowAcknowledgementV1,
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  destroyDomainForegroundAuthorizationV2,
  parseDomainForegroundAuthorizationV2,
} from "@nautilo/lattice-crypto/wire";
import {
  envelopeReadableNamespaces,
  findActorByHandle,
  findActorByOwnerId,
  findOrCreateAccessNamespace,
  getPolicyResolver,
} from "@nautilo/trust";
import { parseProtectedMessageDtoV2 } from "@nautilo/types";
import { publishProtectedMessageUpdated } from "../realtime/ws-publisher.ts";
import {
  createForegroundJournalHistoryRepairer,
  createForegroundMemoryHistoryRepairer,
  createForegroundRecordHistoryRepairer,
} from "@nautilo/runtime";
import { createDormantConversationShadowRepository, decodeMessagePayloadV2, type StrictShadowEnforcementPolicy } from
  "@nautilo/lattice-bridge";
import { createForegroundMessageProductStore } from
  "./foreground-message-product-store.ts";
import {
  createForegroundMemoryRepository,
  createForegroundMemoryAccessPort,
  createForegroundMemoryProjectionPort,
  resolveForegroundMemoryNativeEntries,
} from "./foreground-memory-repository.ts";
import {
  admitAndPersistHumanPeerLiveShadowMessage,
  bindConversationProductCanonicalTransactionRunner,
  createForegroundMessageHistoryRepairer,
  createPostgresForegroundJournalSelectionPort,
  createPostgresConversationCryptoCompletion,
  createLiveShadowAgentTurnSession,
  createPostgresDomainKeyV2LiveShadowCurrentAuthority,
  admitForegroundSessionHumanLiveShadowMessage,
  createDomainCompressedLiveShadowSessionCapability,
  withDomainCompressedLiveShadowSessionCapabilityEntries,
  withProtectedInvocationRecipientPrivateKey,
  destroyProtectedInvocationRecipient,
  createPostgresLiveShadowTurnPlanner,
  createPostgresHumanPeerLiveShadowPlanner,
  createPostgresSharedAgentLiveShadowPlanner,
  openPostgresSharedAgentProtectedInputSet,
  openPostgresRuntimeInvocationProtectedInputSet,
  openPostgresRuntimeInvocationProtectedHistoryHits,
  loadPostgresForegroundMessageRepairSources,
  loadPostgresForegroundJournalRepairSources,
  attachPostgresForegroundJournalRepair,
  restorePostgresForegroundJournalOrdinary,
  validatePostgresForegroundJournalRepairSource,
  loadPostgresForegroundRecordRepairSources,
  attachPostgresForegroundRecordRepair,
  restorePostgresForegroundRecordOrdinary,
  validatePostgresForegroundRecordRepairSource,
  loadPostgresForegroundMemoryRepairSources,
  attachPostgresForegroundMemoryRepair,
  restorePostgresForegroundMemoryOrdinary,
  validatePostgresForegroundMemoryRepairSource,
  persistDeviceWrappedAgentObject,
  readVerifiedDeviceWrappedAgentObject,
  createPostgresForegroundAgentSignerResolver,
  LiveShadowRecipientRegistry,
  PostgresConversationProductStore,
  PostgresHumanMessageEditPlanner,
  PostgresDomainKeyAuthorityRepository,
  PostgresNamespaceProductAuthority,
  PostgresLatticeStorage,
  PostgresHumanDeviceSignerHistory,
  verifyConversationProductPostgresHandle,
  verifyCryptoPostgresHandle,
  verifyAndRecordLiveShadowClientVerification,
  recoverPostgresLiveShadowTurn,
  recoverPostgresPublishedHumanMessage,
  type LiveShadowClientVerificationInput,
  type LiveShadowClientVerificationResult,
  type LiveShadowHumanAdmissionResult,
  type LiveShadowHumanPreparedAttempt,
  type LiveShadowExecutionCapability,
  type DomainKeyV2LiveShadowCurrentAuthority,
  type ForegroundLiveShadowSessionExecutionCapability,
  type LiveShadowForegroundAuthorizationScope,
  type LiveShadowReusableForegroundAuthorization,
  persistForegroundSessionHumanLiveShadowMessage,
  type LiveShadowTurnPlanInput,
  type LiveShadowTurnFallbackInput,
  type LiveShadowTurnJobBindingInput,
  type PostgresLiveShadowTurnPlanner,
  type PostgresHumanPeerLiveShadowPlanner,
  type PostgresSharedAgentLiveShadowPlanner,
  type ResolveLiveShadowReadableNamespaces,
  type LiveShadowAgentTurnExecutionResult,
  type LiveShadowAgentTurnSession,
  type LiveShadowTurnRecoveryResult,
  type HumanPeerLiveShadowAdmissionResult,
  type HumanPeerLiveShadowPreparedAttempt,
  type SharedAgentLiveShadowAdmissionResult,
  type SharedAgentLiveShadowPreparedAttempt,
  type RuntimeInvocationProtectedHistoryHit,
  admitAndPersistSharedAgentLiveShadowMessage,
  admitAndPersistHumanAiReadableLiveShadowMessage,
} from "@nautilo/lattice-bridge/server";
import type { FastifyInstance } from "fastify";
import { log } from "@nautilo/logger";

import { getServerDirectDb } from "../lib/server-direct-db";
import { createProductionForegroundPendingAttention } from "./foreground-pending-attention";
import type { LiveShadowMessagePlanComposition } from "./live-shadow-message";
import {
  createForegroundAgentEntityCryptoGateway,
  createForegroundEntityCheckpointAuthorization,
} from
  "./foreground-agent-entity-crypto-gateway";
import { LiveShadowForegroundAuthorizationSessions } from
  "./live-shadow-foreground-authorization-sessions";
import type { ProtectedHumanMessageEditRouteService } from "./rooms.ts";

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function errorCauseSummary(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    parts.push(`${current.name}: ${current.message}`);
    current = current.cause;
  }
  return parts.length > 0 ? parts.join(" <- ") : typeof error;
}

type RuntimeInvocationContentSelection =
  | Readonly<{ representationMode?: "shadow_encryption"; expectedMergedHumanContent: string }>
  | Readonly<{ representationMode: "full_encryption"; expectedMergedHumanContent?: never }>;

export interface ProductionLiveShadowMessageComposition
  extends LiveShadowMessagePlanComposition {
  readonly protectedEdit?: ProtectedHumanMessageEditRouteService;
  readonly recipients: LiveShadowRecipientRegistry;
  readonly pendingAttention?: ReturnType<typeof createProductionForegroundPendingAttention>;
  admitPrepared(input: LiveShadowHumanPreparedAttempt):
    Promise<LiveShadowHumanAdmissionResult>;
  admitHumanPeer(input: HumanPeerLiveShadowPreparedAttempt & Readonly<{
    userId: string;
    actorId: string;
  }>): Promise<HumanPeerLiveShadowAdmissionResult>;
  admitSharedAgent?(input: SharedAgentLiveShadowPreparedAttempt & Readonly<{
    userId: string;
    actorId: string;
  }>): Promise<SharedAgentLiveShadowAdmissionResult>;
  recordSharedAgentPublished?(input: Readonly<{
    operationId: string;
    messageId: number;
    protectedMessageDigest: Uint8Array;
    finalEventDigest: Uint8Array;
    now: number;
  }>): Promise<"published" | "replayed" | "conflict">;
  recordSharedAgentFallback?(input: Readonly<{
    actorId: string;
    operationId: string;
    stage:
      | "human_admission"
      | "ordinary_commit"
      | "protected_completion"
      | "product_mapping"
      | "realtime_publication";
    reason:
      | "stale_authority"
      | "integrity_failure"
      | "parity_mismatch"
      | "deadline_expired"
      | "product_conflict"
      | "storage_failure"
      | "transport_failure";
    now: number;
  }>): Promise<"fallback" | "replayed" | "conflict">;
  recordSharedAgentConductorResolution?(input: Readonly<{
    operationIds: readonly string[];
    roomId: string;
    subjectHumanId: string;
    state: "awaiting_user" | "not_selected" | "unavailable";
    reason: string;
    now: number;
  }>): Promise<"recorded" | "replayed" | "conflict">;
  reserveSharedAgentExecution?(input: Readonly<{
    operationIds: readonly string[];
    roomId: string;
    subjectUserId: string;
    subjectHumanId: string;
    agentId: string;
    agentThreadId: string;
    clientActionSessionId: string;
    now: number;
  }>): Promise<import("@nautilo/lattice-bridge/server")
    .SharedAgentExecutionReservation | null>;
  reserveSharedAgentRuntimeInvocation?(input: Readonly<{
    operationIds: readonly string[];
    roomId: string;
    subjectHumanId: string;
    clientActionSessionId: string;
    purpose?: "agent" | "conductor";
    now: number;
  }>): Promise<import("@nautilo/lattice-bridge/server")
    .SharedAgentRuntimeInvocationReservation | null>;
  attachSharedAgentRuntimeInvocationExecutions?(input: Readonly<{
    invocationId: string;
    operationIds: readonly string[];
    roomId: string;
    subjectUserId: string;
    subjectHumanId: string;
    agents: readonly Readonly<{
      agentId: string;
      agentThreadId: string;
      expectedResponseMode?: "active" | "mention_only" | "observe" | null;
    }>[];
    now: number;
  }>): Promise<import("@nautilo/lattice-bridge/server")
    .SharedAgentRuntimeInvocationExecutionAttachment | null>;
  reserveSharedAgentRuntimeResume?(input: Readonly<{
    roomId: string;
    subjectUserId: string;
    subjectHumanId: string;
    agentId: string;
    agentThreadId: string;
    clientActionSessionId: string;
    authorizationDeviceId: string;
    resumeCoordinate: string;
    now: number;
  }>): Promise<import("@nautilo/lattice-bridge/server")
    .SharedAgentRuntimeResumeReservationResult | null>;
  planSharedAgentExecutionAuthorization?(input: import("@nautilo/lattice-bridge/server")
    .SharedAgentForegroundExecutionPlanInput): Promise<
      import("@nautilo/lattice-bridge/server")
        .SharedAgentForegroundExecutionPlanResult
    >;
  planRuntimeInvocationAuthorization?(input: import("@nautilo/lattice-bridge/server")
    .RuntimeInvocationForegroundAuthorizationPlanInput): Promise<
      import("@nautilo/lattice-bridge/server")
        .RuntimeInvocationForegroundAuthorizationPlanResult
    >;
  awaitRuntimeInvocationAuthorization?(input: Readonly<{
    invocationId: string;
    deadlineAt: number;
  }>): Promise<Readonly<{
    capability: ForegroundLiveShadowSessionExecutionCapability;
  }> | null>;
  runRuntimeInvocationConductor?<Value>(input: Readonly<{
    invocationId: string;
    operationIds: readonly string[];
    roomId: string;
    userId: string;
    actorId: string;
    clientActionSessionId: string;
    capability: ForegroundLiveShadowSessionExecutionCapability;
    work(
      openedHumanContent: string,
      openHistory: (
        candidates: readonly RuntimeInvocationProtectedHistoryHit[],
      ) => Promise<readonly RuntimeInvocationProtectedHistoryHit[] | null>,
    ): Promise<Value>;
  }> & RuntimeInvocationContentSelection): Promise<LiveShadowAgentTurnExecutionResult<Value>>;
  recordRuntimeInvocationConductorOutcome?(input: Readonly<{
    invocationId: string;
    roomId: string;
    subjectHumanId: string;
    routePath: import("@nautilo/lattice-bridge/server")
      .RuntimeInvocationConductorRoutePath;
    historyStatus: import("@nautilo/lattice-bridge/server")
      .RuntimeInvocationConductorHistoryStatus;
    outcome: import("@nautilo/lattice-bridge/server")
      .RuntimeInvocationConductorOutcome;
    now: number;
  }>): Promise<"recorded" | "replayed" | "conflict">;
  recordRuntimeInvocationConductorFallback?(input: Readonly<{
    invocationId: string;
    roomId: string;
    subjectHumanId: string;
    stage: string;
    reason: string;
    now: number;
  }>): Promise<"recorded" | "replayed" | "conflict">;
  awaitSharedAgentExecutionAuthorization?(input: Readonly<{
    executionId: string;
    deadlineAt: number;
  }>): Promise<Readonly<{
    capability: ForegroundLiveShadowSessionExecutionCapability;
    planBytes: Uint8Array;
  }> | null>;
  admitSharedAgentExecutionAuthorization?(input: LiveShadowHumanPreparedAttempt):
    Promise<"authorized" | "replayed" | "unavailable">;
  admitSharedAgentRuntimeAuthorization?(input: Readonly<{
    operationId: string;
    roomId: string;
    clientActionSessionId: string;
    userId: string;
    actorId: string;
    authorizationPlanBytes: Uint8Array;
    authorizationBytes: Uint8Array;
    now: number;
  }>): Promise<"authorized" | "replayed" | "unavailable">;
  admitRuntimeInvocationAuthorization?(input: Readonly<{
    invocationId: string;
    roomId: string;
    clientActionSessionId: string;
    userId: string;
    actorId: string;
    authorizationPlanBytes: Uint8Array;
    authorizationBytes: Uint8Array;
    now: number;
  }>): Promise<"authorized" | "replayed" | "unavailable">;
  recordSharedAgentExecutionUnavailable?(input: Readonly<{
    executionId: string;
    reason: string;
    now: number;
  }>): Promise<"recorded" | "replayed" | "conflict">;
  acknowledgeSharedAgent?(input: Readonly<{
    userId: string;
    actorId: string;
    roomId: string;
    operationId: string;
    acknowledgementBytes: Uint8Array;
    now: number;
  }>): Promise<"verified" | "replayed" | "conflict">;
  planSharedAgentAcknowledgement?(input: Readonly<{
    userId: string;
    actorId: string;
    roomId: string;
    operationId: string;
    clientDeviceId: string;
  }>): Promise<
    | Readonly<{
        status: "ready";
        subjectHumanId: string;
        clientDeviceId: string;
        clientDeviceSigningKeyGeneration: number;
        hostAuthorizationRevision: number;
      }>
    | Readonly<{
        status: "unavailable";
        reason: "operation_unavailable" | "current_read_authority_unavailable";
      }>
  >;
  planSharedAgentOutputRead?(input: Readonly<{
    userId: string;
    actorId: string;
    roomId: string;
    executionId: string;
    clientDeviceId: string;
  }>): Promise<
    | Readonly<{
        status: "ready";
        subjectHumanId: string;
        clientDeviceId: string;
        clientDeviceSigningKeyGeneration: number;
        hostAuthorizationRevision: number;
      }>
    | Readonly<{
        status: "unavailable";
        reason: "operation_unavailable" | "current_read_authority_unavailable";
      }>
  >;
  acknowledgeSharedAgentOutput?(input: Readonly<{
    userId: string;
    actorId: string;
    roomId: string;
    executionId: string;
    acknowledgementBytes: Uint8Array;
    now: number;
  }>): Promise<"verified" | "replayed" | "conflict">;
  recordHumanPeerPublished(input: Readonly<{
    userId: string;
    actorId: string;
    operationId: string;
    planBytes: Uint8Array;
    messageId: number;
    protectedMessageDigest: Uint8Array;
    finalEventDigest: Uint8Array;
    now: number;
  }>): Promise<"published" | "replayed" | "conflict">;
  recordHumanPeerFallback(input: Readonly<{
    actorId: string;
    operationId: string;
    stage:
      | "human_admission"
      | "ordinary_commit"
      | "protected_completion"
      | "product_mapping"
      | "realtime_publication";
    reason:
      | "stale_authority"
      | "integrity_failure"
      | "parity_mismatch"
      | "deadline_expired"
      | "product_conflict"
      | "storage_failure"
      | "transport_failure";
    now: number;
  }>): Promise<"fallback" | "replayed" | "conflict">;
  acknowledgeHumanPeer(input: Readonly<{
    userId: string;
    actorId: string;
    roomId: string;
    operationId: string;
    acknowledgementBytes: Uint8Array;
    now: number;
  }>): Promise<"verified" | "replayed" | "conflict">;
  planHumanPeerAcknowledgement(input: Readonly<{
    userId: string;
    actorId: string;
    roomId: string;
    operationId: string;
    clientDeviceId: string;
  }>): Promise<
    | Readonly<{
        status: "ready";
        subjectHumanId: string;
        clientDeviceId: string;
        clientDeviceSigningKeyGeneration: number;
        hostAuthorizationRevision: number;
      }>
    | Readonly<{
        status: "unavailable";
        reason: "operation_unavailable" | "current_read_authority_unavailable";
      }>
  >;
  recordFallback(input: LiveShadowTurnFallbackInput): Promise<boolean>;
  bindJob(input: LiveShadowTurnJobBindingInput): Promise<boolean>;
  runDispatchOnce<Value>(input: Readonly<{
    operationId: string;
    now: number;
    work(): Promise<Value>;
  }>): Promise<Value>;
  verifyClient(input: LiveShadowClientVerificationInput):
    Promise<LiveShadowClientVerificationResult>;
  recover(input: Readonly<{
    authority: Readonly<{ userId: string; humanActorId: string }>;
    roomId: string;
    operationId: string;
  }>): Promise<LiveShadowTurnRecoveryResult>;
  runAgentTurn<Value>(input: Readonly<{
    operationId: string;
    capability: LiveShadowExecutionCapability;
    entrypointId?: "foreground.main" | "foreground.fork";
    expectedMergedHumanContent?: string;
    work(
      session: LiveShadowAgentTurnSession,
      openedHumanContent?: string,
      authorizationSignal?: AbortSignal,
    ): Promise<Value>;
  }>): Promise<LiveShadowAgentTurnExecutionResult<Value>>;
  teardownForegroundAuthorizationSessions?(input: Readonly<{
    authority: Readonly<{ userId: string; humanActorId: string }>;
  }>): void;
  reconcileLifecycle?(input?: Readonly<{
    now?: number;
    maximum?: number;
  }>): Promise<Readonly<{
    turnOperations: number;
    humanPeerOperations: number;
    sharedAgentOperations: number;
  }>>;
  shutdown(): Promise<void>;
}

const installedCompositions = new WeakMap<
  FastifyInstance,
  ProductionLiveShadowMessageComposition
>();

export function installProductionLiveShadowMessageComposition(
  app: FastifyInstance,
  composition: ProductionLiveShadowMessageComposition,
): void {
  installedCompositions.set(app, composition);
}

export function getProductionLiveShadowMessageComposition(
  app: FastifyInstance,
): ProductionLiveShadowMessageComposition | null {
  return installedCompositions.get(app) ?? null;
}

export function uninstallProductionLiveShadowMessageComposition(
  app: FastifyInstance,
): void {
  installedCompositions.delete(app);
}

function fallback(
  operationId: string,
  reason: Extract<LiveShadowHumanAdmissionResult, {
    status: "ordinary_fallback";
  }>["reason"],
  messageId: number | null = null,
): LiveShadowHumanAdmissionResult {
  return Object.freeze({
    status: "ordinary_fallback" as const,
    operationId,
    reason,
    messageId,
  });
}

function legacySharedAgentRecipientId(
  plan: ReturnType<typeof decodeSharedAgentLiveShadowMessagePlanV1>
    | ReturnType<typeof decodeHumanAiReadableLiveShadowMessagePlan>,
): string {
  if (!("recipientAgentId" in plan)) {
    throw new TypeError("Legacy shared-Agent plan recipient is absent");
  }
  return plan.recipientAgentId;
}

/** Lazy construction keeps app registration and plaintext-only startup DB-free. */
export function createProductionLiveShadowMessageComposition(input: Readonly<{
  wakeForegroundMemoryEffectRecovery: () => void;
  resolveReadableNamespaces?: ResolveLiveShadowReadableNamespaces;
  loadRuntimePolicy?: () => Promise<StrictShadowEnforcementPolicy>;
}>): ProductionLiveShadowMessageComposition {
  const wakeForegroundMemoryEffectRecovery =
    input.wakeForegroundMemoryEffectRecovery;
  const loadRuntimePolicy = input.loadRuntimePolicy
    ?? (() => getEncryptionTransitionPolicy(getServerDirectDb()));
  const preparedPolicyMatches = async (
    revision: number,
    representationMode: "shadow_encryption" | "full_encryption" | undefined,
  ): Promise<boolean> => {
    const policy = await loadRuntimePolicy();
    return policy.revision === revision && policy.mode !== "plaintext_only"
      && (policy.mode === "encrypted_only") === (representationMode === "full_encryption");
  };
  const serverId = process.env["NAUTILO_PUBLIC_BASE_URL"]?.trim()
    || "http://localhost:3001";
  const agentFallback = <Value>(
    operationId: string,
    stage: string,
  ): LiveShadowAgentTurnExecutionResult<Value> => {
    log(`[live-shadow] Agent turn fallback operation=${operationId} stage=${stage}`);
    return Object.freeze({
      status: "ordinary_fallback" as const,
      reason: stage,
    });
  };
  const recipients = new LiveShadowRecipientRegistry();
  let pendingAttention: ReturnType<typeof createProductionForegroundPendingAttention> | undefined;
  const foregroundAuthorizations =
    new LiveShadowForegroundAuthorizationSessions();
  const crypto = new LatticeCrypto();
  const agentPlans = new Map<string, Readonly<{
    bytes: Uint8Array;
    deadlineAt: number;
    source: "turn" | "shared_execution" | "shared_resume";
  }>>();
  const dispatches = new Map<string, Readonly<{
    promise: Promise<unknown>;
    expiresAt: number;
  }>>();
  const sharedAgentAuthorizationWaiters = new Map<string, Readonly<{
    resolve(value: Readonly<{
      capability: ForegroundLiveShadowSessionExecutionCapability;
      planBytes: Uint8Array;
    }> | null): void;
    timer: ReturnType<typeof setTimeout>;
  }>>();
  const sharedAgentAcceptedAuthorizations = new Map<string, Readonly<{
    capability: ForegroundLiveShadowSessionExecutionCapability;
    planBytes: Uint8Array;
    expiresAt: number;
    timer: ReturnType<typeof setTimeout>;
  }>>();
  const runtimeInvocationAuthorizationWaiters = new Map<string, Readonly<{
    resolve(value: Readonly<{
      capability: ForegroundLiveShadowSessionExecutionCapability;
    }> | null): void;
    timer: ReturnType<typeof setTimeout>;
  }>>();
  const runtimeInvocationAcceptedAuthorizations = new Map<string, Readonly<{
    capability: ForegroundLiveShadowSessionExecutionCapability;
    expiresAt: number;
    timer: ReturnType<typeof setTimeout>;
  }>>();
  const destroyRuntimeInvocationAcceptedAuthorization = (accepted: Readonly<{
    capability: ForegroundLiveShadowSessionExecutionCapability;
    timer: ReturnType<typeof setTimeout>;
  }>): void => {
    clearTimeout(accepted.timer);
    accepted.capability.authorizationDigest.fill(0);
    accepted.capability.scope.domainAuthoritySetDigest.fill(0);
  };
  const publishAcceptedRuntimeInvocationAuthorization = (
    invocationId: string,
    capability: ForegroundLiveShadowSessionExecutionCapability,
    expiresAt: number,
  ): void => {
    const waiter = runtimeInvocationAuthorizationWaiters.get(invocationId);
    if (waiter !== undefined) {
      clearTimeout(waiter.timer);
      runtimeInvocationAuthorizationWaiters.delete(invocationId);
      waiter.resolve(Object.freeze({ capability }));
      return;
    }
    const timer = setTimeout(() => {
      const retained = runtimeInvocationAcceptedAuthorizations.get(
        invocationId,
      );
      if (retained?.capability !== capability) return;
      runtimeInvocationAcceptedAuthorizations.delete(invocationId);
      destroyRuntimeInvocationAcceptedAuthorization(retained);
    }, Math.max(0, expiresAt - Date.now()));
    timer.unref?.();
    const retained = Object.freeze({ capability, expiresAt, timer });
    const prior = runtimeInvocationAcceptedAuthorizations.get(invocationId);
    if (prior !== undefined) {
      destroyRuntimeInvocationAcceptedAuthorization(prior);
    }
    runtimeInvocationAcceptedAuthorizations.set(invocationId, retained);
  };
  const destroySharedAgentAcceptedAuthorization = (
    executionId: string,
    accepted: Readonly<{
      capability: ForegroundLiveShadowSessionExecutionCapability;
      planBytes: Uint8Array;
      timer: ReturnType<typeof setTimeout>;
    }>,
  ): void => {
    clearTimeout(accepted.timer);
    accepted.capability.authorizationDigest.fill(0);
    accepted.capability.scope.domainAuthoritySetDigest.fill(0);
    accepted.planBytes.fill(0);
    const retained = agentPlans.get(executionId);
    if (retained?.source === "shared_execution") {
      retained.bytes.fill(0);
      agentPlans.delete(executionId);
    }
  };
  let planner: PostgresLiveShadowTurnPlanner | null = null;
  let humanPeerPlanner: PostgresHumanPeerLiveShadowPlanner | null = null;
  let sharedAgentPlanner: PostgresSharedAgentLiveShadowPlanner | null = null;
  let humanMessageEditPlanner: Promise<PostgresHumanMessageEditPlanner> | null = null;
  const resolveReadableNamespaces: ResolveLiveShadowReadableNamespaces =
    input.resolveReadableNamespaces ?? (async (coordinates) => {
      const resolver = getPolicyResolver();
      if (resolver === null) {
        throw new Error("Policy resolver unavailable for live Shadow plan");
      }
      const envelope = await resolver.buildEnvelope(
        coordinates.humanActorId,
        `room:${coordinates.roomId}`,
        coordinates.agentId,
        coordinates.roomId,
      );
      return envelopeReadableNamespaces(envelope);
    });
  const getPlanner = (): PostgresLiveShadowTurnPlanner => {
    planner ??= createPostgresLiveShadowTurnPlanner({
      product: createPostgresJsBridgeConnection(getServerDirectDb()),
      restricted: createPostgresJsBridgeConnection(getSharedDirectCryptoDb()),
      recipients,
      serverId,
      resolveReadableNamespaces,
      foregroundAuthorizations,
    });
    return planner;
  };
  const getHumanPeerPlanner = (): PostgresHumanPeerLiveShadowPlanner => {
    humanPeerPlanner ??= createPostgresHumanPeerLiveShadowPlanner({
      product: createPostgresJsBridgeConnection(getServerDirectDb()),
      restricted: createPostgresJsBridgeConnection(getSharedDirectCryptoDb()),
      serverId,
    });
    return humanPeerPlanner;
  };
  const getSharedAgentPlanner = (): PostgresSharedAgentLiveShadowPlanner => {
    sharedAgentPlanner ??= createPostgresSharedAgentLiveShadowPlanner({
      product: createPostgresJsBridgeConnection(getServerDirectDb()),
      restricted: createPostgresJsBridgeConnection(getSharedDirectCryptoDb()),
      resolveReadableNamespaces,
      serverId,
    });
    return sharedAgentPlanner;
  };
  const getHumanMessageEditPlanner = (): Promise<PostgresHumanMessageEditPlanner> => {
    humanMessageEditPlanner ??= (async () => {
      const productDb = getServerDirectDb();
      const productConnection = createPostgresJsBridgeConnection(productDb);
      const restrictedConnection = createPostgresJsBridgeConnection(getSharedDirectCryptoDb());
      const [productHandle, cryptoHandle] = await Promise.all([
        verifyConversationProductPostgresHandle(productConnection),
        verifyCryptoPostgresHandle(restrictedConnection),
      ]);
      const product = new PostgresConversationProductStore(
        productHandle,
        bindConversationProductCanonicalTransactionRunner(
          productHandle,
          createPostgresJsCanonicalBridgeConnection(productDb),
        ),
      );
      return new PostgresHumanMessageEditPlanner(
        productConnection,
        restrictedConnection,
        product,
        crypto,
        serverId,
        async () => loadRuntimePolicy(),
        async ({ revision, plan, signingPublicKey }) => {
          const completion = createPostgresConversationCryptoCompletion({
            handle: cryptoHandle,
            crypto,
            resolveCurrentWriteAuthorization: (context) => {
              const envelope = context.envelopes[0];
              const target = plan.targets.find((candidate) =>
                candidate.cryptoObjectId === context.objectId
              );
              if (
                target === undefined
                || context.committerDeviceId !== plan.committerDeviceId
                || context.hostAuthorizationRevision !== plan.hostAuthorizationRevision
                || context.envelopes.length !== 1
                || envelope?.namespaceId !== target.namespaceId
                || envelope.keyClass !== target.keyClass
                || envelope.keyGeneration !== target.namespaceKeyGeneration
                || envelope.bindingRevisionAtWrap !== target.namespaceAccessRevision
              ) return null;
              return {
                ...context,
                sourceAuthorized: true,
                targetAuthorized: true,
                currentHostAuthorizationRevision: context.hostAuthorizationRevision,
                committerSigningPublicKey: signingPublicKey.slice(),
              };
            },
            resolveHistoricalSigner: (context) =>
              context.committerDeviceId === plan.committerDeviceId
                  && context.hostAuthorizationRevision === plan.hostAuthorizationRevision
                ? { ...context, committerSigningPublicKey: signingPublicKey.slice() }
                : null,
          });
          return completion.complete(revision);
        },
      );
    })();
    return humanMessageEditPlanner;
  };

  const retainAdmission = async (
    prepared: LiveShadowHumanPreparedAttempt,
    plan: Readonly<{ operationId: string; deadlineAt: number }>,
    result: LiveShadowHumanAdmissionResult,
  ): Promise<LiveShadowHumanAdmissionResult> => {
    if (result.status === "ordinary_fallback") {
      let stage: LiveShadowTurnFallbackInput["stage"] = "human_admission";
      try {
        const foregroundPlan = decodeLiveShadowMessagePlanV4(
          prepared.planBytes,
        );
        stage = foregroundPlan.authorization.disposition
            === "authorization_required"
          ? "session_establishment"
          : "session_reuse";
        destroyForegroundPlan(foregroundPlan);
      } catch {
        // Earlier protocols keep their historical admission stage.
      }
      const reason = result.reason === "authority_stale"
        ? "stale_authority"
        : result.reason === "deadline_expired"
          ? "deadline_expired"
          : result.reason === "restart_lost"
            ? "recipient_lost"
            : result.reason === "human_parity_failed"
              ? "parity_mismatch"
              : result.reason === "human_persistence_failed"
                ? "product_conflict"
                : "integrity_failure";
      await getPlanner().recordFallback({
        authority: {
          userId: prepared.userId,
          humanActorId: prepared.actorId,
        },
        operationId: prepared.operationId,
        planBytes: prepared.planBytes,
        stage,
        reason,
        now: prepared.now,
      });
      return result;
    }
    if (result.status !== "human_verified") return result;
    for (const [operationId, retained] of agentPlans) {
      if (retained.deadlineAt <= prepared.now) {
        retained.bytes.fill(0);
        agentPlans.delete(operationId);
      }
    }
    if (agentPlans.size >= 128 && !agentPlans.has(plan.operationId)) {
      result.capability.authorizationDigest.fill(0);
      result.capability.scope.domainAuthoritySetDigest.fill(0);
      await getPlanner().recordFallback({
        authority: {
          userId: prepared.userId,
          humanActorId: prepared.actorId,
        },
        operationId: prepared.operationId,
        planBytes: prepared.planBytes,
        stage: "agent_input",
        reason: "protected_unavailable",
        now: prepared.now,
      });
      return fallback(
        prepared.operationId,
        "agent_capacity_unavailable",
        result.messageId,
      );
    }
    const prior = agentPlans.get(plan.operationId);
    prior?.bytes.fill(0);
    agentPlans.set(plan.operationId, Object.freeze({
      bytes: prepared.planBytes.slice(),
      deadlineAt: plan.deadlineAt,
      source: "turn",
    }));
    return result;
  };

  const destroyForegroundPlan = (
    plan: ForegroundSessionLiveShadowMessagePlan,
  ): void => {
    plan.agentSignerPublicKey.fill(0);
    plan.namespaceHeadDigest.fill(0);
    plan.namespacePublicationDigest.fill(0);
    plan.namespacePublicationSetDigest.fill(0);
    plan.namespaceAudienceFingerprint.fill(0);
    plan.grantDomainParticipantDigest.fill(0);
    plan.grantDomainHeadDigest.fill(0);
    plan.grantDomainPublicationDigest.fill(0);
    plan.namespaceBundleDigest.fill(0);
    if (plan.authorization.disposition === "authorization_required") {
      plan.authorization.authorizationPlanBytes.fill(0);
      plan.authorization.authorizationPlanDigest.fill(0);
      plan.authorization.recipientPublicKey.fill(0);
    } else {
      plan.authorization.authorizationDigest.fill(0);
    }
  };

  const admitPreparedForeground = async (
    prepared: LiveShadowHumanPreparedAttempt,
    plan: ForegroundSessionLiveShadowMessagePlan,
    source: "turn" | "shared_execution" | "shared_resume" = "turn",
  ): Promise<LiveShadowHumanAdmissionResult> => {
    if (!await preparedPolicyMatches(plan.policyRevision, prepared.representationMode)) {
      destroyForegroundPlan(plan);
      return fallback(prepared.operationId, "authority_stale");
    }
    const productDb = getServerDirectDb();
    const productConnection = createPostgresJsBridgeConnection(productDb);
    const restrictedConnection = createPostgresJsBridgeConnection(
      getSharedDirectCryptoDb(),
    );
    const authority = await createPostgresDomainKeyV2LiveShadowCurrentAuthority({
          product: productConnection,
          restricted: restrictedConnection,
          crypto,
          serverId,
          plan,
          representationMode: prepared.representationMode === "full_encryption"
            ? "full_encryption"
            : "shadow_encryption",
          resolveReadableNamespaces,
          source,
        });
    if (authority === null) {
      destroyForegroundPlan(plan);
      return fallback(prepared.operationId, "authority_stale");
    }
    let signingPublicKey: Uint8Array | null = null;
    let current: Awaited<ReturnType<
      DomainKeyV2LiveShadowCurrentAuthority[
        "resolveCurrentForegroundAuthorization"
      ]
    >> = null;
    let scopeDigest: Uint8Array | null = null;
    try {
      current = await authority.resolveCurrentForegroundAuthorization();
      signingPublicKey = authority.signingPublicKey();
      if (
        current === null
        || current.recipientKind !== "agent"
        || signingPublicKey === null
      ) {
        return fallback(prepared.operationId, "authority_stale");
      }
      const agentCurrent = current;
      scopeDigest = domainForegroundAuthoritySetDigest(
        crypto,
        agentCurrent.domains,
      );
      const scope: LiveShadowForegroundAuthorizationScope = Object.freeze({
        subjectHumanId: plan.subjectHumanId,
        issuingDeviceId: plan.committerDeviceId,
        recipientAgentId: plan.recipientAgentId,
        sessionId: plan.sessionId,
        roomId: plan.roomId,
        policyRevision: plan.policyRevision,
        hostAuthorizationRevision: plan.hostAuthorizationRevision,
        agentAuthorizationRevision: plan.agentAuthorizationRevision,
        // The invocation grant already covers the Human's complete readable
        // Domain set. Preserve the matching Namespace snapshot here so the
        // entity gateway can open cross-Room and multi-Namespace Memories
        // without weakening its per-entity scope check.
        namespaceIds: Object.freeze([...agentCurrent.readableNamespaceIds]),
        grantDomainIds: Object.freeze(
          agentCurrent.domains.map((entry) => entry.domainId),
        ),
        domainAuthoritySetDigest: scopeDigest.slice(),
      });
      const [productHandle, cryptoHandle] = await Promise.all([
        verifyConversationProductPostgresHandle(productConnection),
        verifyCryptoPostgresHandle(restrictedConnection),
      ]);
      const product = new PostgresConversationProductStore(
        productHandle,
        bindConversationProductCanonicalTransactionRunner(
          productHandle,
          createPostgresJsCanonicalBridgeConnection(productDb),
        ),
      );
      const completion = createPostgresConversationCryptoCompletion({
        handle: cryptoHandle,
        crypto,
        resolveCurrentWriteAuthorization:
          authority.resolveCurrentHumanObjectWrite,
        resolveHistoricalSigner: (context) =>
          context.committerDeviceId === plan.committerDeviceId
              && context.hostAuthorizationRevision
                === plan.hostAuthorizationRevision
            ? Object.freeze({
              ...context,
              committerSigningPublicKey: signingPublicKey!.slice(),
            })
            : null,
        resolveLiveShadowAgentSigner: (principal) =>
          principal.agentId === plan.recipientAgentId
              && principal.runtimeGeneration === plan.agentRuntimeGeneration
              && principal.signerKeyId === plan.agentSignerKeyId
            ? plan.agentSignerPublicKey.slice()
            : null,
      });
      const admitted = await admitForegroundSessionHumanLiveShadowMessage({
        crypto,
        expectedPlanBytes: prepared.planBytes,
        requestBytes: prepared.requestBytes,
        ...(prepared.representationMode === "full_encryption"
          ? { contentRepresentation: "full" as const }
          : { ordinaryPayloadBytes: prepared.ordinaryPayloadBytes }),
        encryptedPayloadBytes: prepared.encryptedPayloadBytes,
        manifestBytes: prepared.manifestBytes,
        envelopeBytes: prepared.envelopeBytes,
        now: prepared.now,
        resolveCurrentHumanAuthority: (context) =>
          context.subjectHumanId === plan.subjectHumanId
              && context.operationId === plan.operationId
              && context.committerDeviceId === plan.committerDeviceId
              && context.committerDeviceSigningKeyGeneration
                === plan.committerDeviceSigningKeyGeneration
              && context.hostAuthorizationRevision
                === plan.hostAuthorizationRevision
            ? signingPublicKey!.slice()
            : null,
      }).catch(() => null);
      if (admitted === null) {
        return fallback(prepared.operationId, "request_invalid");
      }
      let sessionReference: string | null = null;
      let authorizationDigest: Uint8Array | null = null;
      let newlyRegistered = false;
      let accepted = false;
      const authorizationId = agentCurrent.authorizationId;
      const currentRecipientKeyId = agentCurrent.recipientKeyId;
      const currentRuntimeGeneration = agentCurrent.recipientRuntimeGeneration;
      const currentIssuedAt = agentCurrent.issuedAt;
      const currentDeadlineAt = agentCurrent.deadlineAt;
      try {
        if (
          plan.authorization.disposition === "authorization_required"
          && admitted.authorization.kind === "establish"
        ) {
          const requiredAuthorization = plan.authorization;
          const establishment = admitted.authorization;
          const recipient = recipients.take({
            operationId: plan.operationId,
            clientActionSessionId: prepared.clientActionSessionId,
            actorId: prepared.actorId,
          });
          if (
            recipient === null
            || recipient.publicKey.length
              !== requiredAuthorization.recipientPublicKey.length
            || !recipient.publicKey.every((value, index) =>
              value === requiredAuthorization.recipientPublicKey[index]
            )
          ) {
            recipient?.publicKey.fill(0);
            if (recipient !== null) {
              destroyProtectedInvocationRecipient(recipient.recipient);
            }
            return fallback(prepared.operationId, "restart_lost");
          }
          recipient.publicKey.fill(0);
          try {
            const register = (entries: Parameters<
              typeof createDomainCompressedLiveShadowSessionCapability
            >[0]["entries"]) => {
              authorizationDigest = crypto.hash(
                establishment.authorizationBytes,
              );
              const capability =
                createDomainCompressedLiveShadowSessionCapability({
                  description: {
                    authorizationId,
                    subjectHumanId: plan.subjectHumanId,
                    issuingDeviceId: plan.committerDeviceId,
                    recipientAgentId: plan.recipientAgentId,
                    recipientKeyId: currentRecipientKeyId,
                    sessionId: plan.sessionId,
                    roomId: plan.roomId,
                    policyRevision: plan.policyRevision,
                    hostAuthorizationRevision:
                      plan.hostAuthorizationRevision,
                    agentAuthorizationRevision:
                      plan.agentAuthorizationRevision,
                    agentRuntimeGeneration: currentRuntimeGeneration,
                    namespaceIds: scope.namespaceIds,
                    grantDomainIds: scope.grantDomainIds,
                    issuedAt: currentIssuedAt,
                    expiresAt: currentDeadlineAt,
                    authorizationDigest,
                  },
                  entries,
                });
              const registered = foregroundAuthorizations.register({
                capability,
                scope,
                publicEvidence: {
                  authorizationDigest,
                  authorizationPlanBytes:
                    requiredAuthorization.authorizationPlanBytes,
                  authorizationPlanDigest:
                    requiredAuthorization.authorizationPlanDigest,
                  recipientId: requiredAuthorization.recipientId,
                  recipientKeyId: currentRecipientKeyId,
                  recipientPublicKey:
                    requiredAuthorization.recipientPublicKey,
                },
                now: prepared.now,
              });
              if (registered === null) return null;
              sessionReference = registered.sessionReference;
              newlyRegistered = true;
              registered.authorizationDigest.fill(0);
              registered.authorizationPlanBytes.fill(0);
              registered.authorizationPlanDigest.fill(0);
              registered.recipientPublicKey.fill(0);
              return true;
            };
            const opened = await withProtectedInvocationRecipientPrivateKey(
              recipient.recipient,
              (privateKey) => withOpenedDomainForegroundAuthorization(
                  crypto,
                  {
                    authorizationBytes: establishment.authorizationBytes,
                    now: prepared.now,
                    current: Object.freeze({
                      ...agentCurrent,
                      recipientEncryptionPrivateKey: privateKey,
                    }),
                    operation: (entries) => register(Object.freeze(
                      entries.map((entry) => Object.freeze({
                        grantDomainId: entry.domainId,
                        domainKeyGeneration: entry.domainKeyGeneration,
                        participantDigest: entry.participantDigest,
                        headDigest: entry.headDigest,
                        authorizationRevision: entry.authorizationRevision,
                        domainAiGrantKey: entry.domainKey,
                      })),
                    )),
                  },
                ),
            );
            if (
              opened === null
              || opened.status !== "opened"
              || opened.value !== true
              || sessionReference === null
              || authorizationDigest === null
            ) return fallback(prepared.operationId, "grant_invalid");
          } finally {
            destroyProtectedInvocationRecipient(recipient.recipient);
          }
        } else if (
          plan.authorization.disposition === "authorization_reusable"
          && admitted.authorization.kind === "reuse"
        ) {
          sessionReference = admitted.authorization.sessionReference;
          authorizationDigest = admitted.authorization.authorizationDigest.slice();
        } else {
          return fallback(prepared.operationId, "request_invalid");
        }

        let openedHumanContent: string | undefined;
        const opened = await foregroundAuthorizations.execute({
          sessionReference,
          scope,
          operationDeadline: plan.deadlineAt,
          execute: async (capability) => {
            const value = await withDomainCompressedLiveShadowSessionCapabilityEntries(
              capability,
              (domains) => authority.withCurrentRoomNamespaceKey({
                    domains: Object.freeze(domains.map((entry) =>
                      Object.freeze({
                        domainId: entry.grantDomainId,
                        sourceNamespaceId: plan.namespaceId,
                        participantDigest: entry.participantDigest,
                        participantCount: 1,
                        keyClass: "ai" as const,
                        domainKeyGeneration: entry.domainKeyGeneration,
                        authorizationRevision: entry.authorizationRevision,
                        headDigest: entry.headDigest,
                        domainKey: entry.domainAiGrantKey,
                      })
                    )),
                    use: (namespaceKey) => {
                      const encrypted = decodeEncryptedPayloadV2(
                        prepared.encryptedPayloadBytes,
                      );
                      const envelope = decodeNamespaceObjectEnvelopeV2(
                        prepared.envelopeBytes,
                      );
                      try {
                        const plaintext = decryptObjectThroughNamespace(
                          crypto,
                          namespaceKey,
                          envelope,
                          encrypted,
                        );
                        if (plaintext === null) return false;
                        try {
                          const digest = crypto.hash(plaintext);
                          try {
                            if (!digest.every((value, index) =>
                              value === admitted.plaintextPayloadDigest[index]
                            ) || digest.length !== admitted.plaintextPayloadDigest.length) return false;
                          } finally { digest.fill(0); }
                          const payload = decodeMessagePayloadV2(plaintext);
                          if (payload.role !== "user" || payload.toolCalls !== undefined
                            || payload.toolName !== undefined) return false;
                          if (prepared.representationMode !== "full_encryption" && (
                            plaintext.length !== prepared.ordinaryPayloadBytes.length
                            || !plaintext.every((value, index) => value === prepared.ordinaryPayloadBytes[index])
                          )) return false;
                          openedHumanContent = payload.content;
                          return true;
                        } finally {
                          plaintext.fill(0);
                        }
                      } finally {
                        encrypted.ciphertext.fill(0);
                        envelope.wrappedDek.fill(0);
                      }
                    },
                  }),
            );
            return value === true
              ? Object.freeze({ status: "executed" as const, value: true })
              : Object.freeze({
                status: "unavailable" as const,
                reason: "content_unavailable" as const,
              });
          },
        });
        if (opened.status !== "executed" || opened.value !== true) {
          return fallback(prepared.operationId, "protected_open_failed");
        }
        const executionCapability:
          ForegroundLiveShadowSessionExecutionCapability = Object.freeze({
            kind: "foreground_session",
            sessionReference,
            authorizationDigest: authorizationDigest.slice(),
            scope: Object.freeze({
              ...scope,
              namespaceIds: Object.freeze([...scope.namespaceIds]),
              grantDomainIds: Object.freeze([...scope.grantDomainIds]),
              domainAuthoritySetDigest: scope.domainAuthoritySetDigest.slice(),
            }),
          });
        if (source === "shared_execution") {
          const protectedMessage = parseProtectedMessageDtoV2({
            dtoVersion: 2,
            projection: {
              messageId: String(plan.humanMessageId),
              sessionId: plan.sessionId,
              roomId: plan.roomId,
              namespaceId: plan.namespaceId,
              role: "user",
              createdAt: new Date(plan.createdAt).toISOString(),
              editRevision: 0,
            },
            protectedPayload: {
              status: "encrypted",
              cryptoObjectId: admitted.prepared.objectId,
              payloadVersion: 2,
              keyClass: "ai",
              encryptedPayloadBytesBase64url:
                Buffer.from(prepared.encryptedPayloadBytes).toString("base64url"),
              accessManifestBytesBase64url:
                Buffer.from(prepared.manifestBytes).toString("base64url"),
              namespaceEnvelopeBytesBase64url:
                Buffer.from(prepared.envelopeBytes).toString("base64url"),
            },
          });
          const sharedPlanDigest = crypto.hash(prepared.planBytes);
          let updated;
          try {
            updated = await productConnection.query(
              `/* m296_shared_agent_execution_authorized */
               UPDATE conversation_shared_agent_shadow_executions
                  SET state = 'authorized', authorization_disposition = $2,
                      authorization_digest = $3,
                      authorization_session_reference = $4,
                      authorized_at = $5, updated_at = $5
                WHERE execution_id = $1
                  AND state = 'awaiting_authorization'
                  AND plan_digest = $6
              RETURNING execution_id`,
              [plan.operationId,
                plan.authorization.disposition === "authorization_required"
                  ? "establish"
                  : "reuse",
                authorizationDigest, sessionReference, new Date(prepared.now),
                sharedPlanDigest],
            );
          } finally {
            sharedPlanDigest.fill(0);
          }
          if (updated.length !== 1) {
            executionCapability.authorizationDigest.fill(0);
            executionCapability.scope.domainAuthoritySetDigest.fill(0);
            return fallback(prepared.operationId, "integrity_conflict");
          }
          agentPlans.set(plan.operationId, Object.freeze({
            bytes: prepared.planBytes.slice(),
            deadlineAt: plan.deadlineAt,
            source: "shared_execution",
          }));
          accepted = true;
          return Object.freeze({
            status: "human_verified" as const,
            operationId: plan.operationId,
            messageId: plan.humanMessageId,
            content: openedHumanContent!,
            protectedMessage,
            capability: executionCapability,
          });
        }
        const result = await persistForegroundSessionHumanLiveShadowMessage(
          {
            crypto,
            product,
            conversation: createDormantConversationShadowRepository({
              product,
              crypto: completion,
            }),
          },
          prepared,
          admitted,
          executionCapability,
          openedHumanContent,
        );
        const retained = await retainAdmission(prepared, plan, result);
        accepted = retained.status === "human_verified";
        return retained;
      } finally {
        if (newlyRegistered && !accepted) {
          foregroundAuthorizations.cancelScope(scope);
        }
        authorizationDigest?.fill(0);
        admitted.requestDigest.fill(0);
        admitted.plaintextPayloadDigest.fill(0);
        admitted.authorization.authorizationDigest.fill(0);
        if (admitted.authorization.kind === "establish") {
          admitted.authorization.authorizationBytes.fill(0);
        }
      }
    } finally {
      signingPublicKey?.fill(0);
      current?.committerDeviceSigningPublicKey.fill(0);
      current?.domains.forEach((entry) => {
        entry.participantDigest.fill(0);
        entry.headDigest.fill(0);
        entry.activeNamespaceBindingSetDigest.fill(0);
      });
      scopeDigest?.fill(0);
      authority.destroy();
      destroyForegroundPlan(plan);
    }
  };

  const admitPrepared = async (
    prepared: LiveShadowHumanPreparedAttempt,
  ): Promise<LiveShadowHumanAdmissionResult> => {
    try {
      const foreground = decodeLiveShadowMessagePlanV4(prepared.planBytes);
      return admitPreparedForeground(prepared, foreground);
    } catch {
      return fallback(prepared.operationId, "request_invalid");
    }
  };

  const admitHumanPeer = async (
    prepared: HumanPeerLiveShadowPreparedAttempt & Readonly<{
      userId: string;
      actorId: string;
    }>,
  ): Promise<HumanPeerLiveShadowAdmissionResult> => {
    let plan;
    try {
      plan = decodeHumanPeerLiveShadowMessagePlanV1(prepared.planBytes);
    } catch {
      return Object.freeze({
        status: "ordinary_fallback" as const,
        operationId: prepared.operationId,
        reason: "request_invalid" as const,
        messageId: null,
      });
    }
    const destroyPlan = () => {
      plan.namespaceHeadDigest.fill(0);
      plan.namespacePublicationDigest.fill(0);
      plan.namespacePublicationSetDigest.fill(0);
      plan.namespaceAudienceFingerprint.fill(0);
    };
    if (!await preparedPolicyMatches(plan.policyRevision, prepared.representationMode)) {
      destroyPlan();
      return Object.freeze({
        status: "ordinary_fallback" as const, operationId: prepared.operationId,
        reason: "authority_stale" as const, messageId: null,
      });
    }
    const same = (left: Uint8Array, right: Uint8Array) =>
      left.length === right.length
      && left.every((value, index) => value === right[index]);
    const productDb = getServerDirectDb();
    const productConnection = createPostgresJsBridgeConnection(productDb);
    const restrictedConnection = createPostgresJsBridgeConnection(
      getSharedDirectCryptoDb(),
    );
    const productAuthority = new PostgresNamespaceProductAuthority(
      productConnection,
    );
    const repository = new PostgresDomainKeyAuthorityRepository(
      restrictedConnection,
      crypto,
      serverId,
    );
    const current = await productAuthority.withCurrentHumanOnlyRoom({
      subjectUserId: prepared.userId,
      subjectHumanId: prepared.actorId,
      roomId: plan.roomId,
      namespaceId: plan.namespaceId,
      use: (authority) => repository.inspectSharedAgentWriteAuthority({
        authority,
        deviceId: plan.committerDeviceId,
        keyClass: "human",
      }),
    });
    if (
      current === null
      || current.status !== "ready"
      || current.subjectHumanId !== plan.subjectHumanId
      || current.committerDeviceId !== plan.committerDeviceId
      || current.committerDeviceSigningKeyGeneration
        !== plan.committerDeviceSigningKeyGeneration
      || current.committerDeviceRevision !== plan.hostAuthorizationRevision
      || current.namespaceId !== plan.namespaceId
      || current.namespaceAccessRevision !== plan.namespaceAccessRevision
      || current.namespaceKeyGeneration !== plan.namespaceKeyGeneration
      || !same(current.namespaceHeadDigest, plan.namespaceHeadDigest)
      || !same(
        current.namespacePublicationDigest,
        plan.namespacePublicationDigest,
      )
      || !same(
        current.namespacePublicationSetDigest,
        plan.namespacePublicationSetDigest,
      )
      || !same(
        current.namespaceAudienceFingerprint,
        plan.namespaceAudienceFingerprint,
      )
    ) {
      if (current?.status === "ready") {
        current.committerDeviceSigningPublicKey.fill(0);
        current.namespaceHeadDigest.fill(0);
        current.namespacePublicationDigest.fill(0);
        current.namespacePublicationSetDigest.fill(0);
        current.namespaceAudienceFingerprint.fill(0);
      }
      destroyPlan();
      return Object.freeze({
        status: "ordinary_fallback" as const,
        operationId: prepared.operationId,
        reason: "authority_stale" as const,
        messageId: null,
      });
    }
    const signingPublicKey =
      current.committerDeviceSigningPublicKey.slice();
    try {
      const [productHandle, cryptoHandle] = await Promise.all([
        verifyConversationProductPostgresHandle(productConnection),
        verifyCryptoPostgresHandle(restrictedConnection),
      ]);
      const product = new PostgresConversationProductStore(
        productHandle,
        bindConversationProductCanonicalTransactionRunner(
          productHandle,
          createPostgresJsCanonicalBridgeConnection(productDb),
        ),
      );
      const currentWrite = (context: Parameters<
        Parameters<typeof createPostgresConversationCryptoCompletion>[0][
          "resolveCurrentWriteAuthorization"
        ]
      >[0]) => {
        const envelope = context.envelopes[0];
        if (
          context.committerDeviceId !== plan.committerDeviceId
          || context.hostAuthorizationRevision
            !== plan.hostAuthorizationRevision
          || context.envelopes.length !== 1
          || envelope === undefined
          || envelope.namespaceId !== plan.namespaceId
          || envelope.keyClass !== "human"
          || envelope.keyGeneration !== plan.namespaceKeyGeneration
          || envelope.bindingRevisionAtWrap
            !== plan.namespaceAccessRevision
        ) return null;
        return Object.freeze({
          ...context,
          sourceAuthorized: true,
          targetAuthorized: true,
          currentHostAuthorizationRevision:
            plan.hostAuthorizationRevision,
          committerSigningPublicKey: signingPublicKey.slice(),
        });
      };
      const completion = createPostgresConversationCryptoCompletion({
        handle: cryptoHandle,
        crypto,
        resolveCurrentWriteAuthorization: currentWrite,
        resolveHistoricalSigner: (context) =>
          context.committerDeviceId === plan.committerDeviceId
              && context.hostAuthorizationRevision
                === plan.hostAuthorizationRevision
            ? Object.freeze({
              ...context,
              committerSigningPublicKey: signingPublicKey.slice(),
            })
            : null,
      });
      return await admitAndPersistHumanPeerLiveShadowMessage({
        crypto,
        product,
        sourceUserId: prepared.userId,
        conversation: createDormantConversationShadowRepository({
          product,
          crypto: completion,
        }),
        resolveCurrentHumanAuthority: (context) =>
          context.subjectHumanId === plan.subjectHumanId
              && context.operationId === plan.operationId
              && context.committerDeviceId === plan.committerDeviceId
              && context.committerDeviceSigningKeyGeneration
                === plan.committerDeviceSigningKeyGeneration
              && context.hostAuthorizationRevision
                === plan.hostAuthorizationRevision
            ? signingPublicKey.slice()
            : null,
        senderDeviceSigningPublicKey: signingPublicKey,
      }, prepared);
    } finally {
      signingPublicKey.fill(0);
      current.committerDeviceSigningPublicKey.fill(0);
      current.namespaceHeadDigest.fill(0);
      current.namespacePublicationDigest.fill(0);
      current.namespacePublicationSetDigest.fill(0);
      current.namespaceAudienceFingerprint.fill(0);
      destroyPlan();
    }
  };

  const recordHumanPeerPublished: ProductionLiveShadowMessageComposition[
    "recordHumanPeerPublished"
  ] = async (input) => {
    const plan = decodeHumanPeerLiveShadowMessagePlanV1(input.planBytes);
    const same = (left: Uint8Array, right: Uint8Array) =>
      left.length === right.length
      && left.every((value, index) => value === right[index]);
    const productAuthority = new PostgresNamespaceProductAuthority(
      createPostgresJsBridgeConnection(getServerDirectDb()),
    );
    const current = await productAuthority.withCurrentHumanOnlyRoom({
      subjectUserId: input.userId,
      subjectHumanId: input.actorId,
      roomId: plan.roomId,
      namespaceId: plan.namespaceId,
      use: (authority) => new PostgresDomainKeyAuthorityRepository(
        createPostgresJsBridgeConnection(getSharedDirectCryptoDb()),
        crypto,
        serverId,
      ).inspectSharedAgentWriteAuthority({
        authority,
        deviceId: plan.committerDeviceId,
        keyClass: "human",
      }),
    });
    try {
      if (
        input.operationId !== plan.operationId
        || input.messageId !== plan.humanMessageId
        || current === null
        || current.status !== "ready"
        || current.subjectHumanId !== plan.subjectHumanId
        || current.committerDeviceId !== plan.committerDeviceId
        || current.committerDeviceSigningKeyGeneration
          !== plan.committerDeviceSigningKeyGeneration
        || current.committerDeviceRevision !== plan.hostAuthorizationRevision
        || current.namespaceId !== plan.namespaceId
        || current.namespaceAccessRevision !== plan.namespaceAccessRevision
        || current.namespaceKeyGeneration !== plan.namespaceKeyGeneration
        || !same(current.namespaceHeadDigest, plan.namespaceHeadDigest)
        || !same(
          current.namespacePublicationDigest,
          plan.namespacePublicationDigest,
        )
        || !same(
          current.namespacePublicationSetDigest,
          plan.namespacePublicationSetDigest,
        )
        || !same(
          current.namespaceAudienceFingerprint,
          plan.namespaceAudienceFingerprint,
        )
      ) return "conflict";
      return getHumanPeerPlanner().recordPublished(input);
    } finally {
      if (current?.status === "ready") {
        current.committerDeviceSigningPublicKey.fill(0);
        current.namespaceHeadDigest.fill(0);
        current.namespacePublicationDigest.fill(0);
        current.namespacePublicationSetDigest.fill(0);
        current.namespaceAudienceFingerprint.fill(0);
      }
      plan.namespaceHeadDigest.fill(0);
      plan.namespacePublicationDigest.fill(0);
      plan.namespacePublicationSetDigest.fill(0);
      plan.namespaceAudienceFingerprint.fill(0);
    }
  };

  const admitSharedAgent = async (
    prepared: SharedAgentLiveShadowPreparedAttempt & Readonly<{
      userId: string;
      actorId: string;
    }>,
  ): Promise<SharedAgentLiveShadowAdmissionResult> => {
    let plan;
    let humanAiReadable = false;
    try {
      try {
        plan = decodeHumanAiReadableLiveShadowMessagePlan(
          prepared.planBytes,
        );
        humanAiReadable = true;
      } catch {
        plan = decodeSharedAgentLiveShadowMessagePlanV1(prepared.planBytes);
      }
    } catch {
      return Object.freeze({
        status: "ordinary_fallback" as const,
        operationId: prepared.operationId,
        reason: "request_invalid" as const,
        messageId: null,
      });
    }
    const destroyPlan = () => {
      plan.namespaceHeadDigest.fill(0);
      plan.namespacePublicationDigest.fill(0);
      plan.namespacePublicationSetDigest.fill(0);
      plan.namespaceAudienceFingerprint.fill(0);
    };
    if (!await preparedPolicyMatches(plan.policyRevision, prepared.representationMode)) {
      destroyPlan();
      return Object.freeze({
        status: "ordinary_fallback" as const, operationId: prepared.operationId,
        reason: "authority_stale" as const, messageId: null,
      });
    }
    const same = (left: Uint8Array, right: Uint8Array) =>
      left.length === right.length
      && left.every((value, index) => value === right[index]);
    const productDb = getServerDirectDb();
    const productConnection = createPostgresJsBridgeConnection(productDb);
    const restrictedConnection = createPostgresJsBridgeConnection(
      getSharedDirectCryptoDb(),
    );
    const productAuthority = new PostgresNamespaceProductAuthority(
      productConnection,
    );
    const repository = new PostgresDomainKeyAuthorityRepository(
      restrictedConnection,
      crypto,
      serverId,
    );
    const current = humanAiReadable
      ? await productAuthority.withCurrentHumanAiReadableRoom({
        subjectUserId: prepared.userId,
        subjectHumanId: prepared.actorId,
        roomId: plan.roomId,
        namespaceId: plan.namespaceId,
        use: (authority) => repository.inspectSharedAgentWriteAuthority({
          authority,
          deviceId: plan.committerDeviceId,
        }),
      })
      : await productAuthority.withCurrentSharedAgentRoom({
        subjectUserId: prepared.userId,
        subjectHumanId: prepared.actorId,
        roomId: plan.roomId,
        namespaceId: plan.namespaceId,
        recipientAgentId: legacySharedAgentRecipientId(plan),
        use: (authority) => repository.inspectSharedAgentWriteAuthority({
          authority,
          deviceId: plan.committerDeviceId,
        }),
      });
    if (
      current === null
      || current.status !== "ready"
      || current.subjectHumanId !== plan.subjectHumanId
      || current.committerDeviceId !== plan.committerDeviceId
      || current.committerDeviceSigningKeyGeneration
        !== plan.committerDeviceSigningKeyGeneration
      || current.committerDeviceRevision !== plan.hostAuthorizationRevision
      || current.namespaceId !== plan.namespaceId
      || current.namespaceAccessRevision !== plan.namespaceAccessRevision
      || current.namespaceKeyGeneration !== plan.namespaceKeyGeneration
      || !same(current.namespaceHeadDigest, plan.namespaceHeadDigest)
      || !same(
        current.namespacePublicationDigest,
        plan.namespacePublicationDigest,
      )
      || !same(
        current.namespacePublicationSetDigest,
        plan.namespacePublicationSetDigest,
      )
      || !same(
        current.namespaceAudienceFingerprint,
        plan.namespaceAudienceFingerprint,
      )
    ) {
      if (current?.status === "ready") {
        current.committerDeviceSigningPublicKey.fill(0);
        current.namespaceHeadDigest.fill(0);
        current.namespacePublicationDigest.fill(0);
        current.namespacePublicationSetDigest.fill(0);
        current.namespaceAudienceFingerprint.fill(0);
      }
      destroyPlan();
      return Object.freeze({
        status: "ordinary_fallback" as const,
        operationId: prepared.operationId,
        reason: "authority_stale" as const,
        messageId: null,
      });
    }
    const signingPublicKey = current.committerDeviceSigningPublicKey.slice();
    try {
      const [productHandle, cryptoHandle] = await Promise.all([
        verifyConversationProductPostgresHandle(productConnection),
        verifyCryptoPostgresHandle(restrictedConnection),
      ]);
      const product = new PostgresConversationProductStore(
        productHandle,
        bindConversationProductCanonicalTransactionRunner(
          productHandle,
          createPostgresJsCanonicalBridgeConnection(productDb),
        ),
      );
      const currentWrite = (context: Parameters<
        Parameters<typeof createPostgresConversationCryptoCompletion>[0][
          "resolveCurrentWriteAuthorization"
        ]
      >[0]) => {
        const envelope = context.envelopes[0];
        if (
          context.committerDeviceId !== plan.committerDeviceId
          || context.hostAuthorizationRevision
            !== plan.hostAuthorizationRevision
          || context.envelopes.length !== 1
          || envelope === undefined
          || envelope.namespaceId !== plan.namespaceId
          || envelope.keyClass !== "ai"
          || envelope.keyGeneration !== plan.namespaceKeyGeneration
          || envelope.bindingRevisionAtWrap !== plan.namespaceAccessRevision
        ) return null;
        return Object.freeze({
          ...context,
          sourceAuthorized: true,
          targetAuthorized: true,
          currentHostAuthorizationRevision: plan.hostAuthorizationRevision,
          committerSigningPublicKey: signingPublicKey.slice(),
        });
      };
      const completion = createPostgresConversationCryptoCompletion({
        handle: cryptoHandle,
        crypto,
        resolveCurrentWriteAuthorization: currentWrite,
        resolveHistoricalSigner: (context) =>
          context.committerDeviceId === plan.committerDeviceId
              && context.hostAuthorizationRevision
                === plan.hostAuthorizationRevision
            ? Object.freeze({
              ...context,
              committerSigningPublicKey: signingPublicKey.slice(),
            })
            : null,
      });
      const dependencies = {
        crypto,
        product,
        sourceUserId: prepared.userId,
        conversation: createDormantConversationShadowRepository({
          product,
          crypto: completion,
        }),
        senderDeviceSigningPublicKey: signingPublicKey,
      } as const;
      return humanAiReadable
        ? await admitAndPersistHumanAiReadableLiveShadowMessage({
          ...dependencies,
          resolveCurrentHumanAuthority: (context) =>
            context.subjectHumanId === plan.subjectHumanId
                && context.operationId === plan.operationId
                && context.committerDeviceId === plan.committerDeviceId
                && context.committerDeviceSigningKeyGeneration
                  === plan.committerDeviceSigningKeyGeneration
                && context.hostAuthorizationRevision
                  === plan.hostAuthorizationRevision
              ? signingPublicKey.slice()
              : null,
        }, prepared)
        : await admitAndPersistSharedAgentLiveShadowMessage({
          ...dependencies,
          resolveCurrentHumanAuthority: (context) =>
            context.subjectHumanId === plan.subjectHumanId
                && context.recipientAgentId
                  === legacySharedAgentRecipientId(plan)
                && context.operationId === plan.operationId
                && context.committerDeviceId === plan.committerDeviceId
                && context.committerDeviceSigningKeyGeneration
                  === plan.committerDeviceSigningKeyGeneration
                && context.hostAuthorizationRevision
                  === plan.hostAuthorizationRevision
              ? signingPublicKey.slice()
              : null,
        }, prepared);
    } finally {
      signingPublicKey.fill(0);
      current.committerDeviceSigningPublicKey.fill(0);
      current.namespaceHeadDigest.fill(0);
      current.namespacePublicationDigest.fill(0);
      current.namespacePublicationSetDigest.fill(0);
      current.namespaceAudienceFingerprint.fill(0);
      destroyPlan();
    }
  };

  const recordHumanPeerFallback: ProductionLiveShadowMessageComposition[
    "recordHumanPeerFallback"
  ] = (input) => getHumanPeerPlanner().recordFallback({
    operationId: input.operationId,
    subjectHumanId: input.actorId,
    stage: input.stage,
    reason: input.reason,
    now: input.now,
  });

  const acknowledgeHumanPeer: ProductionLiveShadowMessageComposition[
    "acknowledgeHumanPeer"
  ] = async (input) => {
    let acknowledgement;
    try {
      acknowledgement = decodeHumanPeerLiveShadowAcknowledgementV1(
        input.acknowledgementBytes,
      );
    } catch {
      return "conflict";
    }
    const planBytes = await getHumanPeerPlanner().loadPublishedPlan(input);
    if (planBytes === null) {
      acknowledgement.protectedMessageDigest.fill(0);
      acknowledgement.ordinaryPayloadDigest.fill(0);
      acknowledgement.signature.fill(0);
      return "conflict";
    }
    const plan = decodeHumanPeerLiveShadowMessagePlanV1(planBytes);
    try {
      const productAuthority = new PostgresNamespaceProductAuthority(
        createPostgresJsBridgeConnection(getServerDirectDb()),
      );
      const current = await productAuthority.withCurrentHumanOnlyRoom({
        subjectUserId: input.userId,
        subjectHumanId: input.actorId,
        roomId: input.roomId,
        namespaceId: plan.namespaceId,
        use: (authority) => new PostgresDomainKeyAuthorityRepository(
          createPostgresJsBridgeConnection(getSharedDirectCryptoDb()),
          crypto,
          serverId,
        ).inspectSharedAgentWriteAuthority({
          authority,
          deviceId: acknowledgement.committerDeviceId,
          keyClass: "human",
        }),
      });
      if (
        current === null
        || current.status !== "ready"
        || current.subjectHumanId !== acknowledgement.subjectHumanId
        || current.committerDeviceId !== acknowledgement.committerDeviceId
        || current.committerDeviceSigningKeyGeneration
          !== acknowledgement.committerDeviceSigningKeyGeneration
        || current.committerDeviceRevision
          !== acknowledgement.hostAuthorizationRevision
      ) {
        if (current?.status === "ready") {
          current.committerDeviceSigningPublicKey.fill(0);
          current.namespaceHeadDigest.fill(0);
          current.namespacePublicationDigest.fill(0);
          current.namespacePublicationSetDigest.fill(0);
          current.namespaceAudienceFingerprint.fill(0);
        }
        return "conflict";
      }
      try {
        return getHumanPeerPlanner().acknowledge({
          operationId: input.operationId,
          roomId: input.roomId,
          acknowledgementBytes: input.acknowledgementBytes,
          recipient: {
            subjectHumanId: current.subjectHumanId,
            deviceId: current.committerDeviceId,
            deviceSigningKeyGeneration:
              current.committerDeviceSigningKeyGeneration,
            hostAuthorizationRevision: current.committerDeviceRevision,
            signingPublicKey: current.committerDeviceSigningPublicKey,
          },
          now: input.now,
        });
      } finally {
        current.committerDeviceSigningPublicKey.fill(0);
        current.namespaceHeadDigest.fill(0);
        current.namespacePublicationDigest.fill(0);
        current.namespacePublicationSetDigest.fill(0);
        current.namespaceAudienceFingerprint.fill(0);
      }
    } finally {
      acknowledgement.protectedMessageDigest.fill(0);
      acknowledgement.ordinaryPayloadDigest.fill(0);
      acknowledgement.signature.fill(0);
      planBytes.fill(0);
      plan.namespaceHeadDigest.fill(0);
      plan.namespacePublicationDigest.fill(0);
      plan.namespacePublicationSetDigest.fill(0);
      plan.namespaceAudienceFingerprint.fill(0);
    }
  };

  const planHumanPeerAcknowledgement: ProductionLiveShadowMessageComposition[
    "planHumanPeerAcknowledgement"
  ] = async (input) => {
    const planBytes = await getHumanPeerPlanner().loadPublishedPlan(input);
    if (planBytes === null) {
      return Object.freeze({
        status: "unavailable" as const,
        reason: "operation_unavailable" as const,
      });
    }
    const plan = decodeHumanPeerLiveShadowMessagePlanV1(planBytes);
    try {
      const current = await new PostgresNamespaceProductAuthority(
        createPostgresJsBridgeConnection(getServerDirectDb()),
      ).withCurrentHumanOnlyRoom({
        subjectUserId: input.userId,
        subjectHumanId: input.actorId,
        roomId: input.roomId,
        namespaceId: plan.namespaceId,
        use: (authority) => new PostgresDomainKeyAuthorityRepository(
          createPostgresJsBridgeConnection(getSharedDirectCryptoDb()),
          crypto,
          serverId,
        ).inspectSharedAgentWriteAuthority({
          authority,
          deviceId: input.clientDeviceId,
          keyClass: "human",
        }),
      });
      if (current === null || current.status !== "ready") {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "current_read_authority_unavailable" as const,
        });
      }
      try {
        return Object.freeze({
          status: "ready" as const,
          subjectHumanId: current.subjectHumanId,
          clientDeviceId: current.committerDeviceId,
          clientDeviceSigningKeyGeneration:
            current.committerDeviceSigningKeyGeneration,
          hostAuthorizationRevision: current.committerDeviceRevision,
        });
      } finally {
        current.committerDeviceSigningPublicKey.fill(0);
        current.namespaceHeadDigest.fill(0);
        current.namespacePublicationDigest.fill(0);
        current.namespacePublicationSetDigest.fill(0);
        current.namespaceAudienceFingerprint.fill(0);
      }
    } finally {
      planBytes.fill(0);
      plan.namespaceHeadDigest.fill(0);
      plan.namespacePublicationDigest.fill(0);
      plan.namespacePublicationSetDigest.fill(0);
      plan.namespaceAudienceFingerprint.fill(0);
    }
  };

  const recordSharedAgentPublished: NonNullable<
    ProductionLiveShadowMessageComposition["recordSharedAgentPublished"]
  > = (input) => getSharedAgentPlanner().recordPublished(input);

  const recordSharedAgentFallback: NonNullable<
    ProductionLiveShadowMessageComposition["recordSharedAgentFallback"]
  > = (input) => getSharedAgentPlanner().recordFallback({
    operationId: input.operationId,
    subjectHumanId: input.actorId,
    stage: input.stage,
    reason: input.reason,
    now: input.now,
  });

  const recordSharedAgentConductorResolution: NonNullable<
    ProductionLiveShadowMessageComposition[
      "recordSharedAgentConductorResolution"
    ]
  > = (input) => getSharedAgentPlanner().recordConductorResolution(input);

  const reserveSharedAgentExecution: NonNullable<
    ProductionLiveShadowMessageComposition["reserveSharedAgentExecution"]
  > = (input) => getSharedAgentPlanner().reserveExecution(input);

  const reserveSharedAgentRuntimeInvocation: NonNullable<
    ProductionLiveShadowMessageComposition[
      "reserveSharedAgentRuntimeInvocation"
    ]
  > = (input) => getSharedAgentPlanner().reserveRuntimeInvocation(input);

  const attachSharedAgentRuntimeInvocationExecutions: NonNullable<
    ProductionLiveShadowMessageComposition[
      "attachSharedAgentRuntimeInvocationExecutions"
    ]
  > = (input) => getSharedAgentPlanner().attachRuntimeInvocationExecutions(input);

  const planRuntimeInvocationAuthorization: NonNullable<
    ProductionLiveShadowMessageComposition[
      "planRuntimeInvocationAuthorization"
    ]
  > = (input) => getPlanner().planRuntimeInvocationAuthorization(input);

  const awaitRuntimeInvocationAuthorization: NonNullable<
    ProductionLiveShadowMessageComposition[
      "awaitRuntimeInvocationAuthorization"
    ]
  > = (input) => {
    const accepted = runtimeInvocationAcceptedAuthorizations.get(
      input.invocationId,
    );
    if (accepted !== undefined) {
      runtimeInvocationAcceptedAuthorizations.delete(input.invocationId);
      clearTimeout(accepted.timer);
      if (accepted.expiresAt <= Date.now()) {
        accepted.capability.authorizationDigest.fill(0);
        accepted.capability.scope.domainAuthoritySetDigest.fill(0);
        return Promise.resolve(null);
      }
      return Promise.resolve(Object.freeze({ capability: accepted.capability }));
    }
    if (runtimeInvocationAuthorizationWaiters.has(input.invocationId)) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        runtimeInvocationAuthorizationWaiters.delete(input.invocationId);
        resolve(null);
      }, Math.max(0, input.deadlineAt - Date.now()));
      runtimeInvocationAuthorizationWaiters.set(
        input.invocationId,
        Object.freeze({ resolve, timer }),
      );
    });
  };

  const reserveSharedAgentRuntimeResume: NonNullable<
    ProductionLiveShadowMessageComposition[
      "reserveSharedAgentRuntimeResume"
    ]
  > = (input) => getSharedAgentPlanner().reserveRuntimeResume(input);

  const planSharedAgentExecutionAuthorization: NonNullable<
    ProductionLiveShadowMessageComposition[
      "planSharedAgentExecutionAuthorization"
    ]
  > = async (input) => {
    const result = await getPlanner().planSharedAgentExecution(input);
    if (result.status === "authorized") {
      const prior = agentPlans.get(result.executionId);
      prior?.bytes.fill(0);
      agentPlans.set(result.executionId, Object.freeze({
        bytes: result.planBytes.slice(),
        deadlineAt: result.executionDeadlineAt,
        source: result.executionKind === "resume"
          ? "shared_resume"
          : "shared_execution",
      }));
    }
    return result;
  };

  const recordSharedAgentExecutionUnavailable: NonNullable<
    ProductionLiveShadowMessageComposition[
      "recordSharedAgentExecutionUnavailable"
    ]
  > = (input) => getSharedAgentPlanner().recordExecutionUnavailable(input);

  const awaitSharedAgentExecutionAuthorization: NonNullable<
    ProductionLiveShadowMessageComposition[
      "awaitSharedAgentExecutionAuthorization"
    ]
  > = (input) => {
    const accepted = sharedAgentAcceptedAuthorizations.get(input.executionId);
    if (accepted !== undefined) {
      sharedAgentAcceptedAuthorizations.delete(input.executionId);
      clearTimeout(accepted.timer);
      if (accepted.expiresAt <= Date.now()) {
        destroySharedAgentAcceptedAuthorization(input.executionId, accepted);
        return Promise.resolve(null);
      }
      return Promise.resolve(Object.freeze({
        capability: accepted.capability,
        planBytes: accepted.planBytes,
      }));
    }
    if (sharedAgentAuthorizationWaiters.has(input.executionId)) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const delay = Math.max(0, input.deadlineAt - Date.now());
      const timer = setTimeout(() => {
        sharedAgentAuthorizationWaiters.delete(input.executionId);
        resolve(null);
      }, delay);
      sharedAgentAuthorizationWaiters.set(input.executionId, Object.freeze({
        resolve,
        timer,
      }));
    });
  };

  const publishAcceptedSharedAuthorization = (
    executionId: string,
    capability: ForegroundLiveShadowSessionExecutionCapability,
    planBytes: Uint8Array,
    expiresAt: number,
  ): void => {
    const accepted = Object.freeze({ capability, planBytes, expiresAt });
    const waiter = sharedAgentAuthorizationWaiters.get(executionId);
    if (waiter !== undefined) {
      clearTimeout(waiter.timer);
      sharedAgentAuthorizationWaiters.delete(executionId);
      waiter.resolve(Object.freeze({ capability, planBytes }));
      return;
    }
    const timer = setTimeout(() => {
      if (sharedAgentAcceptedAuthorizations.get(executionId)
        !== retainedAccepted) return;
      sharedAgentAcceptedAuthorizations.delete(executionId);
      destroySharedAgentAcceptedAuthorization(executionId, retainedAccepted);
    }, Math.max(0, expiresAt - Date.now()));
    timer.unref?.();
    const retainedAccepted = Object.freeze({ ...accepted, timer });
    const prior = sharedAgentAcceptedAuthorizations.get(executionId);
    if (prior !== undefined) {
      destroySharedAgentAcceptedAuthorization(executionId, prior);
    }
    sharedAgentAcceptedAuthorizations.set(executionId, retainedAccepted);
  };

  const admitSharedAgentRuntimeAuthorization: NonNullable<
    ProductionLiveShadowMessageComposition[
      "admitSharedAgentRuntimeAuthorization"
    ]
  > = async (input) => {
    const submittedAuthorization = parseDomainForegroundAuthorizationV2(
      input.authorizationBytes,
    );
    if (submittedAuthorization === null) return "unavailable";
    try {
      if (!equalBytes(
        submittedAuthorization.planBytes,
        input.authorizationPlanBytes,
      )) return "unavailable";
    } finally {
      destroyDomainForegroundAuthorizationV2(submittedAuthorization);
    }
    const retainedPlan = await getSharedAgentPlanner().loadExecutionPlan({
      executionId: input.operationId,
      roomId: input.roomId,
      allowAwaitingAuthorization: true,
    });
    if (retainedPlan === null) return "unavailable";
    let workPlan: ForegroundSessionLiveShadowMessagePlan;
    try {
      workPlan = decodeLiveShadowMessagePlanV4(retainedPlan);
    } catch {
      retainedPlan.fill(0);
      return "unavailable";
    }
    const productDb = getServerDirectDb();
    const productConnection = createPostgresJsBridgeConnection(productDb);
    const restrictedConnection = createPostgresJsBridgeConnection(
      getSharedDirectCryptoDb(),
    );
    const executionRows = await productDb.select({
      executionKind: conversationSharedAgentShadowExecutions.executionKind,
      deadlineAt: conversationSharedAgentShadowExecutions.deadlineAt,
    }).from(conversationSharedAgentShadowExecutions).where(eq(
      conversationSharedAgentShadowExecutions.executionId,
      input.operationId,
    )).limit(2);
    if (executionRows.length !== 1 || executionRows[0]!.deadlineAt.getTime() <= input.now) {
      retainedPlan.fill(0);
      destroyForegroundPlan(workPlan);
      return "unavailable";
    }
    const executionKind = executionRows.length === 1
        && executionRows[0]?.executionKind === "resume"
      ? "resume"
      : "turn";
    const source = executionKind === "resume"
      ? "shared_resume" as const
      : "shared_execution" as const;
    const policy = await loadRuntimePolicy();
    if (
      policy.revision !== workPlan.policyRevision
      || policy.mode === "plaintext_only"
    ) {
      retainedPlan.fill(0);
      destroyForegroundPlan(workPlan);
      return "unavailable";
    }
    const authority = await createPostgresDomainKeyV2LiveShadowCurrentAuthority({
          product: productConnection,
          restricted: restrictedConnection,
          crypto,
          serverId,
          plan: workPlan,
          representationMode: policy.mode === "encrypted_only"
            ? "full_encryption"
            : "shadow_encryption",
          resolveReadableNamespaces,
          source,
        });
    let current: Awaited<ReturnType<
      DomainKeyV2LiveShadowCurrentAuthority[
        "resolveCurrentForegroundAuthorization"
      ]
    >> = null;
    let scopeDigest: Uint8Array | null = null;
    let acceptedAuthorizationDigest: Uint8Array | null = null;
    let finalPlanBytes: Uint8Array | null = null;
    let finalPlanDigest: Uint8Array | null = null;
    try {
      if (
        authority === null
      ) return "unavailable";
      current = await authority.resolveCurrentForegroundAuthorization();
      const runtimeCurrent = current?.recipientKind === "runtime"
        ? current
        : null;
      if (
        runtimeCurrent === null
        || runtimeCurrent.sessionId !== input.clientActionSessionId
        || workPlan.roomId !== input.roomId
        || runtimeCurrent.subjectHumanId !== input.actorId
      ) return "unavailable";
      const topLevelRoomId = runtimeCurrent.roomId;
      scopeDigest = domainForegroundAuthoritySetDigest(
        crypto,
        runtimeCurrent.domains,
      );
      const scope = Object.freeze({
        subjectHumanId: workPlan.subjectHumanId,
        issuingDeviceId: workPlan.committerDeviceId,
        recipientKind: "nautilo_foreground_runtime" as const,
        browserSessionId: input.clientActionSessionId,
        topLevelRoomId,
        policyRevision: workPlan.policyRevision,
        hostAuthorizationRevision: workPlan.hostAuthorizationRevision,
        namespaceIds: runtimeCurrent.readableNamespaceIds,
        grantDomainIds: Object.freeze(
          runtimeCurrent.domains.map((entry) => entry.domainId),
        ),
        domainAuthoritySetDigest: scopeDigest.slice(),
      });
      const recipient = recipients.takeRuntime({
        operationId: input.operationId,
        clientActionSessionId: input.clientActionSessionId,
        actorId: input.actorId,
      });
      if (recipient === null) return "unavailable";
      try {
        type OpenedRuntimeRegistration = Readonly<{
          registered: LiveShadowReusableForegroundAuthorization;
          authorizationDigest: Uint8Array;
        }>;
        const register = (
          entries: Parameters<
            typeof createDomainCompressedLiveShadowSessionCapability
          >[0]["entries"],
        ): OpenedRuntimeRegistration | null => {
          const authorizationDigest = crypto.hash(input.authorizationBytes);
          const authorizationPlanDigest = crypto.hash(
            input.authorizationPlanBytes,
          );
          const capability = createDomainCompressedLiveShadowSessionCapability({
            description: {
              authorizationId: runtimeCurrent.authorizationId,
              subjectHumanId: workPlan.subjectHumanId,
              issuingDeviceId: workPlan.committerDeviceId,
              recipientKind: "nautilo_foreground_runtime",
              browserSessionId: input.clientActionSessionId,
              topLevelRoomId,
              recipientKeyId: runtimeCurrent.recipientKeyId,
              policyRevision: workPlan.policyRevision,
              hostAuthorizationRevision: workPlan.hostAuthorizationRevision,
              namespaceIds: scope.namespaceIds,
              grantDomainIds: scope.grantDomainIds,
              issuedAt: runtimeCurrent.issuedAt,
              expiresAt: runtimeCurrent.deadlineAt,
              authorizationDigest,
            },
            entries,
          });
          try {
            const registered = foregroundAuthorizations.register({
              capability,
              scope,
              publicEvidence: {
                authorizationDigest,
                authorizationPlanBytes: input.authorizationPlanBytes,
                authorizationPlanDigest,
                recipientId: runtimeCurrent.authorizationId,
                recipientKeyId: runtimeCurrent.recipientKeyId,
                recipientPublicKey: recipient.publicKey,
              },
              now: input.now,
            });
            if (registered === null) {
              authorizationDigest.fill(0);
              return null;
            }
            return Object.freeze({ registered, authorizationDigest });
          } finally {
            authorizationPlanDigest.fill(0);
          }
        };
        const opened = await withProtectedInvocationRecipientPrivateKey(
          recipient.recipient,
          (privateKey) => withOpenedDomainForegroundAuthorization<
                OpenedRuntimeRegistration | null
              >(crypto, {
                authorizationBytes: input.authorizationBytes,
                now: input.now,
                current: Object.freeze({
                  ...current!,
                  recipientEncryptionPrivateKey: privateKey,
                }),
                operation: (entries) => register(Object.freeze(
                  entries.map((entry) => Object.freeze({
                    grantDomainId: entry.domainId,
                    domainKeyGeneration: entry.domainKeyGeneration,
                    participantDigest: entry.participantDigest,
                    headDigest: entry.headDigest,
                    authorizationRevision: entry.authorizationRevision,
                    domainAiGrantKey: entry.domainKey,
                  })),
                )),
              }),
        );
        if (
          opened === null
          || opened.status !== "opened"
          || opened.value === null
        ) return "unavailable";
        const { registered } = opened.value;
        const authorizationDigest = opened.value.authorizationDigest;
        acceptedAuthorizationDigest = authorizationDigest;
        finalPlanBytes = retainedPlan.slice();
        finalPlanDigest = crypto.hash(finalPlanBytes);
        registered.authorizationDigest.fill(0);
        registered.authorizationPlanBytes.fill(0);
        registered.authorizationPlanDigest.fill(0);
        registered.recipientPublicKey.fill(0);
        const priorDigest = crypto.hash(retainedPlan);
        const submittedPlanDigest = crypto.hash(input.authorizationPlanBytes);
        let updated;
        try {
          const owners = await productDb.select({
            invocationId:
              conversationSharedAgentShadowExecutions.invocationId,
            executionKind:
              conversationSharedAgentShadowExecutions.executionKind,
          }).from(conversationSharedAgentShadowExecutions).where(eq(
            conversationSharedAgentShadowExecutions.executionId,
            input.operationId,
          )).limit(2);
          const invocationId = owners.length === 1
              && typeof owners[0]?.invocationId === "string"
            ? owners[0].invocationId
            : null;
          if (invocationId === null) {
            updated = await productDb
              .update(conversationSharedAgentShadowExecutions)
              .set({
                state: "authorized",
                planBytes: finalPlanBytes,
                planDigest: finalPlanDigest,
                authorizationDisposition: "establish",
                authorizationDigest,
                authorizationSessionReference: registered.sessionReference,
                authorizedAt: new Date(input.now),
                updatedAt: new Date(input.now),
              })
              .where(and(
                eq(
                  conversationSharedAgentShadowExecutions.executionId,
                  input.operationId,
                ),
                eq(
                  conversationSharedAgentShadowExecutions.state,
                  "awaiting_authorization",
                ),
                eq(
                  conversationSharedAgentShadowExecutions.planDigest,
                  priorDigest,
                ),
              ))
              .returning({
                executionId:
                  conversationSharedAgentShadowExecutions.executionId,
              });
          } else {
            updated = await productDb.transaction(async (tx) => {
              const invocation = await tx
                .update(conversationSharedAgentShadowInvocations)
                .set({
                  state: "authorized",
                  authorizationDisposition: "establish",
                  authorizationDigest,
                  authorizationSessionReference: registered.sessionReference,
                  authorizedAt: new Date(input.now),
                  updatedAt: new Date(input.now),
                })
                .where(and(
                  eq(
                    conversationSharedAgentShadowInvocations.invocationId,
                    invocationId,
                  ),
                  eq(
                    conversationSharedAgentShadowInvocations.state,
                    "awaiting_authorization",
                  ),
                  eq(
                    conversationSharedAgentShadowInvocations
                      .authorizationPlanDigest,
                    submittedPlanDigest,
                  ),
                ))
                .returning({
                  invocationId:
                    conversationSharedAgentShadowInvocations.invocationId,
                });
              if (invocation.length !== 1) return [];
              return tx.update(conversationSharedAgentShadowExecutions).set({
                state: "authorized",
                planBytes: finalPlanBytes,
                planDigest: finalPlanDigest,
                authorizedAt: new Date(input.now),
                updatedAt: new Date(input.now),
              }).where(and(
                eq(
                  conversationSharedAgentShadowExecutions.executionId,
                  input.operationId,
                ),
                eq(
                  conversationSharedAgentShadowExecutions.invocationId,
                  invocationId,
                ),
                eq(
                  conversationSharedAgentShadowExecutions.state,
                  "awaiting_authorization",
                ),
                eq(
                  conversationSharedAgentShadowExecutions.planDigest,
                  priorDigest,
                ),
              )).returning({
                executionId:
                  conversationSharedAgentShadowExecutions.executionId,
              });
            }, { isolationLevel: "serializable" });
          }
        } finally {
          priorDigest.fill(0);
          submittedPlanDigest.fill(0);
        }
        if (updated.length !== 1) {
          foregroundAuthorizations.cancelScope(scope);
          return "unavailable";
        }
        const executionCapability: ForegroundLiveShadowSessionExecutionCapability =
          Object.freeze({
            kind: "foreground_session",
            sessionReference: registered.sessionReference,
            authorizationDigest: authorizationDigest.slice(),
            scope: Object.freeze({
              ...scope,
              namespaceIds: Object.freeze([...scope.namespaceIds]),
              grantDomainIds: Object.freeze([...scope.grantDomainIds]),
              domainAuthoritySetDigest:
                scope.domainAuthoritySetDigest.slice(),
            }),
          });
        const prior = agentPlans.get(input.operationId);
        prior?.bytes.fill(0);
        agentPlans.set(input.operationId, Object.freeze({
          bytes: finalPlanBytes.slice(),
          deadlineAt: executionRows[0]!.deadlineAt.getTime(),
          source: executionKind === "resume"
            ? "shared_resume"
            : "shared_execution",
        }));
        publishAcceptedSharedAuthorization(
          input.operationId,
          executionCapability,
          finalPlanBytes.slice(),
          executionRows[0]!.deadlineAt.getTime(),
        );
        return "authorized";
      } finally {
        recipient.publicKey.fill(0);
        destroyProtectedInvocationRecipient(recipient.recipient);
      }
    } finally {
      retainedPlan.fill(0);
      current?.committerDeviceSigningPublicKey.fill(0);
      current?.domains.forEach((entry) => {
        entry.participantDigest.fill(0);
        entry.headDigest.fill(0);
        entry.activeNamespaceBindingSetDigest.fill(0);
      });
      scopeDigest?.fill(0);
      acceptedAuthorizationDigest?.fill(0);
      finalPlanBytes?.fill(0);
      finalPlanDigest?.fill(0);
      authority?.destroy();
      destroyForegroundPlan(workPlan);
    }
  };

  const admitRuntimeInvocationAuthorization: NonNullable<
    ProductionLiveShadowMessageComposition[
      "admitRuntimeInvocationAuthorization"
    ]
  > = async (input) => {
    const submittedAuthorization = parseDomainForegroundAuthorizationV2(
      input.authorizationBytes,
    );
    if (submittedAuthorization === null) return "unavailable";
    try {
      if (!equalBytes(
        submittedAuthorization.planBytes,
        input.authorizationPlanBytes,
      )) return "unavailable";
    } finally {
      destroyDomainForegroundAuthorizationV2(submittedAuthorization);
    }
    const current = await getPlanner()
      .inspectRuntimeInvocationCurrentAuthority({
        authority: {
          userId: input.userId,
          humanActorId: input.actorId,
        },
        invocationId: input.invocationId,
        roomId: input.roomId,
        clientActionSessionId: input.clientActionSessionId,
        authorizationPlanBytes: input.authorizationPlanBytes,
        now: input.now,
    });
    if (current === null) return "unavailable";
    const productDb = getServerDirectDb();
    const authorizationDigest = crypto.hash(input.authorizationBytes);
    try {
      const existing = await productDb.select({
        state: conversationSharedAgentShadowInvocations.state,
        authorizationDigest:
          conversationSharedAgentShadowInvocations.authorizationDigest,
        authorizationSessionReference:
          conversationSharedAgentShadowInvocations
            .authorizationSessionReference,
        deadlineAt: conversationSharedAgentShadowInvocations.deadlineAt,
      }).from(conversationSharedAgentShadowInvocations).where(and(
        eq(
          conversationSharedAgentShadowInvocations.invocationId,
          input.invocationId,
        ),
        eq(conversationSharedAgentShadowInvocations.roomId, input.roomId),
      )).limit(2);
      if (
        existing.length === 1
        && ["authorized", "running"].includes(existing[0]!.state)
        && existing[0]!.authorizationDigest instanceof Uint8Array
        && equalBytes(existing[0]!.authorizationDigest, authorizationDigest)
      ) {
        const reusable = foregroundAuthorizations.inspectReusable(
          current.scope,
        );
        if (
          reusable === null
          || reusable.sessionReference
            !== existing[0]!.authorizationSessionReference
          || !equalBytes(reusable.authorizationDigest, authorizationDigest)
        ) {
          reusable?.authorizationDigest.fill(0);
          reusable?.authorizationPlanBytes.fill(0);
          reusable?.authorizationPlanDigest.fill(0);
          reusable?.recipientPublicKey.fill(0);
          return "unavailable";
        }
        const replayedCapability: ForegroundLiveShadowSessionExecutionCapability =
          Object.freeze({
            kind: "foreground_session",
            sessionReference: reusable.sessionReference,
            authorizationDigest: reusable.authorizationDigest.slice(),
            scope: Object.freeze({
              ...current.scope,
              namespaceIds: Object.freeze([...current.scope.namespaceIds]),
              grantDomainIds: Object.freeze([...current.scope.grantDomainIds]),
              domainAuthoritySetDigest:
                current.scope.domainAuthoritySetDigest.slice(),
            }),
          });
        reusable.authorizationDigest.fill(0);
        reusable.authorizationPlanBytes.fill(0);
        reusable.authorizationPlanDigest.fill(0);
        reusable.recipientPublicKey.fill(0);
        publishAcceptedRuntimeInvocationAuthorization(
          input.invocationId,
          replayedCapability,
          Math.min(
            current.current.deadlineAt,
            existing[0]!.deadlineAt.getTime(),
          ),
        );
        return "replayed";
      }
      const recipient = recipients.takeRuntime({
        operationId: input.invocationId,
        clientActionSessionId: input.clientActionSessionId,
        actorId: input.actorId,
      });
      if (recipient === null) return "unavailable";
      try {
        const register = (
          entries: Parameters<
            typeof createDomainCompressedLiveShadowSessionCapability
          >[0]["entries"],
        ) => {
          const authorizationPlanDigest = crypto.hash(
            input.authorizationPlanBytes,
          );
          const capability =
            createDomainCompressedLiveShadowSessionCapability({
              description: {
                authorizationId: current.current.authorizationId,
                subjectHumanId: current.scope.subjectHumanId,
                issuingDeviceId: current.scope.issuingDeviceId,
                recipientKind: "nautilo_foreground_runtime",
                browserSessionId: input.clientActionSessionId,
                topLevelRoomId: current.scope.topLevelRoomId,
                recipientKeyId: current.current.recipientKeyId,
                policyRevision: current.scope.policyRevision,
                hostAuthorizationRevision:
                  current.scope.hostAuthorizationRevision,
                namespaceIds: current.scope.namespaceIds,
                grantDomainIds: current.scope.grantDomainIds,
                issuedAt: current.current.issuedAt,
                expiresAt: current.current.deadlineAt,
                authorizationDigest,
              },
              entries,
            });
          try {
            return foregroundAuthorizations.register({
              capability,
              scope: current.scope,
              publicEvidence: {
                authorizationDigest,
                authorizationPlanBytes: input.authorizationPlanBytes,
                authorizationPlanDigest,
                recipientId: current.current.authorizationId,
                recipientKeyId: current.current.recipientKeyId,
                recipientPublicKey: recipient.publicKey,
              },
              now: input.now,
            });
          } finally {
            authorizationPlanDigest.fill(0);
          }
        };
        const opened = await withProtectedInvocationRecipientPrivateKey(
          recipient.recipient,
          (privateKey) => withOpenedDomainForegroundAuthorization(crypto, {
                authorizationBytes: input.authorizationBytes,
                now: input.now,
                current: Object.freeze({
                  ...current.current,
                  recipientEncryptionPrivateKey: privateKey,
                }),
                operation: (entries) => register(Object.freeze(
                  entries.map((entry) => Object.freeze({
                    grantDomainId: entry.domainId,
                    domainKeyGeneration: entry.domainKeyGeneration,
                    participantDigest: entry.participantDigest,
                    headDigest: entry.headDigest,
                    authorizationRevision: entry.authorizationRevision,
                    domainAiGrantKey: entry.domainKey,
                  })),
                )),
              }),
        );
        if (
          opened === null
          || opened.status !== "opened"
          || opened.value === null
        ) return "unavailable";
        const registered = opened.value;
        const updated = await productDb
          .update(conversationSharedAgentShadowInvocations)
          .set({
            state: "authorized",
            authorizationDisposition: "establish",
            authorizationDigest,
            authorizationSessionReference: registered.sessionReference,
            authorizedAt: new Date(input.now),
            updatedAt: new Date(input.now),
          })
          .where(and(
            eq(
              conversationSharedAgentShadowInvocations.invocationId,
              input.invocationId,
            ),
            eq(
              conversationSharedAgentShadowInvocations.state,
              "awaiting_authorization",
            ),
            eq(
              conversationSharedAgentShadowInvocations
                .authorizationPlanDigest,
              registered.authorizationPlanDigest,
            ),
          ))
          .returning({
            invocationId:
              conversationSharedAgentShadowInvocations.invocationId,
          });
        if (updated.length !== 1) {
          foregroundAuthorizations.cancelScope(current.scope);
          registered.authorizationDigest.fill(0);
          registered.authorizationPlanBytes.fill(0);
          registered.authorizationPlanDigest.fill(0);
          registered.recipientPublicKey.fill(0);
          return "unavailable";
        }
        const capability: ForegroundLiveShadowSessionExecutionCapability =
          Object.freeze({
            kind: "foreground_session",
            sessionReference: registered.sessionReference,
            authorizationDigest: authorizationDigest.slice(),
            scope: Object.freeze({
              ...current.scope,
              namespaceIds: Object.freeze([...current.scope.namespaceIds]),
              grantDomainIds: Object.freeze([...current.scope.grantDomainIds]),
              domainAuthoritySetDigest:
                current.scope.domainAuthoritySetDigest.slice(),
            }),
          });
        registered.authorizationDigest.fill(0);
        registered.authorizationPlanBytes.fill(0);
        registered.authorizationPlanDigest.fill(0);
        registered.recipientPublicKey.fill(0);
        publishAcceptedRuntimeInvocationAuthorization(
          input.invocationId,
          capability,
          Math.min(
            current.current.deadlineAt,
            existing[0]?.deadlineAt.getTime() ?? current.current.deadlineAt,
          ),
        );
        return "authorized";
      } finally {
        recipient.publicKey.fill(0);
        destroyProtectedInvocationRecipient(recipient.recipient);
      }
    } finally {
      authorizationDigest.fill(0);
      current.destroy();
    }
  };

  const admitSharedAgentExecutionAuthorization: NonNullable<
    ProductionLiveShadowMessageComposition[
      "admitSharedAgentExecutionAuthorization"
    ]
  > = async (prepared) => {
    let plan: ForegroundSessionLiveShadowMessagePlan;
    try {
      plan = decodeLiveShadowMessagePlanV4(prepared.planBytes);
    } catch {
      return "unavailable";
    }
    const executionId = plan.operationId;
    const result = await admitPreparedForeground(
      prepared,
      plan,
      "shared_execution",
    );
    if (result.status === "ordinary_fallback") return "unavailable";
    if (result.status === "human_replayed") return "replayed";
    if (
      !("kind" in result.capability)
      || result.capability.kind !== "foreground_session"
    ) return "unavailable";
    const waiter = sharedAgentAuthorizationWaiters.get(executionId);
    const accepted = Object.freeze({
      capability: result.capability,
      planBytes: prepared.planBytes.slice(),
      expiresAt: plan.deadlineAt,
    });
    if (waiter !== undefined) {
      clearTimeout(waiter.timer);
      sharedAgentAuthorizationWaiters.delete(executionId);
      waiter.resolve(Object.freeze({
        capability: accepted.capability,
        planBytes: accepted.planBytes,
      }));
    } else {
      const expiresAt = plan.deadlineAt;
      const timer = setTimeout(() => {
        if (sharedAgentAcceptedAuthorizations.get(executionId)
          !== retainedAccepted) return;
        sharedAgentAcceptedAuthorizations.delete(executionId);
        destroySharedAgentAcceptedAuthorization(executionId, retainedAccepted);
      }, Math.max(0, expiresAt - Date.now()));
      timer.unref?.();
      const retainedAccepted = Object.freeze({
        ...accepted,
        expiresAt,
        timer,
      });
      const prior = sharedAgentAcceptedAuthorizations.get(executionId);
      if (prior !== undefined) {
        destroySharedAgentAcceptedAuthorization(executionId, prior);
      }
      sharedAgentAcceptedAuthorizations.set(executionId, retainedAccepted);
    }
    return "authorized";
  };

  const planSharedAgentAcknowledgement: NonNullable<
    ProductionLiveShadowMessageComposition[
      "planSharedAgentAcknowledgement"
    ]
  > = async (input) => {
    const planBytes = await getSharedAgentPlanner().loadPublishedPlan(input);
    if (planBytes === null) {
      return Object.freeze({
        status: "unavailable" as const,
        reason: "operation_unavailable" as const,
      });
    }
    let plan;
    let humanAiReadable = false;
    try {
      plan = decodeHumanAiReadableLiveShadowMessagePlan(planBytes);
      humanAiReadable = true;
    } catch {
      plan = decodeSharedAgentLiveShadowMessagePlanV1(planBytes);
    }
    try {
      const productAuthority = new PostgresNamespaceProductAuthority(
        createPostgresJsBridgeConnection(getServerDirectDb()),
      );
      const inspect = (authority: Parameters<
        PostgresDomainKeyAuthorityRepository[
          "inspectSharedAgentWriteAuthority"
        ]
      >[0]["authority"]) => new PostgresDomainKeyAuthorityRepository(
        createPostgresJsBridgeConnection(getSharedDirectCryptoDb()),
        crypto,
        serverId,
      ).inspectSharedAgentWriteAuthority({
        authority,
        deviceId: input.clientDeviceId,
      });
      const current = humanAiReadable
        ? await productAuthority.withCurrentHumanAiReadableRoom({
          subjectUserId: input.userId,
          subjectHumanId: input.actorId,
          roomId: input.roomId,
          namespaceId: plan.namespaceId,
          use: inspect,
        })
        : await productAuthority.withCurrentSharedAgentRoom({
          subjectUserId: input.userId,
          subjectHumanId: input.actorId,
          roomId: input.roomId,
          namespaceId: plan.namespaceId,
          recipientAgentId: legacySharedAgentRecipientId(plan),
          use: inspect,
        });
      if (current === null || current.status !== "ready") {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "current_read_authority_unavailable" as const,
        });
      }
      try {
        return Object.freeze({
          status: "ready" as const,
          subjectHumanId: current.subjectHumanId,
          clientDeviceId: current.committerDeviceId,
          clientDeviceSigningKeyGeneration:
            current.committerDeviceSigningKeyGeneration,
          hostAuthorizationRevision: current.committerDeviceRevision,
        });
      } finally {
        current.committerDeviceSigningPublicKey.fill(0);
        current.namespaceHeadDigest.fill(0);
        current.namespacePublicationDigest.fill(0);
        current.namespacePublicationSetDigest.fill(0);
        current.namespaceAudienceFingerprint.fill(0);
      }
    } finally {
      planBytes.fill(0);
      plan.namespaceHeadDigest.fill(0);
      plan.namespacePublicationDigest.fill(0);
      plan.namespacePublicationSetDigest.fill(0);
      plan.namespaceAudienceFingerprint.fill(0);
    }
  };

  const planSharedAgentOutputRead: NonNullable<
    ProductionLiveShadowMessageComposition["planSharedAgentOutputRead"]
  > = async (input) => {
    const planBytes = await getSharedAgentPlanner().loadExecutionPlan({
      executionId: input.executionId,
      roomId: input.roomId,
    });
    if (planBytes === null) {
      return Object.freeze({
        status: "unavailable" as const,
        reason: "operation_unavailable" as const,
      });
    }
    const plan = decodeLiveShadowMessagePlanV4(planBytes);
    try {
      const current = await new PostgresNamespaceProductAuthority(
        createPostgresJsBridgeConnection(getServerDirectDb()),
      ).withCurrentHumanAiReadableRoom({
        subjectUserId: input.userId,
        subjectHumanId: input.actorId,
        roomId: input.roomId,
        namespaceId: plan.namespaceId,
        use: (authority) => new PostgresDomainKeyAuthorityRepository(
          createPostgresJsBridgeConnection(getSharedDirectCryptoDb()),
          crypto,
          serverId,
        ).inspectSharedAgentWriteAuthority({
          authority,
          deviceId: input.clientDeviceId,
        }),
      });
      if (current === null || current.status !== "ready") {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "current_read_authority_unavailable" as const,
        });
      }
      try {
        return Object.freeze({
          status: "ready" as const,
          subjectHumanId: current.subjectHumanId,
          clientDeviceId: current.committerDeviceId,
          clientDeviceSigningKeyGeneration:
            current.committerDeviceSigningKeyGeneration,
          hostAuthorizationRevision: current.committerDeviceRevision,
        });
      } finally {
        current.committerDeviceSigningPublicKey.fill(0);
        current.namespaceHeadDigest.fill(0);
        current.namespacePublicationDigest.fill(0);
        current.namespacePublicationSetDigest.fill(0);
        current.namespaceAudienceFingerprint.fill(0);
      }
    } finally {
      planBytes.fill(0);
      destroyForegroundPlan(plan);
    }
  };

  const acknowledgeSharedAgentOutput: NonNullable<
    ProductionLiveShadowMessageComposition["acknowledgeSharedAgentOutput"]
  > = async (input) => {
    let acknowledgement;
    try {
      acknowledgement = decodeSharedAgentLiveShadowAcknowledgementV1(
        input.acknowledgementBytes,
      );
    } catch {
      return "conflict";
    }
    const planBytes = await getSharedAgentPlanner().loadExecutionPlan({
      executionId: input.executionId,
      roomId: input.roomId,
    });
    if (planBytes === null) {
      acknowledgement.protectedMessageDigest.fill(0);
      acknowledgement.ordinaryPayloadDigest.fill(0);
      acknowledgement.signature.fill(0);
      return "conflict";
    }
    const plan = decodeLiveShadowMessagePlanV4(planBytes);
    try {
      const current = await new PostgresNamespaceProductAuthority(
        createPostgresJsBridgeConnection(getServerDirectDb()),
      ).withCurrentHumanAiReadableRoom({
        subjectUserId: input.userId,
        subjectHumanId: input.actorId,
        roomId: input.roomId,
        namespaceId: plan.namespaceId,
        use: (authority) => new PostgresDomainKeyAuthorityRepository(
          createPostgresJsBridgeConnection(getSharedDirectCryptoDb()),
          crypto,
          serverId,
        ).inspectSharedAgentWriteAuthority({
          authority,
          deviceId: acknowledgement.committerDeviceId,
        }),
      });
      if (
        current === null
        || current.status !== "ready"
        || current.subjectHumanId !== acknowledgement.subjectHumanId
        || current.committerDeviceId !== acknowledgement.committerDeviceId
        || current.committerDeviceSigningKeyGeneration
          !== acknowledgement.committerDeviceSigningKeyGeneration
        || current.committerDeviceRevision
          !== acknowledgement.hostAuthorizationRevision
      ) {
        if (current?.status === "ready") {
          current.committerDeviceSigningPublicKey.fill(0);
          current.namespaceHeadDigest.fill(0);
          current.namespacePublicationDigest.fill(0);
          current.namespacePublicationSetDigest.fill(0);
          current.namespaceAudienceFingerprint.fill(0);
        }
        return "conflict";
      }
      try {
        return getSharedAgentPlanner().acknowledgeExecutionOutput({
          executionId: input.executionId,
          roomId: input.roomId,
          acknowledgementBytes: input.acknowledgementBytes,
          recipient: {
            subjectHumanId: current.subjectHumanId,
            deviceId: current.committerDeviceId,
            deviceSigningKeyGeneration:
              current.committerDeviceSigningKeyGeneration,
            hostAuthorizationRevision: current.committerDeviceRevision,
            signingPublicKey: current.committerDeviceSigningPublicKey,
          },
          now: input.now,
        });
      } finally {
        current.committerDeviceSigningPublicKey.fill(0);
        current.namespaceHeadDigest.fill(0);
        current.namespacePublicationDigest.fill(0);
        current.namespacePublicationSetDigest.fill(0);
        current.namespaceAudienceFingerprint.fill(0);
      }
    } finally {
      acknowledgement.protectedMessageDigest.fill(0);
      acknowledgement.ordinaryPayloadDigest.fill(0);
      acknowledgement.signature.fill(0);
      planBytes.fill(0);
      destroyForegroundPlan(plan);
    }
  };

  const acknowledgeSharedAgent: NonNullable<
    ProductionLiveShadowMessageComposition["acknowledgeSharedAgent"]
  > = async (input) => {
    let acknowledgement;
    let humanAiReadable = false;
    try {
      try {
        acknowledgement = decodeHumanAiReadableLiveShadowAcknowledgementV1(
          input.acknowledgementBytes,
        );
        humanAiReadable = true;
      } catch {
        acknowledgement = decodeSharedAgentLiveShadowAcknowledgementV1(
          input.acknowledgementBytes,
        );
      }
    } catch {
      return "conflict";
    }
    const planBytes = await getSharedAgentPlanner().loadPublishedPlan(input);
    if (planBytes === null) {
      acknowledgement.protectedMessageDigest.fill(0);
      acknowledgement.ordinaryPayloadDigest.fill(0);
      acknowledgement.signature.fill(0);
      return "conflict";
    }
    let plan;
    try {
      plan = humanAiReadable
        ? decodeHumanAiReadableLiveShadowMessagePlan(planBytes)
        : decodeSharedAgentLiveShadowMessagePlanV1(planBytes);
    } catch {
      acknowledgement.protectedMessageDigest.fill(0);
      acknowledgement.ordinaryPayloadDigest.fill(0);
      acknowledgement.signature.fill(0);
      planBytes.fill(0);
      return "conflict";
    }
    try {
      const productAuthority = new PostgresNamespaceProductAuthority(
        createPostgresJsBridgeConnection(getServerDirectDb()),
      );
      const inspect = (authority: Parameters<
        PostgresDomainKeyAuthorityRepository[
          "inspectSharedAgentWriteAuthority"
        ]
      >[0]["authority"]) => new PostgresDomainKeyAuthorityRepository(
        createPostgresJsBridgeConnection(getSharedDirectCryptoDb()),
        crypto,
        serverId,
      ).inspectSharedAgentWriteAuthority({
        authority,
        deviceId: acknowledgement.committerDeviceId,
      });
      const current = humanAiReadable
        ? await productAuthority.withCurrentHumanAiReadableRoom({
          subjectUserId: input.userId,
          subjectHumanId: input.actorId,
          roomId: input.roomId,
          namespaceId: plan.namespaceId,
          use: inspect,
        })
        : await productAuthority.withCurrentSharedAgentRoom({
          subjectUserId: input.userId,
          subjectHumanId: input.actorId,
          roomId: input.roomId,
          namespaceId: plan.namespaceId,
          recipientAgentId: legacySharedAgentRecipientId(plan),
          use: inspect,
        });
      if (
        current === null
        || current.status !== "ready"
        || current.subjectHumanId !== acknowledgement.subjectHumanId
        || current.committerDeviceId !== acknowledgement.committerDeviceId
        || current.committerDeviceSigningKeyGeneration
          !== acknowledgement.committerDeviceSigningKeyGeneration
        || current.committerDeviceRevision
          !== acknowledgement.hostAuthorizationRevision
      ) {
        if (current?.status === "ready") {
          current.committerDeviceSigningPublicKey.fill(0);
          current.namespaceHeadDigest.fill(0);
          current.namespacePublicationDigest.fill(0);
          current.namespacePublicationSetDigest.fill(0);
          current.namespaceAudienceFingerprint.fill(0);
        }
        return "conflict";
      }
      try {
        return getSharedAgentPlanner().acknowledge({
          operationId: input.operationId,
          roomId: input.roomId,
          acknowledgementBytes: input.acknowledgementBytes,
          recipient: {
            subjectHumanId: current.subjectHumanId,
            deviceId: current.committerDeviceId,
            deviceSigningKeyGeneration:
              current.committerDeviceSigningKeyGeneration,
            hostAuthorizationRevision: current.committerDeviceRevision,
            signingPublicKey: current.committerDeviceSigningPublicKey,
          },
          now: input.now,
        });
      } finally {
        current.committerDeviceSigningPublicKey.fill(0);
        current.namespaceHeadDigest.fill(0);
        current.namespacePublicationDigest.fill(0);
        current.namespacePublicationSetDigest.fill(0);
        current.namespaceAudienceFingerprint.fill(0);
      }
    } finally {
      acknowledgement.protectedMessageDigest.fill(0);
      acknowledgement.ordinaryPayloadDigest.fill(0);
      acknowledgement.signature.fill(0);
      planBytes.fill(0);
      plan.namespaceHeadDigest.fill(0);
      plan.namespacePublicationDigest.fill(0);
      plan.namespacePublicationSetDigest.fill(0);
      plan.namespaceAudienceFingerprint.fill(0);
    }
  };

  const runRuntimeInvocationConductor: NonNullable<
    ProductionLiveShadowMessageComposition["runRuntimeInvocationConductor"]
  > = async <Value>(input: Readonly<{
    invocationId: string;
    operationIds: readonly string[];
    roomId: string;
    userId: string;
    actorId: string;
    clientActionSessionId: string;
    capability: ForegroundLiveShadowSessionExecutionCapability;
    work(
      openedHumanContent: string,
      openHistory: (
        candidates: readonly RuntimeInvocationProtectedHistoryHit[],
      ) => Promise<readonly RuntimeInvocationProtectedHistoryHit[] | null>,
    ): Promise<Value>;
  }> & RuntimeInvocationContentSelection): Promise<LiveShadowAgentTurnExecutionResult<Value>> => {
    const closeFallback = async (stage: string, reason: string) => {
      await getSharedAgentPlanner().recordRuntimeInvocationConductorFallback({
        invocationId: input.invocationId,
        roomId: input.roomId,
        subjectHumanId: input.actorId,
        stage,
        reason,
        now: Date.now(),
      }).catch(() => undefined);
      return agentFallback<Value>(input.invocationId, `${stage}_${reason}`);
    };
    const policy = await loadRuntimePolicy();
    if (policy.revision !== input.capability.scope.policyRevision
      || !await preparedPolicyMatches(policy.revision, input.representationMode)
      || (input.representationMode === "full_encryption"
        && input.expectedMergedHumanContent !== undefined)) {
      return closeFallback("authorization", "policy_changed");
    }
    const productDb = getServerDirectDb();
    const rows = await productDb.select({
      authorizationPlanBytes:
        conversationSharedAgentShadowInvocations.authorizationPlanBytes,
      deadlineAt: conversationSharedAgentShadowInvocations.deadlineAt,
    }).from(conversationSharedAgentShadowInvocations).where(and(
      eq(
        conversationSharedAgentShadowInvocations.invocationId,
        input.invocationId,
      ),
      eq(conversationSharedAgentShadowInvocations.roomId, input.roomId),
    )).limit(2);
    const authorizationPlanBytes = rows.length === 1
        && rows[0]!.authorizationPlanBytes instanceof Uint8Array
      ? rows[0]!.authorizationPlanBytes.slice()
      : null;
    if (authorizationPlanBytes === null) {
      return closeFallback("authorization", "invocation_plan_absent");
    }
    const current = await getPlanner()
      .inspectRuntimeInvocationCurrentAuthority({
        authority: {
          userId: input.userId,
          humanActorId: input.actorId,
        },
        invocationId: input.invocationId,
        roomId: input.roomId,
        clientActionSessionId: input.clientActionSessionId,
        authorizationPlanBytes,
        now: Date.now(),
      });
    authorizationPlanBytes.fill(0);
    if (current === null) {
      return closeFallback("authorization", "invocation_authority_stale");
    }
    const claim = await getSharedAgentPlanner().claimRuntimeInvocationConductor({
      invocationId: input.invocationId,
      roomId: input.roomId,
      subjectHumanId: input.actorId,
      now: Date.now(),
    });
    if (claim !== "claimed") {
      current.destroy();
      if (claim === "already_running" || claim === "terminal") {
        return agentFallback(input.invocationId, "retry_suppressed");
      }
      return closeFallback("claim", "invocation_conflict");
    }
    const productConnection = createPostgresJsBridgeConnection(productDb);
    const restrictedConnection = createPostgresJsBridgeConnection(
      getSharedDirectCryptoDb(),
    );
    let protectedCallbackFailure:
      | "history_unavailable"
      | "callback_failed"
      | null = null;
    try {
      const cryptoHandle = await verifyCryptoPostgresHandle(
        restrictedConnection,
      );
      const executed = await foregroundAuthorizations.execute<Value>({
        sessionReference: input.capability.sessionReference,
        scope: input.capability.scope,
        operationDeadline: rows[0]!.deadlineAt.getTime(),
        entrypointId: "foreground.conductor",
        operations: Object.freeze(["decrypt"]),
        execute: async (capability) => {
          try {
            const opened = await
              withDomainCompressedLiveShadowSessionCapabilityEntries(
              capability,
              (domains) => current.withCurrentRoomNamespaceKey({
                domains: domains.map((entry) => Object.freeze({
                  domainId: entry.grantDomainId,
                  domainKeyGeneration: entry.domainKeyGeneration,
                  authorizationRevision: entry.authorizationRevision,
                  headDigest: entry.headDigest,
                  domainKey: entry.domainAiGrantKey,
                })),
                use: async (namespaceKey) => {
                  const opened = await
                    openPostgresRuntimeInvocationProtectedInputSet({
                      product: productConnection,
                      restricted: restrictedConnection,
                      storage: new PostgresLatticeStorage(cryptoHandle),
                      crypto,
                      invocationId: input.invocationId,
                      operationIds: input.operationIds,
                      authority: current.protectedInput,
                      namespaceKey,
                      ...(input.expectedMergedHumanContent === undefined ? {} : {
                        expectedMergedContent: input.expectedMergedHumanContent,
                      }),
                    });
                  if (opened.status !== "verified") {
                    return Object.freeze({
                      status: "unavailable" as const,
                      reason: "content_unavailable" as const,
                    });
                  }
                  return Object.freeze({
                    status: "executed" as const,
                    value: await input.work(
                      opened.mergedContent,
                      (candidates) =>
                        openPostgresRuntimeInvocationProtectedHistoryHits({
                          product: productConnection,
                          storage: new PostgresLatticeStorage(cryptoHandle),
                          crypto,
                          roomId: input.roomId,
                          namespaceId: current.protectedInput.namespaceId,
                          namespaceAccessRevision:
                            current.protectedInput.namespaceAccessRevision,
                          namespaceKeyGeneration:
                            current.protectedInput.namespaceKeyGeneration,
                          namespaceKey,
                          candidates,
                        }),
                    ),
                  });
                },
              }),
            );
            return opened ?? Object.freeze({
              status: "unavailable" as const,
              reason: "authorization_unavailable" as const,
            });
          } catch (error) {
            protectedCallbackFailure = error instanceof Error
                && error.message === "protected_history_unavailable"
              ? "history_unavailable"
              : "callback_failed";
            throw error;
          }
        },
      });
      if (executed.status === "executed") return executed;
      if (protectedCallbackFailure === "history_unavailable") {
        return closeFallback("history", "content_unavailable");
      }
      if (protectedCallbackFailure === "callback_failed") {
        return closeFallback("routing", "protected_callback_failed");
      }
      return closeFallback("lease", executed.reason);
    } catch (error) {
      log(
        `[m299] Protected Conductor unavailable invocation=${input.invocationId} reason=${error instanceof Error ? error.name : "unknown"}`,
      );
      return error instanceof Error
          && error.message === "protected_history_unavailable"
        ? closeFallback("history", "content_unavailable")
        : closeFallback("routing", "protected_callback_failed");
    } finally {
      current.destroy();
    }
  };

  const recordRuntimeInvocationConductorOutcome: NonNullable<
    ProductionLiveShadowMessageComposition[
      "recordRuntimeInvocationConductorOutcome"
    ]
  > = (input) => getSharedAgentPlanner()
    .recordRuntimeInvocationConductorOutcome(input);

  const recordRuntimeInvocationConductorFallback: NonNullable<
    ProductionLiveShadowMessageComposition[
      "recordRuntimeInvocationConductorFallback"
    ]
  > = (input) => getSharedAgentPlanner()
    .recordRuntimeInvocationConductorFallback(input);

  const protectedEdit: ProtectedHumanMessageEditRouteService = {
    plan: async (request) => {
      const result = await (await getHumanMessageEditPlanner()).plan({
        roomId: request.roomId,
        messageId: request.messageId,
        expectedRevision: request.expectedRevision,
        subjectUserId: request.userId,
        subjectHumanId: request.actorId,
        clientDeviceId: request.clientDeviceId,
        clientIdempotencyKey: request.clientIdempotencyKey,
      });
      return result.status === "planned"
        ? {
          responseVersion: 1,
          status: "planned",
          representationMode: "full_encryption",
          planBytesBase64url: Buffer.from(result.planBytes).toString("base64url"),
        }
        : { responseVersion: 1, status: "unavailable", reason: result.reason };
    },
    publish: async (request) => {
      const decode = (value: string) => Uint8Array.from(Buffer.from(value, "base64url"));
      const result = await (await getHumanMessageEditPlanner()).publish({
        roomId: request.roomId,
        messageId: request.messageId,
        subjectUserId: request.userId,
        subjectHumanId: request.actorId,
        planBytes: decode(request.prepared.planBytesBase64url),
        requestBytes: decode(request.prepared.signedRequestBytesBase64url),
        preparedTargets: request.prepared.preparedTargets.map((target) => ({
          sessionId: target.sessionId,
          messageId: target.messageId,
          encryptedPayloadBytes: decode(target.encryptedPayloadBytesBase64url),
          manifestBytes: decode(target.accessManifestBytesBase64url),
          envelopeBytes: decode(target.namespaceEnvelopeBytesBase64url),
        })),
      });
      if (result.product.status !== "allocated" && result.product.status !== "replayed") {
        throw new TypeError(`Protected edit publication failed: ${result.product.status}`);
      }
      result.protectedMessages.forEach((message) =>
        publishProtectedMessageUpdated({ roomId: request.roomId, message })
      );
      return {
        responseVersion: 1,
        status: "published",
        representationMode: "full_encryption",
        editRevision: result.product.lifecycles[0]!.revision,
        targets: result.product.lifecycles.map((lifecycle) => ({
          sessionId: lifecycle.sessionId,
          messageId: lifecycle.messageId,
          cryptoObjectId: lifecycle.cryptoObjectId,
        })),
      };
    },
  };

  return Object.freeze({
    recipients,
    protectedEdit,
    plan: async (input: LiveShadowTurnPlanInput) => {
      const admittedPolicy = await loadRuntimePolicy();
      const humanAiReadable = await getSharedAgentPlanner().plan(input);
      const planned = (
        input.requestVersion === 2
        || humanAiReadable.status !== "ineligible"
        || humanAiReadable.reason !== "room_topology_unsupported"
      ) ? humanAiReadable : await (async () => {
        const legacyAgent = await getPlanner().plan(input);
        return legacyAgent.status === "ineligible"
            && legacyAgent.reason === "room_topology_unsupported"
          ? getHumanPeerPlanner().plan(input)
          : legacyAgent;
      })();
      if (planned.status !== "planned") return planned;
      const policy = await loadRuntimePolicy();
      if (
        policy.revision !== admittedPolicy.revision
        || policy.mode !== admittedPolicy.mode
      ) return Object.freeze({
        status: "unavailable" as const,
        reason: "policy_unavailable" as const,
      });
      return policy.mode === "encrypted_only"
        ? Object.freeze({ ...planned, representationMode: "full_encryption" as const })
        : planned;
    },
    admitPrepared,
    admitHumanPeer,
    admitSharedAgent,
    recordSharedAgentPublished,
    recordSharedAgentFallback,
    recordSharedAgentConductorResolution,
    reserveSharedAgentExecution,
    reserveSharedAgentRuntimeInvocation,
    attachSharedAgentRuntimeInvocationExecutions,
    reserveSharedAgentRuntimeResume,
    planRuntimeInvocationAuthorization,
    planSharedAgentExecutionAuthorization,
    awaitRuntimeInvocationAuthorization,
    runRuntimeInvocationConductor,
    recordRuntimeInvocationConductorOutcome,
    recordRuntimeInvocationConductorFallback,
    awaitSharedAgentExecutionAuthorization,
    admitSharedAgentExecutionAuthorization,
    admitSharedAgentRuntimeAuthorization,
    admitRuntimeInvocationAuthorization,
    recordSharedAgentExecutionUnavailable,
    acknowledgeSharedAgent,
    planSharedAgentAcknowledgement,
    planSharedAgentOutputRead,
    acknowledgeSharedAgentOutput,
    recordHumanPeerPublished,
    recordHumanPeerFallback,
    acknowledgeHumanPeer,
    planHumanPeerAcknowledgement,
    recordFallback: (input: LiveShadowTurnFallbackInput) =>
      getPlanner().recordFallback(input),
    bindJob: (input: LiveShadowTurnJobBindingInput) =>
      getPlanner().bindJob(input),
    runDispatchOnce: async <Value>(input: Readonly<{
      operationId: string;
      now: number;
      work(): Promise<Value>;
    }>): Promise<Value> => {
      for (const [operationId, retained] of dispatches) {
        if (retained.expiresAt <= input.now) dispatches.delete(operationId);
      }
      const existing = dispatches.get(input.operationId);
      if (existing !== undefined) return existing.promise as Promise<Value>;
      if (dispatches.size >= 128) {
        const oldest = dispatches.keys().next().value;
        if (oldest !== undefined) dispatches.delete(oldest);
      }
      const promise = input.work();
      dispatches.set(input.operationId, Object.freeze({
        promise,
        expiresAt: input.now + 5 * 60_000,
      }));
      try {
        return await promise;
      } catch (cause) {
        dispatches.delete(input.operationId);
        throw cause;
      }
    },
    verifyClient: async (input: LiveShadowClientVerificationInput) => {
      const productConnection = createPostgresJsBridgeConnection(
        getServerDirectDb(),
      );
      const restrictedConnection = createPostgresJsBridgeConnection(
        getSharedDirectCryptoDb(),
      );
      const cryptoHandle = await verifyCryptoPostgresHandle(
        restrictedConnection,
      );
      return verifyAndRecordLiveShadowClientVerification({
        product: productConnection,
        restricted: restrictedConnection,
        storage: new PostgresLatticeStorage(cryptoHandle),
        crypto,
      }, input);
    },
    recover: async (
      input: Parameters<ProductionLiveShadowMessageComposition["recover"]>[0],
    ) => {
      const productConnection = createPostgresJsBridgeConnection(
        getServerDirectDb(),
      );
      const cryptoHandle = await verifyCryptoPostgresHandle(
        createPostgresJsBridgeConnection(getSharedDirectCryptoDb()),
      );
      const storage = new PostgresLatticeStorage(cryptoHandle);
      const previous = await recoverPostgresLiveShadowTurn({
        product: productConnection,
        storage,
      }, input);
      if (previous.status !== "absent") return previous;
      return recoverPostgresPublishedHumanMessage({
        product: await verifyConversationProductPostgresHandle(productConnection),
        storage,
        crypto,
      }, input);
    },
    runAgentTurn: async <Value>(input: Readonly<{
      operationId: string;
      capability: LiveShadowExecutionCapability;
      entrypointId?: "foreground.main" | "foreground.fork";
      expectedMergedHumanContent?: string;
      work(
        session: LiveShadowAgentTurnSession,
        openedHumanContent?: string,
        authorizationSignal?: AbortSignal,
      ): Promise<Value>;
    }>): Promise<LiveShadowAgentTurnExecutionResult<Value>> => {
      const retained = agentPlans.get(input.operationId);
      if (retained === undefined) {
        return agentFallback(input.operationId, "plan_absent");
      }
      agentPlans.delete(input.operationId);
      let foregroundPlan: ForegroundSessionLiveShadowMessagePlan | null = null;
      try {
        foregroundPlan = decodeLiveShadowMessagePlanV4(retained.bytes);
      } catch {
        retained.bytes.fill(0);
        return agentFallback(input.operationId, "plan_invalid");
      }
      if (foregroundPlan !== null) {
        retained.bytes.fill(0);
        if (
          !("kind" in input.capability)
          || input.capability.kind !== "foreground_session"
        ) {
          destroyForegroundPlan(foregroundPlan);
          return agentFallback(input.operationId, "capability_mismatch");
        }
        const token = input.capability;
        const agentRuntime = recipients.takeAgentRuntime(input.operationId);
        if (agentRuntime === null) {
          token.authorizationDigest.fill(0);
          token.scope.domainAuthoritySetDigest.fill(0);
          destroyForegroundPlan(foregroundPlan);
          return agentFallback(input.operationId, "runtime_absent");
        }
        let authority: Awaited<ReturnType<
          typeof createPostgresDomainKeyV2LiveShadowCurrentAuthority
        >> = null;
        let historicalHumanKey: Uint8Array | null = null;
        try {
          const policy = await loadRuntimePolicy();
          if (policy.revision !== foregroundPlan.policyRevision || policy.mode === "plaintext_only") {
            return agentFallback(input.operationId, "policy_changed");
          }
          const sourceRepresentationMode = policy.mode === "encrypted_only"
            ? "protected-only" as const : "ordinary-and-protected" as const;
          const productDb = getServerDirectDb();
          const productConnection = createPostgresJsBridgeConnection(
            productDb,
          );
          const restrictedConnection = createPostgresJsBridgeConnection(
            getSharedDirectCryptoDb(),
          );
          authority = await createPostgresDomainKeyV2LiveShadowCurrentAuthority({
            product: productConnection,
            restricted: restrictedConnection,
            crypto,
            serverId,
            plan: foregroundPlan,
            representationMode: policy.mode === "encrypted_only"
              ? "full_encryption"
              : "shadow_encryption",
            resolveReadableNamespaces,
            source: retained.source,
            onDiagnostic: (stage) => log(
              `[live-shadow] V2 Domain authority unavailable operation=${input.operationId} stage=${stage}`,
            ),
          });
          if (authority === null || !await authority.verifyCurrentPlan()) {
            foregroundAuthorizations.cancelScope(token.scope);
            return agentFallback(input.operationId, "authority_stale");
          }
          const [productHandle, cryptoHandle] = await Promise.all([
            verifyConversationProductPostgresHandle(productConnection),
            verifyCryptoPostgresHandle(restrictedConnection),
          ]);
          const canonicalProductRunner =
            bindConversationProductCanonicalTransactionRunner(
              productHandle,
              createPostgresJsCanonicalBridgeConnection(productDb),
            );
          const product = new PostgresConversationProductStore(
            productHandle,
            canonicalProductRunner,
          );
          historicalHumanKey = authority.signingPublicKey();
          if (historicalHumanKey === null) {
            return agentFallback(input.operationId, "signing_key_absent");
          }
          const storage = new PostgresLatticeStorage(cryptoHandle);
          const signerHistory = new PostgresHumanDeviceSignerHistory({
            handle: cryptoHandle,
            crypto,
          });
          const resolveForegroundSigner = createPostgresForegroundAgentSignerResolver({
            product: productHandle,
            crypto,
          });
          const completion = createPostgresConversationCryptoCompletion({
            handle: cryptoHandle,
            crypto,
            resolveCurrentWriteAuthorization:
              authority.resolveCurrentHumanObjectWrite,
            resolveHistoricalSigner:
              signerHistory.resolveHistoricalObjectSigner,
            resolveHistoricalAgentSignerAuthority:
              signerHistory.resolveAgentRuntimeSignerManager,
            resolveLiveShadowAgentSigner: (principal) =>
              principal.agentId === foregroundPlan.recipientAgentId
                  && principal.runtimeGeneration
                    === foregroundPlan.agentRuntimeGeneration
                  && principal.signerKeyId === foregroundPlan.agentSignerKeyId
                ? foregroundPlan.agentSignerPublicKey.slice()
                : null,
          });
          const foregroundNamespaceKeys = new PostgresDomainKeyAuthorityRepository(
            restrictedConnection,
            crypto,
            serverId,
          );
          const entityCrypto = createForegroundAgentEntityCryptoGateway({
            authorizations: foregroundAuthorizations,
            namespaceKeys: foregroundNamespaceKeys,
          });
          const executed = await entityCrypto.execute({
            sessionReference: token.sessionReference,
            scope: token.scope,
            operationDeadline: retained.deadlineAt,
            entrypointId: input.entrypointId ?? "foreground.main",
            operations: Object.freeze(["decrypt", "encrypt"]),
            execute: async ({ entities, grant: description }) => {
              const openedRoom = await entities.use({
                operations: Object.freeze(["decrypt", "encrypt"]),
                entity: Object.freeze({
                  namespaceId: foregroundPlan.namespaceId,
                  keyGeneration: foregroundPlan.namespaceKeyGeneration,
                  accessRevision: foregroundPlan.namespaceAccessRevision,
                }),
                execute: async ({ namespaceKey }) => {
                        let openedHumanContent: string | undefined;
                        let causalHumanTurnId: string | undefined;
                        if (retained.source === "shared_execution") {
                          if (sourceRepresentationMode !== "protected-only"
                            && input.expectedMergedHumanContent === undefined) {
                            log(
                              `[live-shadow] Protected input context absent operation=${input.operationId}`,
                            );
                            await getSharedAgentPlanner()
                              .recordExecutionUnavailable({
                                executionId: input.operationId,
                                reason: "protected_input_context_absent",
                                now: Date.now(),
                              });
                            return null;
                          }
                          const opened = await
                            openPostgresSharedAgentProtectedInputSet({
                              product: productConnection,
                              restricted: restrictedConnection,
                              storage,
                              crypto,
                              plan: foregroundPlan,
                              namespaceKey,
                              ...(sourceRepresentationMode === "protected-only"
                                || input.expectedMergedHumanContent === undefined ? {} : {
                                  expectedMergedContent: input.expectedMergedHumanContent,
                                }),
                            });
                          if (opened.status !== "verified") {
                            log(
                              `[live-shadow] Protected input unavailable operation=${input.operationId} reason=${opened.reason}`,
                            );
                            await getSharedAgentPlanner()
                              .recordExecutionUnavailable({
                                executionId: input.operationId,
                                reason: opened.reason,
                                now: Date.now(),
                            });
                            return null;
                          }
                          openedHumanContent = opened.mergedContent;
                          causalHumanTurnId = opened.causalHumanTurnId;
                        } else if (retained.source === "shared_resume") {
                          const originalHumanTurnId = await getSharedAgentPlanner()
                            .loadResumeCausalHumanTurnId({
                              executionId: foregroundPlan.operationId,
                              sessionId: foregroundPlan.sessionId,
                              roomId: foregroundPlan.roomId,
                              agentId: foregroundPlan.recipientAgentId,
                              subjectHumanId: foregroundPlan.subjectHumanId,
                              subjectUserId: authority!.causalHumanUserId,
                              policyRevision: foregroundPlan.policyRevision,
                            });
                          if (originalHumanTurnId === null) {
                            await getSharedAgentPlanner().recordExecutionUnavailable({
                              executionId: foregroundPlan.operationId,
                              reason: "resume_causal_input_unavailable",
                              now: Date.now(),
                            });
                            return null;
                          }
                          causalHumanTurnId = originalHumanTurnId;
                        }
                        const derived = deriveAgentRuntimeObjectSignerPublic(
                          crypto,
                          agentRuntime,
                        );
                        try {
                          if (
                            agentRuntime.agentId
                              !== foregroundPlan.recipientAgentId
                            || agentRuntime.generation
                              !== foregroundPlan.agentRuntimeGeneration
                            || derived.principal.signerKeyId
                              !== foregroundPlan.agentSignerKeyId
                            || !derived.publicKey.every((value, index) =>
                              value === foregroundPlan.agentSignerPublicKey[index]
                            )
                          ) {
                            log(
                              `[live-shadow] Agent Runtime identity mismatch operation=${input.operationId}`,
                            );
                            return null;
                          }
                          let terminalization: Promise<void> | null = null;
                          const conversation =
                            createDormantConversationShadowRepository({
                              product,
                              crypto: completion,
                            });
                          const repairProduct = await createForegroundMessageProductStore({
                            userId: authority!.causalHumanUserId,
                            agentId: foregroundPlan.recipientAgentId,
                          });
                          const historyRepairer =
                            createForegroundMessageHistoryRepairer({
                              crypto,
                              cryptoCompletion: completion,
                              storage,
                              entities,
                              product: repairProduct,
                              conversation: createDormantConversationShadowRepository({
                                product: repairProduct,
                                crypto: completion,
                              }),
                              contextNamespaceId:
                                foregroundPlan.namespaceId,
                              sourceRepresentationMode:
                                sourceRepresentationMode,
                              publication: {
                                operationId: foregroundPlan.operationId,
                                policyRevision: foregroundPlan.policyRevision,
                                grantId: description.authorizationId,
                                grantDigest: description.authorizationDigest,
                                recipientKeyId: description.recipientKeyId,
                                agentAuthorizationRevision:
                                  foregroundPlan.agentAuthorizationRevision,
                                signerKeyId: foregroundPlan.agentSignerKeyId,
                                signerPublicKey:
                                  foregroundPlan.agentSignerPublicKey,
                                runtime: agentRuntime,
                                withCurrentPublication: (request) =>
                                  repairProduct.withAuthorizedExistingRepresentationPublication({
                                    ...request,
                                    prepareAuthority: async (scopedProduct) => {
                                      const scoped = await createPostgresDomainKeyV2LiveShadowCurrentAuthority({
                                        product: scopedProduct, restricted: restrictedConnection,
                                        crypto, serverId, plan: foregroundPlan,
                                        representationMode: policy.mode === "encrypted_only" ? "full_encryption" : "shadow_encryption",
                                        source: retained.source,
                                        resolveReadableNamespaces: async (coordinates) => {
                                          const readable = [...new Set(await resolveReadableNamespaces(coordinates))].sort();
                                          const admitted = [...description.namespaceIds].sort();
                                          // Every revalidation locks the SAME full sorted Room set.
                                          // A changed grant set must fail before acquiring more locks.
                                          if (readable.length !== admitted.length || readable.some((id, index) => id !== admitted[index])) {
                                            throw new Error("Foreground publication namespace authority changed");
                                          }
                                          return readable;
                                        },
                                      });
                                      if (scoped === null) return null;
                                      try {
                                        if (await scoped.verifyCurrentPlan()) return scoped;
                                      } catch (error) {
                                        scoped.destroy();
                                        throw error;
                                      }
                                      scoped.destroy();
                                      return null;
                                    },
                                    use: (scopedProduct, scopedAuthority) => request.use({
                                      product: scopedProduct,
                                      resolveCurrentAuthorization: scopedAuthority.resolveCurrentForegroundEntityObjectWrite,
                                    }),
                                    disposeAuthority: (scopedAuthority) => scopedAuthority.destroy(),
                                  }),
                              },
                              loadSources: (selection) =>
                                loadPostgresForegroundMessageRepairSources({
                                  product: productHandle,
                                  ...selection,
                                }),
                              resolveHistoricalHumanSigner:
                                signerHistory.resolveHistoricalObjectSigner,
                              resolveLiveShadowAgentSigner:
                                resolveForegroundSigner,
                              resolveHistoricalAgentSignerAuthority:
                                signerHistory
                                  .resolveAgentRuntimeSignerManager,
                            });
                          const journalRepairer =
                            createForegroundJournalHistoryRepairer({
                              crypto,
                              entities,
                              room: {
                                roomId: foregroundPlan.roomId,
                                namespaceId: foregroundPlan.namespaceId,
                              },
                              sourceRepresentationMode:
                                sourceRepresentationMode,
                              publication: {
                                operationId: foregroundPlan.operationId,
                                grantId: description.authorizationId,
                                grantDigest: description.authorizationDigest,
                                recipientKeyId: description.recipientKeyId,
                                runtime: agentRuntime,
                                signerKeyId: foregroundPlan.agentSignerKeyId,
                                signerPublicKey:
                                  foregroundPlan.agentSignerPublicKey,
                                agentAuthorizationRevision:
                                  foregroundPlan.agentAuthorizationRevision,
                                policyRevision: foregroundPlan.policyRevision,
                              },
                              selection:
                                createPostgresForegroundJournalSelectionPort({
                                  product: productHandle,
                                }),
                              loadSources: (snapshot, representationMode) =>
                                loadPostgresForegroundJournalRepairSources({
                                  product: productHandle,
                                  snapshot,
                                  representationMode:
                                    representationMode ?? sourceRepresentationMode,
                                }),
                              persist: (prepared) =>
                                persistDeviceWrappedAgentObject({
                                  handle: cryptoHandle,
                                  crypto,
                                  prepared,
                                  resolveCurrentAuthorization:
                                    authority!
                                      .resolveCurrentForegroundEntityObjectWrite,
                                }),
                              read: (request) =>
                                readVerifiedDeviceWrappedAgentObject({
                                  handle: cryptoHandle,
                                  crypto,
                                  ...request,
                                  resolveLiveShadowAgentSigner: resolveForegroundSigner,
                                  resolveHistoricalAgentSignerAuthority:
                                    signerHistory
                                      .resolveAgentRuntimeSignerManager,
                                }),
                              validateExisting: (request) =>
                                validatePostgresForegroundJournalRepairSource({
                                  product: productHandle,
                                  ...request,
                                }),
                              attach: (request) =>
                                attachPostgresForegroundJournalRepair({
                                  product: productHandle,
                                  ...request,
                                }),
                              ...(sourceRepresentationMode !== "ordinary-and-protected"
                                ? {}
                                : { restoreOrdinary: (request) =>
                                  restorePostgresForegroundJournalOrdinary({
                                    canonical: canonicalProductRunner,
                                    ...request,
                                  }) }),
                            });
                          const recordRepairer =
                            createForegroundRecordHistoryRepairer({
                              crypto,
                              entities,
                              sourceRepresentationMode:
                                sourceRepresentationMode,
                              publication: {
                                operationId: foregroundPlan.operationId,
                                grantId: description.authorizationId,
                                grantDigest: description.authorizationDigest,
                                recipientKeyId: description.recipientKeyId,
                                runtime: agentRuntime,
                                signerKeyId: foregroundPlan.agentSignerKeyId,
                                signerPublicKey:
                                  foregroundPlan.agentSignerPublicKey,
                                agentAuthorizationRevision:
                                  foregroundPlan.agentAuthorizationRevision,
                                policyRevision: foregroundPlan.policyRevision,
                              },
                              loadSources: (records, representationMode) =>
                                loadPostgresForegroundRecordRepairSources({
                                  product: productHandle,
                                  records,
                                  representationMode:
                                    representationMode ?? sourceRepresentationMode,
                                }),
                              persist: (prepared) =>
                                persistDeviceWrappedAgentObject({
                                  handle: cryptoHandle,
                                  crypto,
                                  prepared,
                                  resolveCurrentAuthorization:
                                    authority!
                                      .resolveCurrentForegroundEntityObjectWrite,
                                }),
                              read: (request) =>
                                readVerifiedDeviceWrappedAgentObject({
                                  handle: cryptoHandle,
                                  crypto,
                                  ...request,
                                  resolveLiveShadowAgentSigner: resolveForegroundSigner,
                                  resolveHistoricalAgentSignerAuthority:
                                    signerHistory
                                      .resolveAgentRuntimeSignerManager,
                                }),
                              validateExisting: (request) =>
                                validatePostgresForegroundRecordRepairSource({
                                  product: productHandle,
                                  ...request,
                                }),
                              attach: (request) =>
                                attachPostgresForegroundRecordRepair({
                                  product: productHandle,
                                  ...request,
                                }),
                              ...(sourceRepresentationMode !== "ordinary-and-protected"
                                ? {}
                                : { restoreOrdinary: (request) =>
                                  restorePostgresForegroundRecordOrdinary({
                                    canonical: canonicalProductRunner,
                                    ...request,
                                  }) }),
                            });
                          const memoryRepairer =
                            createForegroundMemoryHistoryRepairer({
                              crypto,
                              entities,
                              sourceRepresentationMode:
                                sourceRepresentationMode,
                              publication: {
                                operationId: foregroundPlan.operationId,
                                grantId: description.authorizationId,
                                grantDigest: description.authorizationDigest,
                                recipientKeyId: description.recipientKeyId,
                                runtime: agentRuntime,
                                signerKeyId: foregroundPlan.agentSignerKeyId,
                                signerPublicKey:
                                  foregroundPlan.agentSignerPublicKey,
                                agentAuthorizationRevision:
                                  foregroundPlan.agentAuthorizationRevision,
                                policyRevision: foregroundPlan.policyRevision,
                              },
                              loadSources: (memories, representationMode) =>
                                loadPostgresForegroundMemoryRepairSources({
                                  product: productHandle,
                                  crypto,
                                  memories,
                                  representationMode:
                                    representationMode ?? sourceRepresentationMode,
                                }),
                              persist: (prepared) =>
                                persistDeviceWrappedAgentObject({
                                  handle: cryptoHandle,
                                  crypto,
                                  prepared,
                                  resolveCurrentAuthorization:
                                    authority!
                                      .resolveCurrentForegroundEntityObjectWrite,
                                }),
                              read: (request) =>
                                readVerifiedDeviceWrappedAgentObject({
                                  handle: cryptoHandle,
                                  crypto,
                                  ...request,
                                  resolveLiveShadowAgentSigner: resolveForegroundSigner,
                                  resolveHistoricalAgentSignerAuthority:
                                    signerHistory
                                      .resolveAgentRuntimeSignerManager,
                                }),
                              validateExisting: (request) =>
                                validatePostgresForegroundMemoryRepairSource({
                                  product: productHandle,
                                  ...request,
                                }),
                              attach: (request) =>
                                attachPostgresForegroundMemoryRepair({
                                  product: productHandle,
                                  ...request,
                                }),
                              ...(sourceRepresentationMode !== "ordinary-and-protected"
                                ? {}
                                : { restoreOrdinary: (request) =>
                                  restorePostgresForegroundMemoryOrdinary({
                                    canonical: canonicalProductRunner,
                                    ...request,
                                  }) }),
                            });
                          const session = createLiveShadowAgentTurnSession({
                            representationMode: policy.mode === "encrypted_only"
                              ? "full_encryption" : "shadow_encryption",
                            crypto,
                            plan: foregroundPlan,
                            causalHumanUserId: authority!.causalHumanUserId,
                            ...(causalHumanTurnId === undefined
                              ? {}
                              : { causalHumanTurnId }),
                            product,
                            conversation,
                            namespace: {
                              namespaceId: foregroundPlan.namespaceId,
                              accessRevision:
                                foregroundPlan.namespaceAccessRevision,
                              keyGeneration:
                                foregroundPlan.namespaceKeyGeneration,
                              headDigest:
                                foregroundPlan.namespaceHeadDigest.slice(),
                              publicationDigest:
                                foregroundPlan.namespacePublicationDigest.slice(),
                              publicationSetDigest:
                                foregroundPlan.namespacePublicationSetDigest.slice(),
                              audienceFingerprint:
                                foregroundPlan.namespaceAudienceFingerprint.slice(),
                              aiKey: namespaceKey.slice(),
                            },
                            runtime: Object.freeze({
                              ...agentRuntime,
                              key: agentRuntime.key.slice(),
                            }),
                            grantId: description.authorizationId,
                            grantDigest: description.authorizationDigest,
                            authorizationDeadlineAt: Math.min(description.expiresAt, retained.deadlineAt),
                            authorizationSignal: entities.signal,
                            checkpoint:
                              createForegroundEntityCheckpointAuthorization({
                                crypto,
                                entities,
                                namespaceId: foregroundPlan.namespaceId,
                                namespaceAccessRevision:
                                  foregroundPlan.namespaceAccessRevision,
                                namespaceKeyGeneration:
                                  foregroundPlan.namespaceKeyGeneration,
                                domainId: foregroundPlan.grantDomainId,
                                agentAuthorizationRevision:
                                  foregroundPlan.agentAuthorizationRevision,
                                authorizationDeadlineAt:
                                  Math.min(description.expiresAt, retained.deadlineAt),
                                entrypointId:
                                  input.entrypointId ?? "foreground.main",
                              }),
                            recipientKeyId: description.recipientKeyId,
                            resolveCurrentDeviceWrappedAgentObjectAuthorization:
                              authority!.resolveCurrentAgentObjectWrite,
                            protectForegroundHistory:
                              historyRepairer.protect,
                            protectForegroundJournal:
                              journalRepairer.protect,
                            protectForegroundRecords:
                              recordRepairer.protect,
                            protectForegroundMemories:
                              memoryRepairer.protect,
                            createForegroundMemoryRepository: (envelope) =>
                              createForegroundMemoryRepository({
                                envelope,
                                policy,
                                resolvePolicy: loadRuntimePolicy,
                                wakeEffectRecovery:
                                  wakeForegroundMemoryEffectRecovery,
                                domain: {
                                  subjectUserId: authority!.causalHumanUserId,
                                  agentId: foregroundPlan.recipientAgentId,
                                  entrypointId: input.entrypointId ?? "foreground.main",
                                  crypto,
                                  entities,
                                  publication: {
                                    authorizationOperationId: foregroundPlan.operationId,
                                    grantId: description.authorizationId,
                                    grantDigest: description.authorizationDigest,
                                    recipientKeyId: description.recipientKeyId,
                                    runtime: agentRuntime,
                                    signerKeyId: foregroundPlan.agentSignerKeyId,
                                    signerPublicKey: foregroundPlan.agentSignerPublicKey,
                                    agentAuthorizationRevision: foregroundPlan.agentAuthorizationRevision,
                                  },
                                  persist: (prepared) => persistDeviceWrappedAgentObject({
                                    handle: cryptoHandle, crypto, prepared,
                                    resolveCurrentAuthorization: authority!.resolveCurrentForegroundEntityObjectWrite,
                                  }),
                                  read: (request) => readVerifiedDeviceWrappedAgentObject({
                                    handle: cryptoHandle, crypto, ...request,
                                    resolveNativeNamespaceEntries: (coordinates) =>
                                      resolveForegroundMemoryNativeEntries(
                                        foregroundNamespaceKeys,
                                        coordinates,
                                      ),
                                    resolveLiveShadowAgentSigner: resolveForegroundSigner,
                                    resolveHistoricalAgentSignerAuthority: signerHistory.resolveAgentRuntimeSignerManager,
                                  }),
                                },
                              }),
                            createForegroundMemoryAccessPort: (envelope) =>
                              createForegroundMemoryAccessPort({
                                envelope,
                                resolveGrantUserNamespace: async ({ authority: memoryAuthority,
                                  userHandle }) => {
                                  const requester = await findActorByOwnerId(
                                    memoryAuthority.subjectUserId,
                                  );
                                  const target = await findActorByHandle(
                                    userHandle.replace(/^@/u, "").toLowerCase(),
                                  );
                                  if (requester === null || target === null
                                    || target.kind !== "user"
                                    || target.actorId === requester.id) return null;
                                  const destination = await findOrCreateAccessNamespace(
                                    [requester.id, target.actorId],
                                    { requesterUserId: memoryAuthority.subjectUserId,
                                      requesterActorId: requester.id },
                                  );
                                  return memoryAuthority.writableNamespaceId
                                      === destination.namespaceId
                                      || memoryAuthority.mutableNamespaceIds.includes(
                                        destination.namespaceId,
                                      ) ? destination.namespaceId : null;
                                },
                                exact: {
                                  handle: cryptoHandle,
                                  namespaceKeys: foregroundNamespaceKeys,
                                  resolveHistoricalAgentSignerAuthority:
                                    signerHistory.resolveAgentRuntimeSignerManager,
                                  resolveLiveShadowAgentSigner: resolveForegroundSigner,
                                  resolveCurrentAgentSigner: (principal) =>
                                    principal.agentId === foregroundPlan.recipientAgentId
                                        && principal.runtimeGeneration
                                          === foregroundPlan.agentRuntimeGeneration
                                        && principal.signerKeyId
                                          === foregroundPlan.agentSignerKeyId
                                      ? foregroundPlan.agentSignerPublicKey.slice()
                                      : null,
                                },
                                domain: {
                                  subjectUserId: authority!.causalHumanUserId,
                                  agentId: foregroundPlan.recipientAgentId,
                                  entrypointId: input.entrypointId ?? "foreground.main",
                                  crypto,
                                  entities,
                                  publication: {
                                    authorizationOperationId: foregroundPlan.operationId,
                                    grantId: description.authorizationId,
                                    grantDigest: description.authorizationDigest,
                                    recipientKeyId: description.recipientKeyId,
                                    runtime: agentRuntime,
                                    signerKeyId: foregroundPlan.agentSignerKeyId,
                                    signerPublicKey: foregroundPlan.agentSignerPublicKey,
                                    agentAuthorizationRevision:
                                      foregroundPlan.agentAuthorizationRevision,
                                  },
                                  persist: (prepared) => persistDeviceWrappedAgentObject({
                                    handle: cryptoHandle, crypto, prepared,
                                    resolveCurrentAuthorization:
                                      authority!.resolveCurrentForegroundEntityObjectWrite,
                                  }),
                                  read: async (request) => {
                                    const verified = await readVerifiedDeviceWrappedAgentObject({
                                      handle: cryptoHandle, crypto, ...request,
                                      resolveNativeNamespaceEntries: (coordinates) =>
                                        resolveForegroundMemoryNativeEntries(
                                          foregroundNamespaceKeys,
                                          coordinates,
                                        ),
                                      resolveLiveShadowAgentSigner: resolveForegroundSigner,
                                      resolveHistoricalAgentSignerAuthority:
                                        signerHistory.resolveAgentRuntimeSignerManager,
                                    });
                                    return verified?.nativeEntries === undefined
                                      ? null
                                      : { ...verified,
                                        nativeEntries: verified.nativeEntries };
                                  },
                                },
                              }),
                            createForegroundMemoryProjectionPort: (envelope) =>
                              createForegroundMemoryProjectionPort({
                                envelope, policy,
                                wakeEffectRecovery:
                                  wakeForegroundMemoryEffectRecovery,
                                domain: {
                                  subjectUserId: authority!.causalHumanUserId,
                                  agentId: foregroundPlan.recipientAgentId,
                                  entrypointId: input.entrypointId ?? "foreground.main",
                                  crypto, entities,
                                  publication: {
                                    authorizationOperationId: foregroundPlan.operationId,
                                    grantId: description.authorizationId,
                                    grantDigest: description.authorizationDigest,
                                    recipientKeyId: description.recipientKeyId,
                                    runtime: agentRuntime,
                                    signerKeyId: foregroundPlan.agentSignerKeyId,
                                    signerPublicKey: foregroundPlan.agentSignerPublicKey,
                                    agentAuthorizationRevision:
                                      foregroundPlan.agentAuthorizationRevision,
                                  },
                                  persist: (prepared) => persistDeviceWrappedAgentObject({
                                    handle: cryptoHandle, crypto, prepared,
                                    resolveCurrentAuthorization:
                                      authority!.resolveCurrentForegroundEntityObjectWrite,
                                  }),
                                  read: (request) => readVerifiedDeviceWrappedAgentObject({
                                    handle: cryptoHandle, crypto, ...request,
                                    resolveNativeNamespaceEntries: (coordinates) =>
                                      resolveForegroundMemoryNativeEntries(
                                        foregroundNamespaceKeys, coordinates,
                                      ),
                                    resolveLiveShadowAgentSigner: resolveForegroundSigner,
                                    resolveHistoricalAgentSignerAuthority:
                                      signerHistory.resolveAgentRuntimeSignerManager,
                                  }),
                                },
                              }),
                            sharedAgentExecution:
                              retained.source !== "turn",
                            onDiagnostic: (stage, error) => log(
                              `[live-shadow] Agent crypto session unavailable operation=${input.operationId} stage=${stage} error=${errorCauseSummary(error)}`,
                            ),
                            onTerminalFailure: (stage, reason) => {
                              if (
                                retained.source === "turn"
                                || terminalization !== null
                              ) return;
                              terminalization = getSharedAgentPlanner()
                                .recordExecutionUnavailable({
                                  executionId: input.operationId,
                                  reason: `agent_${stage}_${reason}`,
                                  now: Date.now(),
                                })
                                .then((outcome) => {
                                  if (outcome === "conflict") {
                                    log(
                                      `[live-shadow] Agent execution terminalization conflicted operation=${input.operationId}`,
                                    );
                                  }
                                })
                                .catch((error) => {
                                  log(
                                    `[live-shadow] Agent execution terminalization failed operation=${input.operationId} error=${errorCauseSummary(error)}`,
                                  );
                                });
                            },
                          });
                          try {
                            const value = await input.work(
                                session,
                                openedHumanContent,
                                entities.signal,
                              );
                            return Object.freeze({
                              value,
                            });
                          } finally {
                            await (terminalization ?? Promise.resolve());
                            session.destroy();
                          }
                  } finally {
                    derived.publicKey.fill(0);
                  }
                },
              });
              return openedRoom.status === "executed"
                ? openedRoom.value
                : null;
            },
          });
          if (executed.status === "executed") {
            if (executed.value !== null) {
              return Object.freeze({
                status: "executed" as const,
                value: executed.value.value,
              });
            }
            log(
              `[live-shadow] Foreground content unavailable operation=${input.operationId}`,
            );
          } else {
            log(
              `[live-shadow] Foreground session unavailable operation=${input.operationId} reason=${executed.reason}`,
            );
          }
          return agentFallback(input.operationId, "session_unavailable");
        } finally {
          agentRuntime.key.fill(0);
          historicalHumanKey?.fill(0);
          authority?.destroy();
          token.authorizationDigest.fill(0);
          token.scope.domainAuthoritySetDigest.fill(0);
          destroyForegroundPlan(foregroundPlan);
        }
      }
      return agentFallback(input.operationId, "plan_invalid");
    },
    get pendingAttention() {
      return pendingAttention ??= createProductionForegroundPendingAttention(recipients);
    },
    teardownForegroundAuthorizationSessions: (request: Readonly<{
      authority: Readonly<{ userId: string; humanActorId: string }>;
    }>) => {
      foregroundAuthorizations.cancelForHuman(
        request.authority.humanActorId,
      );
      pendingAttention?.cancelForHuman(request.authority.humanActorId);
    },
    reconcileLifecycle: async (request: Readonly<{
      now?: number;
      maximum?: number;
    }> = {}) => {
      const now = request.now ?? Date.now();
      const maximum = request.maximum ?? 64;
      const [turnOperations, humanPeerOperations, sharedAgentOperations] =
        await Promise.all([
          getPlanner().reconcileExpired(now, maximum),
          getHumanPeerPlanner().reconcileExpired(now, maximum),
          getSharedAgentPlanner().reconcileExpired(now, maximum),
        ]);
      return Object.freeze({
        turnOperations,
        humanPeerOperations,
        sharedAgentOperations,
      });
    },
    shutdown: async () => {
      pendingAttention?.close();
      foregroundAuthorizations.close();
      const operationIds = new Set(agentPlans.keys());
      for (const executionId of sharedAgentAuthorizationWaiters.keys()) {
        operationIds.add(executionId);
      }
      for (const executionId of sharedAgentAcceptedAuthorizations.keys()) {
        operationIds.add(executionId);
      }
      for (const invocationId of runtimeInvocationAuthorizationWaiters.keys()) {
        operationIds.add(invocationId);
      }
      for (const invocationId of
        runtimeInvocationAcceptedAuthorizations.keys()) {
        operationIds.add(invocationId);
      }
      for (const waiter of sharedAgentAuthorizationWaiters.values()) {
        clearTimeout(waiter.timer);
        waiter.resolve(null);
      }
      sharedAgentAuthorizationWaiters.clear();
      for (const [executionId, accepted] of
        sharedAgentAcceptedAuthorizations) {
        destroySharedAgentAcceptedAuthorization(executionId, accepted);
      }
      sharedAgentAcceptedAuthorizations.clear();
      for (const waiter of runtimeInvocationAuthorizationWaiters.values()) {
        clearTimeout(waiter.timer);
        waiter.resolve(null);
      }
      runtimeInvocationAuthorizationWaiters.clear();
      for (const accepted of runtimeInvocationAcceptedAuthorizations.values()) {
        destroyRuntimeInvocationAcceptedAuthorization(accepted);
      }
      runtimeInvocationAcceptedAuthorizations.clear();
      for (const retained of agentPlans.values()) retained.bytes.fill(0);
      agentPlans.clear();
      for (const operationId of recipients.shutdown()) {
        operationIds.add(operationId);
      }
      dispatches.clear();
      if (planner !== null && operationIds.size > 0) {
        await planner.recordProcessLoss([...operationIds], Date.now());
      }
      if (sharedAgentPlanner !== null && operationIds.size > 0) {
        await sharedAgentPlanner.recordProcessLoss(
          [...operationIds],
          Date.now(),
        );
      }
    },
  });
}
