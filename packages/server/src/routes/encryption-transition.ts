import { homedir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  EncryptionTransitionPolicyConflictError,
  MaintenanceTransitionError,
  ENCRYPTION_TRANSITION_OBSERVATION_POLICY_V1,
  UnsupportedEncryptionTransitionStateError,
  compareAndSwapEncryptionTransitionPolicy,
  consumeEncryptionTransitionObservationAdmission,
  getEncryptionTransitionPolicy,
  getSharedDirectCryptoDb,
  reconcileExpiredEncryptionTransitionObservationAdmissions,
  reconcileExpiredEncryptionTransitionHistoryReadAdmissions,
  readEncryptionTransitionDashboard,
  readEncryptionTransitionObservationPressure,
  readEncryptionTransitionHistoryReadActivity,
  readLiveShadowTurnDashboard,
  readHumanPeerLiveShadowDashboard,
  readSharedAgentLiveShadowDashboard,
  readDomainKeyCatchUpDashboard,
  readStrictShadowBoundaryHealth,
  type EncryptionTransitionFamilyDashboard,
  type EncryptionTransitionObservationPressure,
  type EncryptionTransitionHistoryReadActivity,
  type LiveShadowEncryptionTransitionPolicy,
  type LiveShadowTurnDashboard,
  type HumanPeerLiveShadowDashboard,
  type SharedAgentLiveShadowDashboard,
  type DomainKeyCatchUpDashboard,
} from "@nautilo/db";
import {
  encryptionTransitionPolicyStatusSchema,
  encryptionTransitionStatusSchema,
  encryptionTransitionUpdateRequestSchema,
  DISABLE_SHADOW_ENCRYPTION_CONFIRMATION,
  ENABLE_SHADOW_ENCRYPTION_CONFIRMATION,
  ENABLE_FULL_ENCRYPTION_CONFIRMATION,
  ENABLE_STRICT_SHADOW_CONFIRMATION,
  USE_FALLBACK_SHADOW_CONFIRMATION,
  protectedShadowAttemptObservationV2Schema,
  type EncryptionTransitionStatus,
} from "@nautilo/api-client";
import {
  STRICT_SHADOW_BOUNDARY_REGISTRY,
  strictShadowCoveragePreview,
  strictShadowRuntimeHealthProjection,
} from "@nautilo/encryption-invariants/node";
import { warn } from "@nautilo/logger";
import { getUserCapabilities } from "@nautilo/trust";

import {
  writeSecurityAuditEvent,
  type EncryptionTransitionPolicyChangeRequestedAuditEvent,
} from
  "../lib/security-audit-log";
import { decodeCanonicalBase64url } from "../lib/canonical-base64url";
import { getServerDirectDb } from "../lib/server-direct-db";
import { publishEncryptionPolicyChanged } from "../realtime/ws-publisher";

function percent(verified: bigint, denominator: bigint): number | null {
  if (denominator === 0n) return null;
  if (verified < 0n || denominator < 0n || verified > denominator) {
    throw new Error("Invalid encryption transition percentage inputs");
  }
  return Number((verified * 10_000n) / denominator) / 100;
}

