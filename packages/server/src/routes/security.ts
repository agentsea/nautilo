/**
 * Server security posture API. D060 Sprint 1 G5.3 (ship plan v3 §5.3).
 *
 *   GET  /api/security/posture   — read current deployment_mode +
 *                                   security_level + caller's
 *                                   Capability set. Auth required.
 *                                   No Capability gate: every
 *                                   authenticated actor sees their
 *                                   slice, so the Settings UI can
 *                                   correctly gate the `[Change
 *                                   posture]` button.
 *
 *   PUT  /api/security/posture   — mutate deployment_mode,
 *                                   security_level, and/or
 *                                   network_policy. Requires
 *                                   `manage_server_security`
 *                                   Capability + PIN re-verify.
 *                                   Body: `{deploymentMode?,
 *                                   securityLevel?,
 *                                   networkPolicy?, pin}`.
 *
 * This file deliberately does NOT read `process.env` for policy
 * fields (G5.6 lockdown) — all posture state comes from the
 * sectioned `security` block in the user's config, resolved via
 * `@nautilo/config::resolveServerPosture()`.
 *
 * **Persistence is a dep** (`mutatePosture`). G5.3.c ships the
 * route logic + validation + PIN + Capability check; G5.3.d fills
 * in the atomic config-file writer + JSONL audit log + WS broadcast
 * by passing a real implementation into `securityRoutes()`. The
 * route body never touches disk directly.
 */

import type { FastifyInstance } from "fastify";
import { homedir } from "node:os";
import { join } from "node:path";
import { warn } from "@nautilo/logger";
import {
  DeploymentModeSchema,
  NetworkPolicySchema,
  SecurityLevelSchema,
  defaultNetworkPolicyForDeploymentMode,
  resolveNautiloRuntimePaths,
  resolveServerPosture,
  type DeploymentMode,
  type SecurityLevel,
  type ServerPosture,
  type NetworkPolicy,
} from "@nautilo/config";
import { detectBackend } from "@nautilo/sandbox";
import {
  CAP_MANAGE_UNCONTAINED_HOST_COMMANDS,
  CAP_MANAGE_SERVER_SECURITY,
  InvalidPinError,
  LockoutError,
  listCommandApprovals,
  projectUserRbac,
  revokeCommandApproval,
  SERVER_ROLE_RANK,
  type ChallengeProvider,
  type RbacProjection,
  type ServerRoleSlug,
} from "@nautilo/trust";

import {
  readSecurityAuditLog,
  type SecurityAuditEvent,
  type SecurityAuditEventKind,
} from "../lib/security-audit-log";
import {
  InvalidMessageDeletionQuery,
  listMessageDeletionReceipts,
  type MessageDeletionReceiptQuery,
} from "../lib/message-deletion-receipts";

/**
 * Metadata the posture mutator needs for the audit log row
 * (G5.3.d): WHO changed the posture, from WHERE, with WHAT client.
 */
export interface PostureMutationMeta {
  readonly actorId: string;
  readonly ip: string;
  readonly userAgent: string | undefined;
  readonly prev: ServerPosture & {
    readonly allowUncontainedHostCommands: boolean;
  };
  readonly next: ServerPosture & {
    readonly allowUncontainedHostCommands: boolean;
  };
}

/**
 * Posture-mutator dependency. The route calls this AFTER auth +
 * Capability + PIN succeed. Implementations must: (a) persist the
 * new posture (ship plan step 5); (b) write a `posture_changed`
 * audit row (§5.8); (c) broadcast `policy.changed` over the WS
 * bus so live clients re-read. G5.3.c ships the interface + an
 * in-memory default used by tests; G5.3.d ships the real
 * filesystem-backed implementation.
 */
export type PostureMutator = (meta: PostureMutationMeta) => Promise<void>;

/**
 * Audit dependency for the non-mutation branches: `capability_check_failed`
 * (403), `pin_check_failed` (401 invalid or 429 lockout). Ship plan
 * §5.8 lists both as mandatory event types. Separated from the
 * mutator because these paths never reach `setConfigOverrides` /
 * `policy.changed`; they just need a forensic trail.
 *
 * Contract: an implementation MAY throw. The route does NOT let a
 * thrown auditor prevent the 4xx response from reaching the caller
 * (ship plan §5.8: better to log a warn and return the 4xx than
 * deny the caller visibility into their own failure). The route
 * enforces this contract at every call site via `safeAudit()` below
 * — regardless of what the injected implementation does.
 *
 * PR-017 MINOR #6 — previously the contract lived in the docstring
 * only; `await auditEvent(...)` at 4 call sites with no try/catch
 * meant any future test injection that threw (or any unhappy-path
 * contract violation in production) would surface as a 500 to the
 * caller. Hardened below: every audit call is wrapped in the
 * module-local `safeAudit` helper that catches + warns and always
 * returns, so the route's invariant "4xx visibility is never
 * denied by audit failure" is enforced at the SITE, not the
 * contract.
 */
export type SecurityAuditor = (event: SecurityAuditEvent) => Promise<void>;

export interface PostureBackendSummary {
  readonly kind: "bubblewrap" | "sandbox-exec" | "passthrough";
  readonly procSupported?: boolean;
}

export interface PostureAccessSummary {
  readonly writablePaths: readonly string[];
  readonly readOnlyPaths: readonly string[];
}

let backendSummaryPromise: Promise<PostureBackendSummary> | null = null;

async function resolveBackendSummary(): Promise<PostureBackendSummary> {
  backendSummaryPromise ??= detectBackend().then((backend) => {
    if (backend.kind === "bubblewrap") {
      return {
        kind: backend.kind,
        procSupported: backend.procSupported,
      };
    }
    if (backend.kind === "sandbox-exec") return { kind: backend.kind };
    return { kind: "passthrough" };
  });
  return backendSummaryPromise;
}

function resolveActorRole(
  policyRole: string | undefined,
  session: { readonly ownerId: string; readonly userId: string } | null,
): string {
  if (policyRole !== undefined) return policyRole;
  // Pre-M052 fallback path — only fires when policyContext is unset
  // (test harnesses, early boot). With a null session under Logto
  // mode we have no other heuristic, so default to "guest" — the
  // caller will gate on the explicit role.
  if (!session) return "guest";
  return session.userId === session.ownerId ? "owner" : "guest";
}

