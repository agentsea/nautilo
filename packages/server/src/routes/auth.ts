import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { fromRuntimeConfig, resolveInstance } from "@nautilo/config";
import {
  db,
  eq,
  getAccountSecurityRowByUserId,
  invites,
  rooms,
} from "@nautilo/db";
import {
  PinChallengeProvider,
  PinAlreadyEnrolledError,
  InvalidPinError,
  LockoutError,
  generateRecoveryCodes,
  useRecoveryCode,
  getRecoveryCodeStatus,
  regenerateRecoveryCodes,
  findRoomIdByGraphThreadIdForUser,
  getLogtoAdminClient,
  verifyLogtoAccessToken,
  type PolicyResolver,
  AgentInvocationDeniedError,
  createAcceptedInvocationAuthority,
  getPolicyResolver,
  isScopeMemoryEnvelope,
  toActionCapabilityHttpDenial,
} from "@nautilo/trust";
import {
  resumeGraphWithIdentity,
  resumeGraphWithApproval,
  resumeGraphWithAskReply,
  readAgentIdForThread,
  readCausalHumanUserIdForThread,
  resumeGraphWithHostChoice,
  resumeGraphWithConnectedWebAction,
  readConnectedWebActionResumeBindingForThread,
  readPendingInterruptEventsForThread,
  readTurnIdForThread,
  readProjectionResumeBindingForThread,
  parentGraphThreadIdFromForkCheckpoint,
  roomGraphThreadFromLaneThread,
  type EncryptedCheckpointSaver,
  type ProjectionResumeBinding,
} from "@nautilo/agent";
import {
  isCapabilitySlug,
  type ApprovalAskNetworkContext,
  type ApprovalReplyVerb,
  type CapabilitySlug,
  type ServerEvent,
  type WhoamiResponse,
} from "@nautilo/types";
import {
  eventBus,
  createPersistingProcessor,
  forkCoordinator,
  jobManager,
  authorizeTaskApprovalResume,
  runTaskApprovalResume,
  getMaintenanceGate,
  createMaintenanceAcceptanceAuthority,
  requiresEncryptedForegroundCheckpoint,
  createLiveShadowDataOperationPolicyBinding,
  runWithLiveShadowTurnSession,
  withLiveShadowCheckpointSaver,
  getCurrentLiveShadowTurnContext,
  resolveForegroundProtectedMemoryGraphDeps,
} from "@nautilo/runtime";
import { log, warn, runWithTurn } from "@nautilo/logger";
import type { SecurityAuditEvent } from "../lib/security-audit-log";
import { redeemInviteWithLogtoSub, type BindLogtoUserArgs } from "../lib/redeem-invite";
import { requireFreshLogtoAccessToken } from "../lib/logto-freshness";
import {
  WHOAMI_CACHE_CONTROL,
  WHOAMI_VARY,
  whoamiIfNoneMatchEquals,
  whoamiWeakETagFromProjection,
} from "../auth/whoami-conditional-http";
import {
  createApprovalResolutionCoordinator,
  type ApprovalResolutionContext,
} from "./approval-resolved";
import {
  requireAgentInvocation,
  type AssertCanInvokeAgent,
} from "../lib/agent-invocation-admission";
import {
  isMaintenanceDrainError,
  replyMaintenanceRejection,
} from "../lib/maintenance-rejection";
import { getProductionLiveShadowMessageComposition } from
  "./live-shadow-message-composition";
import {
  currentStrictShadowPolicy,
  enforceRegisteredStrictShadowBoundary,
  rejectChangedStrictShadowPolicy,
  StrictShadowDispatchError,
} from "../lib/strict-shadow-policy";

async function auditResumeThreadDenied(
  audit: AuthRouteDeps["auditEvent"],
  row: {
    ts: string;
    actorId: string | null;
    userId: string;
    threadId: string;
    route: string;
    ip: string;
    userAgent: string | undefined;
  },
): Promise<void> {
  if (!audit) return;
  const event: SecurityAuditEvent = {
    kind: "resume_thread_auth_denied",
    ts: row.ts,
    actorId: row.actorId,
    ip: row.ip,
    userAgent: row.userAgent,
    sessionUserId: row.userId,
    threadId: row.threadId,
    route: row.route,
  };
  try {
    await audit(event);
  } catch {
    /* best effort */
  }
}

/** D125 / audit F1 — first-time PIN enrollment forensic trail. */
async function auditPinEnrolled(
  audit: AuthRouteDeps["auditEvent"],
  row: {
    ts: string;
    actorId: string | null;
    userId: string;
    route: string;
    ip: string;
    userAgent: string | undefined;
  },
): Promise<void> {
  if (!audit) return;
  const event: SecurityAuditEvent = {
    kind: "pin_enrolled",
    ts: row.ts,
    actorId: row.actorId,
    ip: row.ip,
    userAgent: row.userAgent,
    sessionUserId: row.userId,
    route: "POST /api/auth/pin",
  };
  try {
    await audit(event);
  } catch {
    /* best effort */
  }
}

// D082 PR B — Fastify request augmentation for the auth access log.
// When a resume route binds a turnId (via runWithTurn), we also
// stash it on the request so the `/api/auth/*` `onResponse` hook in
// `app.ts` can prepend `[turn=<id>]` to the single-line access log,
// keeping that line correlated with the rest of the turn's flow.
declare module "fastify" {
  interface FastifyRequest {
    __turnId?: string;
  }
}

export interface AuthRouteDeps {
  pinProvider: PinChallengeProvider;
  ownerActorId: string;
  ownerId: string;
  auditEvent?: (event: SecurityAuditEvent) => Promise<void>;
  now?: () => Date;
  /**
   * M075 — optional override for resume-route thread membership checks
   * (unit tests without a database). When omitted, uses
   * `findRoomIdByGraphThreadIdForUser` against the real DB.
   */
  resumeThreadMembershipForUser?: (
    threadId: string,
    sessionUserId: string,
  ) => Promise<boolean>;
  /**
   * D426 — test-only authenticated Room resolution seam. Production resolves
   * the normalized checkpoint thread through the membership query below, then
   * reads the stored Room kind. A boolean membership override intentionally
   * cannot fabricate a Subthread identity, so it fails closed for child-row
   * stamping.
   */
  resumeThreadScopeForUser?: (
    threadId: string,
    sessionUserId: string,
  ) => Promise<{ roomId: string; kind: string } | null>;
  /**
   * D476 test seam for the private checkpoint binding behind a pending
   * projection approval. Production reads it from the LangGraph checkpoint.
   */
  projectionResumeBindingForThread?: (
    threadId: string,
  ) => Promise<ProjectionResumeBinding>;
  /** Test seam for the canonical Agent identity stored on a paused graph. */
  resumeAgentIdForThread?: (threadId: string) => Promise<string | null>;
  /** Test seam for the causal Human identity stored on a paused graph. */
  resumeCausalHumanUserIdForThread?: typeof readCausalHumanUserIdForThread;
  /** Policy resolver for resume paths that rebuild guest policy context. */
  policyResolver?: PolicyResolver | null;
  /**
   * @deprecated M125 Phase 2.4 — no longer consulted by `authRoutes`.
   * Each resume route requires `request.memoryEnvelope?.agentId` and 409s on
   * missing. Healthy routes then use the paused checkpoint's Agent identity
   * for the actual resume, falling back to the envelope only for legacy
   * checkpoints. Keep this field for backward-compatible `app.ts` wiring;
   * Phase 3 cleanup will drop both. New callers should not pass this.
   */
  defaultAgentId?: string;
  /**
   * D041 — after a successful PIN proof, unwraps the Connection vault master key.
   * Omitted in tests / until the server wires it.
   */
  unlockVaultWithPin?: (pinUtf8: string) => Promise<void>;
  /** M254 test seam; production reads current canonical RBAC state. */
  assertCanInvokeAgent?: AssertCanInvokeAgent;
  /** Test seam for the durable Shadow behavior used by delayed resumes. */
  strictShadowPolicyReader?: typeof currentStrictShadowPolicy;
  /** Test seam for the durable policy re-check at a delayed-resume boundary. */
  strictShadowBoundaryEnforcer?: typeof enforceRegisteredStrictShadowBoundary;
  /** Test seam for the exact currently-parked connected-web interrupt. */
  connectedWebActionPendingForThread?: (threadId: string, laneKey: string) => Promise<readonly ServerEvent[]>;
  /** Test seam for the exact originating Genie and reply lane stored in the checkpoint. */
  connectedWebActionResumeBindingForThread?: (threadId: string) => Promise<{ readonly agentId: string; readonly laneKey: string } | null>;
}

/**
 * A Room member may normally resume a Room thread. A pending projection is
 * narrower: only the Human (and, when present, Human Actor) who authored the
 * exact approved projection may resume it. No snapshot content or identifiers
 * cross this boundary.
 */
export async function projectionResumeAllowed(
  readBinding: (threadId: string) => Promise<ProjectionResumeBinding>,
  threadId: string,
  sessionUserId: string,
  sessionActorId: string | null,
): Promise<boolean> {
  try {
    const binding = await readBinding(threadId);
    if (binding.kind === "none") return true;
    if (binding.kind !== "bound") return false;
    return sessionActorId !== null &&
      binding.requesterUserId === sessionUserId &&
      binding.requesterActorId === sessionActorId;
  } catch {
    // A failing test/production reader cannot establish that a pending
    // projection belongs to this caller, so do not resume it.
    return false;
  }
}

const WEAK_PINS = new Set([
  "123456", "000000", "111111", "222222", "333333", "444444",
  "555555", "666666", "777777", "888888", "999999",
  "123123", "121212", "112233", "654321", "012345", "987654",
  "12345678", "00000000", "11111111",
]);

const INV_PREFIX = "inv_";

