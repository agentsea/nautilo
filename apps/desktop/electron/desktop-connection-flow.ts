/**
 * D514 — the one main-owned add/switch connection coordinator.
 *
 * Network observations are made once here and handed to the candidate session
 * and registry as facts.  The registry owns the prepared view transaction; it
 * never probes.  There is intentionally no elapsed-time failure ceiling.
 */
import { randomUUID } from "node:crypto";
import {
  beginConnectionAttempt,
  connectionAttemptId,
  transitionConnectionAttempt,
  type ConnectionAttemptState,
  type ConnectionContext,
  type IdentityMismatchReceipt,
  type ObservationReceipt,
} from "./connection-attempt";
import {
  presentConnectionAttempt,
  type ConnectionPresentation,
  type ConnectionTerminalPresentationFact,
} from "./connection-presentation";
import type {
  ActiveAuthority,
  PendingConnection,
  PendingConnectionPostCommitCheckpoint,
} from "./pending-connection";
import { planServerTarget } from "./server-target";
import type {
  IncompletePreparedServerSwitchCheckpoint,
  PreparedServerSwitchHandle,
  ServerSession,
} from "./server-sessions/registry";

export type DesktopConnectionResult =
  | { ok: true; url: string }
  | { ok: false; reason: "cancelled" }
  | { ok: false; reason: "downgrade-confirmation-required"; decisionId: string }
  | { ok: false; reason: "wrong-server"; decisionId: string }
  | { ok: false; reason: "invalid-target" | "offline" | "incompatible" | "stale" | "identity-changed-again" }
  | { ok: false; reason: "promotion-failed"; authoritativePairingChanged: false | true | "unknown" };

export type VerifiedHealth = Readonly<{
  answeringOrigin: string;
  body: Readonly<Record<string, unknown>>;
  fingerprint: string;
  logtoConfig: Readonly<{ endpoint: string; appId: string; resource: string }>;
  observedAtMs: number;
}>;

export type DesktopConnectionPreview = Readonly<{
  ok: true;
  origin: string;
  readinessObservedAtMs: number;
  health: VerifiedHealth;
  setup: Readonly<{ observedAtMs: number; state: string; raw: unknown }>;
  authDiscoveredAtMs: number;
}> | Readonly<{ ok: false; reason: "invalid-target" | "downgrade-confirmation-required" | "offline" }>;

export type VerifiedConnectionCohort = Readonly<{
  url: string;
  health: VerifiedHealth;
  setup: Readonly<{ observedAtMs: number; state: string; raw: unknown }>;
  authDiscoveredAtMs: number;
}>;

export type DesktopConnectionTheme = "light" | "dark" | null;

/** Runtime redaction at every renderer boundary; types alone are insufficient. */
export function rendererSafeConnectionValue<T extends object>(
  value: T,
): Omit<T, "fingerprint" | "expectedFingerprint" | "observedFingerprint" | "foundFingerprint"> {
  const safe = { ...value } as T & {
    fingerprint?: unknown;
    expectedFingerprint?: unknown;
    observedFingerprint?: unknown;
    foundFingerprint?: unknown;
  };
  delete safe.fingerprint;
  delete safe.expectedFingerprint;
  delete safe.observedFingerprint;
  delete safe.foundFingerprint;
  return safe;
}

/** Select only proven HTTPS history for the same logical host/port. */
export function selectPreviousHttpsOrigin(
  enteredTarget: string,
  activeOrigin: string | null,
  recents: readonly Readonly<{ url: string; fingerprint?: string }>[],
): string | null {
  let target: URL;
  try {
    target = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(enteredTarget.trim())
      ? enteredTarget.trim()
      : `https://${enteredTarget.trim()}`);
  } catch {
    return null;
  }
  const evidence = [activeOrigin, ...recents.filter((entry) => Boolean(entry.fingerprint)).map((entry) => entry.url)];
  for (const value of evidence) {
    if (!value) continue;
    try {
      const previous = new URL(value);
      if (previous.protocol === "https:" && previous.hostname === target.hostname && previous.port === target.port) {
        return previous.origin;
      }
    } catch { /* malformed history grants no evidence */ }
  }
  return null;
}

type Prepared = Readonly<{
  ok: true;
  handle: PreparedServerSwitchHandle;
  navigationReceipt: ObservationReceipt;
}> | Readonly<{ ok: false; reason: string }>;

type Promoted = Readonly<{ ok: true }> | Readonly<{
  ok: false;
  reason: string;
  handle?: PreparedServerSwitchHandle;
  checkpoint?: string;
}>;