function resolvePostureAccessSummary(
  posture: ServerPosture,
): PostureAccessSummary {
  const paths = resolveNautiloRuntimePaths();
  const userHome = homedir();
  const downloads = join(userHome, "Downloads");

  if (posture.deploymentMode === "server") {
    return {
      writablePaths: [paths.homeRootDir],
      readOnlyPaths: [],
    };
  }

  if (posture.deploymentMode === "desktop-locked") {
    return {
      writablePaths: [paths.workspaceDir],
      readOnlyPaths: [],
    };
  }

  return {
    writablePaths: [paths.workspaceDir, downloads],
    readOnlyPaths: [userHome],
  };
}

const AUDIT_EVENT_KINDS: ReadonlySet<SecurityAuditEventKind> = new Set([
  "moderation_action",
  "moderation_policy_changed",
  "enrollment_review_decided",
  "posture_changed",
  "capability_check_failed",
  "pin_check_failed",
  "pin_enrolled",
  "approval_granted",
  "approval_denied",
  "standing_approval_revoked",
  "connection_vault_tool",
  "mcp_server_config",
  "uncontained_host_commands_activated",
  "uncontained_host_commands_disabled",
  "uncontained_host_commands_invalidated",
  "uncontained_host_commands_status_invalidated",
  "uncontained_host_commands_denied",
  "uncontained_host_commands_dispatch_admitted",
  "uncontained_host_commands_dispatch_denied",
]);

function redactNetworkPolicy(policy: NetworkPolicy): NetworkPolicy {
  if (policy.mode !== "proxy-allowlist") return policy;
  return {
    mode: "proxy-allowlist",
    allow: [],
    ...(policy.defaultPort !== undefined ? { defaultPort: policy.defaultPort } : {}),
  };
}

function parseKinds(raw: string | undefined): SecurityAuditEventKind[] | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const kinds: SecurityAuditEventKind[] = [];
  for (const part of raw.split(",")) {
    const kind = part.trim();
    if (AUDIT_EVENT_KINDS.has(kind as SecurityAuditEventKind)) {
      kinds.push(kind as SecurityAuditEventKind);
    }
  }
  return kinds.length > 0 ? kinds : undefined;
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Wrap an audit call so a thrown implementation cannot bubble up
 * into the route handler. Swallows the error and emits a warn with
 * the event kind + original message so an operator can correlate
 * the missing row with the surrounding request.
 */
