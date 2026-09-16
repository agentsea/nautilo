/**
 * D418 — Full Workstation access activation / disable route.
 *
 * Narrow Fastify route module that wires the
 * `InMemoryWorkstationSessionRegistry` to the HTTP control plane.
 * Foundation ONLY for the HTTP surface — it does NOT touch sandbox /
 * profile execution, renderer UI, desktop profile IPC, sandbox roots, or
 * MCP execution.
 *
 * D418 Commit 3 — this module ALSO exports
 * {@link createWorkstationApprovalOverrideResolver}: the server-side
 * approval decision seam that reads the LIVE active Full Workstation session
 * from the shared `InMemoryWorkstationSessionRegistry`, admits + revalidates
 * a transient `WorkstationDispatchPlan`, and calls the pure
 * {@link resolveWorkstationAdmission} policy with the slim execution-
 * admission contract (`executionClass + activeSession + exactPlan +
 * tool/operation identity`). It returns one
 * decision: `auto` (caller MAY suppress the normal `ask` / `prove_it`
 * prompt for this dispatch) or `none` (caller MUST leave the normal approval
 * logic intact). It is fail-closed: no active session ⇒ `none`, so ordinary
 * D375 Auto-Approve (`ask → auto` client-side) and the dock / PIN / block
 * path run unchanged when Full Mode is off.
 *
 * D418 Commit 4 — the resolver admits an eligible `run_shell` attempt via a
 * STATIC `scanCommand` refusal of critical / elevation ONLY (no boundedness /
 * timeout / dynamic-path / network-intent / OS / MCP / caller-boolean
 * inspection). With an active session + an exact admitted+revalidated plan +
 * a supported `profile_bound_sandbox` class + `run_shell` + no
 * critical/elevation scan hit, the dispatch flips to `auto`; anything else
 * stays `none` and normal approval runs unchanged. This does NOT confirm
 * local containment: Electron-local shell binding and sandbox construction
 * remain fail-closed execution authority. The resolver emits a redacted
 * runtime-owned
 * `workstation_admission` audit row for every consultation. The nine-field
 * caller-authored evidence model is superseded; this seam no longer
 * reconstructs profile/path/network/OS/boundedness/MCP/escape booleans, and
 * it does NOT copy the active session into a fake dispatch binding (the
 * exact binding proof is the `exactPlan` flag).
 *
 * Boundary: this helper is a DECISION seam only. It does NOT itself
 * execute, approve, dispatch, or alter sandbox/profile execution. The
 * live post-model caller that consumes it
 * (`packages/agent/src/nodes/post-model.ts` Pass 2) is wired by the
 * orchestrator in a separate slice — see the deferral note in the task
 * done-report. It is intentionally NOT mounted in `app.ts` as a route by
 * this task; the orchestrator wires it (along with a real
 * `RelayBindingProvider`) when the desktop side lands.
 *
 * Activation contract (mirrors the established `/api/security/posture`
 * pattern in `routes/security.ts`):
 *
 *   1. Auth — `request.sessionUserId` (set by the trust preHandler).
 *   2. Capability — caller must hold `use_workstation` (the D418
 *      profile-activation capability; default Owner / Admin / Superuser /
 *      Member, delegable by Owner / Admin via Group→Role). B3 (D418 Commit 1):
 *      `control_desktop` is NOT required for activation — the normal
 *      workstation tool capability is an orthogonal tool gate, not an
 *      activation gate. Probing without `use_workstation` 403s
 *      and emits a `workstation_session_denied` audit row.
 *   3. Fresh PIN proof — verified via the injected `ChallengeProvider`
 *      using the same `verifyProof(userId, pin)` + `LockoutError` /
 *      `InvalidPinError` shape as the security routes. The route never
 *      stores or invents raw PIN material; it reuses the existing
 *      challenge/provider infrastructure. The PIN is the activating
 *      user's OWN PIN — they never need an offline operator's PIN.
 *   4. Exact relay binding — the client supplies a typed binding
 *      payload; the route resolves the AUTHORITATIVE binding from the
 *      injected `RelayBindingProvider` and requires an exact field-by-
 *      field match. A client flag alone cannot activate.
 *   5. Registry — hands the authoritative binding to
 *      `registry.activate`, which enforces eligibility, monotonicity,
 *      narrowing/removal, and server-switch semantics.
 *
 * Disable contract (B3 — D418 Commit 1):
 *   - Auth ONLY. Disable is user-bound (keyed on `sessionUserId`) and
 *     idempotent by virtue of the registry, and it is INDEPENDENT of all
 *     current capabilities: no capability check runs here, so a user whose
 *     `use_workstation` (or any other capability) is revoked
 *     mid-session can still disable their own session. PIN is NOT required
 *     for disable — the task contract only requires a fresh PIN proof for
 *     activation. The route emits no capability-denial audit (the registry
 *     emits its own disable / not_active transition audit via its injected
 *     callback).
 *
 * Responses are audit-shaped and carry NO command output, PINs, or
 * secrets. Every transition + every denial emits a
 * `WorkstationAccessAuditEvent` via the injected `auditEvent` callback.
 */

import type { FastifyInstance } from "fastify";
import type { ToolCall } from "@langchain/core/messages/tool";
import { getServerHostname, isCanonicalNautiloInstanceId } from "@nautilo/config";
import { warn } from "@nautilo/logger";
import {
  CAP_USE_WORKSTATION,
  InvalidPinError,
  LockoutError,
  resolveWorkstationAdmission,
  type ChallengeProvider,
  type FullWorkstationSessionEvidence,
  type WorkstationAdmissionEvidence,
  type WorkstationAdmissionDecision,
  type WorkstationAdmissionReason,
} from "@nautilo/trust";
import {
  classifyWorkstationExecutionClass,
  requiresNormalWorkstationCommandApproval,
} from "../workstation-execution-class";
import {
  mintWorkstationStartupReceipt,
  verifyWorkstationStartupReceipt,
  type WorkstationStartupReceiptClaims,
} from "../workstation-startup-receipt";
export { classifyWorkstationExecutionClass } from "../workstation-execution-class";
import {
  FULL_WORKSTATION_AGENT_SCOPE,
  InMemoryRelayRegistry,
  InMemoryWorkstationSessionRegistry,
  InMemoryWorkstationDispatchPlanRegistry,
  revalidatePlanAgainstRelay,
  type FullWorkstationBinding,
  type FullWorkstationSession,
  type FullWorkstationSessionRegistryOptions,
  type RelayBindingProvider,
  type WorkstationAccessAuditEvent,
  type WorkstationAdmissionAuditEvent,
  type WorkstationDispatchPlan,
  type WorkstationDispatchPlanBindingSnapshot,
  type WorkstationRelayFingerprint,
} from "@nautilo/runtime";

const ACTIVATE_ROUTE = "POST /api/workstation-access/activate";
const ACTIVATE_PROFILE_ROUTE = "POST /api/workstation-access/activate-profile";
const COMPLETE_PROFILE_ROUTE = "POST /api/workstation-access/activate-profile/complete";

/**
 * D498 — resolve the exact live session/profile/relay binding used by
 * same-authority plan re-admission. The canonical active session remains the
 * identity authority; relay snapshots contribute only their live
 * grant/policy revisions. This server boundary deliberately does not infer
 * local filesystem authority from Current Folder or durable grants: Electron
 * remains final authority for Current Folder equality and identity,
 * operation posture, protected-path policy, and local binding. Any missing
 * or incoherent tuple field returns null, preserving drift revalidation.
 *
 * Exported so app wiring and focused lifecycle tests share one implementation.
 */
export function resolveActiveWorkstationDispatchBinding(input: {
  readonly userId: string;
  readonly currentFolder: string;
  readonly sessionRegistry: InMemoryWorkstationSessionRegistry;
  readonly relayRegistry: InMemoryRelayRegistry;
}): WorkstationDispatchPlanBindingSnapshot | null {
  const session = input.sessionRegistry.get(input.userId);
  if (session === null) return null;
  const grantSnapshot = input.relayRegistry.getDesktopFilesystemGrantSnapshot(session.relayId);
  const profileSnapshot = input.relayRegistry.getWorkstationProfileSnapshot(session.relayId);
  if (grantSnapshot === null || profileSnapshot === null) return null;
  const liveCapabilityRevision =
    input.relayRegistry.getCapabilityRevision(session.relayId);
  if (
    input.relayRegistry.getUserId(session.relayId) !== session.userId ||
    input.relayRegistry.getDesktopSessionId(session.relayId) !== session.desktopSessionId ||
    input.relayRegistry.getPairingGeneration(session.relayId) !== session.pairingGeneration ||
    liveCapabilityRevision === null ||
    liveCapabilityRevision < session.capabilityRevision ||
    grantSnapshot.instanceId !== session.instanceId ||
    profileSnapshot.profileId !== session.profileId ||
    profileSnapshot.profileRevision !== session.profileRevision ||
    profileSnapshot.grantIds.length !== session.grantIds.length ||
    !profileSnapshot.grantIds.every((grantId, index) => grantId === session.grantIds[index])
  ) {
    return null;
  }
  const advertisedGrantIds = new Set(grantSnapshot.grants.map((grant) => grant.id));
  if (!session.grantIds.every((grantId) => advertisedGrantIds.has(grantId))) {
    return null;
  }
  // Grant snapshots prove only that the active session's advertised grant IDs
  // still exist. They are not local filesystem authority: this server must
  // neither require a duplicate exact-root Current Folder grant nor infer a
  // containing-grant capability. Electron re-resolves the selected Current
  // Folder against its local store, canonical identity, requested operation,
  // and protected-path deny policy immediately before execution.
  return {
    userId: session.userId,
    instanceId: session.instanceId,
    relayId: session.relayId,
    desktopSessionId: session.desktopSessionId,
    serverBindingId: session.serverBindingId,
    pairingGeneration: session.pairingGeneration,
    profileId: session.profileId,
    profileRevision: session.profileRevision,
    grantIds: [...session.grantIds],
    capabilityRevision: liveCapabilityRevision,
    grantRevision: grantSnapshot.revision,
    protectedPolicyVersion: profileSnapshot.protectedPolicyVersion,
  };
}