export interface DesktopConnectionFlowDependencies {
  onPresentation?(snapshot: ConnectionPresentation): void;
  active(): Readonly<{
    authority: ActiveAuthority;
    registryScope: string | null;
  }>;
  expectedFingerprint(candidateOrigin: string): string | null;
  /** Main-owned HTTPS evidence for the entered logical host/port. */
  previousHttpsOrigin(enteredTarget: string): string | null;
  /** Exact current routed URL, kept separate from canonical authority scope. */
  activeRoutingServerUrl(): string | null;
  activateAlreadyActive?(): void;
  savePending(pending: PendingConnection): void;
  clearPending(): void;
  fetchHealth(origin: string, signal: AbortSignal): Promise<VerifiedHealth>;
  observeReadiness(origin: string, signal: AbortSignal): Promise<number>;
  observeSetup(origin: string, signal: AbortSignal): Promise<Readonly<{
    observedAtMs: number;
    state: string;
    raw: unknown;
  }>>;
  authenticateCandidate(input: Readonly<{
    routingServerUrl: string;
    health: VerifiedHealth;
    attemptId: string;
    generation: number;
    allowStoredCredentials: boolean;
    theme: DesktopConnectionTheme;
    signal: AbortSignal;
  }>): Promise<
    | Readonly<{ kind: "signed-in"; persist: () => void }>
    | Readonly<{ kind: "cancelled" | "failed" }>
  >;
  prepare(input: Readonly<{
    attemptId: string;
    generation: number;
    canonicalOrigin: string;
    routingServerUrl: string;
    identityTransition: PendingConnection["identityTransition"];
    priorRegistryScope: string | null;
    priorAuthorityGuard: ActiveAuthority;
    candidateServerFingerprint: string;
    forceDetachedReplacement?: boolean;
    acceptedIdentityReplacementReceipt?: ObservationReceipt;
    signal: AbortSignal;
  }>): Promise<Prepared>;
  cancelPrepared?(attemptId: string, generation: number): boolean;
  applyCandidateFacts(session: ServerSession, health: VerifiedHealth, options: Readonly<{
    allowStoredCredentials: boolean;
    authenticatedThisAttempt: boolean;
  }>): void;
  retireStoredCandidateIdentity(routingServerUrl: string, health: VerifiedHealth): Promise<void>;
  commitActiveAuthority(input: Readonly<{
    canonicalOrigin: string;
    routingServerUrl: string;
    attemptId: string;
    serverFingerprint: string;
    priorAuthorityGuard: ActiveAuthority;
  }>): boolean | void;
  persistMetadata(session: ServerSession, health: VerifiedHealth): Promise<void>;
  stopOldCodex(session: ServerSession): Promise<void>;
  stopOldRelay(session: ServerSession): Promise<void>;
  deactivateOldProfile(session: ServerSession): Promise<void>;
  retireOldIdentity(input: Readonly<{ priorRoutingServerUrl: string; targetRegistryScope: string }>, health: VerifiedHealth): Promise<void>;
  startTargetRelay?(session: ServerSession): Promise<void>;
  shouldStartTargetRelay?(session: ServerSession): boolean;
  onActivated?(session: ServerSession): void;
  promote(handle: PreparedServerSwitchHandle, hooks: Readonly<{
    commitActiveAuthority(): Promise<{ committed: true; followupFailure?: "metadata" } | { committed: false }>;
    persistMetadata(session: ServerSession): Promise<void>;
    stopOldCodex(session: ServerSession): Promise<void>;
    stopOldRelay(session: ServerSession): Promise<void>;
    deactivateOldProfile(session: ServerSession): Promise<void>;
    retireOldIdentity?(input: Readonly<{ priorRoutingServerUrl: string; targetRegistryScope: string }>): Promise<void>;
    startTargetRelay?(session: ServerSession): Promise<void>;
    shouldStartTargetRelay: boolean;
    persistNextCheckpoint(checkpoint: IncompletePreparedServerSwitchCheckpoint): Promise<void>;
    clearPending(): Promise<void>;
  }>): Promise<Promoted>;
  resolveUnknownCommitOutcome(
    handle: PreparedServerSwitchHandle,
    authority: ActiveAuthority,
  ): Readonly<{ outcome: "committed-handoff"; handle: PreparedServerSwitchHandle }> |
    Readonly<{ outcome: "not-committed" | "unresolved" | "stale-handle" }>;
  now?(): number;
  mintAttemptId?(): string;
}

function receipt(state: ConnectionAttemptState, origin: string, observedAtMs: number): ObservationReceipt {
  return { attemptId: state.attemptId, generation: state.generation, origin, observedAtMs };
}

function pendingRecord(input: Readonly<{
  tupleBinding: string;
  state: ConnectionAttemptState;
  candidateOrigin: string;
  authority: ActiveAuthority;
  handoffCheckpoint: "candidate" | "active-committed";
  postCommitCheckpoint: PendingConnectionPostCommitCheckpoint | null;
  identityTransition?: PendingConnection["identityTransition"];
}>): PendingConnection {
  return {
    version: 2,
    tupleBinding: input.tupleBinding,
    attemptId: input.state.attemptId,
    context: input.state.context,
    generation: input.state.generation,
    enteredTarget: input.state.enteredTarget,
    candidateOrigin: input.candidateOrigin,
    activeScopeGuard: input.authority.scope,
    activeRevisionGuard: input.authority.revision,
    identityTransition: input.identityTransition ?? { kind: "ordinary" },
    lastProgressPhase: input.state.phase === "complete" || input.state.phase === "failed" ||
        input.state.phase === "cancelled" || input.state.phase === "superseded"
      ? "promotion"
      : input.state.phase,
    handoffCheckpoint: input.handoffCheckpoint,
    postCommitCheckpoint: input.postCommitCheckpoint,
  };
}

