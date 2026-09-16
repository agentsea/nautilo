/**
 * D418 task 3.1.2 — the first authoritative `WorkstationDispatchPlan`
 * admission slice.
 *
 * Before the post-model can auto-approve a Full Workstation operation, the
 * server-side override resolver selects the EXACT active-session-bound relay
 * and admits ONE transient plan keyed by tool-call id binding:
 *
 *   toolCallId + userId + relayId + instanceId + desktopSessionId +
 *   serverBindingId + profileId + profileRevision + grantIds +
 *   capabilityRevision + executionClass
 *
 * The tools node consumes that plan at dispatch time and pins the relay
 * selection to `plan.relayId` (after re-validating the bound relay is still
 * the exact bound relay). It MUST NOT choose a different first-eligible relay
 * after approval: a plan whose bound relay no longer exactly matches fails
 * closed rather than falling back to another relay.
 *
 * Authority boundary — the plan is ADMISSION METADATA ONLY:
 *   - It never replaces the local Electron grant authority. The relay-local
 *     resolver reloads the live grant and decides every filesystem access, so
 *     a stale or revoked plan fails closed on the relay.
 *   - It carries NO roots. Generic `allowedRoots` never becomes workstation
 *     authority: the tools node computes `allowedRoots` from the sandbox
 *     profile + relay caps exactly as before; the plan only selects the
 *     relay, it does not widen any seatbelt.
 *   - It is created ONLY by the server-side resolver (which reads the live
 *     `InMemoryWorkstationSessionRegistry`), so a bare D375-style client
 *     Auto-Approve flag can never self-authorize a plan. The post-model
 *     skips the resolver entirely for anonymous turns.
 *
 * Transience: plans live in an in-memory `Map` keyed by `toolCallId` and
 * expire after a bounded TTL (lazy purge on read). A relay disconnect /
 * desktop-session replacement / session invalidation collapses to
 * `invalidateForBinding` so a plan never outlives the relay binding it
 * pins. The tools node re-validates independently at dispatch time, so a
 * plan whose binding drifted between admission and dispatch still fails
 * closed even if the registry was not yet swept.
 */

import type { WorkstationExecutionClass } from "@nautilo/trust";

/**
 * One transient admission plan. Every field is mandatory; the plan is the
 * exact binding tuple the active Full Workstation session was activated
 * with, plus the tool-call id it pins and the classified operation class.
 *
 * Structurally the binding fields mirror
 * `@nautilo/runtime`'s `FullWorkstationBinding` (re-declared with the
 * tool-call id + execution class + admission timestamp) so the resolver can
 * admit a plan directly from the live session without a remap.
 */