/**
 * The client-supplied activation binding payload. Same shape as
 * `FullWorkstationBinding` (compared for exact match against the
 * authoritative resolver output). Carried in the request body alongside
 * the PIN proof.
 */
export interface WorkstationBindingPayload {
  readonly instanceId: string;
  readonly relayId: string;
  readonly desktopSessionId: string;
  readonly serverBindingId: string;
  readonly agentScope: typeof FULL_WORKSTATION_AGENT_SCOPE;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly grantIds: readonly string[];
  readonly capabilityRevision: number;
  /**
   * D418 Commit 2 — the server-derived `pairingGeneration` (the validated
   * relay-token row id). Carried in the client payload ONLY for an exact
   * field-by-field match against the authoritative resolver output; it is
   * never trusted to self-authorize. The authoritative binding is sourced
   * from the authenticated relay registry, never from this field alone.
   */
  readonly pairingGeneration: string;
}

/**
 * Audit callback for route-emitted events. The route stamps the
 * request-side envelope (actorId / ip / userAgent) before invoking it.
 * Implementations MAY throw; the route swallows + warns so a forensic
 * row missing never blocks the response — mirroring the `safeAudit`
 * contract in `routes/security.ts`.
 */
export type WorkstationAccessAuditor = (event: WorkstationAccessAuditEvent) => Promise<void> | void;

export interface WorkstationAccessRouteDeps {
  readonly pinProvider: ChallengeProvider;
  readonly getCapabilities: (userId: string) => Promise<readonly string[]>;
  readonly relayBindingProvider: RelayBindingProvider;
  readonly relayRegistry: InMemoryRelayRegistry;
  /**
   * D418 — resolves the authoritative Full Workstation binding for the
   * profile-SELECTOR activation path (`POST /activate-profile`). Unlike
   * `relayBindingProvider` (which derives profileId / profileRevision +
   * grantIds from an already-advertised profile snapshot), this provider
   * derives the binding from the relay registry's GRANT snapshot only and
   * stamps the client-supplied `profileId` + `profileRevision` selectors
   * into the binding. It is the seam that unblocks the FIRST activation
   * of an approved stored profile before any compiled profile snapshot
   * has been advertised. Required: the `/activate-profile` route is
   * registered only when this is present.
   */
  readonly profileActivationProvider?: ProfileActivationProvider;
  readonly registry: InMemoryWorkstationSessionRegistry;
  readonly auditEvent: WorkstationAccessAuditor;
  /**
   * D557 — returns existing stable server HMAC material on demand. It is
   * deliberately lazy so servers that have not enabled remote pairing keep
   * their existing boot contract; startup receipt use then fails closed.
   */
  readonly startupReceiptSecret?: () => string;
  readonly now?: () => Date;
}

/**
 * D418 — authoritative binding resolver for the profile-selector activation
 * path. Returns the authoritative `FullWorkstationBinding` for a given
 * relay / desktop session / instance + a client-selected stored profile
 * (profileId + profileRevision), or `null` when no eligible binding exists
 * (headless relay, unknown relay, foreign owner, mismatched desktop session
 * / instance, missing grant snapshot, no active grant surface). The route
 * calls this AFTER auth + capability + PIN-required; the registry never
 * calls it. Production wires a real provider; tests inject a test double.
 */
export interface ProfileActivationProvider {
  resolve(input: {
    readonly userId: string;
    readonly relayId: string;
    readonly desktopSessionId: string;
    readonly instanceId: string;
    readonly profileId: string;
    readonly profileRevision: number;
  }): Promise<FullWorkstationBinding | null>;
}

/**
 * Request context the route stamps onto every audit event. Mirrors the
 * `CommonAuditFields` envelope used by the security audit log.
 */
interface AuditMeta {
  readonly actorId: string;
  readonly ip: string;
  readonly userAgent: string | undefined;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Strict shape validator for the client-supplied binding payload.
 * Returns the parsed binding or a 400-shaped error string. The route
 * runs this BEFORE PIN verification so an obviously invalid payload
 * does not burn a verifyProof attempt (same ordering rationale as the
 * security posture route).
 */
function parseBindingPayload(value: unknown):
  | { ok: true; payload: WorkstationBindingPayload }
  | { ok: false; error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "binding must be an object" };
  }
  const b = value as Record<string, unknown>;
  if (
    !isCanonicalNautiloInstanceId(b["instanceId"]) ||
    !isNonBlankString(b["relayId"]) ||
    !isNonBlankString(b["desktopSessionId"]) ||
    !isNonBlankString(b["serverBindingId"]) ||
    !isNonBlankString(b["profileId"]) ||
    !isNonBlankString(b["pairingGeneration"])
  ) {
    return {
      ok: false,
      error:
        "binding requires a canonical instanceId (default \"\" or named), and non-empty relayId, desktopSessionId, serverBindingId, profileId, pairingGeneration",
    };
  }
  if (b["agentScope"] !== FULL_WORKSTATION_AGENT_SCOPE) {
    return { ok: false, error: `binding agentScope must be ${FULL_WORKSTATION_AGENT_SCOPE}` };
  }
  if (typeof b["profileRevision"] !== "number" || !Number.isSafeInteger(b["profileRevision"]) || b["profileRevision"] < 1) {
    return { ok: false, error: "binding profileRevision must be a positive safe integer (>= 1)" };
  }
  if (typeof b["capabilityRevision"] !== "number" || !Number.isSafeInteger(b["capabilityRevision"]) || b["capabilityRevision"] < 1) {
    return { ok: false, error: "binding capabilityRevision must be a positive safe integer (>= 1)" };
  }
  if (!Array.isArray(b["grantIds"]) || !b["grantIds"].every(isNonBlankString) || new Set(b["grantIds"]).size !== b["grantIds"].length) {
    return { ok: false, error: "binding grantIds must be unique non-empty strings" };
  }
  return {
    ok: true,
    payload: {
      instanceId: b["instanceId"],
      relayId: b["relayId"],
      desktopSessionId: b["desktopSessionId"],
      serverBindingId: b["serverBindingId"],
      agentScope: FULL_WORKSTATION_AGENT_SCOPE,
      profileId: b["profileId"],
      profileRevision: b["profileRevision"],
      grantIds: [...b["grantIds"]],
      capabilityRevision: b["capabilityRevision"],
      pairingGeneration: b["pairingGeneration"],
    },
  };
}

/**
 * Exact field-by-field comparison of the client payload against the
 * authoritative binding (including the userId the route stamps in from
 * the authenticated session). Any mismatch is a foreign binding.
 */
function payloadMatchesAuthoritative(
  payload: WorkstationBindingPayload,
  authoritative: FullWorkstationBinding,
  userId: string,
): boolean {
  return (
    authoritative.userId === userId &&
    authoritative.instanceId === payload.instanceId &&
    authoritative.relayId === payload.relayId &&
    authoritative.desktopSessionId === payload.desktopSessionId &&
    authoritative.serverBindingId === payload.serverBindingId &&
    authoritative.pairingGeneration === payload.pairingGeneration &&
    authoritative.agentScope === payload.agentScope &&
    authoritative.profileId === payload.profileId &&
    authoritative.profileRevision === payload.profileRevision &&
    authoritative.grantIds.length === payload.grantIds.length &&
    authoritative.grantIds.every((g, i) => g === payload.grantIds[i]) &&
    authoritative.capabilityRevision === payload.capabilityRevision
  );
}

function receiptMatchesAuthoritative(
  claims: WorkstationStartupReceiptClaims,
  authoritative: FullWorkstationBinding,
  userId: string,
): boolean {
  return (
    claims.userId === userId &&
    claims.instanceId === authoritative.instanceId &&
    claims.serverBindingId === authoritative.serverBindingId &&
    claims.pairingGeneration === authoritative.pairingGeneration &&
    claims.profileId === authoritative.profileId &&
    claims.profileRevision === authoritative.profileRevision
  );
}

/**
 * Wrap an audit call so a thrown implementation cannot bubble up into
 * the route handler. Mirrors the `safeAudit` helper in
 * `routes/security.ts`: better to log + proceed than deny the caller
 * visibility into their own failure.
 */