/** Serializes attempts. Supersession aborts only work that is still precommit. */
export class DesktopConnectionFlow {
  private generation = 0;
  private controller: AbortController | null = null;
  private committedHandoff = false;
  private resumePromotion: (() => Promise<DesktopConnectionResult>) | null = null;
  private previewed: Readonly<{
    enteredTarget: string;
    origin: string;
    readinessObservedAtMs: number;
    health: VerifiedHealth;
    setup: Readonly<{ observedAtMs: number; state: string; raw: unknown }>;
    authDiscoveredAtMs: number;
  }> | null = null;
  private previewController: AbortController | null = null;
  private activeAttempt: Readonly<{ attemptId: string; generation: number }> | null = null;
  private promotionStarted = false;
  private presentationRevision = 0;
  private currentState: ConnectionAttemptState | null = null;
  private verifiedCohort: VerifiedConnectionCohort | null = null;
  private downgradeDecision: Readonly<{
    id: string;
    state: ConnectionAttemptState;
    prior: ReturnType<DesktopConnectionFlowDependencies["active"]>;
    priorRoutingServerUrl: string | null;
    controller: AbortController;
    theme: DesktopConnectionTheme;
    acceptance?: Readonly<{ priorRoutingServerUrl: string | null }>;
  }> | null = null;
  private identityDecision: Readonly<{
    id: string;
    state: ConnectionAttemptState;
    mismatch: IdentityMismatchReceipt;
    prior: ReturnType<DesktopConnectionFlowDependencies["active"]>;
    priorRoutingServerUrl: string | null;
    controller: AbortController;
    theme: DesktopConnectionTheme;
  }> | null = null;

  constructor(
    private readonly tupleBinding: string,
    private readonly deps: DesktopConnectionFlowDependencies,
  ) {}

  private publish(state: ConnectionAttemptState, terminal?: ConnectionTerminalPresentationFact): void {
    this.currentState = state;
    const presentation = presentConnectionAttempt({
      state, revision: ++this.presentationRevision, ...(terminal ? { terminal } : {}),
    });
    try { this.deps.onPresentation?.(presentation); } catch { /* presentation never owns authority */ }
  }

  private transition(
    state: ConnectionAttemptState,
    event: Parameters<typeof transitionConnectionAttempt>[1],
  ): ReturnType<typeof transitionConnectionAttempt> {
    const result = transitionConnectionAttempt(state, event);
    if (result.accepted) this.publish(result.state);
    return result;
  }

  private publishPromotionFailure(outcome: false | true | "unknown"): void {
    if (!this.currentState) return;
    if (outcome !== "unknown") {
      this.transition(this.currentState, {
        type: "failed", code: "promotion-failed",
        attemptId: this.currentState.attemptId, generation: this.currentState.generation,
        authoritativePairingChanged: outcome,
      });
      return;
    }
    this.publish(this.currentState, {
      failureCode: "promotion-failed",
      pairingStateChange: outcome === "unknown" ? "indeterminate" : outcome ? "changed" : "unchanged",
    });
  }

  /** Main-only one-shot facts handoff; never expose this value over IPC. */
  takeVerifiedCohort(url: string): VerifiedConnectionCohort | null {
    const cohort = this.verifiedCohort;
    if (!cohort || cohort.url !== url) return null;
    this.verifiedCohort = null;
    this.downgradeDecision = null;
    this.identityDecision = null;
    return cohort;
  }

  /** Consume a displayed downgrade once and continue its exact reducer state. */
  confirmDowngrade(decisionId: string): Promise<DesktopConnectionResult> {
    const decision = this.downgradeDecision;
    this.downgradeDecision = null;
    if (!decision || decision.id !== decisionId || decision.controller.signal.aborted ||
        decision.state.generation !== this.generation) {
      return Promise.resolve({ ok: false, reason: "stale" });
    }
    const current = this.deps.active();
    const expected = decision.prior.authority;
    const actual = current.authority;
    if (current.registryScope !== decision.prior.registryScope ||
        this.deps.activeRoutingServerUrl() !== decision.priorRoutingServerUrl ||
        actual.scope !== expected.scope || actual.revision !== expected.revision ||
        actual.connectionAttemptId !== expected.connectionAttemptId ||
        actual.serverFingerprint !== expected.serverFingerprint) {
      return Promise.resolve({ ok: false, reason: "stale" });
    }
    const candidate = decision.state.facts.target?.candidates[0];
    if (!candidate) return Promise.resolve({ ok: false, reason: "stale" });
    const confirmed = this.transition(decision.state, {
      type: "confirm-downgrade",
      attemptId: decision.state.attemptId,
      generation: decision.state.generation,
      receipt: {
        attemptId: decision.state.attemptId,
        generation: decision.state.generation,
        origin: candidate.origin,
        confirmedAtMs: (this.deps.now ?? Date.now)(),
      },
    });
    if (!confirmed.accepted) return Promise.resolve({ ok: false, reason: "stale" });
    return this.continueConnection(
      confirmed.state,
      decision.prior,
      decision.controller,
      decision.acceptance,
      decision.theme,
    );
  }

