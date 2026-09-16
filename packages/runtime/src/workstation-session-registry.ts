/**
 * D418 — server-side Full Workstation session registry.
 *
 * Policy-state foundation ONLY. This module holds the in-memory
 * `FullWorkstationSession` state that the server uses to decide whether
 * a given authenticated user currently has an ACTIVE Full Workstation
 * grant surface bound to a specific relay / desktop session / profile.
 * It is deliberately pure policy state:
 *
 *   - NO persistence. State lives in a `Map` for the lifetime of the
 *     process. A restart re-derives everything from the relay binding
 *     provider.
 *   - NO PersonalPolicyResolver / post-model approval mapping. The
 *     registry does not touch tool approval, sandbox roots, MCP
 *     execution, or the renderer / desktop profile IPC. It only stores
 *     + invalidates session state.
 *   - NO raw PIN storage. Activation PIN proof is verified by the
 *     caller (the route) via the injected `ChallengeProvider`; the
 *     registry never sees a PIN.
 *
 * The session is bound EXACTLY to the tuple:
 *
 *   userId + instanceId + relayId + desktopSessionId + serverBindingId
 *   + agentScope:"all_owned_agents" + profileId + profileRevision
 *   + grantIds + capabilityRevision
 *
 * Every field is mandatory and validated. `agentScope` is pinned to the
 * single `all_owned_agents` constant shared with the relay advisory
 * snapshot — a Full Workstation session never describes a cross-subject
 * wildcard.
 *
 * Authority model: the route resolves an AUTHORITATIVE `FullWorkstationBinding`
 * from an injected relay binding provider (or a test double), compares
 * the client's typed payload against it for an exact match, and hands
 * the authoritative binding to `activate`. The registry never trusts a
 * client-supplied binding to self-authorize; a client flag alone cannot
 * activate.
 *
 * Invalidation semantics:
 *   - `serverBindingId` mismatch between an existing active session and
 *     a freshly resolved authoritative binding represents a server
 *     switch / re-pair. The old session is invalidated and the new one
 *     activated (`switched`), including when the new binding has no durable
 *     filesystem grants. An empty grant set is a valid, narrower binding:
 *     transient Current Folder authority is established locally by Electron,
 *     never represented by a durable grant id here.
 *   - A higher `capabilityRevision` at the same `serverBindingId` may
 *     NARROW (including to an empty durable set) or BROADEN the grant set. The route invokes
 *     `activate` only after fresh PIN proof, so a broadened authoritative
 *     binding is the explicit profile-revision expansion path.
 *   - `invalidateForRelayBinding` drops any active session bound to a
 *     matching relay binding (used on relay disconnect / re-pair).
 *
 * `disable` is user-bound (keyed on `userId`) and idempotent. Audit
 * events are emitted through an injected callback; the registry returns
 * no command output and no secrets.
 */

import { DESKTOP_FILESYSTEM_GRANT_SNAPSHOT_AGENT_SCOPE } from "@nautilo/relay";
import { isCanonicalNautiloInstanceId } from "@nautilo/config";
import { randomUUID } from "node:crypto";
import type {
  WorkstationExecutionClass,
  WorkstationAdmissionReason,
} from "@nautilo/trust";

/**
 * The only agent scope a Full Workstation session may declare. Reuses
 * the relay advisory-snapshot constant so the two surfaces cannot drift.
 */
export const FULL_WORKSTATION_AGENT_SCOPE = DESKTOP_FILESYSTEM_GRANT_SNAPSHOT_AGENT_SCOPE;

/**
 * The full binding tuple that identifies a Full Workstation session.
 * Every field is mandatory; `agentScope` is pinned to
 * `all_owned_agents`. This shape is shared by:
 *   - the authoritative binding returned by a `RelayBindingProvider`,
 *   - the client-supplied activation payload (compared for exact match),
 *   - the stored `FullWorkstationSession`.
 */