function statusDto(
  policy: LiveShadowEncryptionTransitionPolicy,
  dashboard: readonly EncryptionTransitionFamilyDashboard[],
  pressure: EncryptionTransitionObservationPressure,
  liveTurns: LiveShadowTurnDashboard,
  humanPeerLive: HumanPeerLiveShadowDashboard,
  sharedAgentLive: SharedAgentLiveShadowDashboard,
  domainKeyAuthority: DomainKeyCatchUpDashboard,
  historyReadActivity: EncryptionTransitionHistoryReadActivity,
  runtimeHealth: ReturnType<typeof strictShadowRuntimeHealthProjection>,
): EncryptionTransitionStatus {
  const historyReadOutcomes = dashboard.find((metric) =>
    metric.family === "message"
  )?.historyReadOutcomes ?? [];
  const historyReadVerified = historyReadOutcomes.reduce(
    (sum, outcome) => outcome.outcome === "verified"
      ? sum + outcome.count
      : sum,
    0n,
  );
  const historyReadUnavailable = historyReadActivity.eligibleRows
    - historyReadVerified - historyReadActivity.pendingEligibleRows;
  if (historyReadUnavailable < 0n) {
    throw new Error("Invalid history-read activity totals");
  }
  return encryptionTransitionStatusSchema.parse({
    dtoVersion: 2,
    policy: {
      mode: policy.mode,
      shadowBehavior: policy.shadowBehavior,
      revision: policy.revision,
      shadowEncryptionStartedAt: policy.shadowEncryptionStartedAt?.toISOString() ?? null,
      updatedAt: policy.updatedAt.toISOString(),
    },
    coverageReadiness: {
      registered: STRICT_SHADOW_BOUNDARY_REGISTRY.length.toString(),
      protected: strictShadowCoveragePreview().protected.toString(),
      unsupported: strictShadowCoveragePreview().unsupported.toString(),
      unexercised: strictShadowCoveragePreview().unexercised.toString(),
    },
    runtimeHealth: {
      policyRevision: runtimeHealth.policyRevision,
      verified: runtimeHealth.verified.toString(),
      waitingForAuthority: runtimeHealth.waitingForAuthority.toString(),
      repairing: runtimeHealth.repairing.toString(),
      unsupported: runtimeHealth.unsupported.toString(),
      failed: runtimeHealth.failed.toString(),
      unexercised: runtimeHealth.unexercised.toString(),
      lastObservedAt: runtimeHealth.lastObservedAt?.toISOString() ?? null,
      boundaries: runtimeHealth.summaries.map((boundary) => ({
        boundaryId: boundary.boundaryId,
        family: boundary.family,
        operation: boundary.operation,
        actorClass: boundary.actorClass,
        state: boundary.state,
        reason: boundary.reason,
        occurrenceCount: boundary.occurrenceCount.toString(),
        lastObservedAt: boundary.lastObservedAt?.toISOString() ?? null,
      })),
    },
    observationPressure: {
      retainedRows: pressure.retainedRows.toString(),
      capacityRows: pressure.capacityRows.toString(),
      pendingAdmissions: pressure.pendingAdmissions.toString(),
      admissionCapacity: pressure.admissionCapacity.toString(),
      maximumRetentionMs: pressure.maximumRetentionMs,
    },
    domainKeyAuthority: {
      scope: "domain_key_v2",
      catchUp: {
        requested: domainKeyAuthority.requested.toString(),
        waiting: domainKeyAuthority.waiting.toString(),
        delivered: domainKeyAuthority.delivered.toString(),
        acknowledged: domainKeyAuthority.acknowledged.toString(),
        stale: domainKeyAuthority.stale.toString(),
        expired: domainKeyAuthority.expired.toString(),
        unrecoverable: domainKeyAuthority.unrecoverable.toString(),
      },
      authority: {
        humanDomainHeads: domainKeyAuthority.humanDomainHeads.toString(),
        aiDomainHeads: domainKeyAuthority.aiDomainHeads.toString(),
        humanNamespaceBundles:
          domainKeyAuthority.humanNamespaceBundles.toString(),
        aiNamespaceBundles:
          domainKeyAuthority.aiNamespaceBundles.toString(),
        humanNamespaceBundleAdvances:
          domainKeyAuthority.humanNamespaceBundleAdvances.toString(),
        aiNamespaceBundleAdvances:
          domainKeyAuthority.aiNamespaceBundleAdvances.toString(),
      },
    },
    liveTurns: {
      scope: "live_new_browser_private_room_turns",
      completeRoundTrip: {
        verified: liveTurns.completeRoundTrips.toString(),
        eligible: liveTurns.eligibleTurns.toString(),
        percent: percent(
          liveTurns.completeRoundTrips,
          liveTurns.eligibleTurns,
        ),
      },
      pending: {
        turns: liveTurns.pendingTurns.toString(),
        oldestPendingAt: liveTurns.oldestPendingAt?.toISOString() ?? null,
      },
      stages: liveTurns.stages.map((stage) => ({
        stage: stage.stage,
        verified: stage.verified.toString(),
        eligible: stage.eligible.toString(),
        percent: percent(stage.verified, stage.eligible),
      })),
      entities: liveTurns.entities.map((entity) => ({
        entity: entity.entity,
        verified: entity.verified.toString(),
        eligible: entity.eligible.toString(),
        percent: percent(entity.verified, entity.eligible),
      })),
      fallbacks: liveTurns.fallbacks.map((fallback) => ({
        stage: fallback.stage,
        reason: fallback.reason,
        count: fallback.count.toString(),
      })),
    },
    humanPeerLive: {
      scope: "browser_human_only_live_messages",
      writes: {
        published: humanPeerLive.publishedWrites.toString(),
        eligible: humanPeerLive.eligibleWrites.toString(),
        pending: humanPeerLive.pendingWrites.toString(),
        fallback: humanPeerLive.fallbackWrites.toString(),
        failed: humanPeerLive.failedWrites.toString(),
        percent: percent(
          humanPeerLive.publishedWrites,
          humanPeerLive.eligibleWrites,
        ),
      },
      recipientReads: {
        verified: humanPeerLive.recipientReadVerified.toString(),
        attempted: humanPeerLive.recipientReadAttempts.toString(),
        fallback: humanPeerLive.recipientReadFallback.toString(),
        percent: percent(
          humanPeerLive.recipientReadVerified,
          humanPeerLive.recipientReadAttempts,
        ),
      },
    },
    sharedAgentLive: {
      scope: "browser_multi_human_single_agent_live_messages",
      writes: {
        published: sharedAgentLive.publishedWrites.toString(),
        eligible: sharedAgentLive.eligibleWrites.toString(),
        pending: sharedAgentLive.pendingWrites.toString(),
        fallback: sharedAgentLive.fallbackWrites.toString(),
        failed: sharedAgentLive.failedWrites.toString(),
        percent: percent(
          sharedAgentLive.publishedWrites,
          sharedAgentLive.eligibleWrites,
        ),
      },
      recipientReads: {
        verified: sharedAgentLive.recipientReadVerified.toString(),
        attempted: sharedAgentLive.recipientReadAttempts.toString(),
        fallback: sharedAgentLive.recipientReadFallback.toString(),
        percent: percent(
          sharedAgentLive.recipientReadVerified,
          sharedAgentLive.recipientReadAttempts,
        ),
      },
      recipientCoverage: {
        totalHumans:
          sharedAgentLive.participantHumanOpportunities.toString(),
        protectedHumans:
          sharedAgentLive.protectedParticipantHumanOpportunities.toString(),
        plaintextOnlyHumans:
          sharedAgentLive.plaintextParticipantHumanOpportunities.toString(),
        protectedDevices:
          sharedAgentLive.protectedRecipientDeviceOpportunities.toString(),
      },
      planningFallbacks: {
        unavailable: sharedAgentLive.planningUnavailable.toString(),
        deviceUnavailable:
          sharedAgentLive.planningDeviceUnavailable.toString(),
        namespaceUnavailable:
          sharedAgentLive.planningNamespaceUnavailable.toString(),
        recipientSyncRequired:
          sharedAgentLive.planningRecipientSyncRequired.toString(),
      },
      agentRecipientReads: {
        verified: sharedAgentLive.agentRecipientReadVerified.toString(),
        attempted: sharedAgentLive.agentRecipientReadAttempts.toString(),
        fallback: sharedAgentLive.agentRecipientReadFallback.toString(),
        percent: percent(
          sharedAgentLive.agentRecipientReadVerified,
          sharedAgentLive.agentRecipientReadAttempts,
        ),
      },
      conductor: {
        awaitingUser: sharedAgentLive.conductorAwaitingUser.toString(),
        notSelected: sharedAgentLive.conductorNotSelected.toString(),
        selected: sharedAgentLive.conductorSelected.toString(),
        unavailable: sharedAgentLive.conductorUnavailable.toString(),
        eligible: sharedAgentLive.conductorInvocationsEligible.toString(),
        awaitingAuthorization:
          sharedAgentLive.conductorInvocationsAwaitingAuthorization.toString(),
        authorizationEstablished:
          sharedAgentLive.conductorAuthorizationEstablished.toString(),
        authorizationReused:
          sharedAgentLive.conductorAuthorizationReused.toString(),
        currentInputVerified:
          sharedAgentLive.conductorCurrentInputVerified.toString(),
        deterministic:
          sharedAgentLive.conductorRouteDeterministic.toString(),
        floorManager:
          sharedAgentLive.conductorRouteFloorManager.toString(),
        historyNotRequested:
          sharedAgentLive.conductorHistoryNotRequested.toString(),
        historyVerified:
          sharedAgentLive.conductorHistoryVerified.toString(),
        historyUnavailable:
          sharedAgentLive.conductorHistoryUnavailable.toString(),
        verifiedWake:
          sharedAgentLive.conductorVerifiedWake.toString(),
        verifiedAwaitingUser:
          sharedAgentLive.conductorVerifiedAwaitingUser.toString(),
        verifiedSilent:
          sharedAgentLive.conductorVerifiedSilent.toString(),
        fallback: sharedAgentLive.conductorFallback.toString(),
        selectedAgentExecutions:
          sharedAgentLive.conductorSelectedAgentExecutions.toString(),
        fallbackReasons: sharedAgentLive.conductorFallbackReasons.map(
          (entry) => ({
            reason: entry.reason,
            count: entry.count.toString(),
          }),
        ),
      },
      executions: {
        awaitingAuthorization:
          sharedAgentLive.executionsAwaitingAuthorization.toString(),
        authorized: sharedAgentLive.executionsAuthorized.toString(),
        running: sharedAgentLive.executionsRunning.toString(),
        completed: sharedAgentLive.executionsCompleted.toString(),
        fallback: sharedAgentLive.executionsFallback.toString(),
        failed: sharedAgentLive.executionsFailed.toString(),
        protectedInputs: sharedAgentLive.protectedExecutionInputs.toString(),
      },
      resumes: {
        attempted: sharedAgentLive.resumeExecutions.toString(),
        awaitingAuthorization:
          sharedAgentLive.resumesAwaitingAuthorization.toString(),
        authorized: sharedAgentLive.resumesAuthorized.toString(),
        running: sharedAgentLive.resumesRunning.toString(),
        completed: sharedAgentLive.resumesCompleted.toString(),
        fallback: sharedAgentLive.resumesFallback.toString(),
        failed: sharedAgentLive.resumesFailed.toString(),
      },
      authorization: {
        established: sharedAgentLive.authorizationEstablished.toString(),
        reused: sharedAgentLive.authorizationReused.toString(),
        unavailable: sharedAgentLive.authorizationUnavailable.toString(),
        expired: sharedAgentLive.authorizationExpired.toString(),
        revoked: sharedAgentLive.authorizationRevoked.toString(),
      },
      outputStages: {
        streamStarted: sharedAgentLive.streamStarted.toString(),
        streamCompleted: sharedAgentLive.streamCompleted.toString(),
        assistantPublished: sharedAgentLive.assistantPublished.toString(),
        toolResultsPublished: sharedAgentLive.toolResultsPublished.toString(),
      },
    },
    historyReads: {
      scope: "browser_room_history_shadow_reads",
      pagesAttempted: historyReadActivity.pagesAttempted.toString(),
      pagesPending: historyReadActivity.pagesPending.toString(),
      selected: historyReadActivity.selectedRows.toString(),
      verified: historyReadVerified.toString(),
      eligible: historyReadActivity.eligibleRows.toString(),
      pending: historyReadActivity.pendingEligibleRows.toString(),
      unavailable: historyReadUnavailable.toString(),
      percent: percent(historyReadVerified, historyReadActivity.eligibleRows),
      outcomes: historyReadOutcomes.map((outcome) => ({
        ...outcome,
        count: outcome.count.toString(),
      })),
    },
    metrics: dashboard.map((metric) => ({
      family: metric.family,
      attemptSuccess: {
        verified: metric.verifiedAttempts.toString(),
        eligible: metric.eligibleAttempts.toString(),
        percent: percent(metric.verifiedAttempts, metric.eligibleAttempts),
      },
      touchedCoverage: {
        verified: metric.touchedCoveredObjects.toString(),
        total: metric.touchedObjects.toString(),
        percent: percent(metric.touchedCoveredObjects, metric.touchedObjects),
      },
      storedCoverage: {
        verified: metric.coveredObjects.toString(),
        total: metric.totalObjects.toString(),
        percent: percent(metric.coveredObjects, metric.totalObjects),
      },
      pendingLifecycle: {
        operations: metric.pendingLifecycleOperations.toString(),
        oldestPendingAt: metric.oldestPendingAt?.toISOString() ?? null,
      },
      attemptOutcomes: metric.outcomes.map((outcome) => ({
        ...outcome,
        count: outcome.count.toString(),
      })),
    })),
  });
}