  /** Consume an observed mismatch, then require a fresh B proof on a new tuple. */
  acceptIdentity(decisionId: string): Promise<DesktopConnectionResult> {
    const decision = this.identityDecision;
    this.identityDecision = null;
    if (!decision || decision.id !== decisionId || decision.controller.signal.aborted ||
        decision.state.generation !== this.generation) return Promise.resolve({ ok: false, reason: "stale" });
    const current = this.deps.active();
    const expected = decision.prior.authority;
    const actual = current.authority;
    if (current.registryScope !== decision.prior.registryScope ||
        this.deps.activeRoutingServerUrl() !== decision.priorRoutingServerUrl ||
        actual.scope !== expected.scope || actual.revision !== expected.revision ||
        actual.connectionAttemptId !== expected.connectionAttemptId ||
        actual.serverFingerprint !== expected.serverFingerprint) {
      return Promise.resolve({ ok: false, reason: "stale" });
    }
    const accepted = this.transition(decision.state, {
      type: "accept-identity", attemptId: decision.state.attemptId,
      generation: decision.state.generation, mismatch: decision.mismatch,
    });
    if (!accepted.accepted) return Promise.resolve({ ok: false, reason: "stale" });
    const nextGeneration = ++this.generation;
    const nextAttemptId = connectionAttemptId((this.deps.mintAttemptId ?? randomUUID)());
    const retried = this.transition(accepted.state, {
      type: "retry-accepted-identity", attemptId: accepted.state.attemptId,
      generation: accepted.state.generation, nextAttemptId, nextGeneration,
    });
    if (!retried.accepted) return Promise.resolve({ ok: false, reason: "stale" });
    decision.controller.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.activeAttempt = { attemptId: nextAttemptId, generation: nextGeneration };
    const plan = planServerTarget(retried.state.enteredTarget, {
      previousVerifiedOrigin: this.deps.previousHttpsOrigin(retried.state.enteredTarget),
    });
    if (!plan.ok) return Promise.resolve({ ok: false, reason: "stale" });
    const normalized = this.transition(retried.state, {
      type: "target-normalized", attemptId: nextAttemptId, generation: nextGeneration, target: plan,
    });
    if (!normalized.accepted) return Promise.resolve({ ok: false, reason: "stale" });
    if (normalized.state.phase === "downgrade-confirmation") {
      const id = randomUUID();
      this.downgradeDecision = { id, state: normalized.state, prior: decision.prior,
        priorRoutingServerUrl: decision.priorRoutingServerUrl, controller,
        theme: decision.theme,
        acceptance: { priorRoutingServerUrl: decision.priorRoutingServerUrl } };
      return Promise.resolve({ ok: false, reason: "downgrade-confirmation-required", decisionId: id });
    }
    return this.continueConnection(normalized.state, decision.prior, controller, {
      priorRoutingServerUrl: decision.priorRoutingServerUrl,
    }, decision.theme);
  }

  /** Explicit UI cancellation fences late precommit work and its candidate. */
  cancel(): boolean {
    if (this.committedHandoff || this.promotionStarted) return false;
    if (this.currentState) {
      const cancelled = this.transition(this.currentState, {
        type: "cancel", attemptId: this.currentState.attemptId, generation: this.currentState.generation,
      });
      if (!cancelled.accepted && !this.currentState.authoritativePairingChanged) this.currentState = null;
    }
    this.controller?.abort();
    this.previewController?.abort();
    this.controller = null;
    this.previewController = null;
    this.previewed = null;
    this.verifiedCohort = null;
    this.downgradeDecision = null;
    this.identityDecision = null;
    this.generation += 1;
    if (this.activeAttempt) {
      this.deps.cancelPrepared?.(this.activeAttempt.attemptId, this.activeAttempt.generation);
      this.activeAttempt = null;
    }
    this.deps.clearPending();
    return true;
  }

  /** Picker Test and Connect share these exact observations; Connect never refetches them. */
  async preview(enteredTarget: string): Promise<DesktopConnectionPreview> {
    // Starting a new Test deterministically invalidates every older cohort,
    // including when the new target is invalid or its observation fails.
    this.previewed = null;
    this.downgradeDecision = null;
    this.identityDecision = null;
    const plan = planServerTarget(enteredTarget, {
      previousVerifiedOrigin: this.deps.previousHttpsOrigin(enteredTarget),
    });
    if (!plan.ok) return { ok: false, reason: "invalid-target" };
    if (plan.requiresExplicitDowngradeConfirmation) {
      return { ok: false, reason: "downgrade-confirmation-required" };
    }
    this.previewController?.abort();
    const controller = new AbortController();
    this.previewController = controller;
    for (const candidate of plan.candidates) {
      try {
        const readinessObservedAtMs = await this.deps.observeReadiness(candidate.origin, controller.signal);
        const health = await this.deps.fetchHealth(candidate.origin, controller.signal);
        if (health.answeringOrigin !== candidate.origin) continue;
        const setup = await this.deps.observeSetup(candidate.origin, controller.signal);
        const authDiscoveredAtMs = (this.deps.now ?? Date.now)();
        this.previewed = {
          enteredTarget: plan.enteredTarget,
          origin: candidate.origin,
          readinessObservedAtMs,
          health,
          setup,
          authDiscoveredAtMs,
        };
        return { ok: true, origin: candidate.origin, readinessObservedAtMs, health, setup, authDiscoveredAtMs };
      } catch {
        // Eligible target-policy fallback, if any, is the next candidate.
      }
    }
    return { ok: false, reason: "offline" };
  }