interface InviteBindAuditContext {
  readonly tokenHash: string;
  readonly inviteKind: string;
  readonly targetGroupId: string | null;
  readonly targetRoomId: string | null;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Decode the opaque state produced by `packPrepareState` in
 * `routes/invites.ts`.
 *
 * Post-M107 shape (3 segments): `<inviteToken>:<handle>:<nonce>`
 * Pre-M107 shape (2 segments): `<inviteToken>:<nonce>` — handle is
 * `null`; the bind route falls back to the Logto user's `username`
 * field. M107 deprecation — remove the 2-segment branch in M108.
 */
function unpackPrepareState(
  state: string,
): { inviteToken: string; handle: string | null } | null {
  try {
    const decoded = Buffer.from(state, "base64url").toString("utf8");
    const parts = decoded.split(":");
    if (parts.length < 2) return null;
    const inviteToken = parts[0] ?? "";
    if (!inviteToken.startsWith(INV_PREFIX) || inviteToken.length < 10) return null;
    if (parts.length === 2) {
      return { inviteToken, handle: null };
    }
    const handle = (parts[1] ?? "").trim().toLowerCase();
    if (handle.length === 0) {
      return { inviteToken, handle: null };
    }
    return { inviteToken, handle };
  } catch {
    return null;
  }
}

async function loadInviteBindAuditContext(
  inviteToken: string,
): Promise<InviteBindAuditContext> {
  const tokenHash = sha256Hex(inviteToken);
  try {
    const [row] = await db
      .select({
        inviteKind: invites.kind,
        targetGroupId: invites.targetGroupId,
        targetRoomId: invites.targetRoomId,
      })
      .from(invites)
      .where(eq(invites.tokenHash, tokenHash))
      .limit(1);

    return {
      tokenHash,
      inviteKind: row?.inviteKind ?? "unknown",
      targetGroupId: row?.targetGroupId ?? null,
      targetRoomId: row?.targetRoomId ?? null,
    };
  } catch (err) {
    warn(`[bind-logto-user] invite audit context lookup failed: ${String(err)}`);
    return {
      tokenHash,
      inviteKind: "unknown",
      targetGroupId: null,
      targetRoomId: null,
    };
  }
}

function requestUserAgent(request: FastifyRequest): string | undefined {
  const userAgent = request.headers["user-agent"];
  return typeof userAgent === "string" ? userAgent : undefined;
}

export function authRoutes(app: FastifyInstance, deps: AuthRouteDeps) {
  const { pinProvider, unlockVaultWithPin } = deps;
  const approvalResolutions = createApprovalResolutionCoordinator((event) =>
    eventBus.emit(event),
  );
  // M125 Phase 2.4: the legacy `defaultAgentId` closure (bootstrap-state-
  // cache fallback) was removed. Each resume route requires a per-request
  // memory-envelope Agent so half-bound / zero-owned-Agent users fail closed.
  // The resumed speaker, however, comes from the paused graph checkpoint:
  // the envelope can identify a Human's default Agent (for example a named Genie)
  // while a multi-Agent Room interrupt belongs to another Agent (for example
  // their Genie). Conflating those identities corrupts live attribution and
  // protected-runtime reservation even though the durable graph is unchanged.
  const now = deps.now ?? (() => new Date());
  const readResumeCausalHumanUserId =
    deps.resumeCausalHumanUserIdForThread ?? readCausalHumanUserIdForThread;

  class FullResumeExecutionError extends Error {
    constructor(readonly original: unknown) {
      super("protected_resume_execution_failed");
    }
  }

  const resumeFailureForLog = (error: unknown): string =>
    error instanceof FullResumeExecutionError
      ? "protected resume failed"
      : error instanceof Error ? error.message : String(error);

  async function runResumeJobLifecycleWithCurrentPolicy(
    scope: Parameters<typeof jobManager.runResumeJobLifecycle>[0],
    resume: Parameters<typeof jobManager.runResumeJobLifecycle>[1],
    invocation: Parameters<typeof jobManager.runResumeJobLifecycle>[2],
    maintenance?: Parameters<typeof jobManager.runResumeJobLifecycle>[3],
  ): Promise<void> {
    const policy = await (
      deps.strictShadowPolicyReader ?? currentStrictShadowPolicy
    )();
    const full = policy.mode === "encrypted_only";
    try {
      await jobManager.runResumeJobLifecycle({
        ...scope,
        ...(full ? { ephemeralSinkDisposition: "full" as const } : {}),
      }, resume, invocation, maintenance);
    } catch (error) {
      if (full) throw new FullResumeExecutionError(error);
      throw error;
    }
  }
  const hostChoiceReplyClaims = new Map<string, number>();
  const hostChoiceReplyTtlMs = 5 * 60 * 1000;
  const connectedWebActionReplyClaims = new Map<string, number>();
  const connectedWebActionReplyTtlMs = 5 * 60 * 1000;

  async function admitForegroundResume(
    causalHumanUserId: string | null,
    roomId: string | undefined,
    agentId: string,
    reply: FastifyReply,
  ) {
    const humanUserId = causalHumanUserId?.trim() ?? "";
    if (!humanUserId) {
      const denial = new AgentInvocationDeniedError({
        humanUserId: "",
        origin: "foreground_resume",
        ...(roomId ? { roomId } : {}),
        ...(agentId ? { agentId } : {}),
      });
      reply.code(403).send(toActionCapabilityHttpDenial(denial));
      return null;
    }
    if (!(await requireAgentInvocation(
      {
        humanUserId,
        origin: "foreground_resume",
        ...(roomId ? { roomId } : {}),
        ...(agentId ? { agentId } : {}),
      },
      reply,
      deps.assertCanInvokeAgent,
    ))) return null;
    try {
      await getMaintenanceGate().assertAcceptingNewWork();
    } catch (error) {
      if (isMaintenanceDrainError(error)) {
        replyMaintenanceRejection(reply, error);
        return null;
      }
      throw error;
    }
    return {
      humanUserId,
      invocation: createAcceptedInvocationAuthority(humanUserId),
      maintenance: createMaintenanceAcceptanceAuthority(),
    };
  }

  async function canonicalForegroundResumeAgentId(
    threadId: string,
    envelopeAgentId: string,
  ): Promise<string> {
    const checkpointAgentId = await (
      deps.resumeAgentIdForThread ?? readAgentIdForThread
    )(threadId).catch(() => null);
    return checkpointAgentId ?? envelopeAgentId;
  }

  async function acceptAuthorizedTaskResume(
    requestorId: string,
    reply: FastifyReply,
  ) {
    try {
      await getMaintenanceGate().assertAcceptingNewWork();
    } catch (error) {
      if (isMaintenanceDrainError(error)) {
        replyMaintenanceRejection(reply, error);
        return null;
      }
      throw error;
    }
    return {
      invocation: createAcceptedInvocationAuthority(requestorId),
      maintenance: createMaintenanceAcceptanceAuthority(),
    };
  }

  type ProtectedForegroundResume = Readonly<{
    status: "ready";
    executionId: string;
    graphThreadId: string;
    capability: import("@nautilo/lattice-bridge/server")
      .ForegroundLiveShadowSessionExecutionCapability;
  }> | Readonly<{
      status: "replayed";
      cancelRecovery: "available" | "unavailable";
    }>
    | Readonly<{
        status: "unavailable";
        authorizationRequested: boolean;
      }>;
  const unavailableProtectedResume = (
    authorizationRequested: boolean,
  ): ProtectedForegroundResume => Object.freeze({
    status: "unavailable" as const,
    authorizationRequested,
  });

  const rejectRepeatedProtectedResume = (reply: FastifyReply) =>
    reply.status(409).send({
      error: "This response was already submitted. No new action was started.",
      code: "protected_resume_already_submitted",
    });

  async function prepareProtectedForegroundResume(input: Readonly<{
    request: FastifyRequest;
    userId: string;
    humanActorId: string;
    roomId: string;
    agentId: string;
    graphThreadId: string;
    clientActionSessionId: string | undefined;
    authorizationDeviceId: string | undefined;
    resumeKind: "approval" | "prove_it" | "identity" | "host_choice" | "connected_web_action";
    resumeDiscriminator: string;
  }>): Promise<ProtectedForegroundResume> {
    if (
      input.clientActionSessionId === undefined
      || input.authorizationDeviceId === undefined
    ) return unavailableProtectedResume(false);
    const composition = getProductionLiveShadowMessageComposition(
      input.request.server,
    );
    if (
      composition?.reserveSharedAgentRuntimeResume === undefined
      || composition.planSharedAgentExecutionAuthorization === undefined
      || composition.awaitSharedAgentExecutionAuthorization === undefined
    ) return unavailableProtectedResume(true);
    const resumeCoordinate = `${input.resumeKind}:${
      sha256Hex([
        input.graphThreadId,
        input.resumeDiscriminator,
      ].join("\0"))
    }`;
    const reservation = await composition.reserveSharedAgentRuntimeResume({
      roomId: input.roomId,
      subjectUserId: input.userId,
      subjectHumanId: input.humanActorId,
      agentId: input.agentId,
      agentThreadId: parentGraphThreadIdFromForkCheckpoint(
        input.graphThreadId,
      ),
      clientActionSessionId: input.clientActionSessionId,
      authorizationDeviceId: input.authorizationDeviceId,
      resumeCoordinate,
      now: Date.now(),
    });
    if (reservation === null) {
      return unavailableProtectedResume(true);
    }
    if (reservation.status === "replayed") {
      return Object.freeze({
        status: "replayed" as const,
        cancelRecovery: reservation.cancelRecovery,
      });
    }
    const planned = await composition.planSharedAgentExecutionAuthorization({
      authority: {
        userId: input.userId,
        humanActorId: input.humanActorId,
      },
      executionId: reservation.executionId,
      roomId: input.roomId,
      agentId: input.agentId,
      clientActionSessionId: input.clientActionSessionId,
      clientDeviceId: input.authorizationDeviceId,
      now: Date.now(),
    });
    if (planned.status === "authorized") {
      planned.planBytes.fill(0);
      return Object.freeze({
        status: "ready" as const,
        executionId: reservation.executionId,
        graphThreadId: input.graphThreadId,
        capability: Object.freeze({
          kind: "foreground_session" as const,
          sessionReference: planned.sessionReference,
          authorizationDigest: planned.authorizationDigest,
          scope: planned.scope,
        }),
      });
    }
    if (planned.status !== "authorization_required") {
      await composition.recordSharedAgentExecutionUnavailable?.({
        executionId: reservation.executionId,
        reason: "resume_authorization_unavailable",
        now: Date.now(),
      });
      return unavailableProtectedResume(true);
    }
    const pending = composition.awaitSharedAgentExecutionAuthorization({
      executionId: reservation.executionId,
      deadlineAt: reservation.deadlineAt,
    });
    try {
      eventBus.emit({
        wireVersion: 1,
        type: "message.shared_agent_authorization_required",
        laneKey: `room:${input.roomId}`,
        userId: input.userId,
        roomId: input.roomId,
        executionId: reservation.executionId,
        clientActionSessionId: input.clientActionSessionId,
        authorizationScheme: "runtime_foreground_v1",
        authorizationPlanBytesBase64url:
          Buffer.from(planned.authorizationPlanBytes).toString("base64url"),
        recipientPublicKeyBase64url:
          Buffer.from(planned.recipientPublicKey).toString("base64url"),
        deadlineAt: reservation.deadlineAt,
      });
    } finally {
      planned.authorizationPlanBytes.fill(0);
      planned.sourceHumanPlanBytes?.fill(0);
      planned.recipientPublicKey.fill(0);
      planned.scope.domainAuthoritySetDigest.fill(0);
    }
    const authorized = await pending;
    if (authorized === null) {
      await composition.recordSharedAgentExecutionUnavailable?.({
        executionId: reservation.executionId,
        reason: "resume_authorization_timeout",
        now: Date.now(),
      });
      return unavailableProtectedResume(true);
    }
    authorized.planBytes.fill(0);
    return Object.freeze({
      status: "ready" as const,
      executionId: reservation.executionId,
      graphThreadId: input.graphThreadId,
      capability: authorized.capability,
    });
  }

  /** Both choices consume one interrupt. Only a durably failed attempt may
   * admit a fresh denial; an in-flight or completed approval never can. */
  async function prepareProtectedApprovalDecision(
    input: Parameters<typeof prepareProtectedForegroundResume>[0],
    denied: boolean,
  ): Promise<ProtectedForegroundResume> {
    let prepared = await prepareProtectedForegroundResume(input);
    let recoveryAttempt = 0;
    while (denied && prepared.status === "replayed"
      && prepared.cancelRecovery === "available") {
      recoveryAttempt++;
      prepared = await prepareProtectedForegroundResume({
        ...input,
        resumeDiscriminator: `${input.resumeDiscriminator}:deny-recovery:${recoveryAttempt}`,
      });
    }
    return prepared;
  }

  async function runProtectedForegroundResume<Value>(input: Readonly<{
    request: FastifyRequest;
    prepared: ProtectedForegroundResume;
    work(checkpointSaver?: EncryptedCheckpointSaver): Promise<Value>;
    /** Mutations must not replay selected work after protected execution fails. */
    allowUnprotectedFallback?: boolean;
    /** Connected-web recovery already owns durable failure and Cancel admission. */
    callerRecordsFailure?: boolean;
  }>): Promise<Value | undefined> {
    if (input.prepared.status === "replayed") return undefined;
    const enforceBoundary = deps.strictShadowBoundaryEnforcer
      ?? enforceRegisteredStrictShadowBoundary;
    const policy = await (
      deps.strictShadowPolicyReader ?? currentStrictShadowPolicy
    )();
    if (input.prepared.status === "ready") {
      const prepared = input.prepared;
      const composition = getProductionLiveShadowMessageComposition(
        input.request.server,
      );
      if (composition !== null) {
        const recordFailure = async () => {
          if (input.callerRecordsFailure) return;
          try {
            await composition.recordSharedAgentExecutionUnavailable?.({
              executionId: prepared.executionId,
              reason: "protected_resume_failed",
              now: Date.now(),
            });
          } catch {
            // Preserve the original failure for the existing Job/route error
            // channel. Durable expiry reconciliation remains the storage fallback;
            // a failed status write must never retry the selected mutation.
          }
        };
        // Custody deliberately redacts callback exceptions. Retain only these
        // static, content-free approval outcomes for the existing Job error UI;
        // never forward arbitrary protected errors across that boundary.
        const approvalFailure: { value?: Error } = {};
        const result = await composition.runAgentTurn({
          operationId: prepared.executionId,
          capability: prepared.capability,
          work: (session) => runWithLiveShadowTurnSession({
            operationId: prepared.executionId,
            capability: prepared.capability,
            session,
            enforcementPolicy: {
              mode: policy.mode,
              shadowBehavior: policy.shadowBehavior,
              revision: policy.revision,
            },
            dataOperationPolicy: createLiveShadowDataOperationPolicyBinding(
              deps.strictShadowPolicyReader ?? currentStrictShadowPolicy,
            ),
            observeBoundary: async (decision) => {
              const observed = await enforceBoundary({
                ...decision,
                boundaryId: decision.boundaryId
                  ?? "conversation.write.runtime_persist",
                retryable: decision.retryable ?? false,
              });
              rejectChangedStrictShadowPolicy(policy, observed);
            },
            work: () => requiresEncryptedForegroundCheckpoint({
                mode: policy.mode,
                shadowBehavior: policy.shadowBehavior,
                revision: policy.revision,
              })
              ? withLiveShadowCheckpointSaver({
                  logicalThreadId: prepared.graphThreadId,
                  session,
                  work: input.work,
                })
              : input.work(),
          }).catch((error: unknown) => {
            if (error instanceof Error && error.message === "protected_memory_approval_expired") {
              approvalFailure.value = new Error("protected_memory_approval_expired");
            } else if (error instanceof Error && "code" in error
              && error.code === "approval_request_stale") {
              approvalFailure.value = Object.assign(new Error("approval_request_stale"), {
                code: "approval_request_stale",
              });
            }
            throw error;
          }),
        }).catch(async (error: unknown) => {
          await recordFailure();
          throw error;
        });
        if (result.status === "executed") return result.value;
        await recordFailure();
        if (approvalFailure.value !== undefined) throw approvalFailure.value;
        if (input.allowUnprotectedFallback === false) {
          throw new Error("protected_foreground_resume_failed");
        }
      }
    }
    const enforcement = await enforceBoundary({
      boundaryId: "conversation.write.foreground_checkpoint",
      state: input.prepared.status === "ready" ? "failed" : "unsupported",
      reason: input.prepared.status === "ready"
        ? "integrity_failure"
        : "unsupported_operation",
      retryable: false,
    });
    if (
      enforcement.result.disposition === "withhold"
      || enforcement.result.disposition === "reject"
    ) {
      throw new StrictShadowDispatchError(enforcement.result);
    }
    return input.work();
  }

  // Called inside runProtectedForegroundResume, after fresh custody admission.
  // The request's incidental/default Room must not become the resumed audience.
  async function resumedMemoryDeps(
    request: FastifyRequest, graphThreadId: string, roomId: string,
    agentId: string, laneKey: string,
  ) {
    const context = getCurrentLiveShadowTurnContext();
    const policy = context?.enforcementPolicy
      ?? await (deps.strictShadowPolicyReader ?? currentStrictShadowPolicy)();
    const fullOnly = { fullEncryptionOnlyForState: () => policy.mode === "encrypted_only" };
    if (!request.sessionActorId || !request.sessionUserId || !roomId
      || parentGraphThreadIdFromForkCheckpoint(graphThreadId) !== graphThreadId
      || isScopeMemoryEnvelope(request.memoryEnvelope)) return fullOnly;
    // No custody is borrowed from the original paused invocation.
    if (context?.session === null || context?.session === undefined) return fullOnly;
    const resolver = deps.policyResolver ?? getPolicyResolver();
    if (resolver === null) throw new Error("Memory resume policy unavailable");
    const envelope = await resolver.buildEnvelope(request.sessionActorId, laneKey, agentId, roomId);
    if (envelope.ownerId !== request.sessionUserId || envelope.actorId !== request.sessionActorId
      || envelope.agentId !== agentId || envelope.roomId !== roomId) {
      throw new Error("Memory resume authority changed");
    }
    return resolveForegroundProtectedMemoryGraphDeps({
      envelope, session: context.session, policy, normalForeground: true,
    });
  }

  // D500 — narrow, authenticated identity proof for local capability changes.
  // It returns no reusable proof or token: Electron consumes the response
  // immediately and remains the sole owner of the local SSH capability store.
  app.post<{ Body: { pin?: string } }>("/api/auth/verify-pin", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId || request.policyContext?.actorRole === "guest") {
      return reply.status(401).send({ error: "Authentication required" });
    }
    const body = request.body;
    if (!body || Object.keys(body).length !== 1 || typeof body.pin !== "string" || !/^\d{6,8}$/.test(body.pin)) {
      return reply.status(400).send({ error: "PIN must be 6–8 digits" });
    }
    const auditFailure = async (pinOutcome: "invalid" | "locked_out") => {
      if (!deps.auditEvent) return;
      try {
        await deps.auditEvent({
          kind: "pin_check_failed",
          ts: now().toISOString(),
          actorId: request.sessionActorId ?? userId,
          ip: request.ip,
          userAgent: requestUserAgent(request),
          attemptedRoute: "POST /api/auth/verify-pin",
          pinOutcome,
        });
      } catch { /* best effort */ }
    };
    try {
      const valid = await pinProvider.verifyProof(userId, body.pin);
      if (!valid) {
        await auditFailure("invalid");
        return reply.status(401).send({ error: "Invalid PIN" });
      }
    } catch (err) {
      if (err instanceof LockoutError) {
        await auditFailure("locked_out");
        return reply.status(429).send({ error: err.message, retryAfterMs: err.remainingMs });
      }
      if (err instanceof InvalidPinError) {
        await auditFailure("invalid");
        return reply.status(401).send({ error: "Invalid PIN" });
      }
      throw err;
    }
    return { ok: true };
  });

  async function auditInviteBindFailed(
    request: FastifyRequest,
    row: {
      reason: string;
      context?: InviteBindAuditContext | undefined;
      logtoSub?: string | undefined;
      handle?: string | null | undefined;
    },
  ): Promise<void> {
    if (!deps.auditEvent) return;
    const event: SecurityAuditEvent = {
      kind: "invite_bind_logto_user_failed",
      ts: now().toISOString(),
      actorId: null,
      ip: request.ip,
      userAgent: requestUserAgent(request),
      reason: row.reason,
      ...(row.context
        ? {
            tokenHash: row.context.tokenHash,
            inviteKind: row.context.inviteKind,
            targetGroupId: row.context.targetGroupId,
            targetRoomId: row.context.targetRoomId,
          }
        : {}),
      ...(row.logtoSub ? { logtoSub: row.logtoSub } : {}),
      ...(row.handle ? { handleHash: sha256Hex(row.handle) } : {}),
    };
    try {
      await deps.auditEvent(event);
    } catch (err) {
      warn(`[bind-logto-user] audit write failed for ${event.kind}: ${String(err)}`);
    }
  }

  async function auditInviteBindSucceeded(
    request: FastifyRequest,
    row: {
      context: InviteBindAuditContext;
      actorId: string;
      userId: string;
      logtoSub: string;
      handle: string;
    },
  ): Promise<void> {
    if (!deps.auditEvent) return;
    const event: SecurityAuditEvent = {
      kind: "invite_bind_logto_user_succeeded",
      ts: now().toISOString(),
      actorId: row.actorId,
      ip: request.ip,
      userAgent: requestUserAgent(request),
      tokenHash: row.context.tokenHash,
      inviteKind: row.context.inviteKind,
      targetGroupId: row.context.targetGroupId,
      targetRoomId: row.context.targetRoomId,
      userId: row.userId,
      logtoSub: row.logtoSub,
      handleHash: sha256Hex(row.handle),
    };
    try {
      await deps.auditEvent(event);
    } catch (err) {
      warn(`[bind-logto-user] audit write failed for ${event.kind}: ${String(err)}`);
    }
  }

  async function resolveAuthenticatedResumeThreadScope(
    threadId: string,
    sessionUserId: string,
  ): Promise<{ roomId?: string; kind?: string } | null> {
    // M137 follow-up — collapse per-bot / per-user lane suffixes (and forks)
    // to the canonical room graph thread (`room:<id>`) so multi-agent rooms
    // authorize. The actual resume keeps the full bot-laned `threadId`; only
    // this membership lookup needs the room-level id. Without this, a
    // `room:<id>:bot:<agentId>` thread never matches `rooms.graph_thread_id`
    // and every approval/prove-it reply 403s in a 2+-agent room.
    const membershipId = roomGraphThreadFromLaneThread(threadId);
    if (deps.resumeThreadMembershipForUser) {
      const allowed = await deps.resumeThreadMembershipForUser(membershipId, sessionUserId);
      if (!allowed) return null;
    }
    if (deps.resumeThreadScopeForUser) {
      return await deps.resumeThreadScopeForUser(membershipId, sessionUserId);
    }
    if (deps.resumeThreadMembershipForUser) {
      // The existing test seam only proves authorization. Do not infer a Room
      // id or kind from its string input: resumed rows stay unstamped unless a
      // real stored Room was resolved below.
      return {};
    }
    try {
      const roomId = await findRoomIdByGraphThreadIdForUser(sessionUserId, membershipId);
      if (!roomId) return null;
      const [room] = await db
        .select({ id: rooms.id, kind: rooms.kind })
        .from(rooms)
        .where(eq(rooms.id, roomId))
        .limit(1);
      return room ? { roomId: room.id, kind: room.kind } : null;
    } catch {
      // Resume authorization and child stamping must both fail closed when the
      // Room lookup is unavailable; never derive a child id from lane text.
      return null;
    }
  }

  function pendingApprovalStorageKey(userId: string | undefined, approvalId: string): string {
    return userId ? `${userId}:${approvalId}` : approvalId;
  }

  const pendingNetworkByApproval = new Map<string, ApprovalAskNetworkContext>();
  eventBus.on((event: ServerEvent) => {
    if (event.type === "approval.ask" && event.network !== undefined) {
      pendingNetworkByApproval.set(
        pendingApprovalStorageKey(event.userId, event.approvalId),
        event.network,
      );
    }
  });

  async function unlockVaultAfterPinProof(pinUtf8: string): Promise<void> {
    if (!unlockVaultWithPin) return;
    try {
      await unlockVaultWithPin(pinUtf8);
    } catch (e) {
      warn(
        `[vault] unlock after PIN failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // POST /api/auth/pin — change PIN (requires valid session)
  // -------------------------------------------------------------------------

  app.post<{
    Body: {
      currentPin?: string;
      newPin: string;
      threadId?: string;
      laneKey?: string;
      clientActionSessionId?: string;
      authorizationDeviceId?: string;
    };
  }>(
    "/api/auth/pin",
    async (request, reply) => {
      // M052 §6c — auth state is decorated by the trust preHandler (Logto JWT).
      const userId = request.sessionUserId;
      if (!userId || request.policyContext?.actorRole === "guest") {
        return reply.status(401).send({ error: "Authentication required" });
      }

      const {
        currentPin, newPin, threadId, laneKey,
        clientActionSessionId, authorizationDeviceId,
      } = request.body ?? {};
      if (!newPin || typeof newPin !== "string") {
        return reply.status(400).send({ error: "newPin is required" });
      }
      if (newPin.length < 6 || newPin.length > 8 || !/^\d+$/.test(newPin)) {
        return reply.status(400).send({ error: "New PIN must be 6–8 digits" });
      }
      if (WEAK_PINS.has(newPin)) {
        return reply.status(400).send({
          error: "PIN is too predictable — choose something less obvious",
        });
      }

      // M054 — first-time enrollment for a Logto-authenticated user
      // who doesn't have a PIN yet. The workbench's `identity.challenge
      // { mode: "enrollPin" }` handler POSTs `{ newPin }` (no
      // `currentPin`). For a user who IS already enrolled this falls
      // through to the legacy `changePin(currentPin → newPin)` path
      // and rejects a missing `currentPin` with 400.
      const alreadyEnrolled = await pinProvider.isEnrolled(userId);

      if (!alreadyEnrolled) {
        try {
          await pinProvider.enroll(userId, newPin);
        } catch (err) {
          if (err instanceof PinAlreadyEnrolledError) {
            // Race: another tab enrolled between the isEnrolled probe
            // and the enroll() call. Surface a helpful 409 so the
            // workbench can re-fetch and retry as a change-pin if
            // needed (today it just re-prompts the user).
            return reply.status(409).send({ error: "PIN already enrolled" });
          }
          throw err;
        }

        // M063 S1 — first Logto PIN enrollment must mint recovery codes;
        // otherwise POST /api/auth/recover has nothing to consume.
        const recoveryCodes = await generateRecoveryCodes(userId);
        await unlockVaultAfterPinProof(newPin);

        // M054 — if the workbench passed `threadId`, the graph is
        // paused on an `identity_challenge { mode: "enrollPin" }`
        // interrupt that we raised before the pending prove_it.
        // Resume it so the post-model node falls through to
        // prove_it_challenge and the workbench's existing
        // approval-dialog handler picks up.
        if (threadId && typeof threadId === "string") {
          // M164 — Task/subagent enrollPin pre-step. Enrollment already
          // succeeded above; resume the parked Task checkpoint so the graph
          // falls through to the real prove_it challenge (which re-emits a
          // Task-originated prove_it.challenge via the Task-aware processor).
          // The lane is `task:<taskId>`, so the room-membership
          // `resumeThreadAllowed` check below does not apply.
          const taskEnrollLaneKey = laneKey ?? threadId;
          if (taskEnrollLaneKey.startsWith("task:")) {
            const taskId = taskEnrollLaneKey.slice("task:".length);
            const auth = await authorizeTaskApprovalResume({
              taskId,
              threadId,
              sessionUserId: userId,
            }, deps.assertCanInvokeAgent
              ? { assertInvocation: deps.assertCanInvokeAgent }
              : {});
            if (auth.ok) {
              const pc = request.policyContext;
              if (!pc) {
                return reply.status(500).send({ error: "Missing policy context" });
              }
              const taskInvocationAuthority = await acceptAuthorizedTaskResume(
                auth.task.requestorId,
                reply,
              );
              if (!taskInvocationAuthority) return;
              const turnId = await readTurnIdForThread(threadId);
              request.__turnId = turnId;
              runWithTurn(turnId, () => {
                log(`[auth/pin] enrollPin task=${taskId}; resuming thread ${threadId}`);
                void runTaskApprovalResume({
                  task: auth.task,
                  run: auth.run,
                  invocationAuthority: taskInvocationAuthority.invocation,
                  maintenanceAuthority: taskInvocationAuthority.maintenance,
                  kind: "identity",
                  policyContext: pc,
                }).catch((err) => {
                  warn(
                    `[auth/pin] task enrollPin resume failed: ${err instanceof Error ? err.message : String(err)}`,
                  );
                });
              });
            } else {
              warn(`[auth/pin] enrollPin task resume not authorized: ${auth.error}`);
              if (auth.code === "invoke_agents_required") {
                return reply.status(403).send({
                  error: auth.error,
                  code: auth.code,
                  capability: auth.capability,
                });
              }
            }
            void auditPinEnrolled(deps.auditEvent, {
              ts: now().toISOString(),
              actorId: request.sessionActorId ?? null,
              userId,
              route: "POST /api/auth/pin",
              ip: request.ip,
              userAgent:
                typeof request.headers["user-agent"] === "string"
                  ? request.headers["user-agent"]
                  : undefined,
            });
            return { ok: true, enrolled: true, recoveryCodes };
          }

          const resumeRoom = await resolveAuthenticatedResumeThreadScope(threadId, userId);
          if (!resumeRoom) {
            void auditResumeThreadDenied(deps.auditEvent, {
              ts: now().toISOString(),
              actorId: request.sessionActorId ?? null,
              userId,
              threadId,
              route: "POST /api/auth/pin",
              ip: request.ip,
              userAgent:
                typeof request.headers["user-agent"] === "string"
                  ? request.headers["user-agent"]
                  : undefined,
            });
            return reply.status(403).send({ error: "Forbidden" });
          }
          const effectiveLaneKey = laneKey ?? threadId;
          const turnId = await readTurnIdForThread(threadId);
          const causalHumanUserId =
            await readResumeCausalHumanUserId(threadId);
          request.__turnId = turnId;
          const pc = request.policyContext;
          if (!pc) {
            return reply.status(500).send({ error: "Missing policy context" });
          }
          // M125 Phase 2.4: agentId from the envelope; no bootstrap
          // fallback. Half-bound users hit 409 instead of silently
          // resuming as the operator.
          const envelopeAgentId = request.memoryEnvelope?.agentId ?? "";
          if (!envelopeAgentId) {
            warn(
              `[auth/pin] agent_id_required_to_resume userId=${userId} threadId=${threadId}`,
            );
            return reply.status(409).send({
              error: "agent_id_required_to_resume",
              code: "agent_id_required_to_resume",
            });
          }
          const agentIdForResume = await canonicalForegroundResumeAgentId(
            threadId,
            envelopeAgentId,
          );
          const accepted = await admitForegroundResume(
            causalHumanUserId,
            resumeRoom.roomId ?? undefined,
            agentIdForResume,
            reply,
          );
          if (!accepted) return;
          const protectedResume = request.sessionActorId === null
            ? unavailableProtectedResume(
                clientActionSessionId !== undefined
                && authorizationDeviceId !== undefined,
              )
            : await prepareProtectedForegroundResume({
              request,
              userId,
              humanActorId: request.sessionActorId,
              roomId: resumeRoom.roomId!,
              agentId: agentIdForResume,
              graphThreadId: threadId,
              clientActionSessionId,
              authorizationDeviceId,
              resumeKind: "identity",
              resumeDiscriminator: `${turnId}:enroll-pin`,
            }).catch(() => unavailableProtectedResume(
                clientActionSessionId !== undefined
                && authorizationDeviceId !== undefined,
              ));
          if (protectedResume.status === "replayed") {
            return { ok: true, enrolled: true, recoveryCodes };
          }
          runWithTurn(turnId, () => {
            log(
              `[auth/pin] enrollPin success for user ${userId}; resuming thread ${threadId}`,
            );
            const agentId = agentIdForResume;
            const transcriptThreadId = parentGraphThreadIdFromForkCheckpoint(threadId);
            const processor = createPersistingProcessor({
              threadId: transcriptThreadId,
              ownerId: userId,
              agentId,
              ...(resumeRoom.roomId ? { roomId: resumeRoom.roomId } : {}),
              ...(resumeRoom.kind === "subthread" && resumeRoom.roomId
                ? { subthreadRoomId: resumeRoom.roomId }
                : {}),
              laneKey: effectiveLaneKey,
              eventBus,
              humanTurnId: turnId,
              ...(causalHumanUserId ? { causalHumanUserId } : {}),
            });
            void runResumeJobLifecycleWithCurrentPolicy({
              laneKey: effectiveLaneKey,
              roomId: resumeRoom.roomId ?? "",
              graphThreadId: threadId,
              humanUserId: accepted.humanUserId,
              turnId,
              authorAgentId: agentId,
            }, (signal) => runProtectedForegroundResume({
                request,
                prepared: protectedResume,
                allowUnprotectedFallback: false,
                work: async (checkpointSaver) => resumeGraphWithIdentity(
                  threadId,
                  pc,
                  agentId,
                  processor,
                  effectiveLaneKey,
                  undefined,
                  checkpointSaver,
                  signal,
                  processor.liveShadowToolBoundaryForState,
                  await resumedMemoryDeps(
                    request,
                    threadId,
                    resumeRoom.roomId ?? "",
                    agentIdForResume,
                    effectiveLaneKey,
                  ),
                ).then(() => jobManager.reconcileForkAndResumePendingTurns(threadId)),
              }),
              accepted.invocation,
              accepted.maintenance,
            )
              .catch((err) => {
              warn(
                `[auth/pin] enrollPin resume failed: ${resumeFailureForLog(err)}`,
              );
            });
          });
        }

        void auditPinEnrolled(deps.auditEvent, {
          ts: now().toISOString(),
          actorId: request.sessionActorId ?? null,
          userId,
          route: "POST /api/auth/pin",
          ip: request.ip,
          userAgent:
            typeof request.headers["user-agent"] === "string"
              ? request.headers["user-agent"]
              : undefined,
        });

        return { ok: true, enrolled: true, recoveryCodes };
      }

      const hasCurrentPin =
        typeof currentPin === "string" && currentPin.length > 0;

      if (hasCurrentPin) {
        try {
          // M052: PIN keys on the AUTHENTICATED user's id, NOT the closure
          // server-owner id. In single-owner PIN-only installs the two ids
          // matched; with Logto JIT users each bearer changes their OWN PIN.
          // M043 already moved the
          // FK target from actor.id to users.id; this is the multi-user
          // counterpart of that move.
          await pinProvider.changePin(userId, currentPin, newPin);
        } catch (err) {
          if (err instanceof InvalidPinError) {
            return reply.status(401).send({ error: "Current PIN is incorrect" });
          }
          if (err instanceof LockoutError) {
            return reply.status(429).send({
              error: err.message,
              retryAfterMs: err.remainingMs,
            });
          }
          throw err;
        }
      } else {
        // M101 — OIDC step-up (`prompt=login&max_age=…`) proves possession
        // of the Logto session without the old PIN.
        const freshTokenWindowMs = 60_000;
        const challenged = await requireFreshLogtoAccessToken(
          request,
          reply,
          freshTokenWindowMs,
        );
        if (challenged) return;
        await pinProvider.setPinAfterFreshJwt(userId, newPin);
      }

      await unlockVaultAfterPinProof(newPin);

      return { ok: true };
    },
  );

  app.post<{ Body: {
    threadId?: string;
    laneKey?: string;
    toolCallId?: string;
    decision?: string;
    clientActionSessionId?: string;
    authorizationDeviceId?: string;
  } }>(
    "/api/auth/connected-web-action-reply",
    async (request, reply) => {
      if (!request.sessionUserId) {
        return reply.status(401).send({ error: "Authentication required" });
      }
      const {
        threadId,
        laneKey,
        toolCallId,
        decision,
        clientActionSessionId,
        authorizationDeviceId,
      } = request.body ?? {};
      if (
        typeof threadId !== "string" || threadId.length === 0 || threadId.length > 256
        || typeof laneKey !== "string" || laneKey.length === 0 || laneKey.length > 512
        || typeof toolCallId !== "string" || toolCallId.length === 0 || toolCallId.length > 512
        || (decision !== "done" && decision !== "cancel")
        || (clientActionSessionId !== undefined && typeof clientActionSessionId !== "string")
        || (authorizationDeviceId !== undefined && typeof authorizationDeviceId !== "string")
      ) {
        return reply.status(400).send({ error: "Invalid connected web action reply" });
      }
      if (roomGraphThreadFromLaneThread(laneKey) !== roomGraphThreadFromLaneThread(threadId)) {
        return reply.status(400).send({ error: "Invalid connected web action lane" });
      }
      const userId = request.sessionUserId;
      const resumeRoom = await resolveAuthenticatedResumeThreadScope(threadId, userId);
      if (
        !resumeRoom
        || !await projectionResumeAllowed(
          deps.projectionResumeBindingForThread ?? readProjectionResumeBindingForThread,
          threadId,
          userId,
          request.sessionActorId,
        )
      ) {
        return reply.status(403).send({ error: "Forbidden" });
      }
      const actionResumeBindingReader = deps.connectedWebActionResumeBindingForThread
        ?? readConnectedWebActionResumeBindingForThread;
      const actionResumeBinding = await actionResumeBindingReader(threadId).catch(() => null);
      if (!actionResumeBinding || actionResumeBinding.laneKey !== laneKey || !request.sessionActorId) {
        return reply.status(409).send({ error: "agent_id_required_to_resume" });
      }
      const humanActorId = request.sessionActorId;
      const agentId = actionResumeBinding.agentId;
      const pendingReader = deps.connectedWebActionPendingForThread
        ?? readPendingInterruptEventsForThread;
      const findParkedAction = async () => (await pendingReader(threadId, laneKey).catch(() => []))
        .find((event) =>
        event.type === "connected_web.action_attention"
        && event.threadId === threadId
        && event.laneKey === laneKey
        && event.toolCallId === toolCallId
        && event.userId === userId);
      const parked = await findParkedAction();
      if (!parked || parked.type !== "connected_web.action_attention") {
        return reply.status(409).send({ error: "connected_web_action_not_parked" });
      }
      const causalHumanUserId = await readResumeCausalHumanUserId(threadId);
      const accepted = await admitForegroundResume(
        causalHumanUserId,
        resumeRoom.roomId ?? undefined,
        agentId,
        reply,
      );
      if (!accepted) return;
      const claimNow = now().getTime();
      for (const [claim, expiresAt] of connectedWebActionReplyClaims) {
        if (expiresAt <= claimNow) connectedWebActionReplyClaims.delete(claim);
      }
      const replyClaim = `${userId}:${threadId}:${toolCallId}`;
      const existingLocalClaim = connectedWebActionReplyClaims.has(replyClaim);
      if (existingLocalClaim && decision !== "cancel") {
        return reply.status(409).send({
          error: "connected_web_action_already_submitted",
          code: "connected_web_action_already_submitted",
        });
      }
      // Done and Cancel are two outcomes for one parked interrupt, not two
      // independently executable requests. Claim the decision coordinate
      // synchronously before any protected-resume work can yield.
      if (!existingLocalClaim) {
        connectedWebActionReplyClaims.set(replyClaim, claimNow + connectedWebActionReplyTtlMs);
      }
      const protectedResumeInput = (resumeDiscriminator: string) => ({
        request,
        userId,
        humanActorId,
        roomId: resumeRoom.roomId ?? "",
        agentId,
        graphThreadId: threadId,
        clientActionSessionId,
        authorizationDeviceId,
        resumeKind: "connected_web_action" as const,
        resumeDiscriminator,
      });
      let activeProtectedResumeInput = protectedResumeInput(toolCallId);
      let protectedResume = await prepareProtectedForegroundResume(activeProtectedResumeInput)
        .catch(() => unavailableProtectedResume(true));
      if (protectedResume.status === "replayed") {
        // The durable protected execution, not client state, proves whether
        // the first resume is terminal-failed. Only the strictly safer Cancel
        // may recover that exact still-parked tool call; Done never replays.
        if (decision !== "cancel" || protectedResume.cancelRecovery !== "available") {
          return reply.status(409).send({
            error: "connected_web_action_already_submitted",
            code: "connected_web_action_already_submitted",
          });
        }
        // Each recovery receives fresh protected Runtime authority. Walk only
        // past durably terminal-failed Cancel attempts; the first unreserved
        // coordinate is atomically claimed, while an in-flight/completed one
        // returns unavailable and cannot be replayed.
        let recoveryAttempt = 1;
        for (;;) {
          activeProtectedResumeInput = protectedResumeInput(
            `${toolCallId}:cancel-recovery:${recoveryAttempt}`,
          );
          const candidate = await prepareProtectedForegroundResume(activeProtectedResumeInput)
            .catch(() => unavailableProtectedResume(true));
          if (candidate.status === "ready") {
            protectedResume = candidate;
            break;
          }
          if (candidate.status === "replayed" && candidate.cancelRecovery === "available") {
            recoveryAttempt++;
            continue;
          }
          return reply.status(409).send({
            error: "connected_web_action_recovery_unavailable",
            code: "connected_web_action_recovery_unavailable",
          });
        }
      }
      if (protectedResume.status === "unavailable") {
        connectedWebActionReplyClaims.delete(replyClaim);
        return reply.status(409).send({ error: "foreground_resume_unavailable" });
      }
      const turnId = await readTurnIdForThread(threadId);
      request.__turnId = turnId;
      runWithTurn(turnId, () => {
        const createActionProcessor = () => createPersistingProcessor({
          threadId: parentGraphThreadIdFromForkCheckpoint(threadId),
          ownerId: userId,
          agentId,
          ...(resumeRoom.roomId ? { roomId: resumeRoom.roomId } : {}),
          laneKey,
          eventBus,
          humanTurnId: turnId,
        });
        const processor = createActionProcessor();
        void runResumeJobLifecycleWithCurrentPolicy(
          {
            laneKey,
            roomId: resumeRoom.roomId ?? "",
            graphThreadId: threadId,
            humanUserId: accepted.humanUserId,
            turnId,
            authorAgentId: agentId,
          },
          (signal) => {
            const work = async (checkpointSaver?: EncryptedCheckpointSaver) => {
              try {
                await resumeGraphWithConnectedWebAction(
                  threadId,
                  { toolCallId, decision },
                  parked.intervention,
                  userId,
                  processor,
                  laneKey,
                  checkpointSaver,
                  signal,
                  processor.liveShadowToolBoundaryForState,
                );
              } catch (error) {
                // If the graph failed before consuming the exact parked
                // interrupt, do not strand a mutation behind a dead card.
                // A cancellation is strictly less authority than the Human's
                // accepted Done/Cancel and the action runtime makes it
                // idempotent against any durable terminal receipt.
                const stillParked = await findParkedAction();
                if (!stillParked || stillParked.type !== "connected_web.action_attention") throw error;
                warn("[auth/connected-web-action-reply] Resume failed while still parked; cancelling the exact action");
                const cancellationProcessor = createActionProcessor();
                await resumeGraphWithConnectedWebAction(
                  threadId,
                  { toolCallId, decision: "cancel" },
                  stillParked.intervention,
                  userId,
                  cancellationProcessor,
                  laneKey,
                  checkpointSaver,
                  undefined,
                  cancellationProcessor.liveShadowToolBoundaryForState,
                );
              }
              jobManager.reconcileForkAndResumePendingTurns(threadId);
            };
            return runProtectedForegroundResume({
              request,
              prepared: protectedResume,
              work,
              allowUnprotectedFallback: false,
              callerRecordsFailure: true,
            });
          },
          accepted.invocation,
          accepted.maintenance,
        ).catch(async (error) => {
          connectedWebActionReplyClaims.delete(replyClaim);
          // The HTTP acceptance precedes background graph execution. If the
          // graph is still parked after a failed resume, publish exact private
          // failure truth so the card cannot spin forever or imply that a
          // second website action is running. A completed/advanced graph has
          // canonical tool/activity output and must not be overwritten here.
          if (await findParkedAction()) {
            let cancelRecovery: "available" | "unavailable" = "unavailable";
            const composition = getProductionLiveShadowMessageComposition(request.server);
            try {
              await composition?.recordSharedAgentExecutionUnavailable?.({
                executionId: protectedResume.executionId,
                reason: "connected_web_action_resume_failed",
                now: Date.now(),
              });
            } catch { /* the replay read below remains authoritative */ }
            const replay = await prepareProtectedForegroundResume(activeProtectedResumeInput)
              .catch(() => unavailableProtectedResume(true));
            cancelRecovery = replay.status === "replayed"
              ? replay.cancelRecovery
              : "unavailable";
            eventBus.emit({
              type: "connected_web.action_resume_failed",
              threadId,
              laneKey,
              toolCallId,
              userId,
              cancelRecovery,
            });
          }
          warn(`[auth/connected-web-action-reply] Resume failed: ${resumeFailureForLog(error)}`);
        });
      });
      return { ok: true };
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/auth/prove-and-resume — prove_it challenge (PIN) or denial
  //   Approval: { pin, threadId, laneKey? } — verify PIN then resume
  //   Denial:   { denied: true, threadId, laneKey? } — resume with denial
  // -------------------------------------------------------------------------

  app.post<{ Body: {
    pin?: string;
    denied?: boolean;
    threadId: string;
    laneKey?: string;
    challengeId?: string;
    clientActionSessionId?: string;
    authorizationDeviceId?: string;
  } }>(
    "/api/auth/prove-and-resume",
    async (request, reply) => {
      // M052 §6d — preHandler is the single source of truth for auth.
      const userId = request.sessionUserId;
      if (!userId) {
        return reply.status(401).send({ error: "Authentication required" });
      }

      const {
        pin, denied, threadId, laneKey,
        challengeId,
        clientActionSessionId, authorizationDeviceId,
      } = request.body ?? {};
      if (!threadId || typeof threadId !== "string") {
        return reply.status(400).send({ error: "threadId is required" });
      }
      if (challengeId !== undefined
        && (typeof challengeId !== "string" || challengeId.length === 0)) {
        return reply.status(400).send({ error: "Invalid challenge identity" });
      }

      const effectiveLaneKey = laneKey ?? threadId;
      const approved = !denied && typeof pin === "string";

      if (approved) {
        if (!pin || pin.length < 6) {
          return reply.status(400).send({ error: "PIN is required for approval" });
        }

        try {
          // M052: PIN verifies against the AUTHENTICATED user's id, not
          // the closure server-owner id. Same rationale as §6c above.
          const valid = await pinProvider.verifyProof(userId, pin);
          if (!valid) {
            return reply.status(401).send({ error: "Invalid PIN" });
          }
        } catch (err) {
          if (err instanceof LockoutError) {
            return reply.status(429).send({
              error: err.message,
              retryAfterMs: err.remainingMs,
            });
          }
          throw err;
        }

        await unlockVaultAfterPinProof(pin);
      }

      // M164 — Task/subagent prove_it. PIN has already been verified (or this is
      // a denial). The lane is `task:<taskId>`; authorize owner-only against the
      // parked Task run and resume + finalize through the Task path.
      if (effectiveLaneKey.startsWith("task:")) {
        const taskId = effectiveLaneKey.slice("task:".length);
        const auth = await authorizeTaskApprovalResume({
          taskId,
          threadId,
          sessionUserId: userId,
        }, deps.assertCanInvokeAgent
          ? { assertInvocation: deps.assertCanInvokeAgent }
          : {});
        if (!auth.ok) {
          void auditResumeThreadDenied(deps.auditEvent, {
            ts: now().toISOString(),
            actorId: request.sessionActorId ?? null,
            userId,
            threadId,
            route: "POST /api/auth/prove-and-resume",
            ip: request.ip,
            userAgent:
              typeof request.headers["user-agent"] === "string"
                ? request.headers["user-agent"]
                : undefined,
          });
          return reply.status(auth.status).send({
            error: auth.error,
            ...(auth.code ? { code: auth.code } : {}),
            ...(auth.capability ? { capability: auth.capability } : {}),
          });
        }
        const taskInvocationAuthority = await acceptAuthorizedTaskResume(
          auth.task.requestorId,
          reply,
        );
        if (!taskInvocationAuthority) return;
        const turnId = await readTurnIdForThread(threadId);
        request.__turnId = turnId;
        runWithTurn(turnId, () => {
          log(`[auth/prove-and-resume] task=${taskId} threadId=${threadId} approved=${approved}`);
          void runTaskApprovalResume({
            task: auth.task,
            run: auth.run,
            invocationAuthority: taskInvocationAuthority.invocation,
            maintenanceAuthority: taskInvocationAuthority.maintenance,
            kind: "prove_it",
            approved,
            ...(challengeId !== undefined ? { challengeId } : {}),
          }).catch((err) => {
            warn(
              `[auth/prove-and-resume] task resume failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        });
        return { ok: true };
      }

      const resumeRoom = await resolveAuthenticatedResumeThreadScope(threadId, userId);
      if (!resumeRoom) {
        void auditResumeThreadDenied(deps.auditEvent, {
          ts: now().toISOString(),
          actorId: request.sessionActorId ?? null,
          userId,
          threadId,
          route: "POST /api/auth/prove-and-resume",
          ip: request.ip,
          userAgent:
            typeof request.headers["user-agent"] === "string"
              ? request.headers["user-agent"]
              : undefined,
        });
        return reply.status(403).send({ error: "Forbidden" });
      }

      if (!await projectionResumeAllowed(
        deps.projectionResumeBindingForThread ?? readProjectionResumeBindingForThread,
        threadId,
        userId,
        request.sessionActorId,
      )) {
        void auditResumeThreadDenied(deps.auditEvent, {
          ts: now().toISOString(),
          actorId: request.sessionActorId ?? null,
          userId,
          threadId,
          route: "POST /api/auth/prove-and-resume",
          ip: request.ip,
          userAgent:
            typeof request.headers["user-agent"] === "string"
              ? request.headers["user-agent"]
              : undefined,
        });
        return reply.status(403).send({ error: "Forbidden" });
      }

      // D082 PR B — bind turnId from checkpoint before the handler's
      // entry + catch logs so they grep-correlate with the original
      // chat turn that raised the prove_it interrupt.
      const turnId = await readTurnIdForThread(threadId);
      const causalHumanUserId =
        await readResumeCausalHumanUserId(threadId);
      request.__turnId = turnId;

      // M125 Phase 2.4 — envelope-derived agentId; 409 on missing.
      const envelopeAgentId = request.memoryEnvelope?.agentId ?? "";
      if (!envelopeAgentId) {
        warn(
          `[auth/prove-and-resume] agent_id_required_to_resume userId=${userId} threadId=${threadId}`,
        );
        return reply.status(409).send({
          error: "agent_id_required_to_resume",
          code: "agent_id_required_to_resume",
        });
      }
      const agentIdForResume = await canonicalForegroundResumeAgentId(
        threadId,
        envelopeAgentId,
      );
      const accepted = await admitForegroundResume(
        causalHumanUserId,
        resumeRoom.roomId ?? undefined,
        agentIdForResume,
        reply,
      );
      if (!accepted) return;
      const protectedResume = request.sessionActorId === null
        ? unavailableProtectedResume(
            clientActionSessionId !== undefined
            && authorizationDeviceId !== undefined,
          )
        : await prepareProtectedApprovalDecision({
          request,
          userId,
          humanActorId: request.sessionActorId,
          roomId: resumeRoom.roomId!,
          agentId: agentIdForResume,
          graphThreadId: threadId,
          clientActionSessionId,
          authorizationDeviceId,
          resumeKind: "prove_it",
          resumeDiscriminator: challengeId ?? turnId,
        }, !approved).catch(() => unavailableProtectedResume(
            clientActionSessionId !== undefined
            && authorizationDeviceId !== undefined,
          ));
      if (protectedResume.status === "replayed") {
        return rejectRepeatedProtectedResume(reply);
      }
      // Synchronous inner body — see note in /api/auth/verify-and-resume.
      runWithTurn(turnId, () => {
        log(`[auth/prove-and-resume] threadId=${threadId} approved=${approved}`);

        const transcriptThreadId = parentGraphThreadIdFromForkCheckpoint(threadId);
        const processor = createPersistingProcessor({
          threadId: transcriptThreadId,
          ownerId: userId,
          agentId: agentIdForResume,
          ...(resumeRoom.roomId ? { roomId: resumeRoom.roomId } : {}),
          ...(resumeRoom.kind === "subthread" && resumeRoom.roomId
            ? { subthreadRoomId: resumeRoom.roomId }
            : {}),
          laneKey: effectiveLaneKey,
          eventBus,
          humanTurnId: turnId,
          ...(causalHumanUserId ? { causalHumanUserId } : {}),
        });

        // D353 follow-up — prove_it resumes run outside the original Job just
        // like approval.ask resumes. Wrap them so the workbench receives a
        // terminal job.status and clears its optimistic Stop/running state.
        void runResumeJobLifecycleWithCurrentPolicy({
            laneKey: effectiveLaneKey,
            roomId: resumeRoom.roomId ?? "",
            graphThreadId: threadId,
            humanUserId: accepted.humanUserId,
            turnId,
            authorAgentId: agentIdForResume,
          }, (signal) => runProtectedForegroundResume({
            request,
            prepared: protectedResume,
            allowUnprotectedFallback: false,
            work: async (checkpointSaver) =>
              resumeGraphWithApproval(
                threadId,
                approved,
                processor,
                effectiveLaneKey,
                checkpointSaver,
                signal,
                processor.liveShadowToolBoundaryForState,
                await resumedMemoryDeps(request, threadId, resumeRoom.roomId ?? "", agentIdForResume, effectiveLaneKey),
                challengeId,
              )
                .then(() => jobManager.reconcileForkAndResumePendingTurns(threadId)),
          }),
          accepted.invocation, accepted.maintenance)
          .catch((err) => {
            warn(
              `[auth/prove-and-resume] Resume failed: ${resumeFailureForLog(err)}`,
            );
          });
      });

      return { ok: true };
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/auth/host-choice-reply — D458 paired-mobile exact-host resume.
  // Foreground ordinary chat only. The opaque selector is consumed and the
  // chosen host is revalidated inside the server-owned resolver before the
  // graph can reach approvals or tool execution.
  // -------------------------------------------------------------------------

  app.post<{ Body: { choiceId?: string; selector?: string; threadId?: string; laneKey?: string } }>(
    "/api/auth/host-choice-reply",
    async (request, reply) => {
      if (!request.sessionUserId) {
        return reply.status(401).send({ error: "Authentication required" });
      }
      const { choiceId, selector, threadId, laneKey } = request.body ?? {};
      if (!choiceId || !selector || !threadId) {
        return reply.status(400).send({ error: "choiceId, selector, and threadId are required" });
      }
      const userId = request.sessionUserId;
      const resumeRoom = await resolveAuthenticatedResumeThreadScope(threadId, userId);
      if (!resumeRoom) {
        return reply.status(403).send({ error: "Forbidden" });
      }
      if (!await projectionResumeAllowed(
        deps.projectionResumeBindingForThread ?? readProjectionResumeBindingForThread,
        threadId,
        userId,
        request.sessionActorId,
      )) {
        return reply.status(403).send({ error: "Forbidden" });
      }
      const envelopeAgentId = request.memoryEnvelope?.agentId ?? "";
      if (!envelopeAgentId) {
        return reply.status(409).send({
          error: "agent_id_required_to_resume",
          code: "agent_id_required_to_resume",
        });
      }
      const agentId = await canonicalForegroundResumeAgentId(
        threadId,
        envelopeAgentId,
      );
      const causalHumanUserId = await readResumeCausalHumanUserId(threadId);
      const accepted = await admitForegroundResume(
        causalHumanUserId,
        resumeRoom.roomId ?? undefined,
        agentId,
        reply,
      );
      if (!accepted) return;
      const claimNow = now().getTime();
      for (const [claim, expiresAt] of hostChoiceReplyClaims) {
        if (expiresAt <= claimNow) hostChoiceReplyClaims.delete(claim);
      }
      const replyClaim = `${userId}:${choiceId}`;
      if (hostChoiceReplyClaims.has(replyClaim)) {
        return reply.status(409).send({
          error: "host_choice_already_submitted",
          code: "host_choice_already_submitted",
        });
      }
      // Claim synchronously before scheduling graph work. Two taps or two
      // concurrent HTTP retries must never launch competing resumes for the
      // same one-use selector.
      hostChoiceReplyClaims.set(replyClaim, claimNow + hostChoiceReplyTtlMs);
      const effectiveLaneKey = laneKey ?? threadId;
      const turnId = await readTurnIdForThread(threadId);
      request.__turnId = turnId;
      runWithTurn(turnId, () => {
        const processor = createPersistingProcessor({
          threadId: parentGraphThreadIdFromForkCheckpoint(threadId),
          ownerId: userId,
          agentId,
          ...(resumeRoom.roomId ? { roomId: resumeRoom.roomId } : {}),
          ...(resumeRoom.kind === "subthread" && resumeRoom.roomId
            ? { subthreadRoomId: resumeRoom.roomId }
            : {}),
          laneKey: effectiveLaneKey,
          eventBus,
          humanTurnId: turnId,
        });
        void runResumeJobLifecycleWithCurrentPolicy({
            laneKey: effectiveLaneKey,
            roomId: resumeRoom.roomId ?? "",
            graphThreadId: threadId,
            humanUserId: accepted.humanUserId,
            turnId,
            authorAgentId: agentId,
          }, (signal) =>
            resumeGraphWithHostChoice(
              threadId,
              { choiceId, selector },
              processor,
              effectiveLaneKey,
              signal,
            ).then(() => {
              forkCoordinator.markForkCompletedByCheckpoint(threadId);
            }),
          accepted.invocation, accepted.maintenance)
          .catch((err) => {
            warn(`[auth/host-choice-reply] Resume failed: ${resumeFailureForLog(err)}`);
          });
      });
      return { ok: true };
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/auth/approval-reply — D061 Phase 2 ask-verb reply
  //   Body: { verb: "once" | "room" | "always" | "deny", threadId, laneKey? }
  //   Resumes the graph with { approved, verb } where approved = verb !== "deny".
  //
  // No PIN required — this is the light-approval tier. prove_it lives at
  // /api/auth/prove-and-resume and handles the PIN-gated flow separately.
  // -------------------------------------------------------------------------

  app.post<{ Body: {
    verb?: string;
    threadId?: string;
    laneKey?: string;
    approvalId?: string;
    localMcpInstallDigest?: string;
    mediaGenerationDigest?: string;
    mediaGenerationQuoteDigest?: string;
    mediaGenerationRevision?: number;
    clientActionSessionId?: string;
    authorizationDeviceId?: string;
  } }>(
    "/api/auth/approval-reply",
    async (request, reply) => {
      // M052 §6d — preHandler-set request.sessionUserId is the single
      // auth gate. The legacy per-handler bearer check 401'd JWTs.
      if (!request.sessionUserId) {
        return reply.status(401).send({ error: "Authentication required" });
      }

      const {
        verb, threadId, laneKey, approvalId, localMcpInstallDigest,
        mediaGenerationDigest, mediaGenerationQuoteDigest, mediaGenerationRevision,
        clientActionSessionId, authorizationDeviceId,
      } = request.body ?? {};

      if (!threadId || typeof threadId !== "string") {
        return reply.status(400).send({ error: "threadId is required" });
      }
      if (!verb || !isApprovalReplyVerb(verb)) {
        return reply.status(400).send({
          error: "verb is required — must be 'once', 'room', 'always', or 'deny'",
        });
      }

      const sessionUserId = request.sessionUserId;

      const hasMediaEcho = mediaGenerationDigest !== undefined ||
        mediaGenerationQuoteDigest !== undefined || mediaGenerationRevision !== undefined;
      if (hasMediaEcho) {
        if (
          (verb !== "once" && verb !== "deny") ||
          typeof approvalId !== "string" || approvalId.length === 0 ||
          typeof laneKey !== "string" || laneKey.length === 0 ||
          typeof mediaGenerationDigest !== "string" ||
          !/^[a-f0-9]{64}$/.test(mediaGenerationDigest) ||
          typeof mediaGenerationQuoteDigest !== "string" ||
          !/^[a-f0-9]{64}$/.test(mediaGenerationQuoteDigest) ||
          mediaGenerationRevision !== 1
        ) {
          return reply.status(409).send({ error: "approval_stale", code: "approval_stale" });
        }
      }
      // Authenticated transport only: the durable graph checkpoint remains
      // authority and revalidates every field against its prepared binding.
      // Keeping this route stateless makes approval resumes restart-safe.
      const mediaEcho = hasMediaEcho
        ? {
            approvalId: approvalId!,
            digest: mediaGenerationDigest!,
            quoteDigest: mediaGenerationQuoteDigest!,
            laneKey: laneKey!,
            revision: mediaGenerationRevision!,
          }
        : undefined;

      // D503: local MCP install authority is durable graph checkpoint state,
      // not a server-process cache. The route still fail-closes before resume:
      // both the exact receipt and digest are mandatory and the graph checks
      // them against its checkpoint-bound tool-call binding.
      if (typeof approvalId === "string" && approvalId.startsWith("local-mcp-install:")) {
        if (!localMcpInstallDigest || (verb !== "once" && verb !== "deny")) {
          return reply.status(409).send({ error: "approval_stale", code: "approval_stale" });
        }
      }
      // D500: Electron's post-prepare SSH summary is an exact one-shot review,
      // never a standing/room approval. The tools node binds this id again to
      // the preparation, digest, tool-call, and dynamic subject before launch.
      if (typeof approvalId === "string" && approvalId.startsWith("ssh-prepare-approval:")) {
        if (verb !== "once" && verb !== "deny") {
          return reply.status(409).send({ error: "approval_stale", code: "approval_stale" });
        }
      }

      // M164 — Task/subagent approval. The lane is `task:<taskId>`, not a room
      // thread, so the room-membership `resumeThreadAllowed` check below does
      // not apply; authorize owner-only against the parked Task run instead and
      // resume + finalize through the Task path.
      const taskApprovalLaneKey = laneKey ?? "";
      if (taskApprovalLaneKey.startsWith("task:")) {
        const taskId = taskApprovalLaneKey.slice("task:".length);
        const auth = await authorizeTaskApprovalResume({
          taskId,
          threadId,
          sessionUserId,
        }, deps.assertCanInvokeAgent
          ? { assertInvocation: deps.assertCanInvokeAgent }
          : {});
        if (!auth.ok) {
          void auditResumeThreadDenied(deps.auditEvent, {
            ts: now().toISOString(),
            actorId: request.sessionActorId ?? null,
            userId: sessionUserId,
            threadId,
            route: "POST /api/auth/approval-reply",
            ip: request.ip,
            userAgent:
              typeof request.headers["user-agent"] === "string"
                ? request.headers["user-agent"]
                : undefined,
          });
          return reply.status(auth.status).send({
            error: auth.error,
            ...(auth.code ? { code: auth.code } : {}),
            ...(auth.capability ? { capability: auth.capability } : {}),
          });
        }
        const taskInvocationAuthority = await acceptAuthorizedTaskResume(
          auth.task.requestorId,
          reply,
        );
        if (!taskInvocationAuthority) return;
        const resolutionContext: ApprovalResolutionContext | null = approvalId
          ? {
              approvalId,
              threadId,
              laneKey: taskApprovalLaneKey,
              userId: sessionUserId,
              verb,
              taskId,
              taskRunId: auth.run.id,
              origin: "task",
            }
          : null;
        const resolutionAttempt = resolutionContext
          ? approvalResolutions.begin(resolutionContext)
          : null;
        if (resolutionAttempt?.kind === "conflict") {
          return reply.status(409).send({
            error: "approval_decision_conflict",
            code: "approval_decision_conflict",
          });
        }
        if (resolutionAttempt?.kind === "duplicate") {
          return { ok: true };
        }
        const turnId = await readTurnIdForThread(threadId);
        request.__turnId = turnId;
        runWithTurn(turnId, () => {
          log(`[auth/approval-reply] task=${taskId} threadId=${threadId} verb=${verb}`);
          void runTaskApprovalResume({
            task: auth.task,
            run: auth.run,
            invocationAuthority: taskInvocationAuthority.invocation,
            maintenanceAuthority: taskInvocationAuthority.maintenance,
            kind: "ask",
            verb,
            ...(approvalId !== undefined ? { approvalId } : {}),
            ...(approvalId?.startsWith("local-mcp-install:") ? { localMcpInstallApprovalId: approvalId } : {}),
            ...(localMcpInstallDigest !== undefined ? { localMcpInstallDigest } : {}),
            ...(approvalId?.startsWith("ssh-prepare-approval:") ? { structuredSshApprovalId: approvalId } : {}),
            ...(mediaEcho ? {
              mediaGenerationApprovalId: mediaEcho.approvalId,
              mediaGenerationDigest: mediaEcho.digest,
              mediaGenerationQuoteDigest: mediaEcho.quoteDigest,
              mediaGenerationLaneKey: mediaEcho.laneKey,
              mediaGenerationRevision: mediaEcho.revision,
            } : {}),
          })
            .then((result) => {
              if (
                resolutionContext &&
                resolutionAttempt?.kind === "started"
              ) {
                if (result.staleReply === true) {
                  approvalResolutions.fail(
                    resolutionContext,
                    resolutionAttempt.token,
                  );
                } else {
                  approvalResolutions.complete(
                    resolutionContext,
                    resolutionAttempt.token,
                  );
                }
              }
            })
            .catch((err) => {
              if (
                resolutionContext &&
                resolutionAttempt?.kind === "started"
              ) {
                approvalResolutions.fail(
                  resolutionContext,
                  resolutionAttempt.token,
                );
              }
              warn(
                `[auth/approval-reply] task resume failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
        });
        void auditApprovalReply(deps.auditEvent, {
          kind: verb === "deny" ? "approval_denied" : "approval_granted",
          ts: now().toISOString(),
          actorId: request.sessionActorId ?? sessionUserId,
          ip: request.ip,
          userAgent: request.headers["user-agent"],
          route: "POST /api/auth/approval-reply",
          threadId,
          laneKey: taskApprovalLaneKey,
          verb,
        });
        return { ok: true };
      }

      const resumeRoom = await resolveAuthenticatedResumeThreadScope(threadId, sessionUserId);
      if (!resumeRoom) {
        void auditResumeThreadDenied(deps.auditEvent, {
          ts: now().toISOString(),
          actorId: request.sessionActorId ?? null,
          userId: sessionUserId,
          threadId,
          route: "POST /api/auth/approval-reply",
          ip: request.ip,
          userAgent:
            typeof request.headers["user-agent"] === "string"
              ? request.headers["user-agent"]
              : undefined,
        });
        return reply.status(403).send({ error: "Forbidden" });
      }

      if (!await projectionResumeAllowed(
        deps.projectionResumeBindingForThread ?? readProjectionResumeBindingForThread,
        threadId,
        sessionUserId,
        request.sessionActorId,
      )) {
        void auditResumeThreadDenied(deps.auditEvent, {
          ts: now().toISOString(),
          actorId: request.sessionActorId ?? null,
          userId: sessionUserId,
          threadId,
          route: "POST /api/auth/approval-reply",
          ip: request.ip,
          userAgent:
            typeof request.headers["user-agent"] === "string"
              ? request.headers["user-agent"]
              : undefined,
        });
        return reply.status(403).send({ error: "Forbidden" });
      }

      const effectiveLaneKey = laneKey ?? threadId;

      // D082 PR B — bind turnId from checkpoint so both the entry
      // log and the access-log hook carry the same `[turn=<id>]`
      // prefix as the upstream post_model interrupt + downstream
      // resume stream.
      const turnId = await readTurnIdForThread(threadId);
      const causalHumanUserId =
        await readResumeCausalHumanUserId(threadId);
      request.__turnId = turnId;

      // M125 Phase 2.4 — envelope-derived agentId; 409 on missing.
      const envelopeAgentId = request.memoryEnvelope?.agentId ?? "";
      if (!envelopeAgentId) {
        warn(
          `[auth/approval-reply] agent_id_required_to_resume userId=${sessionUserId} threadId=${threadId}`,
        );
        return reply.status(409).send({
          error: "agent_id_required_to_resume",
          code: "agent_id_required_to_resume",
        });
      }
      const agentIdForResume = await canonicalForegroundResumeAgentId(
        threadId,
        envelopeAgentId,
      );
      const accepted = await admitForegroundResume(
        causalHumanUserId,
        resumeRoom.roomId ?? undefined,
        agentIdForResume,
        reply,
      );
      if (!accepted) return;
      const auditNetwork = approvalId !== undefined
        ? pendingNetworkByApproval.get(pendingApprovalStorageKey(sessionUserId, approvalId))
        : undefined;
      if (approvalId !== undefined) {
        pendingNetworkByApproval.delete(
          pendingApprovalStorageKey(sessionUserId, approvalId),
        );
      }
      const auditEvent: SecurityAuditEvent = {
        kind: verb === "deny" ? "approval_denied" : "approval_granted",
        ts: now().toISOString(),
        actorId: request.sessionActorId ?? request.sessionUserId ?? null,
        ip: request.ip,
        userAgent: request.headers["user-agent"],
        route: "POST /api/auth/approval-reply",
        threadId,
        laneKey: effectiveLaneKey,
        verb,
        ...(auditNetwork ? { network: auditNetwork } : {}),
      };

      const resolutionContext: ApprovalResolutionContext | null = approvalId
        ? {
            approvalId,
            threadId,
            laneKey: effectiveLaneKey,
            userId: sessionUserId,
            verb,
          }
        : null;
      const resolutionAttempt = resolutionContext
        ? approvalResolutions.begin(resolutionContext)
        : null;
      if (resolutionAttempt?.kind === "conflict") {
        return reply.status(409).send({
          error: "approval_decision_conflict",
          code: "approval_decision_conflict",
        });
      }
      if (resolutionAttempt?.kind === "duplicate") {
        return clientActionSessionId !== undefined && authorizationDeviceId !== undefined
          ? rejectRepeatedProtectedResume(reply)
          : { ok: true };
      }
      const protectedResume = request.sessionActorId === null
        ? unavailableProtectedResume(
            clientActionSessionId !== undefined
            && authorizationDeviceId !== undefined,
          )
        : await prepareProtectedApprovalDecision({
          request,
          userId: sessionUserId,
          humanActorId: request.sessionActorId,
          roomId: resumeRoom.roomId!,
          agentId: agentIdForResume,
          graphThreadId: threadId,
          clientActionSessionId,
          authorizationDeviceId,
          resumeKind: "approval",
          resumeDiscriminator: approvalId ?? turnId,
        }, verb === "deny").catch(() => unavailableProtectedResume(
            clientActionSessionId !== undefined
            && authorizationDeviceId !== undefined,
          ));
      if (protectedResume.status === "replayed") {
        // The durable reservation consumed this response, but no new graph
        // work began. Release the local claim so a safer denial can proceed.
        if (resolutionContext && resolutionAttempt?.kind === "started") {
          approvalResolutions.fail(resolutionContext, resolutionAttempt.token);
        }
        return rejectRepeatedProtectedResume(reply);
      }

      // Synchronous inner body — see note in /api/auth/verify-and-resume.
      runWithTurn(turnId, () => {
        log(`[auth/approval-reply] threadId=${threadId} verb=${verb}`);

        const agentId = agentIdForResume;
        const transcriptThreadId = parentGraphThreadIdFromForkCheckpoint(threadId);
        const processor = createPersistingProcessor({
          threadId: transcriptThreadId,
          ownerId: sessionUserId,
          agentId,
          ...(resumeRoom.roomId ? { roomId: resumeRoom.roomId } : {}),
          ...(resumeRoom.kind === "subthread" && resumeRoom.roomId
            ? { subthreadRoomId: resumeRoom.roomId }
            : {}),
          laneKey: effectiveLaneKey,
          eventBus,
          humanTurnId: turnId,
          ...(causalHumanUserId ? { causalHumanUserId } : {}),
        });

        // D353 follow-up — wrap the resumed chain in a synthetic Job
        // lifecycle so the workbench gets a terminal `job.status` when
        // the resumed stream settles. Without this, the resume runs
        // outside any Job (the original already emitted
        // `job.status:completed` when the interrupt parked it), so the
        // workbench's optimistic `setIsRunning(true)` from
        // `submitApprovalAsk` never clears and Stop stays stale. See
        // `JobManager.runResumeJobLifecycle` for the full rationale.
        void runResumeJobLifecycleWithCurrentPolicy({
            laneKey: effectiveLaneKey,
            roomId: resumeRoom.roomId ?? "",
            graphThreadId: threadId,
            humanUserId: accepted.humanUserId,
            turnId,
            authorAgentId: agentId,
          }, (signal) => runProtectedForegroundResume({
            request,
            prepared: protectedResume,
            allowUnprotectedFallback: false,
            work: async (checkpointSaver) => resumeGraphWithAskReply(
                threadId,
                verb,
                processor,
                effectiveLaneKey,
                checkpointSaver,
                signal,
                approvalId?.startsWith("local-mcp-install:") ? approvalId : undefined,
                localMcpInstallDigest,
                effectiveLaneKey,
                approvalId?.startsWith("ssh-prepare-approval:") ? approvalId : undefined,
                mediaEcho?.approvalId,
                mediaEcho?.digest,
                mediaEcho?.quoteDigest,
                mediaEcho?.laneKey,
                mediaEcho?.revision,
                processor.liveShadowToolBoundaryForState,
                await resumedMemoryDeps(request, threadId, resumeRoom.roomId ?? "", agentIdForResume, effectiveLaneKey),
                approvalId,
              )
                .then(() => jobManager.reconcileForkAndResumePendingTurns(threadId))
                .then(() => auditApprovalReply(deps.auditEvent, auditEvent))
                .then(() => {
                  if (
                    resolutionContext &&
                    resolutionAttempt?.kind === "started"
                  ) {
                    approvalResolutions.complete(
                      resolutionContext,
                      resolutionAttempt.token,
                    );
                  }
                }),
          }),
          accepted.invocation, accepted.maintenance)
          .catch((err) => {
            if (
              resolutionContext &&
              resolutionAttempt?.kind === "started"
            ) {
              approvalResolutions.fail(
                resolutionContext,
                resolutionAttempt.token,
              );
            }
            warn(
              `[auth/approval-reply] Resume failed: ${resumeFailureForLog(err)}`,
            );
          });
      });

      return { ok: true };
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/auth/whoami — returns current actor role and label
  // Used by clients to display the role badge.
  // -------------------------------------------------------------------------

  app.get("/api/auth/whoami", async (request, reply) => {
    const userId = request.sessionUserId;
    const principal = request.resolvedPrincipal;
    const rbac = request.rbacProjection;
    const instanceId = resolveInstance().instanceId;
    const officeEnabled = fromRuntimeConfig().nautilo_office_enabled;

    let handle: string | null = null;
    let displayName: string | null = null;
    let externalId: string | null = null;
    let userIdentity: string | null = null;
    let mustChangePassword = false;

    if (principal) {
      handle = principal.handle;
      displayName = principal.displayName;
      externalId =
        principal.logtoSub.length > 0 ? principal.logtoSub : null;
      userIdentity =
        principal.federatedId.length > 0 ? principal.federatedId : null;
    }

    if (userId) {
      try {
        const sec = await getAccountSecurityRowByUserId(db, userId);
        mustChangePassword = sec?.requiresPasswordChange === true;
      } catch {
        mustChangePassword = false;
      }
    }
    const groupsChips = rbac
      ? rbac.groupChips.map((chip) => ({
          id: chip.id,
          type: chip.type,
          label: chip.label,
          roleSlug: chip.roleSlug,
        }))
      : [];

    const capabilities: CapabilitySlug[] = rbac
      ? rbac.capabilitySlugs.filter(isCapabilitySlug)
      : [];

    const highestRole = rbac?.highestRole ?? null;

    const body: WhoamiResponse = {
      sessionUserId: request.sessionUserId ?? null,
      sessionActorId: request.sessionActorId ?? null,
      userIdentity,
      handle,
      displayName,
      externalId,
      instanceId,
      mustChangePassword,
      groups: groupsChips,
      capabilities,
      features: {
        office: {
          enabled: officeEnabled,
        },
      },
      highestRole,
    };

    const etag = whoamiWeakETagFromProjection(body);
    reply.header("ETag", etag);
    reply.header("Vary", WHOAMI_VARY);
    reply.header("Cache-Control", WHOAMI_CACHE_CONTROL);

    if (whoamiIfNoneMatchEquals(request.headers["if-none-match"], etag)) {
      return reply.status(304).send();
    }

    return reply.send(body);
  });

  // -------------------------------------------------------------------------
  // GET /api/auth/pin-enrollment — whether this session user has a PIN yet
  // (Workbench Settings branches enroll vs change without a failed POST).
  // -------------------------------------------------------------------------

  app.get("/api/auth/pin-enrollment", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId || request.policyContext?.actorRole === "guest") {
      return reply.status(401).send({ error: "Authentication required" });
    }
    const enrolled = await pinProvider.isEnrolled(userId);
    return reply.send({ enrolled });
  });

  // -------------------------------------------------------------------------
  // POST /api/auth/recover — reset PIN using a single-use recovery code
  // Bearer JWT required; recovery targets sessionUserId. Either pass
  // `recoveryCode` (always allowed) or a fresh Logto JWT (≤60s `iat`) via
  // `requireFreshLogtoAccessToken` for the no-code path. No longer
  // localhost-gated — fresh-JWT is the sensitive-action gate.
  // NOT in PUBLIC_ROUTES — trust preHandler must run so Logto JWT decorates
  // sessionUserId (S2 + S2b).
  // -------------------------------------------------------------------------

  app.post<{ Body: { recoveryCode?: string; newPin: string } }>(
    "/api/auth/recover",
    async (request, reply) => {
      const { recoveryCode, newPin } = request.body ?? {};
      if (!newPin || typeof newPin !== "string") {
        return reply.status(400).send({ error: "newPin is required" });
      }
      if (newPin.length < 6 || newPin.length > 8 || !/^\d+$/.test(newPin)) {
        return reply.status(400).send({ error: "New PIN must be 6–8 digits" });
      }
      if (WEAK_PINS.has(newPin)) {
        return reply.status(400).send({
          error: "New PIN is too predictable — choose something less obvious",
        });
      }

      const userId = request.sessionUserId;
      if (!userId || request.policyContext?.actorRole === "guest") {
        return reply.status(401).send({ error: "Authentication required" });
      }

      const hasRecoveryCode =
        typeof recoveryCode === "string" && recoveryCode.length > 0;

      if (hasRecoveryCode) {
        const result = await useRecoveryCode(userId, recoveryCode, newPin);

        if (!result.success) {
          switch (result.reason) {
            case "no_codes":
              return reply.status(400).send({ error: "No unused recovery codes remain. Use the CLI reset tool." });
            case "invalid":
              return reply.status(401).send({ error: "Invalid recovery code" });
            case "weak_pin":
              return reply.status(400).send({ error: "New PIN is too predictable — choose something less obvious" });
            case "invalid_pin_length":
              return reply.status(400).send({ error: "New PIN must be 6–8 digits" });
          }
        }

        await unlockVaultAfterPinProof(newPin);
        return reply.send({ ok: true, codesRemaining: result.codesRemaining });
      }

      const freshTokenWindowMs = 60_000;
      const challenged = await requireFreshLogtoAccessToken(
        request,
        reply,
        freshTokenWindowMs,
      );
      if (challenged) return;

      await pinProvider.setPinAfterFreshJwt(userId, newPin);
      await unlockVaultAfterPinProof(newPin);
      const status = await getRecoveryCodeStatus(userId);
      return reply.send({ ok: true, codesRemaining: status.remaining });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/auth/identity-verify-resume — mid-session identity PIN (JWT + PIN).
  // -------------------------------------------------------------------------

  app.post<{ Body: {
    pin: string;
    threadId: string;
    laneKey?: string;
    clientActionSessionId?: string;
    authorizationDeviceId?: string;
  } }>(
    "/api/auth/identity-verify-resume",
    async (request, reply) => {
      const userId = request.sessionUserId;
      if (!userId) {
        return reply.status(401).send({ error: "Authentication required" });
      }

      const {
        pin, threadId, laneKey,
        clientActionSessionId, authorizationDeviceId,
      } = request.body ?? {};
      if (!pin || typeof pin !== "string") {
        return reply.status(400).send({ error: "pin is required" });
      }
      if (!threadId || typeof threadId !== "string") {
        return reply.status(400).send({ error: "threadId is required" });
      }

      try {
        const valid = await pinProvider.verifyProof(userId, pin);
        if (!valid) {
          return reply.status(401).send({ error: "Invalid PIN" });
        }
      } catch (err) {
        if (err instanceof LockoutError) {
          return reply.status(429).send({
            error: err.message,
            retryAfterMs: err.remainingMs,
          });
        }
        throw err;
      }

      await unlockVaultAfterPinProof(pin);

      const effectiveLaneKey = laneKey ?? threadId;
      if (effectiveLaneKey.startsWith("task:")) {
        const taskId = effectiveLaneKey.slice("task:".length);
        const auth = await authorizeTaskApprovalResume({
          taskId,
          threadId,
          sessionUserId: userId,
        }, deps.assertCanInvokeAgent
          ? { assertInvocation: deps.assertCanInvokeAgent }
          : {});
        if (!auth.ok) {
          return reply.status(auth.status).send({
            error: auth.error,
            ...(auth.code ? { code: auth.code } : {}),
            ...(auth.capability ? { capability: auth.capability } : {}),
          });
        }
        const pc = request.policyContext;
        if (!pc) {
          return reply.status(500).send({ error: "Missing policy context" });
        }
        const taskInvocationAuthority = await acceptAuthorizedTaskResume(
          auth.task.requestorId,
          reply,
        );
        if (!taskInvocationAuthority) return;
        const turnId = await readTurnIdForThread(threadId);
        request.__turnId = turnId;
        runWithTurn(turnId, () => {
          log(`[auth/identity-verify-resume] task=${taskId} threadId=${threadId}`);
          void runTaskApprovalResume({
            task: auth.task,
            run: auth.run,
            invocationAuthority: taskInvocationAuthority.invocation,
            maintenanceAuthority: taskInvocationAuthority.maintenance,
            kind: "identity",
            policyContext: pc,
          }).catch((err) => {
            warn(
              `[auth/identity-verify-resume] task resume failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        });
        return { ok: true };
      }

      const resumeRoom = await resolveAuthenticatedResumeThreadScope(threadId, userId);
      if (!resumeRoom) {
        void auditResumeThreadDenied(deps.auditEvent, {
          ts: now().toISOString(),
          actorId: request.sessionActorId ?? null,
          userId,
          threadId,
          route: "POST /api/auth/identity-verify-resume",
          ip: request.ip,
          userAgent:
            typeof request.headers["user-agent"] === "string"
              ? request.headers["user-agent"]
              : undefined,
        });
        return reply.status(403).send({ error: "Forbidden" });
      }

      const pc = request.policyContext;
      if (!pc) {
        return reply.status(500).send({ error: "Missing policy context" });
      }

      const turnId = await readTurnIdForThread(threadId);
      const causalHumanUserId =
        await readResumeCausalHumanUserId(threadId);
      request.__turnId = turnId;

      // M125 Phase 2.4 — envelope-derived agentId; 409 on missing.
      const envelopeAgentId = request.memoryEnvelope?.agentId ?? "";
      if (!envelopeAgentId) {
        warn(
          `[auth/identity-verify-resume] agent_id_required_to_resume userId=${userId} threadId=${threadId}`,
        );
        return reply.status(409).send({
          error: "agent_id_required_to_resume",
          code: "agent_id_required_to_resume",
        });
      }
      const agentIdForResume = await canonicalForegroundResumeAgentId(
        threadId,
        envelopeAgentId,
      );
      const accepted = await admitForegroundResume(
        causalHumanUserId,
        resumeRoom.roomId ?? undefined,
        agentIdForResume,
        reply,
      );
      if (!accepted) return;
      const protectedResume = request.sessionActorId === null
        ? unavailableProtectedResume(
            clientActionSessionId !== undefined
            && authorizationDeviceId !== undefined,
          )
        : await prepareProtectedForegroundResume({
          request,
          userId,
          humanActorId: request.sessionActorId,
          roomId: resumeRoom.roomId!,
          agentId: agentIdForResume,
          graphThreadId: threadId,
          clientActionSessionId,
          authorizationDeviceId,
          resumeKind: "identity",
          resumeDiscriminator: turnId,
        }).catch(() => unavailableProtectedResume(
            clientActionSessionId !== undefined
            && authorizationDeviceId !== undefined,
          ));
      if (protectedResume.status === "replayed") return { ok: true };

      runWithTurn(turnId, () => {
        log(`[auth/identity-verify-resume] threadId=${threadId}`);

        const agentId = agentIdForResume;
        const transcriptThreadId = parentGraphThreadIdFromForkCheckpoint(threadId);
        const processor = createPersistingProcessor({
          threadId: transcriptThreadId,
          ownerId: userId,
          agentId,
          ...(resumeRoom.roomId ? { roomId: resumeRoom.roomId } : {}),
          ...(resumeRoom.kind === "subthread" && resumeRoom.roomId
            ? { subthreadRoomId: resumeRoom.roomId }
            : {}),
          laneKey: effectiveLaneKey,
          eventBus,
          humanTurnId: turnId,
          ...(causalHumanUserId ? { causalHumanUserId } : {}),
        });
        // D353 follow-up — identity-verify resumes also run outside the
        // original Job. Emit a synthetic terminal lifecycle so Stop does not
        // remain enabled after the resumed stream settles.
        void runResumeJobLifecycleWithCurrentPolicy({
            laneKey: effectiveLaneKey,
            roomId: resumeRoom.roomId ?? "",
            graphThreadId: threadId,
            humanUserId: accepted.humanUserId,
            turnId,
            authorAgentId: agentId,
          }, (signal) => runProtectedForegroundResume({
            request,
            prepared: protectedResume,
            allowUnprotectedFallback: false,
            work: async (checkpointSaver) => resumeGraphWithIdentity(
                threadId,
                pc,
                agentId,
                processor,
                effectiveLaneKey,
                undefined,
                checkpointSaver,
                signal,
                processor.liveShadowToolBoundaryForState,
                await resumedMemoryDeps(
                  request,
                  threadId,
                  resumeRoom.roomId ?? "",
                  agentIdForResume,
                  effectiveLaneKey,
                ),
              )
                .then(() => jobManager.reconcileForkAndResumePendingTurns(threadId)),
          }),
          accepted.invocation, accepted.maintenance)
          .catch((err) => {
            warn(
              `[auth/identity-verify-resume] Resume failed: ${resumeFailureForLog(err)}`,
            );
          });
      });

      return { ok: true };
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/auth/recovery-codes/status — how many codes remain?
  // Requires authenticated non-guest user (same bar as POST /api/auth/pin).
  // -------------------------------------------------------------------------

  app.get("/api/auth/recovery-codes/status", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId || request.policyContext?.actorRole === "guest") {
      return reply.status(401).send({ error: "Authentication required" });
    }
    const status = await getRecoveryCodeStatus(userId);
    return reply.send(status);
  });

  // -------------------------------------------------------------------------
  // POST /api/auth/recovery-codes/regenerate — invalidate old codes, get new
  // Requires authenticated non-guest user + PIN reverify.
  // -------------------------------------------------------------------------

  app.post("/api/auth/recovery-codes/regenerate", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId || request.policyContext?.actorRole === "guest") {
      return reply.status(401).send({ error: "Authentication required" });
    }
    const body = request.body as Record<string, unknown> | undefined;
    const pin = body?.["pin"];
    if (typeof pin !== "string" || pin.length === 0) {
      return reply.status(400).send({
        error: "Regenerating recovery codes requires PIN re-verification.",
      });
    }
    try {
      const valid = await pinProvider.verifyProof(userId, pin);
      if (!valid) {
        return reply.status(401).send({ error: "Invalid PIN" });
      }
    } catch (err) {
      if (err instanceof LockoutError) {
        return reply.status(429).send({
          error: err.message,
          retryAfterMs: err.remainingMs,
        });
      }
      throw err;
    }
    const codes = await regenerateRecoveryCodes(userId);
    return reply.send({ recoveryCodes: codes });
  });

  // -------------------------------------------------------------------------
  // POST /api/bind-logto-user — M105/M260 browser-mediated Invite bind.
  // Caller: the workbench `/invite/<token>` wizard's OAuth
  // callback after Logto-hosted sign-up. Body: `{ state }`. Auth: a Logto
  // access token in the Authorization header. JIT-creates the local users
  // row with external_id = sub; returns { actorId, userId,
  // requiresProfileCompletion: true }. The wizard then calls
  // /api/invites/:token/complete-profile with displayName/pin.
  // -------------------------------------------------------------------------

  app.post<{ Body: { state?: unknown } }>(
    "/api/bind-logto-user",
    async (request, reply) => {
      const authHeader = request.headers.authorization;
      const bearer = authHeader?.startsWith("Bearer ")
        ? authHeader.slice(7)
        : null;
      if (!bearer) {
        return reply.code(401).send({ error: "missing_bearer" });
      }
      let payload;
      try {
        payload = await verifyLogtoAccessToken(bearer);
      } catch {
        return reply.code(401).send({ error: "invalid_token" });
      }

      const body = request.body ?? {};
      const stateRaw = typeof body.state === "string" ? body.state : "";
      const unpacked = unpackPrepareState(stateRaw);
      if (!unpacked) {
        await auditInviteBindFailed(request, {
          reason: "invalid_state",
          logtoSub: payload.sub,
        });
        return reply.code(422).send({
          error: "invalid_state",
          code: "invalid_state",
        });
      }
      const auditContext = deps.auditEvent
        ? await loadInviteBindAuditContext(unpacked.inviteToken)
        : null;

      const logto = (() => {
        try {
          return getLogtoAdminClient();
        } catch {
          return null;
        }
      })();
      if (!logto) {
        await auditInviteBindFailed(request, {
          reason: "logto_unconfigured",
          context: auditContext ?? undefined,
          logtoSub: payload.sub,
        });
        return reply.code(503).send({ error: "logto_unconfigured" });
      }

      let logtoUser;
      try {
        logtoUser = await logto.getUser(payload.sub);
      } catch (e) {
        warn(
          `[bind-logto-user] getUser failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        await auditInviteBindFailed(request, {
          reason: "logto_lookup_failed",
          context: auditContext ?? undefined,
          logtoSub: payload.sub,
        });
        return reply.code(502).send({ error: "logto_lookup_failed" });
      }
      if (!logtoUser) {
        await auditInviteBindFailed(request, {
          reason: "logto_user_not_found",
          context: auditContext ?? undefined,
          logtoSub: payload.sub,
        });
        return reply.code(404).send({ error: "logto_user_not_found" });
      }

      // M107 Phase 2c — handle resolution.
      // Primary: from the opaque state the wizard round-tripped through
      // Logto sign-up (set by /api/invites/:token/prepare-logto-signup).
      // Fallback: the Logto user's `username`, for stale renderers that
      // still send pre-M107 2-segment states (M107 deprecation — remove
      // in M108).
      const stateHandle = unpacked.handle;
      const logtoUsername =
        typeof logtoUser.username === "string" ? logtoUser.username.toLowerCase() : "";
      const handle = stateHandle ?? (logtoUsername.length > 0 ? logtoUsername : null);
      if (handle === null) {
        await auditInviteBindFailed(request, {
          reason: "missing_handle",
          context: auditContext ?? undefined,
          logtoSub: payload.sub,
        });
        return reply.code(400).send({
          error: "missing_handle",
          code: "missing_handle",
        });
      }
      // Security: when both the state and Logto agree, they must agree
      // on the same handle. Mismatch means the state was tampered with
      // (or a stale renderer round-tripped a different handle than the
      // one the user typed on the Logto-hosted page). Surface clearly
      // rather than silently choosing one.
      if (
        stateHandle !== null &&
        logtoUsername.length > 0 &&
        stateHandle !== logtoUsername
      ) {
        warn(
          `[bind-logto-user] handle_mismatch sub=${payload.sub} ` +
            `state=${stateHandle} logto=${logtoUsername}`,
        );
        await auditInviteBindFailed(request, {
          reason: "handle_mismatch",
          context: auditContext ?? undefined,
          logtoSub: payload.sub,
          handle: stateHandle,
        });
        return reply.code(409).send({
          error: "handle_mismatch",
          code: "handle_mismatch",
        });
      }

      const args: BindLogtoUserArgs = {
        handle,
        displayName: payload.name ?? logtoUser.username ?? "",
      };

      const result = await redeemInviteWithLogtoSub(
        unpacked.inviteToken,
        payload.sub,
        args,
        {},
      );

      if (!result.ok) {
        await auditInviteBindFailed(request, {
          reason: result.code ?? result.error,
          context: auditContext ?? undefined,
          logtoSub: payload.sub,
          handle,
        });
        return reply.code(result.httpStatus).send({
          error: result.error,
          code: result.code,
        });
      }

      if (auditContext) {
        await auditInviteBindSucceeded(request, {
          context: auditContext,
          actorId: result.actorId,
          userId: result.userId,
          logtoSub: payload.sub,
          handle,
        });
      }

      return reply.send({
        ok: true,
        actorId: result.actorId,
        userId: result.userId,
        requiresProfileCompletion: true,
      });
    },
  );
}

async function auditApprovalReply(
  auditEvent: AuthRouteDeps["auditEvent"],
  event: SecurityAuditEvent,
): Promise<void> {
  if (!auditEvent) return;
  try {
    await auditEvent(event);
  } catch {
    warn(`[auth/approval-reply] audit write failed for ${event.kind}`);
  }
}


function isApprovalReplyVerb(v: string): v is ApprovalReplyVerb {
  return v === "once" || v === "room" || v === "always" || v === "deny";
}