type RequestedAuditInput = Omit<
  EncryptionTransitionPolicyChangeRequestedAuditEvent,
  "ts" | "ip" | "userAgent"
>;

function audit(request: FastifyRequest, event: RequestedAuditInput): void {
  const row: EncryptionTransitionPolicyChangeRequestedAuditEvent = {
    ...event,
    ts: new Date().toISOString(),
    ip: request.ip,
    userAgent: request.headers["user-agent"],
  };
  writeSecurityAuditEvent(
    join(homedir(), ".nautilo", "logs", "security-audit.log"),
    row,
  );
}

export interface EncryptionTransitionRouteDeps {
  getCapabilities?: typeof getUserCapabilities;
  getDb?: typeof getServerDirectDb;
  getPolicy?: typeof getEncryptionTransitionPolicy;
  casPolicy?: typeof compareAndSwapEncryptionTransitionPolicy;
  getDashboard?: typeof readEncryptionTransitionDashboard;
  getObservationPressure?: typeof readEncryptionTransitionObservationPressure;
  getLiveTurnDashboard?: typeof readLiveShadowTurnDashboard;
  getHumanPeerLiveDashboard?: typeof readHumanPeerLiveShadowDashboard;
  getSharedAgentLiveDashboard?: typeof readSharedAgentLiveShadowDashboard;
  getDomainKeyCatchUpDashboard?: () => Promise<DomainKeyCatchUpDashboard>;
  getHistoryReadActivity?: typeof readEncryptionTransitionHistoryReadActivity;
  getStrictShadowBoundaryHealth?: typeof readStrictShadowBoundaryHealth;
  reconcileObservationAdmissions?:
    typeof reconcileExpiredEncryptionTransitionObservationAdmissions;
  reconcileHistoryReadAdmissions?:
    typeof reconcileExpiredEncryptionTransitionHistoryReadAdmissions;
  consumeObservationAdmission?:
    typeof consumeEncryptionTransitionObservationAdmission;
  auditEvent?: typeof audit;
  now?: () => Date;
  maintenanceController?: Readonly<{
    enterDraining(): Promise<{ operationId: string | null }>;
    complete(operationId: string): Promise<unknown>;
  }>;
  getExecutableActivity?: () => Promise<Readonly<{
    runningForegroundJobs: number;
    runningBackgroundJobs: number;
    queuedTurns: number;
    bufferedLanes: number;
    acceptedWork: number;
    runningTaskRuns: number;
    claimedTasks: number;
  }>>;
  flushPendingBroadcasts?: () => Promise<void>;
  publishPolicyChanged?: (policyRevision: number) => void;
}