  async connect(
    enteredTarget: string,
    context: Extract<ConnectionContext, "initial" | "add" | "switch">,
    theme: DesktopConnectionTheme = null,
  ): Promise<DesktopConnectionResult> {
    this.verifiedCohort = null;
    this.downgradeDecision = null;
    this.identityDecision = null;
    if (this.committedHandoff) {
      if (this.resumePromotion) return this.resumePromotion();
      this.publishPromotionFailure(true);
      return { ok: false, reason: "promotion-failed", authoritativePairingChanged: true };
    }
    this.controller?.abort();
    this.previewController?.abort();
    this.previewController = null;
    const controller = new AbortController();
    this.controller = controller;
    const generation = ++this.generation;
    this.promotionStarted = false;
    const attemptId = connectionAttemptId((this.deps.mintAttemptId ?? randomUUID)());
    this.activeAttempt = { attemptId, generation };
    const prior = this.deps.active();
    let state = beginConnectionAttempt({
      attemptId,
      generation,
      context,
      priorActiveScope: prior.authority.scope,
      enteredTarget: enteredTarget.trim(),
    });
    this.publish(state);
    const plan = planServerTarget(enteredTarget, { previousVerifiedOrigin: this.deps.previousHttpsOrigin(enteredTarget) });
    if (!plan.ok) {
      this.transition(state, { type: "failed", code: "invalid-target", attemptId, generation });
      return { ok: false, reason: "invalid-target" };
    }
    state = this.transition(state, { type: "target-normalized", attemptId, generation, target: plan }).state;
    if (state.phase === "downgrade-confirmation") {
      const decisionId = randomUUID();
      const candidate = state.facts.target?.candidates[0];
      if (!candidate) return { ok: false, reason: "stale" };
      // Crash-safe intent only: recovery deliberately restarts normalization
      // and re-prompts; this journal can never stand in for Human consent.
      this.deps.savePending(pendingRecord({
        tupleBinding: this.tupleBinding, state, candidateOrigin: candidate.origin,
        authority: prior.authority, handoffCheckpoint: "candidate", postCommitCheckpoint: null,
      }));
      this.downgradeDecision = {
        id: decisionId,
        state,
        prior,
        priorRoutingServerUrl: this.deps.activeRoutingServerUrl(),
        controller,
        theme,
      };
      return { ok: false, reason: "downgrade-confirmation-required", decisionId };
    }
    return this.continueConnection(state, prior, controller, undefined, theme);
  }