export interface WorkstationDispatchPlan {
  /** The tool-call id this plan pins. Keyed in the plan registry. */
  readonly toolCallId: string;
  readonly userId: string;
  readonly relayId: string;
  readonly instanceId: string;
  readonly desktopSessionId: string;
  readonly serverBindingId: string;
  /**
   * D418 Commit 2 — the server-derived `pairingGeneration` the active Full
   * Workstation session was activated with. Sourced from the validated
   * relay-token row id (never client-authored). Re-validation requires the
   * live relay's advertised pairing generation to still match; a re-pair
   * (changed generation) fails closed even when desktopSessionId is reused.
   */
  readonly pairingGeneration: string;
  readonly profileId: string;
  readonly profileRevision: number;
  /** Unique, non-empty opaque grant ids the session was activated with. */
  readonly grantIds: readonly string[];
  /** Monotonic revision of the advertised capability state at admission. */
  readonly capabilityRevision: number;
  /**
   * D418 Commit 3 — the execution class the admission reasons about
   * (`profile_bound_sandbox` / `typed_broker` / `real_workstation`). This
   * replaces the old six-value operation taxonomy; the concrete tool /
   * operation identity stays separate from this field.
   */
  readonly executionClass: WorkstationExecutionClass;
  /** ISO timestamp the plan was admitted (used for lazy TTL purge). */
  readonly admittedAt: string;
  /**
   * D440 Phase 1 — the Current Folder the operation was admitted for. The
   * plan is admitted from a per-dispatch request, so the selected Current
   * Folder is pinned here for revision-coherence. The dispatch seam fails
   * closed when the live Current Folder drifts from this value (a re-bind
   * to a different Current Folder is an authority change requiring fresh
   * approval; the plan never silently re-targets a new folder). Optional in
   * the structural type only so legacy non-profile callers compile; a
   * `profile_bound_sandbox` plan missing it fails revalidation closed.
   */
  readonly currentFolder?: string;
  /**
   * D440 Phase 1 — the durable grant-store revision advertised by the bound
   * relay at admission (the advisory grant snapshot's `revision`). Carried
   * so a grant-store change between admission and dispatch is detectable
   * as a binding drift. Optional in the structural type only; profile-bound
   * plans and fingerprints missing it fail revalidation closed.
   */
  readonly grantRevision?: number | null;
  /**
   * D440 Phase 1 — the protected-policy version advertised by the bound
   * relay's Workstation Profile snapshot at admission. Carried so a
   * protected-policy change between admission and dispatch is detectable
   * as a binding drift (protected paths are a security-sensitive authority
   * surface). Optional in the structural type only; profile-bound plans and
   * fingerprints missing it fail revalidation closed.
   */
  readonly protectedPolicyVersion?: number | null;
}

/**
 * The live relay-binding fingerprint read from the
 * `InMemoryRelayRegistry` for the plan's `relayId` at admission OR at
 * dispatch time. Each field is `null` when the relay is not connected or
 * has not advertised that piece of binding state; a single `null` fails
 * the re-validation closed (`relay_not_connected`).
 *
 * `profileId` / `profileRevision` come from the relay's advisory Workstation
 * Profile binding snapshot; `userId` / `desktopSessionId` /
 * `capabilityRevision` come from the relay registry's retained registration
 * state. All five are re-validated against the plan's binding fields.
 */
export interface WorkstationRelayFingerprint {
  readonly userId: string | null;
  readonly desktopSessionId: string | null;
  readonly capabilityRevision: number | null;
  readonly profileId: string | null;
  readonly profileRevision: number | null;
  /**
   * D418 Commit 2 — the live relay's server-derived pairing generation, or
   * `null` when the relay is not connected or never carried one. A `null`
   * value fails re-validation closed (`relay_not_connected`); a non-null
   * value that does not match the plan's `pairingGeneration` fails closed
   * (`pairing_generation_mismatch`) so a re-paired relay cannot consume a
   * plan admitted under the prior generation.
   */
  readonly pairingGeneration: string | null;
  /**
   * D440 Phase 1 — the live relay's advertised durable grant-store revision
   * (the advisory grant snapshot's `revision`), or `null`/absent when the
   * relay is not connected or did not advertise a grant snapshot. When both
   * the plan and the fingerprint carry a non-null value, a mismatch fails
   * re-validation closed (`grant_revision_mismatch`); missing profile-bound
   * metadata fails closed as `binding_metadata_missing`.
   */
  readonly grantRevision?: number | null;
  /**
   * D440 Phase 1 — the live relay's advertised protected-policy version
   * (from the Workstation Profile snapshot), or `null`/absent when the
   * relay is not connected or did not advertise a profile snapshot. Same
   * skip / mismatch semantics as `grantRevision`; a mismatch fails closed
   * as `protected_policy_mismatch`.
   */
  readonly protectedPolicyVersion?: number | null;
}