async function safeAudit(
  auditor: WorkstationAccessAuditor,
  event: WorkstationAccessAuditEvent,
): Promise<void> {
  try {
    await auditor(event);
  } catch {
    // Swallow — forensic row missing, response proceeds.
  }
}

export function workstationAccessRoutes(
  app: FastifyInstance,
  deps: WorkstationAccessRouteDeps,
): void {
  const { pinProvider, getCapabilities, relayBindingProvider, profileActivationProvider, registry, auditEvent, startupReceiptSecret } = deps;
  const now = deps.now ?? (() => new Date());

  // A retained session alone is insufficient readiness: a replacement Relay
  // can still be offline, advertise stale revisions, or lose its profile/grants.
  // Use the same binding check as command admission without deleting consent
  // during a transient disconnect or claiming local filesystem authorization.
  app.get("/api/workstation-access/session", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) {
      return reply.status(401).send({ error: "Authentication required" });
    }
    const binding = resolveActiveWorkstationDispatchBinding({
      userId,
      currentFolder: "",
      sessionRegistry: registry,
      relayRegistry: deps.relayRegistry,
    });
    return reply.send({
      ok: true,
      session: binding === null ? null : {
        profileId: binding.profileId,
        profileRevision: binding.profileRevision,
      },
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/workstation-access/activate
  // -------------------------------------------------------------------------

  app.post<{
    Body: { pin?: unknown; startupReceipt?: unknown; binding?: unknown };
  }>("/api/workstation-access/activate", async (request, reply) => {
    // 1. Auth.
    const userId = request.sessionUserId;
    if (!userId) {
      return reply.status(401).send({ error: "Authentication required" });
    }
    const auditMeta: AuditMeta = {
      actorId: request.sessionActorId ?? userId,
      ip: request.ip,
      userAgent: request.headers["user-agent"],
    };

    // 2. Capability check — B3 (D418 Commit 1): activation requires ONLY
    // `use_workstation` (the D418 profile-activation capability).
    // `control_desktop` is no longer required here — it is an orthogonal
    // tool capability, not an activation gate. Rejected BEFORE the body
    // is read so a probing caller learns nothing about validation
    // behavior.
    const userCaps = await getCapabilities(userId);
    if (!userCaps.includes(CAP_USE_WORKSTATION)) {
      await safeAudit(auditEvent, {
        ts: now().toISOString(),
        actorId: auditMeta.actorId,
        ip: auditMeta.ip,
        userAgent: auditMeta.userAgent,
        kind: "workstation_session_denied",
        userId,
        relayId: "",
        desktopSessionId: "",
        serverBindingId: "",
        capabilityRevision: -1,
        denialCode: "ineligible_binding",
        route: ACTIVATE_ROUTE,
      });
      return reply.status(403).send({
        error: "capability_missing",
        capability: CAP_USE_WORKSTATION,
      });
    }

    const { pin, startupReceipt, binding } = request.body ?? {};

    // 3. Binding shape — validated BEFORE PIN so a bad payload does
    // not burn a verifyProof attempt.
    if (binding === undefined) {
      return reply.status(400).send({ error: "binding is required" });
    }
    const parsed = parseBindingPayload(binding);
    if (!parsed.ok) {
      return reply.status(400).send({ error: parsed.error });
    }
    const payload = parsed.payload;

    // 4. Exactly one proof is required. A PIN is the initial own-Human
    // ceremony; a startup receipt is its narrowly-bound repeat proof.
    const hasPin = isNonBlankString(pin);
    const hasStartupReceipt = isNonBlankString(startupReceipt);
    if (pin !== undefined && startupReceipt !== undefined) {
      return reply.status(400).send({
        error: "PIN and startupReceipt are mutually exclusive",
      });
    }
    if (hasPin === hasStartupReceipt) return reply.status(400).send({ error: "PIN is required" });

    // 5. Resolve the authoritative relay binding. The provider returns
    // null for a headless / unknown / unpaired relay — ineligible.
    let authoritative: FullWorkstationBinding | null;
    try {
      authoritative = await relayBindingProvider.resolve({
        userId,
        relayId: payload.relayId,
        desktopSessionId: payload.desktopSessionId,
        instanceId: payload.instanceId,
      });
    } catch {
      authoritative = null;
    }
    if (authoritative === null) {
      await safeAudit(auditEvent, {
        ts: now().toISOString(),
        actorId: auditMeta.actorId,
        ip: auditMeta.ip,
        userAgent: auditMeta.userAgent,
        kind: "workstation_session_denied",
        userId,
        relayId: payload.relayId,
        desktopSessionId: payload.desktopSessionId,
        serverBindingId: payload.serverBindingId,
        capabilityRevision: payload.capabilityRevision,
        denialCode: "ineligible_binding",
        route: ACTIVATE_ROUTE,
      });
      return reply.status(404).send({ error: "relay_binding_unavailable" });
    }

    // 6. Exact-match the client payload against the authoritative
    // binding. A client flag alone cannot activate.
    if (!payloadMatchesAuthoritative(payload, authoritative, userId)) {
      await safeAudit(auditEvent, {
        ts: now().toISOString(),
        actorId: auditMeta.actorId,
        ip: auditMeta.ip,
        userAgent: auditMeta.userAgent,
        kind: "workstation_session_denied",
        userId,
        relayId: payload.relayId,
        desktopSessionId: payload.desktopSessionId,
        serverBindingId: payload.serverBindingId,
        capabilityRevision: payload.capabilityRevision,
        denialCode: "foreign_binding",
        route: ACTIVATE_ROUTE,
      });
      return reply.status(409).send({ error: "foreign_binding" });
    }

    // 7. Verify only the submitted proof after all current authenticated,
    // capability, and live binding checks pass. Receipt verification never
    // substitutes for those checks or for registry activation below.
    if (hasPin) {
      try {
        const valid = await pinProvider.verifyProof(userId, pin);
        if (!valid) {
          await safeAudit(auditEvent, {
            ts: now().toISOString(),
            actorId: auditMeta.actorId,
            ip: auditMeta.ip,
            userAgent: auditMeta.userAgent,
            kind: "workstation_session_denied",
            userId,
            relayId: payload.relayId,
            desktopSessionId: payload.desktopSessionId,
            serverBindingId: payload.serverBindingId,
            capabilityRevision: payload.capabilityRevision,
            denialCode: "ineligible_binding",
            route: ACTIVATE_ROUTE,
          });
          return reply.status(401).send({ error: "Invalid PIN" });
        }
      } catch (err) {
        if (err instanceof LockoutError) {
          return reply.status(429).send({
            error: err.message,
            retryAfterMs: err.remainingMs,
          });
        }
        if (err instanceof InvalidPinError) {
          return reply.status(401).send({ error: "Invalid PIN" });
        }
        throw err;
      }
    } else {
      let secret: string;
      try {
        if (startupReceiptSecret === undefined) throw new Error("receipt secret unavailable");
        secret = startupReceiptSecret();
      } catch {
        return reply.status(503).send({ error: "startup_receipt_unavailable" });
      }
      const claims = verifyWorkstationStartupReceipt(secret, startupReceipt);
      if (claims === null || !receiptMatchesAuthoritative(claims, authoritative, userId)) {
        await safeAudit(auditEvent, {
          ts: now().toISOString(),
          actorId: auditMeta.actorId,
          ip: auditMeta.ip,
          userAgent: auditMeta.userAgent,
          kind: "workstation_session_denied",
          userId,
          relayId: payload.relayId,
          desktopSessionId: payload.desktopSessionId,
          serverBindingId: payload.serverBindingId,
          capabilityRevision: payload.capabilityRevision,
          denialCode: "ineligible_binding",
          route: ACTIVATE_ROUTE,
        });
        return reply.status(401).send({ error: "invalid_startup_receipt" });
      }
    }

    // 8. Hand the AUTHORITATIVE binding to the registry. The registry
    // enforces eligibility, monotonicity, narrowing/removal, and
    // server-switch semantics. Audit is emitted by the registry via
    // its own injected callback (the same `auditEvent` dep, wired at
    // construction) — but for route-side denial visibility we also
    // surface the result here.
    const result = registry.activate(authoritative, authoritative);
    if (!result.ok) {
      // Registry denials are audit-emitted inside the registry. The
      // route maps the denial code to an HTTP status.
      const status =
        result.denialCode === "stale_revision" || result.denialCode === "duplicate_active"
          ? 409
          : result.denialCode === "foreign_binding"
            ? 409
            : 400;
      return reply.status(status).send({
        error: result.denialCode,
        reason: result.reason,
      });
    }

    let mintedStartupReceipt: string | null = null;
    if (hasPin && startupReceiptSecret !== undefined) {
      try {
        mintedStartupReceipt = mintWorkstationStartupReceipt(startupReceiptSecret(), {
          userId: authoritative.userId,
          instanceId: authoritative.instanceId,
          serverBindingId: authoritative.serverBindingId,
          pairingGeneration: authoritative.pairingGeneration,
          profileId: authoritative.profileId,
          profileRevision: authoritative.profileRevision,
        });
      } catch {
        // Receipt minting is an optional post-success convenience. The
        // successful existing PIN activation remains authoritative.
      }
    }
    return reply.send({
      ok: true,
      outcome: result.outcome,
      session: result.session === null ? null : shapeSessionResponse(result.session),
      ...(mintedStartupReceipt === null ? {} : { startupReceipt: mintedStartupReceipt }),
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/workstation-access/activate-profile (phase 1)
  // -------------------------------------------------------------------------

  if (profileActivationProvider !== undefined) {
    app.post<{
      Body: {
        pin?: unknown;
        startupReceipt?: unknown;
        profileId?: unknown;
        profileRevision?: unknown;
        relayId?: unknown;
        desktopSessionId?: unknown;
        instanceId?: unknown;
      };
    }>("/api/workstation-access/activate-profile", async (request, reply) => {
      // 1. Auth.
      const userId = request.sessionUserId;
      if (!userId) {
        return reply.status(401).send({ error: "Authentication required" });
      }
      const auditMeta: AuditMeta = {
        actorId: request.sessionActorId ?? userId,
        ip: request.ip,
        userAgent: request.headers["user-agent"],
      };

      // 2. Capability check — B3 (D418 Commit 1): activation requires ONLY
      // `use_workstation`, identical gate to `/activate`.
      // `control_desktop` is no longer required here. Rejected BEFORE the
      // body is read so a probing caller learns nothing about validation
      // behavior.
      const userCaps = await getCapabilities(userId);
      if (!userCaps.includes(CAP_USE_WORKSTATION)) {
        await safeAudit(auditEvent, {
          ts: now().toISOString(),
          actorId: auditMeta.actorId,
          ip: auditMeta.ip,
          userAgent: auditMeta.userAgent,
          kind: "workstation_session_denied",
          userId,
          relayId: "",
          desktopSessionId: "",
          serverBindingId: "",
          capabilityRevision: -1,
          denialCode: "ineligible_binding",
          route: ACTIVATE_PROFILE_ROUTE,
        });
        return reply.status(403).send({
          error: "capability_missing",
          capability: CAP_USE_WORKSTATION,
        });
      }

      const {
        pin,
        startupReceipt,
        profileId,
        profileRevision,
        relayId,
        desktopSessionId,
        instanceId,
      } = request.body ?? {};

      // 3. Payload shape — validated BEFORE proof verification so a bad
      // payload does not burn a verifyProof attempt. Electron main supplies
      // only the profile selectors, relay binding evidence, and one proof; no
      // roots, env, executable rules, grants, subject, or profile payload are
      // accepted.
      if (!isNonBlankString(profileId)) {
        return reply.status(400).send({ error: "profileId is required" });
      }
      if (
        typeof profileRevision !== "number" ||
        !Number.isSafeInteger(profileRevision) ||
        profileRevision < 1
      ) {
        return reply.status(400).send({
          error: "profileRevision must be a positive safe integer (>= 1)",
        });
      }
      if (
        !isNonBlankString(relayId) ||
        !isNonBlankString(desktopSessionId) ||
        !isCanonicalNautiloInstanceId(instanceId)
      ) {
        return reply.status(400).send({
          error: "relayId, desktopSessionId are required; instanceId must be canonical (default \"\" or named)",
        });
      }

      // 4. Exactly one proof is required. The PIN is the initial own-Human
      // ceremony; the bounded receipt may repeat that ceremony only for the
      // same live profile binding.
      const hasPin = isNonBlankString(pin);
      const hasStartupReceipt = isNonBlankString(startupReceipt);
      if (pin !== undefined && startupReceipt !== undefined) {
        return reply.status(400).send({
          error: "PIN and startupReceipt are mutually exclusive",
        });
      }
      if (hasPin === hasStartupReceipt) {
        return reply.status(400).send({ error: "PIN or startupReceipt is required" });
      }

      // 5. Resolve the authoritative binding. The provider derives the
      // authority-bearing fields (userId, instanceId, relayId,
      // desktopSessionId, serverBindingId, agentScope, grantIds,
      // capabilityRevision) from the relay registry's retained grant
      // snapshot + capability revision, and stamps the client's profile
      // selectors (profileId + profileRevision) in. null = ineligible.
      let authoritative: FullWorkstationBinding | null;
      try {
        authoritative = await profileActivationProvider.resolve({
          userId,
          relayId,
          desktopSessionId,
          instanceId,
          profileId,
          profileRevision,
        });
      } catch {
        authoritative = null;
      }
      if (authoritative === null) {
        await safeAudit(auditEvent, {
          ts: now().toISOString(),
          actorId: auditMeta.actorId,
          ip: auditMeta.ip,
          userAgent: auditMeta.userAgent,
          kind: "workstation_session_denied",
          userId,
          relayId,
          desktopSessionId,
          serverBindingId: "",
          capabilityRevision: -1,
          denialCode: "ineligible_binding",
          route: ACTIVATE_PROFILE_ROUTE,
        });
        return reply.status(404).send({ error: "relay_binding_unavailable" });
      }

      // 6. Verify only the submitted proof. The receipt is not authority:
      // this route already reran auth, capability, payload-shape, and live
      // authoritative profile-binding resolution before accepting it.
      if (hasPin) {
        try {
          const valid = await pinProvider.verifyProof(userId, pin);
          if (!valid) {
            await safeAudit(auditEvent, {
              ts: now().toISOString(),
              actorId: auditMeta.actorId,
              ip: auditMeta.ip,
              userAgent: auditMeta.userAgent,
              kind: "workstation_session_denied",
              userId,
              relayId: authoritative.relayId,
              desktopSessionId: authoritative.desktopSessionId,
              serverBindingId: authoritative.serverBindingId,
              capabilityRevision: authoritative.capabilityRevision,
              denialCode: "ineligible_binding",
              route: ACTIVATE_PROFILE_ROUTE,
            });
            return reply.status(401).send({ error: "Invalid PIN" });
          }
        } catch (err) {
          if (err instanceof LockoutError) {
            return reply.status(429).send({
              error: err.message,
              retryAfterMs: err.remainingMs,
            });
          }
          if (err instanceof InvalidPinError) {
            return reply.status(401).send({ error: "Invalid PIN" });
          }
          throw err;
        }
      } else {
        let secret: string;
        try {
          if (startupReceiptSecret === undefined) throw new Error("receipt secret unavailable");
          secret = startupReceiptSecret();
        } catch {
          return reply.status(503).send({ error: "startup_receipt_unavailable" });
        }
        const claims = verifyWorkstationStartupReceipt(secret, startupReceipt);
        if (claims === null || !receiptMatchesAuthoritative(claims, authoritative, userId)) {
          await safeAudit(auditEvent, {
            ts: now().toISOString(),
            actorId: auditMeta.actorId,
            ip: auditMeta.ip,
            userAgent: auditMeta.userAgent,
            kind: "workstation_session_denied",
            userId,
            relayId: authoritative.relayId,
            desktopSessionId: authoritative.desktopSessionId,
            serverBindingId: authoritative.serverBindingId,
            capabilityRevision: authoritative.capabilityRevision,
            denialCode: "ineligible_binding",
            route: ACTIVATE_PROFILE_ROUTE,
          });
          return reply.status(401).send({ error: "invalid_startup_receipt" });
        }
      }

      // 7. Issue only a short-lived opaque one-time preauthorization.
      // Crucially this is NOT an active Full Workstation session: zero grants
      // and capabilityRevision 0 are valid baselines at this phase.
      const pending = registry.issuePendingAuthorization({
        userId: authoritative.userId,
        instanceId: authoritative.instanceId,
        relayId: authoritative.relayId,
        desktopSessionId: authoritative.desktopSessionId,
        serverBindingId: authoritative.serverBindingId,
        pairingGeneration: authoritative.pairingGeneration,
        agentScope: authoritative.agentScope,
        profileId: authoritative.profileId,
        profileRevision: authoritative.profileRevision,
        baselineCapabilityRevision: authoritative.capabilityRevision,
      });
      return reply.send({
        ok: true,
        authorization: pending.ticket,
        expiresAt: pending.expiresAt,
      });
    });

    // Phase 2 completion: ticket only. Auth/capability are rechecked, then
    // the current normal profile snapshot must prove the exact compiled
    // profile, non-empty policy-pack grants, and a revision bump.
    app.post<{ Body: { authorization?: unknown } }>(
      COMPLETE_PROFILE_ROUTE.replace("POST ", ""),
      async (request, reply) => {
        const userId = request.sessionUserId;
        if (!userId) return reply.status(401).send({ error: "Authentication required" });
        // B3 (D418 Commit 1): completion requires ONLY `use_workstation`.
        const caps = await getCapabilities(userId);
        if (!caps.includes(CAP_USE_WORKSTATION)) {
          return reply.status(403).send({
            error: "capability_missing",
            capability: CAP_USE_WORKSTATION,
          });
        }
        const authorization = request.body?.authorization;
        if (!isNonBlankString(authorization)) {
          return reply.status(400).send({ error: "authorization is required" });
        }
        // The registry owns ticket metadata. Resolve through the normal
        // profile-snapshot provider only after extracting the ticket binding.
        const pending = registry.peekPendingAuthorization(authorization);
        if (pending === null || pending.userId !== userId) {
          return reply.status(401).send({ error: "invalid_pending_authorization" });
        }
        let authoritative: FullWorkstationBinding | null;
        try {
          authoritative = await relayBindingProvider.resolve({
            userId,
            relayId: pending.relayId,
            desktopSessionId: pending.desktopSessionId,
            instanceId: pending.instanceId,
          });
        } catch {
          authoritative = null;
        }
        if (authoritative === null) {
          return reply.status(409).send({ error: "advertised_binding_unavailable" });
        }
        const result = registry.completePendingAuthorization(authorization, authoritative);
        if (!result.ok) {
          return reply.status(409).send({ error: result.denialCode, reason: result.reason });
        }
        let mintedStartupReceipt: string | null = null;
        if (startupReceiptSecret !== undefined) {
          try {
            mintedStartupReceipt = mintWorkstationStartupReceipt(startupReceiptSecret(), {
              userId: authoritative.userId,
              instanceId: authoritative.instanceId,
              serverBindingId: authoritative.serverBindingId,
              pairingGeneration: authoritative.pairingGeneration,
              profileId: authoritative.profileId,
              profileRevision: authoritative.profileRevision,
            });
          } catch {
            // Successful activation remains authoritative when the optional
            // startup receipt secret is unavailable.
          }
        }
        return reply.send({
          ok: true,
          outcome: result.outcome,
          session: result.session === null ? null : shapeSessionResponse(result.session),
          ...(mintedStartupReceipt === null ? {} : { startupReceipt: mintedStartupReceipt }),
        });
      },
    );
  }

  // -------------------------------------------------------------------------
  // POST /api/workstation-access/disable
  // -------------------------------------------------------------------------

  app.post<{
    Body: Record<string, never> | undefined;
  }>("/api/workstation-access/disable", async (request, reply) => {
    // 1. Auth ONLY. B3 (D418 Commit 1): disable is authenticated, user-bound,
    //    idempotent, and INDEPENDENT of all current capabilities. No
    //    capability check runs here, so a user whose `use_workstation`
    //    (or any other capability) is revoked mid-session can still disable
    //    their own session. No PIN is required for disable. No route-side
    //    denial audit is emitted; the registry emits its own disable /
    //    not_active transition audit via its injected callback.
    const userId = request.sessionUserId;
    if (!userId) {
      return reply.status(401).send({ error: "Authentication required" });
    }

    // 2. User-bound + idempotent disable. The registry is the fail-closed
    //    authority for the server-side session; it keys the transition on
    //    `userId` and is idempotent (no active session ⇒ `not_active`).
    const result = registry.disable(userId);
    return reply.send({
      ok: true,
      outcome: result.outcome,
      session: result.session === null ? null : shapeSessionResponse(result.session),
    });
  });
}

/**
 * Shape a stored session for the HTTP response. Strips nothing the
 * registry doesn't already expose publicly, but centralizes the
 * response shape so the route never accidentally leaks future
 * internal-only fields. No PINs / command output / secrets are present.
 */
function shapeSessionResponse(session: FullWorkstationSession): {
  userId: string;
  instanceId: string;
  relayId: string;
  desktopSessionId: string;
  serverBindingId: string;
  agentScope: typeof FULL_WORKSTATION_AGENT_SCOPE;
  profileId: string;
  profileRevision: number;
  grantIds: readonly string[];
  capabilityRevision: number;
  pairingGeneration: string;
  activatedAt: string;
} {
  return {
    userId: session.userId,
    instanceId: session.instanceId,
    relayId: session.relayId,
    desktopSessionId: session.desktopSessionId,
    serverBindingId: session.serverBindingId,
    agentScope: session.agentScope,
    profileId: session.profileId,
    profileRevision: session.profileRevision,
    grantIds: session.grantIds,
    capabilityRevision: session.capabilityRevision,
    pairingGeneration: session.pairingGeneration,
    activatedAt: session.activatedAt,
  };
}

/**
 * Convenience factory for tests + the future app wiring: builds a
 * registry pre-wired with the supplied audit callback + clock so the
 * route's `registry` and `auditEvent` deps stay in sync (the registry
 * emits the transition/denial events; the route emits the request-side
 * denial events through the same callback).
 */
export function createWorkstationAccessRegistry(
  options: FullWorkstationSessionRegistryOptions,
): InMemoryWorkstationSessionRegistry {
  // Imported lazily through the type re-export above; the concrete
  // class is imported at the top of the module.
  return new InMemoryWorkstationSessionRegistry(options);
}

export type { FullWorkstationSession };

// ---------------------------------------------------------------------------
// D418 Commit 3 — Workstation execution-admission DECISION SEAM.
//
// This is the server-side integration of the pure
// `resolveWorkstationAdmission` policy (in `@nautilo/trust`) with the LIVE
// session evidence source: the shared `InMemoryWorkstationSessionRegistry`
// that `app.ts` constructs and injects into this route's `registry` dep. The
// post-model approval resolver (in `packages/agent/src/nodes/post-model.ts`,
// wired by the orchestrator in a separate slice) supplies the tool call +
// the turn's actor / room / two-path context; the factory below supplies the
// pieces only the live server holds — the active authenticated Full
// Workstation session, the admitted + revalidated `WorkstationDispatchPlan`,
// and the execution class — and returns the admission decision.
//
// Contract:
//   - Reads `registry.get(userId)` once. No mutation, no execution, no
//     sandbox/profile change, no dispatch. Pure with respect to the registry
//     read (the plan admission is the one side effect, owned here).
//   - Fail-closed: `registry.get(userId) === null` ⇒ `session: null` ⇒ the
//     pure policy returns `none` (no_active_session). The caller leaves the
//     normal approval logic intact, so ordinary D375 Auto-Approve
//     (`ask → auto`, client-side) and the dock / PIN / block path run
//     unchanged when Full Mode is off.
//   - `auto` is returned ONLY when the pure policy proves the dispatch is a
//     `profile_bound_sandbox` operation under an exact active session pinned
//     by a live admitted + revalidated plan with local containment
//     confirmed. Real Workstation escape surfaces and typed brokers stop
//     inside the pure policy, independent of the session. Critical /
//     elevation scanning remains an independent hard stop in the post-model
//     verb map (`block` is never overridable), NOT in this seam.
//   - The seam does NOT copy the active session into a fake dispatch
//     binding. The exact binding proof is the `exactPlan` flag, set only
//     when a `WorkstationDispatchPlan` was admitted AND revalidated against
//     the bound relay's live fingerprint (which already proves subject /
//     desktop session / capability revision / profile binding match).
// ---------------------------------------------------------------------------

/**
 * Map a live `FullWorkstationSession` registry row to the pure-engine
 * `FullWorkstationSessionEvidence` shape. `null` when no session is active.
 * Re-declared here only to keep the mapping co-located with the seam; the
 * evidence type itself lives in `@nautilo/trust`.
 */
function sessionEvidence(
  live: FullWorkstationSession | null,
): FullWorkstationSessionEvidence | null {
  if (live === null) return null;
  return {
    userId: live.userId,
    instanceId: live.instanceId,
    relayId: live.relayId,
    desktopSessionId: live.desktopSessionId,
    serverBindingId: live.serverBindingId,
    agentScope: live.agentScope,
    profileId: live.profileId,
    profileRevision: live.profileRevision,
    grantIds: live.grantIds,
    capabilityRevision: live.capabilityRevision,
    activatedAt: live.activatedAt,
  };
}

// ---------------------------------------------------------------------------
// D418 production wiring — RelayBindingProvider backed by the
// authenticated InMemoryRelayRegistry. Lives in this owned route module
// so the binding-derivation contract stays co-located with the route
// that consumes it. app.ts constructs one and injects it as the route's
// `relayBindingProvider` dep.
// ---------------------------------------------------------------------------

/**
 * D418 — production `RelayBindingProvider`. Derives the authoritative
 * Full Workstation binding ONLY from the authenticated relay registry's
 * retained state for a connected relay:
 *
 *   - relay owner user      ← `registry.getUserId(relayId)`
 *   - desktopSessionId      ← `registry.getDesktopSessionId(relayId)`
 *   - capabilityRevision    ← `registry.getCapabilityRevision(relayId)`
 *   - grant snapshot        ← `registry.getDesktopFilesystemGrantSnapshot(relayId)`
 *   - profile snapshot      ← `registry.getWorkstationProfileSnapshot(relayId)`
 *
 * `serverBindingId` is the ONE field not derivable from the registry:
 * it is the stable server-side server identity. It is sourced from
 * the existing `@nautilo/config::getServerHostname()` — the federated
 * hostname of the resolved Nautilo instance — which is stable for the
 * lifetime of a server install and changes exactly on a server switch
 * (a different install / instance). It is NOT a per-pair nonce, so a
 * re-pair within the same server keeps the same `serverBindingId`.
 *
 * Re-pair / app-restart invalidation is NOT wired through this id and
 * is NOT wired through the relay registry's `onUnregister` hook. A
 * transient relay socket disconnect must NOT clear a Full Workstation
 * session (a reconnect with the same `desktopSessionId` resumes it), so
 * `onUnregister` is intentionally left unwired to session invalidation
 * in production. The app-restart seam that DOES invalidate is the relay
 * registry's `onDesktopSessionReplaced` hook: when the same
 * `(relayId, userId)` re-registers with a DIFFERENT non-empty
 * `desktopSessionId` (a new Electron main-process launch), app.ts wires
 * the hook to `InMemoryWorkstationSessionRegistry.invalidateForRelayBinding`
 * against the previous `(userId, serverBindingId, relayId,
 * desktopSessionId)`. Generating an explicit per-pair `serverBindingId`
 * (a re-pair nonce distinct from the server hostname) remains tracked as
 * future work; it is not what this field is today.
 *
 * Lifecycle: tied to the running server process's resolved instance;
 * recomputed on a server restart that changes `NAUTILO_INSTANCE_ID`,
 * which is itself a server switch and the correct trigger for
 * invalidating prior sessions.
 *
 * Ineligibility (returns `null` — the route maps this to a truthful
 * 404 `relay_binding_unavailable`, NEVER fabricating a binding):
 *   - relay not connected / unknown
 *   - registry owner user missing or does not match the authenticated
 *     caller's `userId` (foreign relay)
 *   - headless relay (no `desktopSessionId` advertised)
 *   - registry `desktopSessionId` does not match the client-supplied one
 *   - `capabilityRevision` missing
 *   - missing advisory grant snapshot OR profile snapshot
 *   - grant snapshot `instanceId` empty or not matching the client input
 *   - grant snapshot `agentScope` not `all_owned_agents`
 *   - profile snapshot `grantIds` empty (a profile bound to no grants
 *     is not an eligible Full Workstation surface)
 *   - mismatched profile/grant state: a profile-bound grant id not
 *     present in the grant snapshot's active grant ids
 *
 * No PIN, roots, env, token, or raw profile data is read or emitted.
 */
export interface RelayRegistryBindingProviderOptions {
  readonly relayRegistry: InMemoryRelayRegistry;
  /**
   * Stable server-side pairing identity. Defaults to
   * `getServerHostname()`; injectable so tests can pin a deterministic
   * value and assert exact-match behavior against the client payload.
   */
  readonly serverBindingId?: string;
}

export function createRelayRegistryBindingProvider(
  options: RelayRegistryBindingProviderOptions,
): RelayBindingProvider {
  const { relayRegistry } = options;
  const serverBindingId = options.serverBindingId ?? getServerHostname();
  return {
    resolve(input): Promise<FullWorkstationBinding | null> {
      const { relayId, userId, desktopSessionId, instanceId } = input;

      // Relay must be connected + owned by the authenticated caller.
      const relayUserId = relayRegistry.getUserId(relayId);
      if (relayUserId === null || relayUserId !== userId) return Promise.resolve(null);

      // Headless relays are ineligible by design.
      const relayDesktopSessionId = relayRegistry.getDesktopSessionId(relayId);
      if (relayDesktopSessionId === null || relayDesktopSessionId === "") {
        return Promise.resolve(null);
      }
      if (relayDesktopSessionId !== desktopSessionId) return Promise.resolve(null);

      const capabilityRevision = relayRegistry.getCapabilityRevision(relayId);
      if (capabilityRevision === null) return Promise.resolve(null);

      // D418 Commit 2 — the server-derived pairing generation (validated
      // relay-token row id). Missing/empty ⇒ ineligible: a Full Workstation
      // session never binds to a relay that never proved a pairing generation.
      const pairingGeneration = relayRegistry.getPairingGeneration(relayId);
      if (pairingGeneration === null) return Promise.resolve(null);

      const grantSnapshot = relayRegistry.getDesktopFilesystemGrantSnapshot(relayId);
      if (grantSnapshot === null) return Promise.resolve(null);
      const profileSnapshot = relayRegistry.getWorkstationProfileSnapshot(relayId);
      if (profileSnapshot === null) return Promise.resolve(null);

      // instanceId is carried by the grant snapshot; the client input
      // must match the registry's retained grant snapshot instanceId.
      // D418 default-instance: an empty snapshot instanceId ("") is the
      // canonical default instance and is a valid exact-match target, so
      // only the exact-equality check below gates eligibility.
      if (grantSnapshot.instanceId !== instanceId) return Promise.resolve(null);
      if (grantSnapshot.agentScope !== FULL_WORKSTATION_AGENT_SCOPE) return Promise.resolve(null);

      // Reject mismatched profile/grant state: every profile-bound grant
      // id must be present in the active grant snapshot.
      if (profileSnapshot.grantIds.length === 0) return Promise.resolve(null);
      const activeGrantIds = new Set(
        grantSnapshot.grants.map((g) => g.id),
      );
      if (!profileSnapshot.grantIds.every((g) => activeGrantIds.has(g))) {
        return Promise.resolve(null);
      }

      const binding: FullWorkstationBinding = {
        userId,
        instanceId: grantSnapshot.instanceId,
        relayId,
        desktopSessionId: relayDesktopSessionId,
        serverBindingId,
        pairingGeneration,
        agentScope: FULL_WORKSTATION_AGENT_SCOPE,
        profileId: profileSnapshot.profileId,
        profileRevision: profileSnapshot.profileRevision,
        grantIds: [...profileSnapshot.grantIds],
        capabilityRevision,
      };
      return Promise.resolve(binding);
    },
  };
}

// ---------------------------------------------------------------------------
// D418 — production `ProfileActivationProvider` for the profile-selector
// activation seam (`POST /api/workstation-access/activate-profile`).
// Co-located with the route that consumes it. Unlike the binding provider
// above, this derives the binding from the relay registry's GRANT snapshot
// only (no profile snapshot required), so it works for the FIRST activation
// of an approved stored profile before any compiled profile snapshot has
// been advertised. The client-supplied profileId + profileRevision SELECTORS
// are stamped into the binding; every authority-bearing field is server-
// derived.
// ---------------------------------------------------------------------------

export interface RelayRegistryProfileActivationProviderOptions {
  readonly relayRegistry: InMemoryRelayRegistry;
  /**
   * Stable server-side pairing identity. Defaults to `getServerHostname()`;
   * injectable so tests can pin a deterministic value and assert
   * exact-match behavior against the client payload.
   */
  readonly serverBindingId?: string;
}

/**
 * D418 — production `ProfileActivationProvider`. Derives the authoritative
 * Full Workstation binding for a profile-selector activation from the
 * relay registry's retained state for a connected relay:
 *
 *   - relay owner user      ← `registry.getUserId(relayId)`
 *   - desktopSessionId      ← `registry.getDesktopSessionId(relayId)`
 *   - capabilityRevision    ← `registry.getCapabilityRevision(relayId)`
 *   - grant snapshot        ← `registry.getDesktopFilesystemGrantSnapshot(relayId)`
 *   - profileId             ← client selector (trusted desktop main)
 *   - profileRevision       ← client selector (trusted desktop main)
 *   - grantIds              ← grant snapshot's active grant ids
 *   - serverBindingId       ← `getServerHostname()` (stable server identity)
 *
 * Ineligibility (returns `null` — the route maps this to a truthful 404
 * `relay_binding_unavailable`, NEVER fabricating a binding):
 *   - relay not connected / unknown
 *   - registry owner user missing or does not match the authenticated
 *     caller's `userId` (foreign relay)
 *   - headless relay (no `desktopSessionId` advertised)
 *   - registry `desktopSessionId` does not match the client-supplied one
 *   - `capabilityRevision` missing or not a positive (>= 1) revision
 *   - missing grant snapshot
 *   - grant snapshot `instanceId` empty or not matching the client input
 *   - grant snapshot `agentScope` not `all_owned_agents`
 *   - grant snapshot has NO active grants (a Full Workstation session
 *     requires a non-empty grant surface; the registry rejects an empty
 *     grantIds list for a fresh activate)
 *
 * The client's `profileId` + `profileRevision` are NOT verified against
 * server-side profile state — the server has no stored-profile registry
 * (a Workstation Profile is desktop-local admin configuration). They are
 * selectors supplied by the trusted Electron main process (never the
 * renderer), and the desktop main verifies them against its owned profile
 * store before calling this route. No PIN, roots, env, token, or raw
 * profile data is read or emitted.
 */
export function createRelayRegistryProfileActivationProvider(
  options: RelayRegistryProfileActivationProviderOptions,
): ProfileActivationProvider {
  const { relayRegistry } = options;
  const serverBindingId = options.serverBindingId ?? getServerHostname();
  return {
    resolve(input): Promise<FullWorkstationBinding | null> {
      const { relayId, userId, desktopSessionId, instanceId, profileId, profileRevision } = input;

      // Relay must be connected + owned by the authenticated caller.
      const relayUserId = relayRegistry.getUserId(relayId);
      if (relayUserId === null || relayUserId !== userId) return Promise.resolve(null);

      // Headless relays are ineligible by design.
      const relayDesktopSessionId = relayRegistry.getDesktopSessionId(relayId);
      if (relayDesktopSessionId === null || relayDesktopSessionId === "") {
        return Promise.resolve(null);
      }
      if (relayDesktopSessionId !== desktopSessionId) return Promise.resolve(null);

      // This is only a preauthorization baseline: revision 0 is valid here.
      // Completion requires the post-compile advertised revision to increase.
      const capabilityRevision = relayRegistry.getCapabilityRevision(relayId);
      if (capabilityRevision === null || capabilityRevision < 0) {
        return Promise.resolve(null);
      }

      // D418 Commit 2 — the server-derived pairing generation (validated
      // relay-token row id). Missing/empty ⇒ ineligible.
      const pairingGeneration = relayRegistry.getPairingGeneration(relayId);
      if (pairingGeneration === null) return Promise.resolve(null);

      const grantSnapshot = relayRegistry.getDesktopFilesystemGrantSnapshot(relayId);
      if (grantSnapshot === null) return Promise.resolve(null);

      // instanceId is carried by the grant snapshot; the client input
      // must match the registry's retained grant snapshot instanceId.
      // D418 default-instance: an empty snapshot instanceId ("") is the
      // canonical default instance and is a valid exact-match target, so
      // only the exact-equality check below gates eligibility.
      if (grantSnapshot.instanceId !== instanceId) return Promise.resolve(null);
      if (grantSnapshot.agentScope !== FULL_WORKSTATION_AGENT_SCOPE) return Promise.resolve(null);

      const activeGrantIds = grantSnapshot.grants.map((g) => g.id);

      const binding: FullWorkstationBinding = {
        userId,
        instanceId: grantSnapshot.instanceId,
        relayId,
        desktopSessionId: relayDesktopSessionId,
        serverBindingId,
        pairingGeneration,
        agentScope: FULL_WORKSTATION_AGENT_SCOPE,
        profileId,
        profileRevision,
        grantIds: [...activeGrantIds],
        capabilityRevision,
      };
      return Promise.resolve(binding);
    },
  };
}

// ---------------------------------------------------------------------------
// D418 Commit 3 — production Workstation execution-admission RESOLVER for
// the live post-model approval path.
//
// `app.ts` constructs one of these (bound to the shared
// `InMemoryWorkstationSessionRegistry` + `InMemoryRelayRegistry` +
// `InMemoryWorkstationDispatchPlanRegistry`) and installs it on
// `defaultPostModelDeps.resolveWorkstationApprovalOverride` so every graph
// built downstream (foreground `langgraphExecutor`, fork executor,
// subagent runs, resume paths) consults it in post-model Pass 2. The
// post-model calls it with the authenticated subject + the tool call + the
// turn's actor / room / two-path context; this resolver supplies the pieces
// only the live server holds — the active Full Workstation session, the
// admitted + revalidated `WorkstationDispatchPlan`, and the execution
// class — then forwards the slim admission contract to the pure
// {@link resolveWorkstationAdmission} policy.
//
// D418 task 3.1.2 — ADMISSION SLICE. Before the DECISION, when an active
// Full Workstation session exists, the resolver selects the EXACT
// active-session-bound relay (`live.relayId`), re-validates it against the
// live relay registry's retained fingerprint, and admits ONE transient
// `WorkstationDispatchPlan` keyed by `toolCall.id` binding tool-call id +
// user + relay + instance + desktop session + server binding + profile /
// revision + grant ids + capability revision + execution class. The tools
// node consumes that plan at dispatch time and pins the relay to
// `plan.relayId` (re-validated again at the dispatch seam); it must NOT
// choose a different first-eligible relay after approval. The plan is
// admission metadata only — it never replaces local Electron grant
// authority and never widens `allowedRoots` (it carries no roots).
//
// D418 Commit 4 — DECISION. The factory admits an eligible `run_shell`
// profile-bound-sandbox ATTEMPT when active session + exact plan +
// `profile_bound_sandbox` + `run_shell` hold. A STATIC `scanCommand` refuses
// only critical / elevation (no boundedness / timeout / dynamic-path /
// network-intent / OS / MCP / caller-boolean inspection). The scan is
// independent defense-in-depth, NOT containment evidence. Local Electron
// shell binding, sandbox construction, grant reload, protected-path, and OS
// enforcement remain fail-closed execution authority; the server makes no
// preflight claim that a sandbox exists. The resolver does NOT fabricate
// caller-authored profile/path/network/OS/boundedness/MCP/escape evidence
// and does NOT copy the active session into a fake dispatch binding; the
// exact binding proof is the `exactPlan` flag (a live admitted + revalidated
// plan). Real Workstation escape surfaces and typed brokers stop inside the
// pure policy (fail-closed), independent of the session.
//
// The plan ADMISSION is independent of the override DECISION: the plan is
// admitted whenever an active session + eligible bound relay exists, so the
// relay pinning takes effect through the normal-approval path even when the
// decision is `none` (e.g. a critical `run_shell` the slim scan refused).
//
// Contract guarantees preserved regardless of evidence completeness:
//   - `none` ⇒ normal approval intact. The post-model treats `none` as
//     "leave the prompt alone".
//   - A bare D375-style client Auto-Approve flag never reaches this
//     resolver: the post-model skips the consultation for anonymous turns
//     (no `state.userId`), and a plan is admitted ONLY from the LIVE
//     server-side session — a client flag alone cannot create a session
//     (activation requires fresh PIN proof + an authoritative relay
//     binding) and therefore can never self-authorize a plan.
//   - `block` (critical) is never overridable: the post-model does not
//     consult the resolver for `block` verbs, and the independent slim
//     `scanCommand` refuses critical / elevation so a future caller cannot
//     widen admission.
//   - Audit / trace: the post-model emits a grep-able
//     `workstation_full_mode_auto_approved` log line on every `auto`
//     decision. The resolver ALSO emits a redacted runtime-owned
//     `workstation_admission` audit ROW for EVERY consultation (auto or
//     none) via the injected `audit` sink — carrying execution class +
//     outcome/reason + tool/tool-call id + OPAQUE session/plan binding
//     identifiers, NEVER command text / output / roots / paths / env /
//     token / PIN / grant contents. `none` is no longer silent: every
//     consultation is auditable.
// ---------------------------------------------------------------------------

/**
 * The per-dispatch request this resolver accepts. Structurally identical to
 * `packages/agent/src/nodes/post-model.ts::WorkstationApprovalOverrideRequest`
 * so the function returned by {@link createWorkstationApprovalOverrideResolver}
 * is assignable to `PostModelDeps["resolveWorkstationApprovalOverride"]`
 * without a cross-package type import (the agent barrel does not re-export
 * the request type). The two definitions MUST stay in sync.
 *
 * `clientMeta` carries the request-side audit envelope (ip / userAgent) from
 * the executing turn's `securityAuditClientMeta`; the resolver stamps it onto
 * the redacted `workstation_admission` audit row. It is `null` for background
 * / resume-only paths that omit it (the audit sink falls back to an empty ip).
 */
export interface WorkstationOverrideResolverRequest {
  readonly userId: string;
  readonly toolCall: ToolCall;
  readonly actorId: string;
  readonly roomId: string;
  readonly currentFolder: string;
  readonly workspacePath: string;
  readonly requiredRelayId?: string;
  readonly clientMeta?: { readonly ip: string; readonly userAgent?: string | undefined } | null;
}

/**
 * D418/D486 — execution-class classification lives in the small pure module
 * below. D486 adds one exact opt-in: run_shell + execution=workstation maps
 * to `real_workstation`. Routine calls may skip command-shape approval, but
 * Electron's exact local consent remains final authority. Everything else
 * remains `profile_bound_sandbox`.
 */
/**
 * D418 task 3.1.2 — read the live relay-binding fingerprint for a relay id
 * from the relay registry, for `WorkstationDispatchPlan` admission
 * re-validation. Each field is `null` when the relay is not connected or has
 * not advertised that piece of binding state. The profile id / revision come
 * from the relay's advisory Workstation Profile binding snapshot; the user /
 * desktop session / capability revision come from the registry's retained
 * registration state.
 */
function readRelayFingerprint(
  relayRegistry: InMemoryRelayRegistry,
  relayId: string,
): WorkstationRelayFingerprint {
  const profile = relayRegistry.getWorkstationProfileSnapshot(relayId);
  const grant = relayRegistry.getDesktopFilesystemGrantSnapshot(relayId);
  return {
    userId: relayRegistry.getUserId(relayId),
    desktopSessionId: relayRegistry.getDesktopSessionId(relayId),
    capabilityRevision: relayRegistry.getCapabilityRevision(relayId),
    profileId: profile?.profileId ?? null,
    profileRevision: profile?.profileRevision ?? null,
    // D418 Commit 2 — the live relay's server-derived pairing generation. A
    // null value (relay gone / never carried one) fails re-validation closed;
    // a non-null value that drifted from the plan's pairing generation fails
    // closed so a re-paired relay cannot consume a prior-generation plan.
    pairingGeneration: relayRegistry.getPairingGeneration(relayId),
    // D440 Phase 1 — live grant-store + protected-policy revisions. Absent
    // (null) when the relay did not advertise the corresponding snapshot;
    // revalidation skips the check when either side is absent.
    grantRevision: grant?.revision ?? null,
    protectedPolicyVersion: profile?.protectedPolicyVersion ?? null,
  };
}

/**
 * D418 task 3.1.2 / Commit 3 — construct the live Workstation execution-
 * admission resolver bound to `deps.registry` (active sessions),
 * `deps.relayRegistry` (live relay binding fingerprints for plan admission
 * re-validation), and `deps.planRegistry` (the transient
 * `WorkstationDispatchPlan` store). Returns a function the server installs
 * on `defaultPostModelDeps.resolveWorkstationApprovalOverride`; the
 * post-model calls it once per `ask` / `prove_it` / `auto`-anomaly
 * candidate. See the block header above for the admission + fail-closed
 * decision contract.
 */
export function createWorkstationApprovalOverrideResolver(deps: {
  readonly registry: InMemoryWorkstationSessionRegistry;
  readonly relayRegistry: InMemoryRelayRegistry;
  readonly planRegistry: InMemoryWorkstationDispatchPlanRegistry;
  /**
   * D418 Commit 4 — redacted `workstation_admission` audit sink. Invoked
   * once per consultation with the admission decision (auto or none). Fire-
   * and-forget: a throw is swallowed + warned so a forensic row missing
   * never widens approval or blocks the turn. Production wires this to the
   * security-audit-log writer; unit tests inject a spy.
   */
  readonly audit?: (event: WorkstationAdmissionAuditEvent) => void;
  readonly now?: () => Date;
}): (request: WorkstationOverrideResolverRequest) => WorkstationAdmissionDecision {
  const { registry, relayRegistry, planRegistry } = deps;
  const audit = deps.audit;
  const now = deps.now ?? (() => new Date());
  return (request) => {
    const live = registry.get(request.userId);
    const executionClass = classifyWorkstationExecutionClass(
      request.toolCall.name,
      request.toolCall.args,
    );
    const toolName = request.toolCall.name;
    const toolCallId = request.toolCall.id ?? "";

    // -----------------------------------------------------------------
    // D418 task 3.1.2 — ADMISSION. When an active Full Workstation session
    // exists, select the EXACT active-session-bound relay (`live.relayId`)
    // and admit ONE transient `WorkstationDispatchPlan` keyed by
    // `toolCall.id`. The plan pins the relay the tools node must dispatch
    // to; it is re-validated against the live relay registry here (admission
    // seam) AND again in the tools node (dispatch seam), so a binding that
    // drifted between admission and dispatch still fails closed at the
    // dispatch seam. No active session ⇒ no plan (Full Mode no-op); a bare
    // client Auto-Approve flag cannot reach here (post-model skips anonymous
    // turns, and a session requires fresh-PIN activation).
    // -----------------------------------------------------------------
    let exactPlan = false;
    let admittedPlan: WorkstationDispatchPlan | null = null;
    if (
      live !== null &&
      (executionClass === "profile_bound_sandbox" || executionClass === "typed_broker") &&
      (!request.requiredRelayId || live.relayId === request.requiredRelayId)
    ) {
      if (toolCallId.length > 0 && request.currentFolder.length > 0) {
        const binding = resolveActiveWorkstationDispatchBinding({
          userId: request.userId,
          currentFolder: request.currentFolder,
          sessionRegistry: registry,
          relayRegistry,
        });
        // Use the canonical same-authority binding resolver here as well as at
        // dispatch-time readmission. A relay capability revision may advance
        // when Electron refreshes Current Folder/capabilities without changing
        // the active Human/Desktop/profile/grant authority. Pinning the plan to
        // the older activation revision made a valid Ready-to-work session
        // unusable until it was manually toggled off/on. The resolver accepts
        // only monotonic revision advance and still fails closed on rollback or
        // any owner/Desktop/pairing/profile/grant mismatch.
        if (
          binding !== null &&
          (!request.requiredRelayId || binding.relayId === request.requiredRelayId)
        ) {
          const plan: WorkstationDispatchPlan = {
            toolCallId,
            ...binding,
            executionClass,
            admittedAt: now().toISOString(),
            // D440 Phase 1 — revision-coherent Current Folder / grant-store
            // revision / protected-policy version. The Current Folder is pinned
            // from the per-dispatch request; the grant + protected-policy
            // revisions are sourced from the live relay's advisory snapshots
            // so a drift between admission and dispatch is detectable. These
            // are non-secret binding metadata; the plan never carries roots.
            currentFolder: request.currentFolder,
          };
          const fingerprint = readRelayFingerprint(relayRegistry, binding.relayId);
          const revalidation = revalidatePlanAgainstRelay(plan, fingerprint);
          // Admit the plan ONLY when the bound relay is still the exact bound
          // relay. A stale/gone binding ⇒ NO plan admitted (Full Mode no-op for
          // this dispatch; the tools node then uses the normal first-eligible
          // path, exactly as pre-D418). The plan never carries roots and never
          // widens `allowedRoots` — it is admission metadata only. `exactPlan`
          // is the binding proof the pure engine requires for `auto`.
          if (revalidation.ok) {
            planRegistry.admit(plan);
            exactPlan = true;
            admittedPlan = plan;
          }
        }
      }
    }

    // -----------------------------------------------------------------
    // D418 Commit 4 — INDEPENDENT STATIC SCAN REFUSAL. This is NOT
    // containment evidence and does NOT assert that Electron created an
    // active sandbox. It refuses only critical destruction / elevation for
    // a run_shell attempt; it never inspects boundedness, timeout, dynamic
    // paths, network intent, OS, MCP, or caller-authored booleans. Electron-
    // local shell binding, sandbox construction, grants, protected paths,
    // and OS enforcement remain fail-closed at execution.
    //
    // The scan runs at a FIXED `standard` level so the admission's
    // critical/elevation refusal is independent of the server's configured
    // security posture (Full Workstation Mode is a separate, narrower,
    // session-bound authority surface, NOT a posture change — see
    // `resolveWorkstationAdmission`). Only `critical` and `high` severities
    // (destruction / elevation) refuse `auto`; medium and lower do not
    // prove or disprove local containment. Non-run_shell tools remain `none`
    // through the pure admission contract's `run_shell_required` gate.
    // -----------------------------------------------------------------
    const isRunShell = toolName === "run_shell";
    const criticalOrElevationScanHit =
      requiresNormalWorkstationCommandApproval({
        toolName,
        executionClass,
        args: request.toolCall.args,
      });

    // -----------------------------------------------------------------
    // D418 Commit 4 — DECISION. The independent scan refusal returns `none`;
    // otherwise forward the slim admission contract to the pure
    // `resolveWorkstationAdmission` policy. The seam does NOT copy the active
    // session into a fake dispatch binding; `exactPlan` is the exact binding
    // proof. `block` (critical) is never overridable: the post-model does not
    // consult the resolver for `block` verbs, and the scan independently
    // refuses critical/elevation so a future caller cannot widen admission.
    // Real Workstation routine calls proceed only to Electron's independent
    // local-consent gate; typed brokers stop inside the pure policy.
    // -----------------------------------------------------------------
    const evidence: WorkstationAdmissionEvidence = {
      executionClass,
      session: sessionEvidence(live),
      exactPlan,
      tool: { name: toolName, operation: isRunShell ? "execute" : null },
    };
    const decision: WorkstationAdmissionDecision = criticalOrElevationScanHit
      ? {
          override: "none",
          executionClass,
          reason: "critical_or_elevation_command",
          detail: "static command scan refused critical destruction or elevation; Electron-local enforcement remains authoritative at execution",
        }
      : resolveWorkstationAdmission(evidence);

    // -----------------------------------------------------------------
    // D418 Commit 4 — emit the redacted runtime-owned `workstation_admission`
    // audit row for EVERY consultation (auto or none). The row carries
    // execution class + outcome/reason + tool/tool-call id + OPAQUE
    // session/plan binding identifiers — NEVER command text, output, roots,
    // paths, env, token, PIN, or grant contents. Fire-and-forget: a throw
    // is swallowed + warned so a forensic row missing never blocks the turn
    // nor widens approval.
    // -----------------------------------------------------------------
    if (audit !== undefined) {
      const reason: WorkstationAdmissionReason | "auto_admitted" =
        decision.override === "auto" ? "auto_admitted" : decision.reason;
      const event: WorkstationAdmissionAuditEvent = {
        ts: now().toISOString(),
        actorId: request.actorId,
        ip: request.clientMeta?.ip ?? "",
        userAgent: request.clientMeta?.userAgent,
        kind: "workstation_admission",
        userId: request.userId,
        toolName,
        toolCallId,
        executionClass: decision.executionClass,
        outcome: decision.override,
        reason,
        relayId: live?.relayId ?? "",
        desktopSessionId: live?.desktopSessionId ?? "",
        serverBindingId: live?.serverBindingId ?? "",
        pairingGeneration: live?.pairingGeneration ?? "",
        profileId: live?.profileId ?? "",
        profileRevision: live?.profileRevision ?? 0,
        capabilityRevision:
          admittedPlan?.capabilityRevision ?? live?.capabilityRevision ?? 0,
      };
      try {
        audit(event);
      } catch (err) {
        warn(
          `[workstation-access] admission audit emit failed for ${toolName}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return decision;
  };
}