export interface FullWorkstationBinding {
  readonly userId: string;
  readonly instanceId: string;
  readonly relayId: string;
  /**
   * Per Electron main-process-launch identity. A headless relay (no
   * desktop session) is INELIGIBLE for a Full Workstation session —
   * `activate` rejects with `ineligible_binding` when this is empty.
   */
  readonly desktopSessionId: string;
  /**
   * Server-side binding identifier. Represents the current
   * relay↔server pairing. A mismatch with an existing active session's
   * `serverBindingId` is the server-switch / re-pair signal.
   */
  readonly serverBindingId: string;
  /**
   * D418 Commit 2 — the server-derived `pairingGeneration` (the validated
   * relay-token row id). NEVER client-authored: the route resolves it from
   * the authenticated relay registry, never from the client payload. A
   * mismatch with an existing active session's `pairingGeneration` is the
   * explicit re-pair signal (same server, new token) and is treated as a
   * binding-identity switch that invalidates the prior session. Same
   * generation + desktop-session reconnect preserves the mode.
   */
  readonly pairingGeneration: string;
  readonly agentScope: typeof FULL_WORKSTATION_AGENT_SCOPE;
  readonly profileId: string;
  readonly profileRevision: number;
  /** Unique opaque durable-grant ids. An empty list is a valid grant set. */
  readonly grantIds: readonly string[];
  /** Monotonic revision of the advertised capability state. */
  readonly capabilityRevision: number;
}

/**
 * A stored active session = the binding tuple plus the activation
 * timestamp. `activatedAt` is set by the registry from the injected
 * clock; it is never trusted from input.
 */
export interface FullWorkstationSession extends FullWorkstationBinding {
  readonly activatedAt: string;
}

/** Server-only, one-time preauthorization for the two-phase D418 flow. */
export interface PendingWorkstationAuthorization {
  /** Opaque random capability returned to Electron main; never audited. */
  readonly ticket: string;
  readonly userId: string;
  readonly instanceId: string;
  readonly relayId: string;
  readonly desktopSessionId: string;
  readonly serverBindingId: string;
  /**
   * D418 Commit 2 — the server-derived pairing generation captured at
   * phase-one issue. Completion requires the advertised binding to carry
   * the SAME `pairingGeneration`; a re-pair between phase one and two
   * invalidates the ticket.
   */
  readonly pairingGeneration: string;
  readonly agentScope: typeof FULL_WORKSTATION_AGENT_SCOPE;
  readonly profileId: string;
  readonly profileRevision: number;
  /** Capability revision before local compilation/advertisement. May be 0. */
  readonly baselineCapabilityRevision: number;
  readonly expiresAt: string;
}

/**
 * Injected resolver that returns the AUTHORITATIVE binding for a given
 * relay / desktop session / instance, or `null` when no eligible
 * binding exists (headless relay, unknown relay, not paired). The route
 * calls this AFTER auth + capability + PIN; the registry never calls
 * it. Production wires a real provider; tests inject a test double.
 */
export interface RelayBindingProvider {
  resolve(input: {
    readonly userId: string;
    readonly relayId: string;
    readonly desktopSessionId: string;
    readonly instanceId: string;
  }): Promise<FullWorkstationBinding | null>;
}

// ---------------------------------------------------------------------------
// Audit events — audit-envelope-shaped, locally owned kind union
// ---------------------------------------------------------------------------

/**
 * Common audit envelope fields, mirroring the security audit log's
 * `CommonAuditFields`. The kinds are owned by this module because the
 * global `SecurityAuditEvent` union lives in `@nautilo/server` lib
 * (out of this task's allow-list); the route forwards these to its
 * injected audit callback. No command output, PINs, or secrets appear
 * in any variant — only identifiers + an outcome/denial reason.
 */