/**
 * D440 Phase 1 — the live binding tuple for an active Full Workstation
 * session, used by {@link InMemoryWorkstationDispatchPlanRegistry.readmit}
 * to re-admit a TTL-expired / missing plan for the SAME authority tuple
 * without forcing a fresh approval. Structurally a subset of
 * `FullWorkstationBinding` (re-declared here so the plan registry does not
 * import the session-registry module); every field is non-secret binding
 * metadata. The `currentFolder` is supplied by the dispatch caller (per
 * request), not by the session, so it is NOT part of this snapshot —
 * `readmit` stamps it from its input.
 */
export interface WorkstationDispatchPlanBindingSnapshot {
  readonly userId: string;
  readonly instanceId: string;
  readonly relayId: string;
  readonly desktopSessionId: string;
  readonly serverBindingId: string;
  readonly pairingGeneration: string;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly grantIds: readonly string[];
  readonly capabilityRevision: number;
  readonly grantRevision?: number | null;
  readonly protectedPolicyVersion?: number | null;
}

export type WorkstationPlanRevalidationReason =
  | "relay_not_connected"
  | "user_mismatch"
  | "desktop_session_mismatch"
  | "capability_revision_mismatch"
  | "profile_binding_mismatch"
  | "binding_metadata_missing"
  | "grant_revision_mismatch"
  | "protected_policy_mismatch";

export type WorkstationPlanRevalidationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: WorkstationPlanRevalidationReason;
      readonly detail: string;
    };

/**
 * Pure re-validation of a plan against a live relay fingerprint. Used at
 * admission (the resolver admits a plan only when the bound relay is still
 * the exact bound relay) AND at dispatch (the tools node fails closed if the
 * binding drifted between admission and dispatch). Identical logic at both
 * seams means a drift is caught at the earliest point AND re-checked at the
 * last point — defense in depth.
 *
 * `relay_not_connected` (any fingerprint field `null`) is checked first so a
 * disconnected / re-paired relay never silently matches on the non-null
 * fields. The remaining fields are checked in binding-stability order:
 * subject → desktop session → capability revision → profile binding.
 */