function hasExecutableActivity(activity: Awaited<ReturnType<
  NonNullable<EncryptionTransitionRouteDeps["getExecutableActivity"]>
>>): boolean {
  return Object.values(activity).some((count) => count > 0);
}

async function hasCapability(
  userId: string,
  capability: "read_server_settings" | "manage_server_settings",
  getCapabilities: typeof getUserCapabilities,
): Promise<boolean> {
  try {
    return (await getCapabilities(userId)).includes(capability);
  } catch {
    return false;
  }
}

function unavailable(reply: { code(status: number): { send(body: unknown): unknown } }) {
  return reply.code(503).send({ error: "encryption_transition_unavailable" });
}

export function encryptionTransitionRoutes(
  app: FastifyInstance,
  overrides: EncryptionTransitionRouteDeps = {},
): void {
  const getCapabilities = overrides.getCapabilities ?? getUserCapabilities;
  const getDb = overrides.getDb ?? getServerDirectDb;
  const getPolicy = overrides.getPolicy ?? getEncryptionTransitionPolicy;
  const casPolicy = overrides.casPolicy ?? compareAndSwapEncryptionTransitionPolicy;
  const getDashboard = overrides.getDashboard ?? readEncryptionTransitionDashboard;
  const getObservationPressure = overrides.getObservationPressure
    ?? readEncryptionTransitionObservationPressure;
  const getLiveTurnDashboard = overrides.getLiveTurnDashboard
    ?? readLiveShadowTurnDashboard;
  const getHumanPeerLiveDashboard = overrides.getHumanPeerLiveDashboard
    ?? readHumanPeerLiveShadowDashboard;
  const getSharedAgentLiveDashboard = overrides.getSharedAgentLiveDashboard
    ?? readSharedAgentLiveShadowDashboard;
  const getDomainKeyAuthorityDashboard = overrides.getDomainKeyCatchUpDashboard
    ?? (() => readDomainKeyCatchUpDashboard(getSharedDirectCryptoDb()));
  const getHistoryReadActivity = overrides.getHistoryReadActivity
    ?? readEncryptionTransitionHistoryReadActivity;
  const getBoundaryHealth = overrides.getStrictShadowBoundaryHealth
    ?? readStrictShadowBoundaryHealth;
  const reconcileObservationAdmissions = overrides.reconcileObservationAdmissions
    ?? reconcileExpiredEncryptionTransitionObservationAdmissions;
  const reconcileHistoryReadAdmissions = overrides.reconcileHistoryReadAdmissions
    ?? reconcileExpiredEncryptionTransitionHistoryReadAdmissions;
  const consumeObservationAdmission = overrides.consumeObservationAdmission ??
    consumeEncryptionTransitionObservationAdmission;
  const auditEvent = overrides.auditEvent ?? audit;
  const publishPolicyChanged = overrides.publishPolicyChanged
    ?? publishEncryptionPolicyChanged;
  const now = overrides.now ?? (() => new Date());

  app.get("/api/encryption-transition/policy", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) return reply.code(401).send({ error: "Authentication required" });
    const [policy, capabilities] = await Promise.all([
      getPolicy(getDb()),
      getCapabilities(userId).catch((): string[] => []),
    ]);
    const preview = strictShadowCoveragePreview();
    return reply.send(encryptionTransitionPolicyStatusSchema.parse({
      responseVersion: 1,
      policy: {
        mode: policy.mode,
        shadowBehavior: policy.shadowBehavior,
        revision: policy.revision,
        updatedAt: policy.updatedAt.toISOString(),
      },
      requiresCryptoDevice: policy.mode !== "plaintext_only",
      canManage: capabilities.includes("manage_server_settings"),
      coveragePreview: {
        protected: preview.protected.toString(),
        unsupported: preview.unsupported.toString(),
        unexercised: preview.unexercised.toString(),
      },
    }));
  });

  app.get("/api/admin/encryption-transition", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) return reply.code(401).send({ error: "Authentication required" });
    const capabilities = await getCapabilities(userId).catch((): string[] => []);
    if (!capabilities.includes("read_server_settings") &&
      !capabilities.includes("manage_server_settings")) {
      return reply.code(403).send({ error: "admin only" });
    }
    try {
      const db = getDb();
      const policy = await getPolicy(db);
      if (policy.mode === "shadow_encryption") {
        await reconcileObservationAdmissions(db, { now: now() });
        await reconcileHistoryReadAdmissions(db, { now: now() });
      }
      const [dashboard, pressure, liveTurns, humanPeerLive, sharedAgentLive, domainKeyAuthority, historyReadActivity, boundaryHealth] = await Promise.all([
        getDashboard(db, policy),
        getObservationPressure(db, policy, {
          storageLimitRows:
            ENCRYPTION_TRANSITION_OBSERVATION_POLICY_V1.storageLimitRows,
          retentionMs: ENCRYPTION_TRANSITION_OBSERVATION_POLICY_V1.retentionMs,
        }),
        getLiveTurnDashboard(db, policy),
        getHumanPeerLiveDashboard(db, policy),
        getSharedAgentLiveDashboard(db, policy),
        getDomainKeyAuthorityDashboard(),
        getHistoryReadActivity(db),
        getBoundaryHealth(db, policy.revision),
      ]);
      return reply.send(statusDto(
        policy,
        dashboard,
        pressure,
        liveTurns,
        humanPeerLive,
        sharedAgentLive,
        domainKeyAuthority,
        historyReadActivity,
        strictShadowRuntimeHealthProjection(policy.revision, boundaryHealth),
      ));
    } catch (error) {
      if (error instanceof UnsupportedEncryptionTransitionStateError) {
        return unavailable(reply);
      }
      throw error;
    }
  });

  app.post("/api/admin/encryption-transition", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) return reply.code(401).send({ error: "Authentication required" });
    if (!(await hasCapability(userId, "manage_server_settings", getCapabilities))) {
      return reply.code(403).send({ error: "admin only" });
    }
    const parsed = encryptionTransitionUpdateRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: "invalid_encryption_transition" });
    }

    const db = getDb();
    try {
      const before = await getPolicy(db);
      const expectedConfirmation = parsed.data.targetMode === "plaintext_only"
        ? DISABLE_SHADOW_ENCRYPTION_CONFIRMATION
        : parsed.data.targetMode === "encrypted_only"
        ? ENABLE_FULL_ENCRYPTION_CONFIRMATION
        : parsed.data.targetShadowBehavior === "strict"
        ? ENABLE_STRICT_SHADOW_CONFIRMATION
        : before.mode !== "shadow_encryption"
        ? ENABLE_SHADOW_ENCRYPTION_CONFIRMATION
        : USE_FALLBACK_SHADOW_CONFIRMATION;
      if (parsed.data.confirmation !== expectedConfirmation) {
        return reply.code(422).send({
          error: "invalid_encryption_transition_confirmation",
        });
      }
      let maintenanceOperationId: string | null = null;
      let after: LiveShadowEncryptionTransitionPolicy;
      try {
        if (parsed.data.targetMode === "encrypted_only" &&
          before.mode !== "encrypted_only") {
          if (!overrides.maintenanceController ||
            !overrides.getExecutableActivity ||
            !overrides.flushPendingBroadcasts) {
            return unavailable(reply);
          }
          let draining: { operationId: string | null };
          try {
            draining = await overrides.maintenanceController.enterDraining();
          } catch (error) {
            if (error instanceof MaintenanceTransitionError) {
              return reply.code(409).send({
                error: "encryption_transition_busy",
                retryable: true,
              });
            }
            throw error;
          }
          if (draining.operationId === null) {
            throw new Error("Full transition drain did not acquire an operation ID");
          }
          maintenanceOperationId = draining.operationId;
          if (hasExecutableActivity(await overrides.getExecutableActivity())) {
            return reply.code(409).send({
              error: "encryption_transition_busy",
              retryable: true,
            });
          }
          await overrides.flushPendingBroadcasts();
          if (hasExecutableActivity(await overrides.getExecutableActivity())) {
            return reply.code(409).send({
              error: "encryption_transition_busy",
              retryable: true,
            });
          }
        }
        // The security record is the admission gate, not a best-effort
        // afterthought. A write failure aborts before the policy CAS; an audit
        // row without a matching change is an honest failed attempt.
        auditEvent(request, {
          kind: "encryption_transition_policy_change_requested",
          actorId: userId,
          before: {
            mode: before.mode,
            shadowBehavior: before.shadowBehavior,
            revision: before.revision,
          },
          requested: {
            mode: parsed.data.targetMode,
            shadowBehavior: parsed.data.targetShadowBehavior,
            expectedRevision: parsed.data.expectedRevision,
          },
        });
        after = await casPolicy(db, {
          expectedRevision: parsed.data.expectedRevision,
          targetMode: parsed.data.targetMode,
          targetShadowBehavior: parsed.data.targetShadowBehavior,
          now: now(),
        });
        // The durable CAS is authoritative. Publish immediately so later
        // maintenance release, reconciliation, or dashboard failures cannot
        // hide a committed policy change from connected clients.
        try {
          publishPolicyChanged(after.revision);
        } catch (error) {
          warn(
            `[encryption-transition] committed policy notification unavailable: ${
              error instanceof Error ? error.name : "unknown"
            }`,
          );
        }
      } finally {
        if (maintenanceOperationId !== null) {
          await overrides.maintenanceController!.complete(maintenanceOperationId);
        }
      }
      if (after.mode === "shadow_encryption") {
        await reconcileObservationAdmissions(db, { now: now() });
        await reconcileHistoryReadAdmissions(db, { now: now() });
      }
      const [dashboard, pressure, liveTurns, humanPeerLive, sharedAgentLive, domainKeyAuthority, historyReadActivity, boundaryHealth] = await Promise.all([
        getDashboard(db, after),
        getObservationPressure(db, after, {
          storageLimitRows:
            ENCRYPTION_TRANSITION_OBSERVATION_POLICY_V1.storageLimitRows,
          retentionMs: ENCRYPTION_TRANSITION_OBSERVATION_POLICY_V1.retentionMs,
        }),
        getLiveTurnDashboard(db, after),
        getHumanPeerLiveDashboard(db, after),
        getSharedAgentLiveDashboard(db, after),
        getDomainKeyAuthorityDashboard(),
        getHistoryReadActivity(db),
        getBoundaryHealth(db, after.revision),
      ]);
      return reply.send(statusDto(
        after,
        dashboard,
        pressure,
        liveTurns,
        humanPeerLive,
        sharedAgentLive,
        domainKeyAuthority,
        historyReadActivity,
        strictShadowRuntimeHealthProjection(after.revision, boundaryHealth),
      ));
    } catch (error) {
      if (error instanceof EncryptionTransitionPolicyConflictError) {
        return reply.code(409).send({
          error: "stale_revision",
          currentRevision: error.actualRevision,
        });
      }
      if (error instanceof UnsupportedEncryptionTransitionStateError) {
        return unavailable(reply);
      }
      throw error;
    }
  });

  app.post("/api/protected/shadow-attempts/observe", async (request, reply) => {
    if (!request.sessionUserId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const parsed = protectedShadowAttemptObservationV2Schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: "invalid_shadow_attempt_observation" });
    }
    const token = decodeCanonicalBase64url(
      parsed.data.observationTokenBase64url,
      32,
    );
    if (token === null) {
      return reply.code(422).send({ error: "invalid_shadow_attempt_observation" });
    }
    try {
      const result = await (async () => {
        try {
          return await consumeObservationAdmission(getDb(), {
            token,
            outcome: parsed.data.outcome,
            reason: parsed.data.reason,
            observedAt: now(),
          });
        } finally {
          token.fill(0);
        }
      })();
      if (result.status === "conflict") {
        return reply.code(409).send({ error: "observation_admission_conflict" });
      }
      if (result.status === "unavailable") {
        return reply.code(410).send({ error: "observation_admission_unavailable" });
      }
      return reply.send({ status: "accepted" as const });
    } catch (error) {
      // Observation projection remains subordinate to the already-finished
      // ordinary operation. The client treats any non-success as ignored and
      // never reclassifies the product result.
      warn(`[encryption-transition] observation ignored: ${String(error)}`);
      return reply.code(503).send({ error: "observation_projection_unavailable" });
    }
  });
}