  private async continueConnection(
    initialState: ConnectionAttemptState,
    prior: ReturnType<DesktopConnectionFlowDependencies["active"]>,
    controller: AbortController,
    acceptance?: Readonly<{ priorRoutingServerUrl: string | null }>,
    theme: DesktopConnectionTheme = null,
  ): Promise<DesktopConnectionResult> {
    let state = initialState;
    const { attemptId, generation } = state;
    const plan = state.facts.target;
    if (!plan) return { ok: false, reason: "stale" };
    let candidate = plan.candidates[0];
    if (!candidate) return { ok: false, reason: "invalid-target" };
    this.deps.savePending(pendingRecord({
      tupleBinding: this.tupleBinding, state, candidateOrigin: candidate.origin,
      authority: prior.authority, handoffCheckpoint: "candidate", postCommitCheckpoint: null,
    }));

    let health: VerifiedHealth | null = null;
    let setupObservation: Readonly<{ observedAtMs: number; state: string; raw: unknown }> | null = null;
    let setupObservedAtMs: number | null = null;
    let authDiscoveredAtMs: number | null = null;
    const previewed = this.previewed?.enteredTarget === plan.enteredTarget
      ? this.previewed
      : null;
    this.previewed = null;
    if (previewed) {
      const previewCandidate = plan.candidates.find((item) => item.origin === previewed.origin);
      if (previewCandidate) {
        if (previewCandidate !== candidate) {
          const fallback = this.transition(state, {
            type: "transport-failed", attemptId, generation,
            receipt: receipt(state, candidate.origin, previewed.readinessObservedAtMs),
            category: "network",
          });
          if (!fallback.accepted) return { ok: false, reason: "stale" };
          state = fallback.state;
        }
        candidate = previewCandidate;
        const transported = this.transition(state, {
          type: "transport-connected", attemptId, generation,
          receipt: receipt(state, candidate.origin, previewed.readinessObservedAtMs),
        });
        if (!transported.accepted) return { ok: false, reason: "stale" };
        state = transported.state;
        const ready = this.transition(state, {
          type: "readiness-observed", attemptId, generation,
          receipt: receipt(state, candidate.origin, previewed.readinessObservedAtMs),
        });
        if (!ready.accepted) return { ok: false, reason: "stale" };
        state = ready.state;
        health = previewed.health;
        setupObservation = previewed.setup;
        setupObservedAtMs = previewed.setup.observedAtMs;
        authDiscoveredAtMs = previewed.authDiscoveredAtMs;
      }
    }
    for (const plannedCandidate of health ? [] : plan.candidates) {
      candidate = plannedCandidate;
      if (controller.signal.aborted || generation !== this.generation) return { ok: false, reason: "stale" };
      try {
        const readinessAtMs = await this.deps.observeReadiness(candidate.origin, controller.signal);
        const transportReceipt = receipt(state, candidate.origin, readinessAtMs);
        const transported = this.transition(state, {
          type: "transport-connected", attemptId, generation, receipt: transportReceipt,
        });
        if (!transported.accepted) return { ok: false, reason: "stale" };
        state = transported.state;
        const ready = this.transition(state, {
          type: "readiness-observed", attemptId, generation,
          receipt: receipt(state, candidate.origin, readinessAtMs),
        });
        if (!ready.accepted) return { ok: false, reason: "stale" };
        state = ready.state;
        try {
          health = await this.deps.fetchHealth(candidate.origin, controller.signal);
        } catch {
          if (controller.signal.aborted || generation !== this.generation) return { ok: false, reason: "stale" };
          this.transition(state, { type: "failed", code: "health-unavailable", attemptId, generation });
          return { ok: false, reason: "offline" };
        }
      } catch {
        if (controller.signal.aborted || generation !== this.generation) return { ok: false, reason: "stale" };
        const failed = this.transition(state, {
          type: "transport-failed", attemptId, generation,
          receipt: receipt(state, candidate.origin, (this.deps.now ?? Date.now)()),
          category: "network",
        });
        if (failed.accepted) state = failed.state;
        continue;
      }
      if (health.answeringOrigin !== candidate.origin) {
        this.transition(state, { type: "failed", code: "health-unavailable", attemptId, generation,
          measured: { answeringOriginMatched: false } });
        return { ok: false, reason: "incompatible" };
      }
      break;
    }
    if (!health) return { ok: false, reason: "offline" };
    if (controller.signal.aborted || generation !== this.generation) return { ok: false, reason: "stale" };

    const observed = receipt(state, candidate.origin, health.observedAtMs);
    const healthObserved = this.transition(state, {
      type: "health-observed", attemptId, generation, receipt: observed,
    });
    if (!healthObserved.accepted) return { ok: false, reason: "stale" };
    state = healthObserved.state;
    const expectedFingerprint = prior.authority.scope === candidate.origin
      ? prior.authority.serverFingerprint
      : this.deps.expectedFingerprint(candidate.origin);
    const identity = this.transition(state, {
      type: "identity-observed", attemptId, generation, receipt: observed,
      expected: expectedFingerprint, observed: health.fingerprint,
    });
    state = identity.state;
    if (state.phase === "mismatch") {
      if (state.facts.acceptedMismatch) {
        // Acceptance was for B only. A fresh C can never inherit or chain it;
        // the Human must begin a wholly new connection attempt.
        return { ok: false, reason: "identity-changed-again" };
      }
      const mismatch = state.facts.mismatch;
      if (!mismatch) return { ok: false, reason: "stale" };
      this.deps.savePending(pendingRecord({ tupleBinding: this.tupleBinding, state,
        candidateOrigin: candidate.origin, authority: prior.authority,
        handoffCheckpoint: "candidate", postCommitCheckpoint: null }));
      const decisionId = randomUUID();
      this.identityDecision = { id: decisionId, state, mismatch, prior,
        priorRoutingServerUrl: this.deps.activeRoutingServerUrl(), controller, theme };
      return { ok: false, reason: "wrong-server", decisionId };
    }
    if (state.phase !== "setup") return { ok: false, reason: "incompatible" };
    if (!setupObservation) {
      try {
        setupObservation = await this.deps.observeSetup(candidate.origin, controller.signal);
        setupObservedAtMs = setupObservation.observedAtMs;
        authDiscoveredAtMs = (this.deps.now ?? Date.now)();
      } catch {
        if (controller.signal.aborted || generation !== this.generation) return { ok: false, reason: "stale" };
        state = this.transition(state, {
          type: "failed", code: "setup-discovery-failed", attemptId, generation,
        }).state;
        return { ok: false, reason: "incompatible" };
      }
    }
    if (setupObservedAtMs === null || authDiscoveredAtMs === null) return { ok: false, reason: "incompatible" };
    const setupTransition = this.transition(state, {
      type: "setup-discovered", attemptId, generation,
      receipt: receipt(state, candidate.origin, setupObservedAtMs),
    });
    if (!setupTransition.accepted) return { ok: false, reason: "stale" };
    state = setupTransition.state;
    const allowStoredCredentials = state.facts.acceptedMismatch === undefined;
    let authenticatedThisAttempt = false;
    let persistAuthenticatedCredentials = () => {};
    if (health.body["authRequired"] === true) {
      const auth = await this.deps.authenticateCandidate({
        routingServerUrl: candidate.origin,
        health,
        attemptId,
        generation,
        allowStoredCredentials,
        theme,
        signal: controller.signal,
      });
      if (auth.kind !== "signed-in") {
        if (auth.kind === "cancelled") {
          this.transition(state, { type: "cancel", attemptId, generation });
          this.deps.clearPending();
          return { ok: false, reason: "cancelled" };
        }
        this.transition(state, { type: "failed", code: "auth-discovery-failed", attemptId, generation });
        return { ok: false, reason: "incompatible" };
      }
      authenticatedThisAttempt = true;
      persistAuthenticatedCredentials = auth.persist;
    }
    const authTransition = this.transition(state, {
      type: "auth-discovered", attemptId, generation,
      receipt: receipt(state, candidate.origin, authDiscoveredAtMs),
    });
    if (!authTransition.accepted) return { ok: false, reason: "stale" };
    state = authTransition.state;

    if (prior.authority.scope === candidate.origin && prior.registryScope !== null &&
      prior.authority.serverFingerprint !== null &&
      prior.authority.serverFingerprint === health.fingerprint) {
      persistAuthenticatedCredentials();
      this.deps.clearPending();
      this.deps.activateAlreadyActive?.();
      this.verifiedCohort = {
        url: candidate.origin,
        health,
        setup: setupObservation,
        authDiscoveredAtMs,
      };
      this.controller = null;
      this.activeAttempt = null;
      return { ok: true, url: candidate.origin };
    }

    const acceptedMismatch = state.facts.acceptedMismatch;
    const activeReplacement = Boolean(acceptedMismatch && prior.authority.scope === candidate.origin &&
      prior.registryScope !== null && prior.authority.connectionAttemptId && prior.authority.serverFingerprint &&
      acceptance?.priorRoutingServerUrl);
    if (acceptedMismatch && prior.authority.scope === candidate.origin && !activeReplacement) {
      return { ok: false, reason: "incompatible" };
    }
    const identityTransition: PendingConnection["identityTransition"] = activeReplacement
      ? {
          kind: "accepted-identity-replacement",
          priorConnectionAttemptId: prior.authority.connectionAttemptId!,
          priorServerFingerprint: prior.authority.serverFingerprint!,
          priorRoutingServerUrl: acceptance!.priorRoutingServerUrl!,
        }
      : { kind: "ordinary" };
    if (acceptedMismatch && !activeReplacement) {
      try {
        await this.deps.retireStoredCandidateIdentity(candidate.origin, health);
      } catch {
        this.transition(state, { type: "failed", code: "navigation-failed", attemptId, generation });
        return { ok: false, reason: "incompatible" };
      }
    }
    const acceptedReplacementReceipt = activeReplacement ? state.facts.health : undefined;
    if (activeReplacement && !acceptedReplacementReceipt) return { ok: false, reason: "stale" };
    const prepared = await this.deps.prepare({
      attemptId, generation, canonicalOrigin: candidate.origin,
      routingServerUrl: candidate.origin, identityTransition,
      priorRegistryScope: prior.registryScope, priorAuthorityGuard: prior.authority,
      candidateServerFingerprint: health.fingerprint,
      ...(activeReplacement && acceptedReplacementReceipt ? {
        forceDetachedReplacement: true,
        acceptedIdentityReplacementReceipt: acceptedReplacementReceipt,
      } : {}),
      signal: controller.signal,
    });
    if (!prepared.ok || controller.signal.aborted || generation !== this.generation) {
      if (!controller.signal.aborted && generation === this.generation) {
        this.transition(state, { type: "failed", code: "navigation-failed", attemptId, generation });
      }
      return { ok: false, reason: controller.signal.aborted ? "stale" : "incompatible" };
    }
    const navigated = this.transition(state, {
      type: "navigation-succeeded", attemptId, generation, receipt: prepared.navigationReceipt,
    });
    if (!navigated.accepted) return { ok: false, reason: "stale" };
    state = navigated.state;
    this.deps.applyCandidateFacts(prepared.handle.session, health, {
      allowStoredCredentials,
      authenticatedThisAttempt,
    });

    let committedPending = pendingRecord({
      tupleBinding: this.tupleBinding, state, candidateOrigin: candidate.origin,
      authority: prior.authority, handoffCheckpoint: "active-committed", postCommitCheckpoint: "metadata",
      identityTransition,
    });
    const promotionHooks: Parameters<DesktopConnectionFlowDependencies["promote"]>[1] = {
      commitActiveAuthority: () => {
        const committed = this.deps.commitActiveAuthority({
          canonicalOrigin: candidate.origin,
          routingServerUrl: candidate.origin,
          attemptId,
          serverFingerprint: health.fingerprint,
          priorAuthorityGuard: prior.authority,
        });
        if (committed === false) return Promise.resolve({ committed: false });
        this.committedHandoff = true;
        try {
          this.deps.savePending(committedPending);
          return Promise.resolve({ committed: true });
        } catch {
          return Promise.resolve({ committed: true, followupFailure: "metadata" });
        }
      },
      persistMetadata: (session) => {
        if (!activeReplacement) persistAuthenticatedCredentials();
        return this.deps.persistMetadata(session, health);
      },
      stopOldCodex: (session) => this.deps.stopOldCodex(session),
      stopOldRelay: (session) => this.deps.stopOldRelay(session),
      deactivateOldProfile: (session) => this.deps.deactivateOldProfile(session),
      ...(activeReplacement ? { retireOldIdentity: async (input: Readonly<{
        priorRoutingServerUrl: string;
        targetRegistryScope: string;
      }>) => {
        await this.deps.retireOldIdentity(input, health);
        persistAuthenticatedCredentials();
      } } : {}),
      ...(this.deps.startTargetRelay ? { startTargetRelay: (session: ServerSession) => this.deps.startTargetRelay!(session) } : {}),
      shouldStartTargetRelay: this.deps.shouldStartTargetRelay?.(prepared.handle.session) ?? false,
      persistNextCheckpoint: (checkpoint) => {
        committedPending = { ...committedPending, postCommitCheckpoint: checkpoint };
        this.deps.savePending(committedPending);
        return Promise.resolve();
      },
      clearPending: () => { this.deps.clearPending(); return Promise.resolve(); },
    };
    return this.finishPreparedPromotion({
      handle: prepared.handle,
      navigationReceipt: prepared.navigationReceipt,
      hooks: promotionHooks,
      state,
      onSuccess: () => {
        if (!health || !setupObservation || authDiscoveredAtMs === null) return null;
        return { url: candidate.origin, health, setup: setupObservation, authDiscoveredAtMs };
      },
    });
  }