export function revalidatePlanAgainstRelay(
  plan: WorkstationDispatchPlan,
  fingerprint: WorkstationRelayFingerprint,
): WorkstationPlanRevalidationResult {
  if (
    (plan.executionClass === "profile_bound_sandbox" || plan.executionClass === "typed_broker") &&
    (
      plan.currentFolder === undefined ||
      plan.currentFolder.length === 0 ||
      plan.grantRevision === undefined ||
      plan.grantRevision === null ||
      plan.protectedPolicyVersion === undefined ||
      plan.protectedPolicyVersion === null ||
      fingerprint.grantRevision === undefined ||
      fingerprint.grantRevision === null ||
      fingerprint.protectedPolicyVersion === undefined ||
      fingerprint.protectedPolicyVersion === null
    )
  ) {
    return {
      ok: false,
      reason: "binding_metadata_missing",
      detail: `relay ${plan.relayId} profile-bound plan lacks protocol-v2 Current Folder, grant revision, or protected-policy metadata`,
    };
  }
  if (
    fingerprint.userId === null ||
    fingerprint.desktopSessionId === null ||
    fingerprint.capabilityRevision === null ||
    fingerprint.profileId === null ||
    fingerprint.profileRevision === null ||
    fingerprint.pairingGeneration === null
  ) {
    return {
      ok: false,
      reason: "relay_not_connected",
      detail: `relay ${plan.relayId} is not connected or has no workstation binding fingerprint`,
    };
  }
  if (fingerprint.userId !== plan.userId) {
    return {
      ok: false,
      reason: "user_mismatch",
      detail: `relay ${plan.relayId} owner ${fingerprint.userId} does not match plan user ${plan.userId}`,
    };
  }
  if (fingerprint.desktopSessionId !== plan.desktopSessionId) {
    return {
      ok: false,
      reason: "desktop_session_mismatch",
      detail: `relay ${plan.relayId} desktopSessionId ${fingerprint.desktopSessionId} does not match plan ${plan.desktopSessionId}`,
    };
  }
  if (fingerprint.pairingGeneration !== plan.pairingGeneration) {
    // D418 Commit 2 — the relay re-paired (new server-derived pairing
    // generation) while desktopSessionId is reused. This is a binding-stale
    // denial: the relay is still connected, but it is no longer the EXACT
    // bound relay, so the plan fails closed. The distinct
    // `pairing_generation_mismatch` reason label is deferred to a follow-up
    // that syncs the agent's re-declared `WorkstationPlanRevalidationReasonView`
    // mirror (owned by a later commit); until then it reuses the
    // `desktop_session_mismatch` binding-identity category, which keeps the
    // agent's `relayUnavailable` (R6) semantics correct (false — relay is
    // connected) and carries the precise drift in `detail`.
    return {
      ok: false,
      reason: "desktop_session_mismatch",
      detail: `relay ${plan.relayId} pairingGeneration ${fingerprint.pairingGeneration} does not match plan ${plan.pairingGeneration}`,
    };
  }
  if (fingerprint.capabilityRevision !== plan.capabilityRevision) {
    return {
      ok: false,
      reason: "capability_revision_mismatch",
      detail: `relay ${plan.relayId} capabilityRevision ${fingerprint.capabilityRevision} does not match plan ${plan.capabilityRevision}`,
    };
  }
  if (
    fingerprint.profileId !== plan.profileId ||
    fingerprint.profileRevision !== plan.profileRevision
  ) {
    return {
      ok: false,
      reason: "profile_binding_mismatch",
      detail: `relay ${plan.relayId} profile ${fingerprint.profileId}@${fingerprint.profileRevision} does not match plan ${plan.profileId}@${plan.profileRevision}`,
    };
  }
  // D440 Phase 1 — revision-coherent grant-store + protected-policy checks.
  // Missing v2 metadata was rejected above for profile-bound plans. When
  // both sides carry a value, a mismatch is authority drift and fails closed
  // — a grant-store or protected-policy change is never silently re-bound.
  if (
    plan.grantRevision !== undefined &&
    fingerprint.grantRevision !== undefined &&
    plan.grantRevision !== null &&
    fingerprint.grantRevision !== null &&
    plan.grantRevision !== fingerprint.grantRevision
  ) {
    return {
      ok: false,
      reason: "grant_revision_mismatch",
      detail: `relay ${plan.relayId} grantRevision ${fingerprint.grantRevision} does not match plan ${plan.grantRevision}`,
    };
  }
  if (
    plan.protectedPolicyVersion !== undefined &&
    fingerprint.protectedPolicyVersion !== undefined &&
    plan.protectedPolicyVersion !== null &&
    fingerprint.protectedPolicyVersion !== null &&
    plan.protectedPolicyVersion !== fingerprint.protectedPolicyVersion
  ) {
    return {
      ok: false,
      reason: "protected_policy_mismatch",
      detail: `relay ${plan.relayId} protectedPolicyVersion ${fingerprint.protectedPolicyVersion} does not match plan ${plan.protectedPolicyVersion}`,
    };
  }
  return { ok: true };
}

/**
 * Registry construction options. All fields optional; tests inject a
 * deterministic clock + short TTL to exercise lazy purge.
 */
export interface WorkstationDispatchPlanRegistryOptions {
  /** Injected clock for deterministic `admittedAt` + TTL purge. */
  readonly now?: () => Date;
  /**
   * Plan lifetime in milliseconds. Plans are transient; default 5 minutes.
   * A non-positive value disables TTL purge (plans live until explicitly
   * invalidated / cleared).
   */
  readonly ttlMs?: number;
  /**
   * D440 Phase 1 — optional same-authority re-admission source. Returns the
   * LIVE binding tuple for a user (sourced from the active Full Workstation
   * session registry in production), or `null` when no session is active.
   * When wired, the dispatch seam can re-admit a TTL-expired / missing plan
   * for the SAME authority tuple without forcing a fresh approval; when
   * absent (legacy wiring / pre-D440), `readmit` returns `null` and the
   * dispatch seam fails closed exactly as before. The provider never reads
   * roots or sandbox state — only the binding tuple.
   */
  readonly getActiveBinding?: (input: {
    readonly userId: string;
    readonly currentFolder: string;
    readonly executionClass: WorkstationExecutionClass;
  }) => WorkstationDispatchPlanBindingSnapshot | null;
}