export interface WorkstationAccessAuditEvent {
  readonly ts: string;
  readonly actorId: string | null;
  readonly ip: string;
  readonly userAgent: string | undefined;
  readonly kind:
    | "workstation_session_activated"
    | "workstation_session_narrowed"
    | "workstation_session_broadened"
    | "workstation_session_switched"
    | "workstation_session_invalidated"
    | "workstation_session_disabled"
    | "workstation_session_denied";
  readonly userId: string;
  readonly relayId: string;
  readonly desktopSessionId: string;
  readonly serverBindingId: string;
  /** Present on `*_denied` events: the registry denial code. */
  readonly denialCode?: ActivateDenialCode | DisableDenialCode;
  /** Present on transitions: the outcome of the activate/disable. */
  readonly outcome?: ActivateOutcome | DisableOutcome;
  /** Forensic route tag, mirroring the security audit log's `route` field. */
  readonly route?: string;
  readonly capabilityRevision: number;
}

export type ActivateDenialCode =
  | "ineligible_binding"
  | "foreign_binding"
  | "stale_revision"
  | "broader_revision"
  | "duplicate_active";

export type DisableDenialCode = "not_active";

// ---------------------------------------------------------------------------
// D418 Commit 4 — runtime-owned redacted Workstation execution-ADMISSION
// audit row. Emitted by the server-side override resolver
// (`createWorkstationApprovalOverrideResolver`) for every dispatch it is
// consulted on. The row is REDACTED: it carries ONLY the execution class,
// the admission outcome/reason, the concrete tool/tool-call id, and OPAQUE
// plan/session binding identifiers. It NEVER carries command text, command
// output, roots, paths, environment values, tokens, PINs, or grant
// contents — those are authority material owned by the local Electron
// sandbox/grant enforcement at execution, not by admission. `grantIds` are
// deliberately NOT serialized (a grant-id list is binding material, not a
// redacted identifier — see `WorkstationSessionAuditEvent` for the same
// decision). The binding identifiers here (`relayId / desktopSessionId /
// serverBindingId / pairingGeneration / profileId / profileRevision /
// capabilityRevision`) let an operator correlate the row with the relay
// registration + the active session without leaking authority.
//
// The shape is owned by the runtime package (the server's
// `security-audit-log.ts` mirrors it into the global `SecurityAuditEvent`
// union + writer). `reason` is the admission `WorkstationAdmissionReason`
// for a `none` outcome (including the server's independent
// `critical_or_elevation_command` scan refusal), plus the runtime-owned
// `auto_admitted` sentinel for an `auto` outcome.
// ---------------------------------------------------------------------------

/** Admission outcome: `auto` (prompt suppressed) or `none` (normal approval intact). */
export type WorkstationAdmissionAuditOutcome = "auto" | "none";

/**
 * The admission reason recorded on the audit row. Extends
 * {@link WorkstationAdmissionReason} (used for `none`, including the
 * independent scan refusal) with the runtime-owned `auto_admitted` sentinel
 * (used for `auto`).
 */
export type WorkstationAdmissionAuditReason =
  | WorkstationAdmissionReason
  | "auto_admitted";

export interface WorkstationAdmissionAuditEvent {
  readonly ts: string;
  readonly actorId: string | null;
  readonly ip: string;
  readonly userAgent: string | undefined;
  readonly kind: "workstation_admission";
  /** The authenticated subject the dispatch is for. */
  readonly userId: string;
  /** Concrete tool name (audit correlation; the engine does not branch on it). */
  readonly toolName: string;
  /** The tool-call id the admitted plan is keyed by (opaque plan binding). */
  readonly toolCallId: string;
  readonly executionClass: WorkstationExecutionClass;
  readonly outcome: WorkstationAdmissionAuditOutcome;
  readonly reason: WorkstationAdmissionAuditReason;
  /** Opaque session binding identifiers (never grant contents). */
  readonly relayId: string;
  readonly desktopSessionId: string;
  readonly serverBindingId: string;
  readonly pairingGeneration: string;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly capabilityRevision: number;
}

export type ActivateOutcome =
  | "activated"
  | "narrowed"
  | "broadened"
  | "switched"
  | "invalidated";

export type DisableOutcome = "disabled" | "not_active";