  /** One promotion engine for initial/add/switch. */
  private async finishPreparedPromotion(input: Readonly<{
    handle: PreparedServerSwitchHandle;
    navigationReceipt: ObservationReceipt;
    hooks: Parameters<DesktopConnectionFlowDependencies["promote"]>[1];
    state: ConnectionAttemptState;
    onSuccess: () => VerifiedConnectionCohort | null;
  }>): Promise<DesktopConnectionResult> {
    let resolvingUnknownCommit = false;
    const finishPromotion = async (): Promise<DesktopConnectionResult> => {
      this.promotionStarted = true;
      const promoted = await this.deps.promote(input.handle, input.hooks);
      if (!promoted.ok) {
        let authoritativePairingChanged: false | true | "unknown" =
          promoted.reason === "commit-outcome-unknown"
            ? "unknown"
            : this.committedHandoff;
        if (promoted.reason === "commit-failed" || promoted.reason === "stale-handle") {
          this.promotionStarted = false;
        }
        if (promoted.reason === "commit-outcome-unknown" && !resolvingUnknownCommit) {
          resolvingUnknownCommit = true;
          const resolved = this.deps.resolveUnknownCommitOutcome(
            promoted.handle ?? input.handle,
            this.deps.active().authority,
          );
          if (resolved.outcome === "committed-handoff") {
            this.committedHandoff = true;
            return finishPromotion();
          }
          if (resolved.outcome === "not-committed") {
            authoritativePairingChanged = false;
            this.promotionStarted = false;
            this.activeAttempt = null;
            this.resumePromotion = null;
            this.deps.clearPending();
          }
          if (resolved.outcome === "unresolved" || resolved.outcome === "stale-handle") {
            this.committedHandoff = true;
            this.resumePromotion = async () => {
              const retried = this.deps.resolveUnknownCommitOutcome(
                promoted.handle ?? input.handle,
                this.deps.active().authority,
              );
              if (retried.outcome === "committed-handoff") {
                this.committedHandoff = true;
                return finishPromotion();
              }
              if (retried.outcome === "not-committed") {
                this.committedHandoff = false;
                this.promotionStarted = false;
                this.activeAttempt = null;
                this.resumePromotion = null;
                this.deps.clearPending();
              }
              const retryOutcome = retried.outcome === "not-committed" ? false : "unknown";
              this.publishPromotionFailure(retryOutcome);
              return {
                ok: false,
                reason: "promotion-failed",
                authoritativePairingChanged: retryOutcome,
              };
            };
          }
        }
        this.publishPromotionFailure(authoritativePairingChanged);
        return {
          ok: false,
          reason: "promotion-failed",
          authoritativePairingChanged,
        };
      }
      const promotedState = this.transition(input.state, {
        type: "promoted",
        attemptId: input.state.attemptId,
        generation: input.state.generation,
        receipt: {
          ...input.navigationReceipt,
          committedAtMs: Math.max((this.deps.now ?? Date.now)(), input.navigationReceipt.observedAtMs),
          authoritativePairingChanged: true,
        },
      });
      if (!promotedState.accepted) {
        this.publishPromotionFailure(true);
        return { ok: false, reason: "promotion-failed", authoritativePairingChanged: true };
      }
      try { this.deps.onActivated?.(input.handle.session); } catch { /* authority is already committed */ }
      const cohort = input.onSuccess();
      if (!cohort) {
        this.publishPromotionFailure(true);
        return { ok: false, reason: "promotion-failed", authoritativePairingChanged: true };
      }
      this.committedHandoff = false;
      this.promotionStarted = false;
      this.resumePromotion = null;
      this.controller = null;
      this.activeAttempt = null;
      this.verifiedCohort = cohort;
      return { ok: true, url: cohort.url };
    };
    this.resumePromotion = finishPromotion;
    return finishPromotion();
  }
}