function defaultNow(): Date {
  return new Date();
}

/**
 * In-memory transient `WorkstationDispatchPlan` store. Keyed by `toolCallId`;
 * one plan per tool-call id (a tool call is admitted + dispatched once per
 * turn, and the network-egress retry path re-uses the SAME tool-call id, so
 * `get` is non-destructive).
 *
 * The store is pure policy state: it holds admission metadata only, never
 * authority. Production wires invalidation to the relay registry's
 * `onUnregister` + `onDesktopSessionReplaced` hooks and the session
 * registry's invalidation paths so a plan never outlives its relay binding.
 * The tools node re-validates independently at dispatch time, so a plan
 * whose binding drifted is still rejected even if the sweep has not run.
 */
export class InMemoryWorkstationDispatchPlanRegistry {
  private readonly plans = new Map<string, WorkstationDispatchPlan>();
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly getActiveBinding:
    | ((input: {
        readonly userId: string;
        readonly currentFolder: string;
        readonly executionClass: WorkstationExecutionClass;
      }) => WorkstationDispatchPlanBindingSnapshot | null)
    | undefined;

  constructor(options: WorkstationDispatchPlanRegistryOptions = {}) {
    this.now = options.now ?? defaultNow;
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.getActiveBinding = options.getActiveBinding;
  }

  /**
   * Admit (or replace) a plan keyed by `plan.toolCallId`. A plan with an
   * empty `toolCallId` is refused — it cannot be keyed or consumed. A
   * duplicate admit for the same `toolCallId` overwrites the prior plan
   * (the binding is re-derived from the live session on every consultation,
   * so a stale overwrite is the freshest admission).
   */
  admit(plan: WorkstationDispatchPlan): void {
    if (plan.toolCallId.length === 0) return;
    this.plans.set(plan.toolCallId, plan);
  }

  /**
   * Read the plan for a tool-call id, or `null` when none is active.
   * Non-destructive (the network-egress retry path re-uses the same
   * tool-call id). Lazily purges an expired plan before returning.
   */
  get(toolCallId: string): WorkstationDispatchPlan | null {
    if (toolCallId.length === 0) return null;
    const plan = this.plans.get(toolCallId);
    if (plan === undefined) return null;
    if (this.isExpired(plan)) {
      this.plans.delete(toolCallId);
      return null;
    }
    return plan;
  }

  /**
   * Re-validate a plan against a live relay fingerprint. Delegates to the
   * pure {@link revalidatePlanAgainstRelay} so the admission seam and the
   * dispatch seam share one implementation.
   */
  revalidate(
    plan: WorkstationDispatchPlan,
    fingerprint: WorkstationRelayFingerprint,
  ): WorkstationPlanRevalidationResult {
    return revalidatePlanAgainstRelay(plan, fingerprint);
  }