async function safeAudit(
  auditor: SecurityAuditor,
  event: SecurityAuditEvent,
): Promise<void> {
  try {
    await auditor(event);
  } catch (err) {
    warn(
      `[security-audit] auditor threw on ${event.kind} — ` +
        `forensic row missing but 4xx response proceeds: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export interface SecurityRouteDeps {
  // Typed as the ChallengeProvider interface (not the concrete
  // PinChallengeProvider) so tests can inject a minimal fake without
  // standing up a real DB. Production wires a real PinChallengeProvider
  // in app.ts; the interface is satisfied identically.
  readonly pinProvider: ChallengeProvider;
  readonly mutatePosture: PostureMutator;
  readonly auditEvent: SecurityAuditor;
  /**
   * Caller Capability lookup — D060 Sprint 1 G5.5. Production wires
   * `@nautilo/trust::getUserCapabilities`. Keyed on `userId` from the
   * trust preHandler (`request.sessionUserId`).
   */
  readonly getCapabilities: (userId: string) => Promise<readonly string[]>;
  readonly listMessageDeletionReceipts?: typeof listMessageDeletionReceipts;
  readonly auditLogPath?: string;
  readonly now?: () => Date;
  /**
   * Posture backend probe — injectable so unit tests don't spawn the
   * real `/usr/bin/sandbox-exec` / `bwrap` subprocess via
   * `detectBackend()`. Defaults to the production cached probe. Under
   * heavy parallel load (lefthook pre-push pipeline) the real probe
   * has been observed to never settle, hanging tests at the 60s bun
   * timeout instead of the 5s `execFile` timeout. Tests pass a stub
   * (e.g. `() => Promise.resolve({ kind: "passthrough" })`) to stay
   * truly hermetic.
   */
  readonly backendSummary?: () => Promise<PostureBackendSummary>;
  /**
   * D538 default-off policy source. Production reads the posture sidecar on
   * each request; older test compositions omit it and therefore fail closed.
   */
  readonly getAllowUncontainedHostCommands?: () => boolean;
  /**
   * D538's bounded, process-local controller. It is supplied only by the
   * normal server composition after its authenticated relay registry exists.
   * Tests that do not exercise this feature may omit it; the endpoints then
   * fail closed instead of manufacturing desktop authority.
   */
  readonly uncontainedHostCommands?: UncontainedHostCommandsController;
}

const UNCONTAINED_HOST_COMMANDS_GROUP = "uncontained_host_commands_grantees";
const UNCONTAINED_HOST_COMMANDS_ROLE = "uncontained_host_commands_grantee";

export interface UncontainedHostCommandsRelayBinding {
  readonly userId: string;
  readonly serverBindingId: string;
  readonly relayId: string;
  readonly desktopSessionId: string;
  readonly pairingGeneration: string;
  readonly capabilityRevision: number;
}

export interface UncontainedHostCommandSession extends UncontainedHostCommandsRelayBinding {
  readonly activatedAt: string;
}

/**
 * The abort controller is process-local session state, never an API payload or
 * durable authority record. Keeping it adjacent to the exact activation gives
 * an admitted dispatch a stable fence even if the same Human activates again.
 */
interface ActiveUncontainedHostCommandSession extends UncontainedHostCommandSession {
  readonly abortController: AbortController;
}

type UncontainedHostCommandsReason =
  | "policy_disabled"
  | "grant_missing"
  | "role_floor_missing"
  | "relay_binding_unavailable"
  | "session_binding_mismatch"
  | "session_inactive"
  | "pin_invalid"
  | "pin_locked_out";

type UncontainedHostCommandsEligibility =
  | { readonly ok: true; readonly binding: UncontainedHostCommandsRelayBinding }
  | { readonly ok: false; readonly reason: UncontainedHostCommandsReason };

export interface UncontainedHostCommandsControllerDeps {
  readonly pinProvider: ChallengeProvider;
  readonly getAllowUncontainedHostCommands: () => boolean;
  readonly getLiveRelayBinding: (input: {
    readonly userId: string;
    readonly relayId: string;
    readonly desktopSessionId: string;
  }) => UncontainedHostCommandsRelayBinding | null;
  readonly auditEvent: SecurityAuditor;
  /** Test seam only; production always re-reads the canonical projection. */
  readonly getRbac?: (userId: string) => Promise<RbacProjection>;
  readonly now?: () => Date;
}

/**
 * D538's whole activation store. One Human may hold one short-lived entry,
 * solely in process memory. It deliberately has no persistence, renewal,
 * readmission, folder, profile, ticket, or RBAC-generation state.
 */
export class UncontainedHostCommandsController {
  readonly #sessions = new Map<string, ActiveUncontainedHostCommandSession>();
  readonly #pinProvider: ChallengeProvider;
  readonly #getAllowUncontainedHostCommands: () => boolean;
  readonly #getLiveRelayBinding: UncontainedHostCommandsControllerDeps["getLiveRelayBinding"];
  readonly #auditEvent: SecurityAuditor;
  readonly #getRbac: (userId: string) => Promise<RbacProjection>;
  readonly #now: () => Date;

  constructor(deps: UncontainedHostCommandsControllerDeps) {
    this.#pinProvider = deps.pinProvider;
    this.#getAllowUncontainedHostCommands = deps.getAllowUncontainedHostCommands;
    this.#getLiveRelayBinding = deps.getLiveRelayBinding;
    this.#auditEvent = deps.auditEvent;
    this.#getRbac = deps.getRbac ?? projectUserRbac;
    this.#now = deps.now ?? (() => new Date());
  }

  private async audit(input: {
    readonly kind:
      | "uncontained_host_commands_activated"
      | "uncontained_host_commands_disabled"
      | "uncontained_host_commands_invalidated"
      | "uncontained_host_commands_status_invalidated"
      | "uncontained_host_commands_denied"
      | "uncontained_host_commands_dispatch_admitted"
      | "uncontained_host_commands_dispatch_denied";
    readonly actorId: string;
    readonly userId: string;
    readonly ip?: string;
    readonly userAgent?: string | undefined;
    readonly route?: string;
    readonly reason?: string;
    readonly binding?: UncontainedHostCommandsRelayBinding | UncontainedHostCommandSession;
  }): Promise<void> {
    await safeAudit(this.#auditEvent, {
      kind: input.kind,
      ts: this.#now().toISOString(),
      actorId: input.actorId,
      ip: input.ip ?? "",
      userAgent: input.userAgent,
      userId: input.userId,
      ...(input.binding !== undefined ? {
        relayId: input.binding.relayId,
        desktopSessionId: input.binding.desktopSessionId,
        serverBindingId: input.binding.serverBindingId,
        capabilityRevision: input.binding.capabilityRevision,
      } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.route !== undefined ? { route: input.route } : {}),
    });
  }

  private async eligibility(input: {
    readonly userId: string;
    readonly relayId: string;
    readonly desktopSessionId: string;
  }): Promise<UncontainedHostCommandsEligibility> {
    if (!this.#getAllowUncontainedHostCommands()) {
      return { ok: false, reason: "policy_disabled" };
    }
    const rbac = await this.#getRbac(input.userId);
    const hasExactGrant = rbac.groupChips.some(
      (chip) => chip.type === UNCONTAINED_HOST_COMMANDS_GROUP &&
        chip.roleSlug === UNCONTAINED_HOST_COMMANDS_ROLE,
    );
    if (!hasExactGrant) return { ok: false, reason: "grant_missing" };
    const highestRole = rbac.highestRole;
    if (
      highestRole === null ||
      !Object.hasOwn(SERVER_ROLE_RANK, highestRole) ||
      SERVER_ROLE_RANK[highestRole as ServerRoleSlug] > SERVER_ROLE_RANK.superuser
    ) {
      return { ok: false, reason: "role_floor_missing" };
    }
    const binding = this.#getLiveRelayBinding(input);
    return binding === null
      ? { ok: false, reason: "relay_binding_unavailable" }
      : { ok: true, binding };
  }

  private bindingMatches(
    session: UncontainedHostCommandSession,
    binding: UncontainedHostCommandsRelayBinding,
  ): boolean {
    return session.userId === binding.userId &&
      session.serverBindingId === binding.serverBindingId &&
      session.relayId === binding.relayId &&
      session.desktopSessionId === binding.desktopSessionId &&
      session.pairingGeneration === binding.pairingGeneration &&
      session.capabilityRevision === binding.capabilityRevision;
  }

  /**
   * The sole session-ending seam. Delete before aborting so no observer can
   * turn cancellation into continued authority; the retained signal then
   * fences an already-admitted dispatch and reaches the existing relay cancel
   * path. The method owns no queue, durable record, or recovery behavior.
   */
  private async revokeSession(input: {
    readonly userId: string;
    readonly session: ActiveUncontainedHostCommandSession;
    readonly kind:
      | "uncontained_host_commands_disabled"
      | "uncontained_host_commands_invalidated"
      | "uncontained_host_commands_status_invalidated";
    readonly actorId: string;
    readonly reason?: string;
    readonly ip?: string;
    readonly userAgent?: string | undefined;
    readonly route?: string;
  }): Promise<boolean> {
    if (this.#sessions.get(input.userId) !== input.session) return false;
    this.#sessions.delete(input.userId);
    input.session.abortController.abort();
    await this.audit({
      kind: input.kind,
      actorId: input.actorId,
      userId: input.userId,
      ...(input.ip !== undefined ? { ip: input.ip } : {}),
      ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
      ...(input.route !== undefined ? { route: input.route } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      binding: input.session,
    });
    return true;
  }

  async status(input: {
    readonly userId: string;
    readonly actorId: string;
    readonly relayId: string;
    readonly desktopSessionId: string;
    readonly ip: string;
    readonly userAgent: string | undefined;
  }): Promise<{
    readonly active: boolean;
    readonly eligible: boolean;
    readonly reason: UncontainedHostCommandsReason | null;
    readonly activatedAt: string | null;
  }> {
    const session = this.#sessions.get(input.userId) ?? null;
    const eligibility = await this.eligibility(input);
    if (!eligibility.ok) {
      // Policy / grant / role loss is user-wide and necessarily revokes the
      // one stored Human session. A missing binding for THIS requesting
      // Desktop is different: it must not let an unavailable/foreign desktop
      // tear down another still-live exact Desktop session.
      const storedBindingIsStale = session !== null && (
        eligibility.reason !== "relay_binding_unavailable" ||
        (() => {
          const storedLive = this.#getLiveRelayBinding(session);
          return storedLive === null || !this.bindingMatches(session, storedLive);
        })()
      );
      if (storedBindingIsStale && session !== null) {
        await this.revokeSession({
          kind: "uncontained_host_commands_status_invalidated",
          actorId: input.actorId,
          userId: input.userId,
          ip: input.ip,
          userAgent: input.userAgent,
          route: "GET /api/security/uncontained-host-commands/session",
          reason: eligibility.reason,
          session,
        });
      }
      return { active: false, eligible: false, reason: eligibility.reason, activatedAt: null };
    }
    if (session === null) {
      return { active: false, eligible: true, reason: null, activatedAt: null };
    }
    if (!this.bindingMatches(session, eligibility.binding)) {
      // A caller asking after another Desktop's valid activation must not clear
      // that other session. Only clear when the stored session itself is now
      // stale against its own current relay identity.
      const storedLive = this.#getLiveRelayBinding(session);
      if (storedLive === null || !this.bindingMatches(session, storedLive)) {
        await this.revokeSession({
          kind: "uncontained_host_commands_status_invalidated",
          actorId: input.actorId,
          userId: input.userId,
          ip: input.ip,
          userAgent: input.userAgent,
          route: "GET /api/security/uncontained-host-commands/session",
          reason: "session_binding_mismatch",
          session,
        });
      }
      return { active: false, eligible: true, reason: "session_binding_mismatch", activatedAt: null };
    }
    return { active: true, eligible: true, reason: null, activatedAt: session.activatedAt };
  }

  async activate(input: {
    readonly userId: string;
    readonly actorId: string;
    readonly pin: string;
    readonly relayId: string;
    readonly desktopSessionId: string;
    readonly ip: string;
    readonly userAgent: string | undefined;
  }): Promise<
    | { readonly ok: true; readonly session: UncontainedHostCommandSession }
    | { readonly ok: false; readonly status: 401 | 403 | 429; readonly reason: UncontainedHostCommandsReason; readonly retryAfterMs?: number }
  > {
    const initial = await this.eligibility(input);
    if (!initial.ok) {
      await this.audit({ kind: "uncontained_host_commands_denied", ...input, reason: initial.reason });
      return { ok: false, status: 403, reason: initial.reason };
    }
    try {
      const verified = await this.#pinProvider.verifyProof(input.userId, input.pin);
      if (!verified) {
        await this.audit({ kind: "uncontained_host_commands_denied", ...input, reason: "pin_invalid", binding: initial.binding });
        return { ok: false, status: 401, reason: "pin_invalid" };
      }
    } catch (err) {
      if (err instanceof LockoutError) {
        await this.audit({ kind: "uncontained_host_commands_denied", ...input, reason: "pin_locked_out", binding: initial.binding });
        return { ok: false, status: 429, reason: "pin_locked_out", retryAfterMs: err.remainingMs };
      }
      if (err instanceof InvalidPinError) {
        await this.audit({ kind: "uncontained_host_commands_denied", ...input, reason: "pin_invalid", binding: initial.binding });
        return { ok: false, status: 401, reason: "pin_invalid" };
      }
      throw err;
    }
    // Re-read policy, grant, role floor and the server-owned relay tuple after
    // proving the PIN; no renderer fact survives this boundary as authority.
    const rechecked = await this.eligibility(input);
    if (!rechecked.ok || !this.bindingMatches({ ...initial.binding, activatedAt: "" }, rechecked.binding)) {
      const reason = rechecked.ok ? "relay_binding_unavailable" : rechecked.reason;
      await this.audit({ kind: "uncontained_host_commands_denied", ...input, reason, binding: initial.binding });
      return { ok: false, status: 403, reason };
    }
    const previous = this.#sessions.get(input.userId);
    if (previous !== undefined) {
      await this.revokeSession({
        userId: input.userId,
        session: previous,
        kind: "uncontained_host_commands_invalidated",
        actorId: input.actorId,
        reason: "activation_replaced",
        ip: input.ip,
        userAgent: input.userAgent,
        route: "POST /api/security/uncontained-host-commands/activate",
      });
    }
    const session: ActiveUncontainedHostCommandSession = {
      ...rechecked.binding,
      activatedAt: this.#now().toISOString(),
      abortController: new AbortController(),
    };
    this.#sessions.set(input.userId, session);
    await this.audit({ kind: "uncontained_host_commands_activated", ...input, binding: session });
    return { ok: true, session };
  }

  async disable(input: {
    readonly userId: string;
    readonly actorId: string;
    readonly relayId: string;
    readonly desktopSessionId: string;
    readonly ip: string;
    readonly userAgent: string | undefined;
  }): Promise<boolean> {
    const session = this.#sessions.get(input.userId);
    if (
      session === undefined ||
      session.relayId !== input.relayId ||
      session.desktopSessionId !== input.desktopSessionId
    ) return false;
    return await this.revokeSession({
      userId: input.userId,
      session,
      kind: "uncontained_host_commands_disabled",
      actorId: input.actorId,
      ip: input.ip,
      userAgent: input.userAgent,
      route: "POST /api/security/uncontained-host-commands/disable",
    });
  }

  /**
   * D538's only live lane decision. It deliberately re-runs the same policy,
   * protected grant, canonical role floor, live relay binding, and exact
   * in-memory activation check immediately before relay dispatch. The caller's
   * foreground tuple is useful only to name the exact session to compare; it
   * never survives this method as authority or persistence.
   */
  async resolveDispatch(input: {
    readonly userId: string;
    readonly actorId: string;
    readonly relayId: string;
    readonly desktopSessionId: string;
    readonly pairingGeneration: string;
    readonly toolCallId: string;
    readonly ip?: string;
    readonly userAgent?: string | undefined;
  }): Promise<
    | {
      readonly admitted: true;
      readonly executionClass: "real_workstation";
      /** Exact process-local activation fence; never sent to a client. */
      readonly activationSignal: AbortSignal;
    }
    | { readonly admitted: false; readonly reason: UncontainedHostCommandsReason }
  > {
    const eligibility = await this.eligibility(input);
    const session = this.#sessions.get(input.userId) ?? null;
    const reject = async (
      reason: UncontainedHostCommandsReason,
      binding: UncontainedHostCommandsRelayBinding | UncontainedHostCommandSession | undefined,
    ) => {
      await this.audit({
        kind: "uncontained_host_commands_dispatch_denied",
        actorId: input.actorId,
        userId: input.userId,
        ip: input.ip ?? "",
        userAgent: input.userAgent,
        route: "relay:dispatch/run_shell",
        reason,
        ...(binding !== undefined ? { binding } : {}),
      });
      return { admitted: false as const, reason };
    };

    if (!eligibility.ok) return await reject(eligibility.reason, session ?? undefined);
    if (session === null) return await reject("session_inactive", eligibility.binding);
    if (
      input.pairingGeneration !== eligibility.binding.pairingGeneration ||
      !this.bindingMatches(session, eligibility.binding)
    ) {
      return await reject("session_binding_mismatch", session);
    }
    await this.audit({
      kind: "uncontained_host_commands_dispatch_admitted",
      actorId: input.actorId,
      userId: input.userId,
      ip: input.ip ?? "",
      userAgent: input.userAgent,
      route: "relay:dispatch/run_shell",
      binding: session,
    });
    return {
      admitted: true,
      executionClass: "real_workstation",
      activationSignal: session.abortController.signal,
    };
  }

  /**
   * Prepare one event-stable post-commit revoker for a membership removal.
   * Classification is about the exact target membership, not the session or
   * the rest of the Human's groups: every D538 grant group and every canonical
   * Superuser-or-above group independently prepares revocation. The closure
   * revokes whichever activation is current after the successful mutation,
   * including one created or replaced while the DB write was in flight. A
   * projection failure likewise prepares fail-closed revocation; unrelated
   * groups return no closure.
   */
  async prepareMembershipRemoval(input: {
    readonly userId: string;
    readonly groupId: string;
    readonly actorId: string;
  }): Promise<(() => Promise<boolean>) | null> {
    const revokeCurrentActivation = async (): Promise<boolean> => {
      const session = this.#sessions.get(input.userId);
      if (session === undefined) return false;
      return await this.revokeSession({
        userId: input.userId,
        session,
        kind: "uncontained_host_commands_invalidated",
        actorId: input.actorId,
        reason: "rbac_membership_removed",
        route: "RBAC membership mutation",
      });
    };
    try {
      const projection = await this.#getRbac(input.userId);
      const target = projection.groupChips.find((chip) => chip.id === input.groupId);
      if (target === undefined) return null;
      const isExactGrant = target.type === UNCONTAINED_HOST_COMMANDS_GROUP &&
        target.roleSlug === UNCONTAINED_HOST_COMMANDS_ROLE;
      const isRoleFloorGroup = Object.hasOwn(SERVER_ROLE_RANK, target.roleSlug) &&
        SERVER_ROLE_RANK[target.roleSlug as ServerRoleSlug] <= SERVER_ROLE_RANK.superuser;
      return isExactGrant || isRoleFloorGroup ? revokeCurrentActivation : null;
    } catch {
      return revokeCurrentActivation;
    }
  }

  /** Policy disable is server-wide but still ends only the active in-memory sessions. */
  async invalidateAllForPolicyDisable(input: { readonly actorId: string }): Promise<void> {
    for (const [userId, session] of [...this.#sessions]) {
      await this.revokeSession({
        userId,
        session,
        kind: "uncontained_host_commands_invalidated",
        actorId: input.actorId,
        reason: "policy_disabled",
        route: "PUT /api/security/posture",
      });
    }
  }

  async invalidateForRelayBinding(input: {
    readonly userId: string;
    readonly relayId: string;
    readonly desktopSessionId?: string | null;
    readonly pairingGeneration?: string;
    readonly capabilityRevision?: number;
    readonly reason: string;
  }): Promise<void> {
    const session = this.#sessions.get(input.userId);
    if (
      session === undefined ||
      session.relayId !== input.relayId ||
      (input.desktopSessionId !== undefined && input.desktopSessionId !== null && session.desktopSessionId !== input.desktopSessionId) ||
      (input.pairingGeneration !== undefined && session.pairingGeneration !== input.pairingGeneration) ||
      (input.capabilityRevision !== undefined && session.capabilityRevision !== input.capabilityRevision)
    ) return;
    await this.revokeSession({
      userId: input.userId,
      session,
      kind: "uncontained_host_commands_invalidated",
      actorId: input.userId,
      reason: input.reason,
      route: "relay lifecycle",
    });
  }
}

export function securityRoutes(app: FastifyInstance, deps: SecurityRouteDeps) {
  const {
    pinProvider,
    mutatePosture,
    auditEvent,
    getCapabilities,
    auditLogPath,
  } = deps;
  const now = deps.now ?? ((): Date => new Date());
  const probeBackend = deps.backendSummary ?? resolveBackendSummary;
  const getAllowUncontainedHostCommands =
    deps.getAllowUncontainedHostCommands ?? (() => false);
  const uncontainedHostCommands = deps.uncontainedHostCommands;
  const PUT_ROUTE = "PUT /api/security/posture";

  // -------------------------------------------------------------------------
  // GET /api/security/posture — read current server posture
  // -------------------------------------------------------------------------

  app.get("/api/security/posture", async (request, reply) => {
    // M052/M055 — `request.sessionUserId` is set by the trust preHandler
    // for Logto-issued JWTs (after JIT user provisioning). Routes used
    // to gate on a local-only `sessionStore.validateSession(token)`
    // lookup, which 401-d every Logto-authenticated request — the
    // workbench's PostureProvider then surfaced the security level as
    // "unavailable" even for signed-in owners.
    //
    // GET is intentionally open to all authenticated callers (guests
    // included): per-role redaction below hides path details from
    // anyone without `manage_server_security`. Only the PUT route
    // (below) requires the cap + PIN re-verify.
    const userId = request.sessionUserId;
    if (!userId) {
      return reply.status(401).send({ error: "Authentication required" });
    }

    const posture = resolveServerPosture();

    // Capability array for the caller. D060 Sprint 1 G5.5: real
    // Capability store lookup (was owner-actor heuristic pre-G5.5).
    // Ship plan §5.3: GET is unrestricted (every authenticated actor
    // sees their slice), but the UI uses `capabilities` to gate the
    // mutation affordance. Sprint 3 returns the full cap slug list so
    // the posture modal can show the caller's governance slice. The
    // PUT route below performs the manage_server_security gate for
    // mutation. Keyed on users.id post-M043.
    const capabilities = await getCapabilities(userId);
    const access = resolvePostureAccessSummary(posture);
    const networkPolicy =
      posture.networkPolicy ??
      defaultNetworkPolicyForDeploymentMode(posture.deploymentMode);
    const backend = await probeBackend();
    const actorRole = resolveActorRole(
      request.policyContext?.actorRole,
      null,
    );
    const maySeePathDetails =
      actorRole === "owner" ||
      capabilities.includes(CAP_MANAGE_SERVER_SECURITY);

    return reply.send({
      deploymentMode: posture.deploymentMode,
      securityLevel: posture.securityLevel,
      allowUncontainedHostCommands: getAllowUncontainedHostCommands(),
      capabilities,
      actorRole,
      writablePaths: maySeePathDetails ? access.writablePaths : [],
      readOnlyPaths: maySeePathDetails ? access.readOnlyPaths : [],
      networkPolicy: maySeePathDetails
        ? networkPolicy
        : redactNetworkPolicy(networkPolicy),
      backend,
    });
  });

  app.get<{
    Querystring: {
      limit?: string;
      since?: string;
      actorId?: string;
      correlationId?: string;
      kinds?: string;
      cursor?: string;
    };
  }>("/api/security/audit-log", async (request, reply) => {
    // M052/M055 — same auth-mode-agnostic gate as GET /posture above.
    // The `actorRole === "guest"` rejection happens further down with
    // a 403 (audit_log_forbidden) — preserving the pre-M055 contract
    // where the unauth path returns 401 and the authed-but-unprivileged
    // path returns 403.
    if (!request.sessionUserId) {
      return reply.status(401).send({ error: "Authentication required" });
    }
    if (auditLogPath === undefined) {
      return reply.status(503).send({ error: "audit_log_unavailable" });
    }

    // M128 P0.2 (B2 fix, 2026-05-28): gate audit-log read on the
    // `view_audit_log` capability rather than a role guard. Per
    // permission-model.md §6 grid this cap is held by owner + admin
    // only; superuser / member / contributor / guest are all denied.
    const callerCapsForAudit = await getCapabilities(request.sessionUserId);
    if (!callerCapsForAudit.includes("view_audit_log")) {
      return reply.status(403).send({ error: "audit_log_forbidden" });
    }

    const requestedActorId = request.query.actorId;
    // Owner-rank callers can re-target the query at any actor; admin
    // and below see only their own slice. We still source the "owner"
    // discriminator from actorRole because it's the cheapest readout
    // that's already on the request; the cap above gates access wholesale.
    const actorRoleForFilter = resolveActorRole(
      request.policyContext?.actorRole,
      null,
    );
    const actorId = actorRoleForFilter === "owner"
      ? requestedActorId
      : request.sessionActorId ?? undefined;
    const kinds = parseKinds(request.query.kinds);
    const limit = parseLimit(request.query.limit);

    try {
      return reply.send(readSecurityAuditLog(auditLogPath, {
        ...(request.query.since !== undefined ? { since: request.query.since } : {}),
        ...(actorId !== undefined ? { actorId } : {}),
        ...(request.query.correlationId !== undefined ? { correlationId: request.query.correlationId } : {}),
        ...(kinds !== undefined ? { kinds } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(request.query.cursor !== undefined ? { cursor: request.query.cursor } : {}),
      }));
    } catch (error) {
      const code = error instanceof Error && error.message === "stale_audit_cursor"
        ? "stale_audit_cursor"
        : "invalid_audit_cursor";
      return reply.status(code === "stale_audit_cursor" ? 409 : 400).send({ error: code });
    }
  });

  app.get<{ Querystring: Omit<MessageDeletionReceiptQuery, "actorId"> }>(
    "/api/security/message-deletions",
    async (request, reply) => {
      if (!request.sessionUserId) {
        return reply.status(401).send({ error: "Authentication required" });
      }
      const capabilities = await getCapabilities(request.sessionUserId);
      if (!capabilities.includes("view_audit_log")) {
        return reply.status(403).send({ error: "audit_log_forbidden" });
      }
      const role = resolveActorRole(request.policyContext?.actorRole, null);
      const actorId = role === "owner" ? undefined : request.sessionActorId;
      if (role !== "owner" && !actorId) {
        return reply.status(403).send({ error: "audit_log_forbidden" });
      }
      try {
        return reply.send(await (deps.listMessageDeletionReceipts ?? listMessageDeletionReceipts)({
          ...request.query,
          ...(actorId ? { actorId } : {}),
        }));
      } catch (error) {
        if (error instanceof InvalidMessageDeletionQuery) {
          return reply.status(400).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  // -------------------------------------------------------------------------
  // M037 — standing command approvals (per-user). The caller manages their
  // OWN rules; no Capability gate (you can only see/revoke your own grants).
  // Auth: signed-in non-guest, mirroring POST /api/auth/approval-reply.
  // -------------------------------------------------------------------------

  app.get("/api/security/standing-approvals", async (request, reply) => {
    if (!request.sessionUserId) {
      return reply.status(401).send({ error: "Authentication required" });
    }
    if (request.policyContext?.actorRole === "guest") {
      return reply.status(403).send({ error: "Forbidden" });
    }
    const approvals = await listCommandApprovals(request.sessionUserId);
    return reply.send({ approvals });
  });

  app.delete<{ Params: { id: string } }>(
    "/api/security/standing-approvals/:id",
    async (request, reply) => {
      if (!request.sessionUserId) {
        return reply.status(401).send({ error: "Authentication required" });
      }
      if (request.policyContext?.actorRole === "guest") {
        return reply.status(403).send({ error: "Forbidden" });
      }
      const userId = request.sessionUserId;
      const { id } = request.params;
      if (!id || typeof id !== "string") {
        return reply.status(400).send({ error: "id is required" });
      }
      // Pre-read metadata while the row is still active — revokeCommandApproval
      // returns void and does not tell us whether a row matched.
      const rule = (await listCommandApprovals(userId)).find((a) => a.id === id);
      // Scoped to the caller (createdBy) inside revokeCommandApproval, so a
      // user can never revoke another user's rule even by guessing an id.
      await revokeCommandApproval(id, userId);
      if (rule) {
        await safeAudit(auditEvent, {
          kind: "standing_approval_revoked",
          ts: now().toISOString(),
          actorId: request.sessionActorId ?? userId,
          ip: request.ip,
          userAgent: request.headers["user-agent"],
          route: "DELETE /api/security/standing-approvals/:id",
          actorUserId: userId,
          ruleId: id,
          scope: rule.scope,
          roomId: rule.roomId,
          label: rule.label,
          toolPattern: rule.toolPattern,
        });
      }
      return reply.send({ ok: true });
    },
  );

  // -------------------------------------------------------------------------
  // D538 — bounded, own-PIN uncontained-host-command activation. These routes
  // own only a process-local session permission; they do not select an
  // execution lane, start a process, or make Current Folder an authority
  // boundary. Electron main supplies the exact relay/session tuple.
  // -------------------------------------------------------------------------

  function requireUncontainedController() {
    return uncontainedHostCommands ?? null;
  }

  function parseUncontainedBinding(value: unknown):
    | { readonly relayId: string; readonly desktopSessionId: string }
    | null {
    if (value === null || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (
      typeof record["relayId"] !== "string" || record["relayId"].length === 0 ||
      record["relayId"].length > 256 ||
      typeof record["desktopSessionId"] !== "string" || record["desktopSessionId"].length === 0 ||
      record["desktopSessionId"].length > 256
    ) return null;
    return { relayId: record["relayId"], desktopSessionId: record["desktopSessionId"] };
  }

  app.get<{
    Querystring: { relayId?: string; desktopSessionId?: string };
  }>("/api/security/uncontained-host-commands/session", async (request, reply) => {
    const userId = request.sessionUserId;
    const controller = requireUncontainedController();
    if (!userId) return reply.status(401).send({ error: "Authentication required" });
    if (!controller) return reply.status(503).send({ error: "uncontained_host_commands_unavailable" });
    const binding = parseUncontainedBinding(request.query);
    if (!binding) return reply.status(400).send({ error: "invalid_relay_binding" });
    return reply.send(await controller.status({
      userId,
      actorId: request.sessionActorId ?? userId,
      ...binding,
      ip: request.ip,
      userAgent: request.headers["user-agent"],
    }));
  });

  app.post<{
    Body: { pin?: unknown; relayId?: unknown; desktopSessionId?: unknown };
  }>("/api/security/uncontained-host-commands/activate", async (request, reply) => {
    const userId = request.sessionUserId;
    const controller = requireUncontainedController();
    if (!userId) return reply.status(401).send({ error: "Authentication required" });
    if (!controller) return reply.status(503).send({ error: "uncontained_host_commands_unavailable" });
    const binding = parseUncontainedBinding(request.body);
    if (!binding || typeof request.body?.pin !== "string" || request.body.pin.length === 0) {
      return reply.status(400).send({ error: "invalid_activation_request" });
    }
    const result = await controller.activate({
      userId,
      actorId: request.sessionActorId ?? userId,
      pin: request.body.pin,
      ...binding,
      ip: request.ip,
      userAgent: request.headers["user-agent"],
    });
    if (!result.ok) {
      return reply.status(result.status).send({
        error: result.reason,
        ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
      });
    }
    return reply.send({
      ok: true,
      active: true,
      activatedAt: result.session.activatedAt,
    });
  });

  app.post<{
    Body: { relayId?: unknown; desktopSessionId?: unknown };
  }>("/api/security/uncontained-host-commands/disable", async (request, reply) => {
    const userId = request.sessionUserId;
    const controller = requireUncontainedController();
    if (!userId) return reply.status(401).send({ error: "Authentication required" });
    if (!controller) return reply.status(503).send({ error: "uncontained_host_commands_unavailable" });
    const binding = parseUncontainedBinding(request.body);
    if (!binding) return reply.status(400).send({ error: "invalid_relay_binding" });
    const disabled = await controller.disable({
      userId,
      actorId: request.sessionActorId ?? userId,
      ...binding,
      ip: request.ip,
      userAgent: request.headers["user-agent"],
    });
    return reply.send({ ok: true, disabled });
  });

  // -------------------------------------------------------------------------
  // PUT /api/security/posture — mutate server posture
  // -------------------------------------------------------------------------

  app.put<{
    Body: {
      deploymentMode?: string;
      securityLevel?: string;
      networkPolicy?: unknown;
      allowUncontainedHostCommands?: unknown;
      pin?: string;
    };
  }>("/api/security/posture", async (request, reply) => {
    // 1. Auth — without a session the caller has no Capability to check.
    const userId = request.sessionUserId;
    if (!userId) {
      return reply.status(401).send({ error: "Authentication required" });
    }

    const {
      deploymentMode,
      securityLevel,
      networkPolicy,
      allowUncontainedHostCommands,
      pin,
    } = request.body ?? {};
    const mutatesExistingPosture =
      deploymentMode !== undefined ||
      securityLevel !== undefined ||
      networkPolicy !== undefined;
    // Preserve the existing empty-body gate, while a D538-only request is
    // governed solely by its dedicated management capability.
    const requiredCapabilities = [
      ...(mutatesExistingPosture || allowUncontainedHostCommands === undefined
        ? [CAP_MANAGE_SERVER_SECURITY]
        : []),
      ...(allowUncontainedHostCommands !== undefined
        ? [CAP_MANAGE_UNCONTAINED_HOST_COMMANDS]
        : []),
    ];

    // 2. Capability check (D060 Sprint 1 G5.5 — real Capability
    // store lookup, swapped from the owner-actor heuristic). We
    // reject BEFORE touching the body so a non-authorized caller
    // probing the endpoint learns nothing about validation
    // behavior. Ship plan §5.8: log the attempt so an admin can
    // spot household/teammate probing the endpoint. Keyed on
    // sessionUserId from the trust preHandler.
    const userCaps = await getCapabilities(userId);
    const missingCapability = requiredCapabilities.find(
      (capability) => !userCaps.includes(capability),
    );
    if (missingCapability) {
      await safeAudit(auditEvent, {
        kind: "capability_check_failed",
        ts: now().toISOString(),
        actorId: request.sessionActorId ?? userId,
        ip: request.ip,
        userAgent: request.headers["user-agent"],
        capability: missingCapability,
        attemptedRoute: PUT_ROUTE,
      });
      return reply.status(403).send({
        error: "capability_missing",
        capability: missingCapability,
      });
    }

    // 3. PIN is MANDATORY for every posture mutation. Ship plan §3.3:
    // the PIN re-confirmation is what makes the change attestable in
    // the audit log — the human consented at the moment of change.
    if (pin === undefined || typeof pin !== "string" || pin.length === 0) {
      return reply.status(400).send({ error: "PIN is required" });
    }

    // 4. At least one field must be mutated. An empty body
    // (`{pin: "..."}` only) is a no-op so we 400 rather than
    // silently write-back-what-we-have + log a useless audit row.
    if (
      deploymentMode === undefined &&
      securityLevel === undefined &&
      networkPolicy === undefined &&
      allowUncontainedHostCommands === undefined
    ) {
      return reply.status(400).send({
        error:
          "At least one of deploymentMode / securityLevel / networkPolicy / allowUncontainedHostCommands must be supplied",
      });
    }

    // 5. Validate shape (Zod) BEFORE PIN verification so we don't
    // burn a verifyProof attempt on an obviously invalid request.
    // Using safeParse so we can craft a clean error rather than a
    // Zod stack trace.
    let nextMode: DeploymentMode | null = null;
    if (deploymentMode !== undefined) {
      const result = DeploymentModeSchema.safeParse(deploymentMode);
      if (!result.success) {
        return reply.status(400).send({
          error: "Invalid deploymentMode",
          valid: DeploymentModeSchema.options,
        });
      }
      nextMode = result.data;
    }
    let nextLevel: SecurityLevel | null = null;
    if (securityLevel !== undefined) {
      const result = SecurityLevelSchema.safeParse(securityLevel);
      if (!result.success) {
        return reply.status(400).send({
          error: "Invalid securityLevel",
          valid: SecurityLevelSchema.options,
        });
      }
      nextLevel = result.data;
    }
    let nextNetworkPolicy: NetworkPolicy | null = null;
    if (networkPolicy !== undefined) {
      const result = NetworkPolicySchema.safeParse(networkPolicy);
      if (!result.success) {
        return reply.status(400).send({
          error: "Invalid networkPolicy",
        });
      }
      nextNetworkPolicy = result.data;
    }
    let nextAllowUncontainedHostCommands: boolean | null = null;
    if (allowUncontainedHostCommands !== undefined) {
      if (typeof allowUncontainedHostCommands !== "boolean") {
        return reply.status(400).send({
          error: "Invalid allowUncontainedHostCommands",
        });
      }
      nextAllowUncontainedHostCommands = allowUncontainedHostCommands;
    }

    // 6. PIN verification — after Capability + shape, before mutation.
    // Matches the /api/auth/pin + /api/auth/session lockout shape so
    // brute-force attempts fall into the existing throttle. Every
    // failure path gets a `pin_check_failed` audit row per §5.8.
    //
    // Keyed on request.sessionUserId (D060 Sprint 1 G5.5 self-review SEC-2
    // fix + M043 rebase + session-userId threading): PIN must prove
    // the IDENTITY of the authenticated caller, not the server
    // owner. M043 moved credentials from actor-keyed to user-keyed.
    // Non-owner cap holder without their own enrolled PIN
    // fails-closed on 401 — the owner\u0027s PIN is NOT a master key.
    try {
      const valid = await pinProvider.verifyProof(userId, pin);
      if (!valid) {
        await safeAudit(auditEvent, {
          kind: "pin_check_failed",
          ts: now().toISOString(),
          actorId: request.sessionActorId ?? userId,
          ip: request.ip,
          userAgent: request.headers["user-agent"],
          attemptedRoute: PUT_ROUTE,
          pinOutcome: "invalid",
        });
        return reply.status(401).send({ error: "Invalid PIN" });
      }
    } catch (err) {
      if (err instanceof LockoutError) {
        await safeAudit(auditEvent, {
          kind: "pin_check_failed",
          ts: now().toISOString(),
          actorId: request.sessionActorId ?? userId,
          ip: request.ip,
          userAgent: request.headers["user-agent"],
          attemptedRoute: PUT_ROUTE,
          pinOutcome: "locked_out",
        });
        return reply.status(429).send({
          error: err.message,
          retryAfterMs: err.remainingMs,
        });
      }
      if (err instanceof InvalidPinError) {
        await safeAudit(auditEvent, {
          kind: "pin_check_failed",
          ts: now().toISOString(),
          actorId: request.sessionActorId ?? userId,
          ip: request.ip,
          userAgent: request.headers["user-agent"],
          attemptedRoute: PUT_ROUTE,
          pinOutcome: "invalid",
        });
        return reply.status(401).send({ error: "Invalid PIN" });
      }
      throw err;
    }

    // 7. Build next posture + invoke mutator. Resolve prev AFTER
    // PIN success so any stale write in between is captured in the
    // audit log's `prev` snapshot accurately.
    const resolvedPosture = resolveServerPosture();
    const prev: PostureMutationMeta["prev"] = {
      ...resolvedPosture,
      allowUncontainedHostCommands: getAllowUncontainedHostCommands(),
    };
    const effectiveNextMode = nextMode ?? prev.deploymentMode;
    const deploymentModeChanged =
      nextMode !== null && nextMode !== prev.deploymentMode;
    const effectiveNetworkPolicy =
      nextNetworkPolicy ??
      (deploymentModeChanged
        ? defaultNetworkPolicyForDeploymentMode(effectiveNextMode)
        : prev.networkPolicy ??
          defaultNetworkPolicyForDeploymentMode(prev.deploymentMode));
    const next: PostureMutationMeta["next"] = {
      deploymentMode: effectiveNextMode,
      securityLevel: nextLevel ?? prev.securityLevel,
      networkPolicy: effectiveNetworkPolicy,
      allowUncontainedHostCommands:
        nextAllowUncontainedHostCommands ??
        prev.allowUncontainedHostCommands,
    };

    // Short-circuit no-op: caller tried to write exactly what's
    // already configured. No mutation, no audit row (ship plan
    // avoids audit-log noise for idempotent writes).
    if (
      next.deploymentMode === prev.deploymentMode &&
      next.securityLevel === prev.securityLevel &&
      JSON.stringify(next.networkPolicy) === JSON.stringify(prev.networkPolicy) &&
      next.allowUncontainedHostCommands === prev.allowUncontainedHostCommands
    ) {
      return reply.send({
        deploymentMode: next.deploymentMode,
        securityLevel: next.securityLevel,
        networkPolicy: next.networkPolicy,
        allowUncontainedHostCommands: next.allowUncontainedHostCommands,
        capabilities: requiredCapabilities,
        changed: false,
      });
    }

    await mutatePosture({
      actorId: request.sessionActorId ?? userId,
      ip: request.ip,
      userAgent: request.headers["user-agent"],
      prev,
      next,
    });

    // Mutate first so a failed posture write cannot revoke a valid session;
    // on a successful true→false change, delete/abort every activation before
    // acknowledging the policy change to the administrator.
    if (prev.allowUncontainedHostCommands && !next.allowUncontainedHostCommands) {
      await uncontainedHostCommands?.invalidateAllForPolicyDisable({
        actorId: request.sessionActorId ?? userId,
      });
    }

    return reply.send({
      deploymentMode: next.deploymentMode,
      securityLevel: next.securityLevel,
      networkPolicy: next.networkPolicy,
      allowUncontainedHostCommands: next.allowUncontainedHostCommands,
      capabilities: requiredCapabilities,
      changed: true,
    });
  });
}