export interface ActivateSuccess {
  readonly ok: true;
  readonly outcome: ActivateOutcome;
  readonly session: FullWorkstationSession | null;
}

export interface ActivateFailure {
  readonly ok: false;
  readonly denialCode: ActivateDenialCode;
  readonly reason: string;
}

export type ActivateResult = ActivateSuccess | ActivateFailure;

export interface DisableResult {
  readonly ok: true;
  readonly outcome: DisableOutcome;
  readonly session: FullWorkstationSession | null;
}

export interface InvalidateResult {
  readonly ok: true;
  readonly invalidated: boolean;
  readonly session: FullWorkstationSession | null;
}

export interface FullWorkstationSessionRegistryOptions {
  /**
   * Injected audit callback. Invoked once per activate / disable /
   * invalidate transition with an audit-envelope-shaped event. The
   * registry never throws on audit failure — it treats the callback as
   * fire-and-forget, mirroring the `safeAudit` contract in the security
   * routes.
   */
  readonly audit?: (event: WorkstationAccessAuditEvent) => void;
  /** Injected clock for deterministic `activatedAt` / audit `ts`. */
  readonly now?: () => Date;
  /** Mint opaque one-time authorization tickets; injectable for tests. */
  readonly mintPendingTicket?: () => string;
  /** Pending authorization lifetime. Defaults to 60 seconds. */
  readonly pendingAuthorizationTtlMs?: number;
}