  /**
   * D440 Phase 1 — same-authority re-admission. When a dispatch seam finds
   * no live plan for a tool-call id (missing OR TTL-expired) but the active
   * Full Workstation session is still bound to the exact same authority
   * tuple the relay now advertises, re-admit ONE fresh plan for this
   * tool-call id and return it. The caller MUST call this ONLY before any
   * relay dispatch (side effects known not started) and MUST retry the
   * dispatch at most once with the returned plan.
   *
   * Fail-closed contract:
   *   - `getActiveBinding` not wired (legacy) ⇒ `null` (current behavior).
   *   - no active session for the user ⇒ `null`.
   *   - the live relay fingerprint does not exactly match the live binding
   *     (any authority drift: user / desktop session / pairing / capability
   *     / profile / grant revision / protected policy) ⇒ `null`. Authority
   *     drift requires fresh approval; this path never re-binds drifted
   *     authority.
   *   - empty `toolCallId` ⇒ `null` (cannot be keyed).
   *
   * The re-admitted plan carries the caller's `currentFolder` so the
   * dispatch seam's Current Folder coherence check pins the folder the
   * retry is for. The plan never carries roots and never widens
   * `allowedRoots` — it is admission metadata only, identical to a plan
   * admitted by the server-side resolver.
   */
  readmit(input: {
    readonly toolCallId: string;
    readonly userId: string;
    readonly currentFolder: string;
    readonly executionClass: WorkstationExecutionClass;
    readonly fingerprint: WorkstationRelayFingerprint;
  }): WorkstationDispatchPlan | null {
    if (input.toolCallId.length === 0) return null;
    if (this.getActiveBinding === undefined) return null;
    const binding = this.getActiveBinding({
      userId: input.userId,
      currentFolder: input.currentFolder,
      executionClass: input.executionClass,
    });
    if (binding === null) return null;
    const plan: WorkstationDispatchPlan = {
      toolCallId: input.toolCallId,
      userId: binding.userId,
      relayId: binding.relayId,
      instanceId: binding.instanceId,
      desktopSessionId: binding.desktopSessionId,
      serverBindingId: binding.serverBindingId,
      pairingGeneration: binding.pairingGeneration,
      profileId: binding.profileId,
      profileRevision: binding.profileRevision,
      grantIds: [...binding.grantIds],
      capabilityRevision: binding.capabilityRevision,
      executionClass: input.executionClass,
      admittedAt: this.now().toISOString(),
      ...(input.currentFolder.length > 0 ? { currentFolder: input.currentFolder } : {}),
      ...(binding.grantRevision !== undefined ? { grantRevision: binding.grantRevision } : {}),
      ...(binding.protectedPolicyVersion !== undefined
        ? { protectedPolicyVersion: binding.protectedPolicyVersion }
        : {}),
    };
    const revalidation = revalidatePlanAgainstRelay(plan, input.fingerprint);
    if (!revalidation.ok) return null;
    this.plans.set(plan.toolCallId, plan);
    return plan;
  }

  /** Drop the plan for one tool-call id (no-op if none). */
  invalidate(toolCallId: string): void {
    this.plans.delete(toolCallId);
  }

  /**
   * Drop every plan bound to the given relay binding
   * (`userId + relayId + desktopSessionId`). Used on relay disconnect /
   * desktop-session replacement / session invalidation so a plan never
   * outlives the relay binding it pins. Returns the count invalidated
   * (for audit / test assertions). `capabilityRevision` is deliberately
   * NOT matched — a revision bump on the same binding still invalidates
   * the now-stale plans.
   */
  invalidateForBinding(input: {
    readonly userId: string;
    readonly relayId: string;
    readonly desktopSessionId: string;
  }): number {
    let count = 0;
    for (const [id, plan] of this.plans) {
      if (
        plan.userId === input.userId &&
        plan.relayId === input.relayId &&
        plan.desktopSessionId === input.desktopSessionId
      ) {
        this.plans.delete(id);
        count++;
      }
    }
    return count;
  }

  /** Drop every plan (shutdown / test reset). */
  clear(): void {
    this.plans.clear();
  }

  /** Live plan count (test / observability). */
  size(): number {
    return this.plans.size;
  }

  private isExpired(plan: WorkstationDispatchPlan): boolean {
    if (this.ttlMs <= 0) return false;
    const admittedAt = new Date(plan.admittedAt).getTime();
    if (!Number.isFinite(admittedAt)) return true;
    return this.now().getTime() - admittedAt > this.ttlMs;
  }
}