function defaultNow(): Date {
  return new Date();
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * D418 — both binding revisions must be POSITIVE safe integers (>= 1) for
 * activation. A `profileRevision` of 0 means "no profile revisions have
 * happened" and is not an activatable binding; a `capabilityRevision` of 0
 * is the pre-advertisement default and likewise not activatable. An empty
 * durable `grantIds` list may still carry a positive `capabilityRevision` —
 * the revision floor is independent of the durable grant set.
 */
function isPositiveSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Strict, fail-closed shape validator for a `FullWorkstationBinding`.
 * Returns a denial code (`ineligible_binding`) + reason on any failure
 * so `activate` can reject without throwing. Headless relays (empty
 * `desktopSessionId`) are ineligible by design.
 */
function validateBinding(binding: unknown):
  | { ok: true; binding: FullWorkstationBinding }
  | { ok: false; reason: string } {
  if (typeof binding !== "object" || binding === null || Array.isArray(binding)) {
    return { ok: false, reason: "binding must be an object" };
  }
  const b = binding as Record<string, unknown>;
  if (
    !isNonBlankString(b["userId"]) ||
    !isCanonicalNautiloInstanceId(b["instanceId"]) ||
    !isNonBlankString(b["relayId"]) ||
    !isNonBlankString(b["desktopSessionId"]) ||
    !isNonBlankString(b["serverBindingId"]) ||
    !isNonBlankString(b["profileId"]) ||
    !isNonBlankString(b["pairingGeneration"])
  ) {
    return {
      ok: false,
      reason:
        "binding requires non-empty userId, relayId, desktopSessionId, serverBindingId, profileId, pairingGeneration; instanceId must be canonical (default \"\" or named)",
    };
  }
  if (b["agentScope"] !== FULL_WORKSTATION_AGENT_SCOPE) {
    return {
      ok: false,
      reason: `binding agentScope must be ${FULL_WORKSTATION_AGENT_SCOPE}`,
    };
  }
  if (!isPositiveSafeInt(b["profileRevision"])) {
    return { ok: false, reason: "binding profileRevision must be a positive safe integer (>= 1)" };
  }
  if (!isPositiveSafeInt(b["capabilityRevision"])) {
    return { ok: false, reason: "binding capabilityRevision must be a positive safe integer (>= 1)" };
  }
  if (!Array.isArray(b["grantIds"])) {
    return { ok: false, reason: "binding grantIds must be an array" };
  }
  if (!b["grantIds"].every(isNonBlankString)) {
    return { ok: false, reason: "binding grantIds must be non-empty strings" };
  }
  if (new Set(b["grantIds"]).size !== b["grantIds"].length) {
    return { ok: false, reason: "binding grantIds must be unique" };
  }
  return {
    ok: true,
    binding: {
      userId: b["userId"],
      instanceId: b["instanceId"],
      relayId: b["relayId"],
      desktopSessionId: b["desktopSessionId"],
      serverBindingId: b["serverBindingId"],
      pairingGeneration: b["pairingGeneration"],
      agentScope: FULL_WORKSTATION_AGENT_SCOPE,
      profileId: b["profileId"],
      profileRevision: b["profileRevision"],
      grantIds: [...b["grantIds"]],
      capabilityRevision: b["capabilityRevision"],
    },
  };
}

/**
 * Identity comparison for the binding fields that must match the
 * authoritative resolver output. `grantIds` + `capabilityRevision` are
 * compared separately (grantIds via subset, revision via monotonicity).
 */
function bindingIdentityEquals(
  a: FullWorkstationBinding,
  b: FullWorkstationBinding,
): boolean {
  return (
    a.userId === b.userId &&
    a.instanceId === b.instanceId &&
    a.relayId === b.relayId &&
    a.desktopSessionId === b.desktopSessionId &&
    a.serverBindingId === b.serverBindingId &&
    a.pairingGeneration === b.pairingGeneration &&
    a.agentScope === b.agentScope &&
    a.profileId === b.profileId &&
    a.profileRevision === b.profileRevision
  );
}

function bindingDeepEquals(
  a: FullWorkstationBinding,
  b: FullWorkstationBinding,
): boolean {
  return (
    bindingIdentityEquals(a, b) &&
    a.capabilityRevision === b.capabilityRevision &&
    a.grantIds.length === b.grantIds.length &&
    a.grantIds.every((g, i) => g === b.grantIds[i])
  );
}

function grantIdsSubsetOf(
  narrower: readonly string[],
  broader: readonly string[],
): boolean {
  const set = new Set(broader);
  return narrower.every((g) => set.has(g));
}

/**
 * In-memory Full Workstation session registry. One active session per
 * `userId` (a user has at most one Full Workstation surface live at a
 * time). All mutators are synchronous and pure with respect to the
 * injected clock + audit callback.
 */
export class InMemoryWorkstationSessionRegistry {
  private readonly sessions = new Map<string, FullWorkstationSession>();
  private readonly pendingAuthorizations = new Map<string, PendingWorkstationAuthorization>();
  private readonly audit: ((event: WorkstationAccessAuditEvent) => void) | undefined;
  private readonly now: () => Date;
  private readonly mintPendingTicket: () => string;
  private readonly pendingAuthorizationTtlMs: number;

  constructor(options: FullWorkstationSessionRegistryOptions = {}) {
    this.audit = options.audit;
    this.now = options.now ?? defaultNow;
    this.mintPendingTicket = options.mintPendingTicket ?? randomUUID;
    this.pendingAuthorizationTtlMs = options.pendingAuthorizationTtlMs ?? 60_000;
  }

  /**
   * Issues a server-only one-time ticket after auth/capability/PIN proof.
   * This deliberately creates NO Full Workstation session and therefore can
   * carry a zero-grant/capabilityRevision-0 baseline.
   */
  issuePendingAuthorization(input: Omit<PendingWorkstationAuthorization, "ticket" | "expiresAt">):
    PendingWorkstationAuthorization {
    const now = this.now();
    for (const [existingTicket, existing] of this.pendingAuthorizations) {
      if (now.getTime() > new Date(existing.expiresAt).getTime()) {
        this.pendingAuthorizations.delete(existingTicket);
      }
    }
    const ticket = this.mintPendingTicket();
    const pending: PendingWorkstationAuthorization = {
      ...input,
      ticket,
      expiresAt: new Date(now.getTime() + this.pendingAuthorizationTtlMs).toISOString(),
    };
    this.pendingAuthorizations.set(ticket, pending);
    return pending;
  }

  /** Internal route lookup; expired tickets are never returned. */
  peekPendingAuthorization(ticket: string): PendingWorkstationAuthorization | null {
    const pending = this.pendingAuthorizations.get(ticket);
    if (pending === undefined) return null;
    if (this.now().getTime() > new Date(pending.expiresAt).getTime()) {
      this.pendingAuthorizations.delete(ticket);
      return null;
    }
    return pending;
  }

  /**
   * Atomically consumes a valid ticket and commits the now-advertised exact
   * binding. No PIN/client binding is accepted here. Any completion attempt
   * consumes the ticket (including a stale/foreign completion), making it
   * one-time and replay-safe.
   */
  completePendingAuthorization(ticket: string, binding: FullWorkstationBinding):
    | ActivateResult
    | { readonly ok: false; readonly denialCode: "invalid_pending_authorization"; readonly reason: string } {
    const pending = this.pendingAuthorizations.get(ticket);
    if (pending === undefined) {
      return { ok: false, denialCode: "invalid_pending_authorization", reason: "pending authorization is missing or consumed" };
    }
    this.pendingAuthorizations.delete(ticket);
    if (this.now().getTime() > new Date(pending.expiresAt).getTime()) {
      return { ok: false, denialCode: "invalid_pending_authorization", reason: "pending authorization has expired" };
    }
    if (
      binding.userId !== pending.userId ||
      binding.instanceId !== pending.instanceId ||
      binding.relayId !== pending.relayId ||
      binding.desktopSessionId !== pending.desktopSessionId ||
      binding.serverBindingId !== pending.serverBindingId ||
      binding.pairingGeneration !== pending.pairingGeneration ||
      binding.agentScope !== pending.agentScope ||
      binding.profileId !== pending.profileId ||
      binding.profileRevision !== pending.profileRevision ||
      binding.capabilityRevision <= pending.baselineCapabilityRevision
    ) {
      return { ok: false, denialCode: "invalid_pending_authorization", reason: "advertised binding does not satisfy pending authorization" };
    }
    return this.activate(binding, binding);
  }

  /**
   * Activate (or transition) a Full Workstation session for a user.
   *
   * `session` is the binding to store; `authoritative` is the binding
   * resolved by the injected `RelayBindingProvider`. The registry
   * requires the session's identity fields to match the authoritative
   * binding exactly, the session's `grantIds` to be a subset of the
   * authoritative `grantIds`, and the session's `capabilityRevision` to
   * equal the authoritative `capabilityRevision`. This is what makes a
   * client flag alone insufficient: the resolver is the authority.
   */
  activate(
    session: FullWorkstationBinding,
    authoritative: FullWorkstationBinding,
  ): ActivateResult {
    const parsed = validateBinding(session);
    if (!parsed.ok) {
      return this.deny("ineligible_binding", parsed.reason, session);
    }
    const authParsed = validateBinding(authoritative);
    if (!authParsed.ok) {
      // An invalid authoritative binding is an upstream contract
      // violation; fail closed as ineligible rather than storing
      // unvalidated state.
      return this.deny("ineligible_binding", authParsed.reason, session);
    }
    const s = parsed.binding;
    const a = authParsed.binding;

    // The session must describe the SAME subject as the authoritative
    // binding. A mismatched userId / relay / desktop session / server
    // binding / profile is a foreign binding — denied.
    if (!bindingIdentityEquals(s, a)) {
      return this.deny("foreign_binding", "session binding does not match the authoritative relay binding", s);
    }
    // The session must not claim grants the authoritative binding did
    // not authorize, and must carry the authoritative current revision.
    if (!grantIdsSubsetOf(s.grantIds, a.grantIds)) {
      return this.deny("broader_revision", "session grantIds are broader than the authoritative binding", s);
    }
    if (s.capabilityRevision !== a.capabilityRevision) {
      if (s.capabilityRevision < a.capabilityRevision) {
        return this.deny("stale_revision", "session capabilityRevision is stale relative to the authoritative binding", s);
      }
      return this.deny("broader_revision", "session capabilityRevision is ahead of the authoritative binding", s);
    }

    const existing = this.sessions.get(s.userId);
    if (existing === undefined) {
      // An empty durable grant set is still a coherent session. Current
      // Folder authority is transient and re-established locally by Electron
      // after this identity-bound server admission succeeds.
      const stored: FullWorkstationSession = { ...s, activatedAt: this.now().toISOString() };
      this.sessions.set(s.userId, stored);
      this.emitActivate("activated", stored);
      return { ok: true, outcome: "activated", session: stored };
    }

    // Exact duplicate of the active session — deny (disable is the
    // idempotent operation, not activate).
    if (bindingDeepEquals(existing, s)) {
      return this.deny("duplicate_active", "an identical session is already active", s);
    }

    // Server switch / re-pair / desktop app restart: a different
    // `serverBindingId`, `pairingGeneration`, OR authoritative
    // `desktopSessionId` invalidates the old session. Profile activation has
    // just required fresh PIN proof before this transition reaches the
    // registry, so replacing the stale process-bound session does not let a
    // client flag self-authorize. The new binding is authoritative and may
    // legitimately carry an empty durable grant set.
    if (
      existing.serverBindingId !== s.serverBindingId ||
      existing.pairingGeneration !== s.pairingGeneration ||
      existing.desktopSessionId !== s.desktopSessionId
    ) {
      this.sessions.delete(s.userId);
      const stored: FullWorkstationSession = { ...s, activatedAt: this.now().toISOString() };
      this.sessions.set(s.userId, stored);
      this.emitActivate("switched", stored);
      return { ok: true, outcome: "switched", session: stored };
    }

    // Same serverBindingId — capabilityRevision must be strictly
    // monotonic. Stale or same-revision-different-content are denied.
    if (s.capabilityRevision < existing.capabilityRevision) {
      return this.deny("stale_revision", "session capabilityRevision is older than the active session", s);
    }
    if (s.capabilityRevision === existing.capabilityRevision) {
      // Same revision but not deep-equal (caught above) — a scope change
      // at the same revision is forbidden. Broaden via re-pair, narrow
      // via a revision bump.
      return this.deny("broader_revision", "session changed scope at the same capabilityRevision", s);
    }

    // Strictly greater revision at the same serverBindingId. Narrowing,
    // including to an empty durable grant set, requires no additional
    // authority; broadening is valid here because the route has just
    // required fresh PIN proof against the authoritative new profile binding.
    const stored: FullWorkstationSession = { ...s, activatedAt: this.now().toISOString() };
    this.sessions.set(s.userId, stored);
    const outcome: ActivateOutcome = grantIdsSubsetOf(s.grantIds, existing.grantIds)
      ? "narrowed"
      : "broadened";
    this.emitActivate(outcome, stored);
    return { ok: true, outcome, session: stored };
  }

  /**
   * Read the active session for a user, or `null` when none is active.
   * Pure; never emits an audit event.
   */
  get(userId: string): FullWorkstationSession | null {
    return this.sessions.get(userId) ?? null;
  }

  /**
   * Disable the active session for a user. User-bound (keyed on
   * `userId`) and idempotent: disabling when no session is active is a
   * no-op success with outcome `not_active`. Always succeeds.
   */
  disable(userId: string): DisableResult {
    const existing = this.sessions.get(userId);
    if (existing === undefined) {
      this.emitDisable(null, userId);
      return { ok: true, outcome: "not_active", session: null };
    }
    this.sessions.delete(userId);
    this.emitDisable(existing, userId);
    return { ok: true, outcome: "disabled", session: existing };
  }

  /**
   * Invalidate any active session bound to the given relay binding.
   * Used on relay disconnect / un-pair. Matches on `userId` +
   * `serverBindingId` (+ `relayId` + `desktopSessionId` when supplied).
   * D418 Commit 2 — an optional `pairingGeneration` filter pins the
   * invalidation to the exact prior generation so a re-paired relay does
   * not accidentally clear a session already re-activated under the new
   * generation. Returns whether a session was invalidated.
   */
  invalidateForRelayBinding(input: {
    readonly userId: string;
    readonly serverBindingId: string;
    readonly relayId?: string;
    readonly desktopSessionId?: string;
    readonly pairingGeneration?: string;
  }): InvalidateResult {
    const existing = this.sessions.get(input.userId);
    if (existing === undefined) {
      return { ok: true, invalidated: false, session: null };
    }
    if (existing.serverBindingId !== input.serverBindingId) {
      return { ok: true, invalidated: false, session: null };
    }
    if (input.relayId !== undefined && existing.relayId !== input.relayId) {
      return { ok: true, invalidated: false, session: null };
    }
    if (
      input.desktopSessionId !== undefined &&
      existing.desktopSessionId !== input.desktopSessionId
    ) {
      return { ok: true, invalidated: false, session: null };
    }
    if (
      input.pairingGeneration !== undefined &&
      existing.pairingGeneration !== input.pairingGeneration
    ) {
      return { ok: true, invalidated: false, session: null };
    }
    this.sessions.delete(input.userId);
    this.emitInvalidate(existing, "invalidateForRelayBinding");
    return { ok: true, invalidated: true, session: existing };
  }

  // -----------------------------------------------------------------------
  // Audit emission — fire-and-forget; never throws
  // -----------------------------------------------------------------------

  private baseEvent(
    binding: FullWorkstationBinding,
    kind: WorkstationAccessAuditEvent["kind"],
    extra: Partial<WorkstationAccessAuditEvent>,
  ): WorkstationAccessAuditEvent {
    return {
      ts: this.now().toISOString(),
      // actorId / ip / userAgent are stamped by the route from the
      // request context; the registry itself has no request, so it
      // leaves them as the neutral defaults. The route's audit
      // callback is expected to be the one that knows the request;
      // for direct-registry unit tests these stay null/""/undefined.
      actorId: extra.actorId ?? null,
      ip: extra.ip ?? "",
      userAgent: extra.userAgent,
      kind,
      userId: binding.userId,
      relayId: binding.relayId,
      desktopSessionId: binding.desktopSessionId,
      serverBindingId: binding.serverBindingId,
      capabilityRevision: binding.capabilityRevision,
      ...extra,
    };
  }

  private emitActivate(outcome: ActivateOutcome, session: FullWorkstationSession): void {
    if (!this.audit) return;
    const kind: WorkstationAccessAuditEvent["kind"] =
      outcome === "activated"
        ? "workstation_session_activated"
        : outcome === "narrowed"
          ? "workstation_session_narrowed"
          : outcome === "broadened"
            ? "workstation_session_broadened"
          : "workstation_session_switched";
    this.audit(this.baseEvent(session, kind, { outcome }));
  }

  private emitInvalidate(session: FullWorkstationSession, _origin: string): void {
    if (!this.audit) return;
    this.audit(this.baseEvent(session, "workstation_session_invalidated", { outcome: "invalidated" }));
  }

  private emitDisable(session: FullWorkstationSession | null, userId: string): void {
    if (!this.audit) return;
    if (session !== null) {
      this.audit(this.baseEvent(session, "workstation_session_disabled", { outcome: "disabled" }));
      return;
    }
    // No active session — emit a minimal denied/disabled event keyed on
    // the userId the caller requested, with placeholder binding fields.
    this.audit({
      ts: this.now().toISOString(),
      actorId: null,
      ip: "",
      userAgent: undefined,
      kind: "workstation_session_disabled",
      userId,
      relayId: "",
      desktopSessionId: "",
      serverBindingId: "",
      capabilityRevision: -1,
      outcome: "not_active",
    });
  }

  private deny(
    denialCode: ActivateDenialCode,
    reason: string,
    binding: FullWorkstationBinding,
  ): ActivateFailure {
    if (this.audit) {
      this.audit(
        this.baseEvent(binding, "workstation_session_denied", { denialCode }),
      );
    }
    return { ok: false, denialCode, reason };
  }
}
