/**
 * D514 Phase 0 — pure, main-process-owned cold-boot health observation.
 *
 * This module has no Electron dependency. It deliberately retains a verified
 * response body only inside the main-process result so callers can reuse it
 * for Logto discovery without asking a renderer to issue another /health
 * request. Diagnostics are a separate content-safe projection.
 */

import { randomUUID } from "node:crypto";

import {
  beginConnectionAttempt,
  connectionAttemptId,
  transitionConnectionAttempt,
  type ConnectionAttemptState,
  type ConnectionContext,
  type ConnectionAttemptId,
  type ObservationReceipt,
} from "./connection-attempt";
import { planServerTarget, type NormalizedServerTarget } from "./server-target";

export type ColdBootObservation =
  | { kind: "connecting"; generation: number; serverUrl: string | null }
  | {
      kind: "live";
      generation: number;
      serverUrl: string;
      healthBody: Record<string, unknown>;
    }
  | { kind: "unavailable"; generation: number; serverUrl: string }
  | { kind: "malformed"; generation: number; serverUrl: string }
  | {
      kind: "wrong-server";
      generation: number;
      serverUrl: string;
      expectedFingerprint: string;
      observedFingerprint: string;
      healthBody: Record<string, unknown>;
    }
  | { kind: "no-pairing"; generation: number };

export type ColdBootPhase = "health" | "identity" | "recovery" | "auth" | "navigation";
export type ColdBootCategory =
  | "connecting"
  | "verified"
  | "status"
  | "network"
  | "invalid-json"
  | "malformed"
  | "missing"
  | "mismatch"
  | "retry-requested"
  | "cancelled"
  | "superseded"
  | "auth-resolved"
  | "auth-unresolved"
  | "navigation-released"
  | "navigation-blocked"
  | "accepted";

export type ColdBootDiagnostic = {
  generation: number;
  phase: ColdBootPhase;
  category: ColdBootCategory;
  durationMs: number;
  acceptedGeneration: boolean;
  stateChanged: boolean;
};

export type ColdBootFetch = (
  input: string,
  init: RequestInit,
) => Promise<{ ok: boolean; json: () => Promise<unknown>; url?: string }>;

export type ColdBootObservationDeps = {
  fetch: ColdBootFetch;
  expectedFingerprint: (serverUrl: string) => string | null;
  fingerprintFromHealthBody: (body: Record<string, unknown>) => string | null;
  /** Informational only. It never grants a new pairing or mutates the reducer. */
  priorActiveScope?: () => string | null;
  now?: () => number;
  /** Durable-eligible attempts must never alias across fresh processes. */
  mintAttemptId?: () => string;
  onDiagnostic?: (diagnostic: ColdBootDiagnostic) => void;
};

type WrongServerAcceptance = Extract<ColdBootObservation, { kind: "wrong-server" }>;
export type ColdBootAcceptanceProof = Readonly<{
  /** Main-only provisional proof: never project this to a renderer as live. */
  kind: "acceptance-proof";
  attemptId: ConnectionAttemptId;
  generation: number;
  serverUrl: string;
  displayedGeneration: number;
  observedFingerprint: string;
  healthBody: Record<string, unknown>;
  receipt: ObservationReceipt;
}>;
export type ColdBootObserveResult = ColdBootObservation | ColdBootAcceptanceProof;
type PendingWrongServerAcceptance = {
  displayed: WrongServerAcceptance;
  displayedAttempt: ConnectionAttemptState;
  acceptedIdentity: string;
  proof: ColdBootAcceptanceProof | null;
};
export type ColdBootObserveOptions = {
  forceFresh?: boolean;
  /**
   * A Human's trust decision is bound to the mismatch they actually saw.
   * The following request must re-prove that same observed identity before
   * it can become live; it never promotes the stale mismatch body itself.
   */
  acceptDisplayedWrongServer?: WrongServerAcceptance;
};

/**
 * A completed DesktopConnectionFlow cohort may be projected into this
 * renderer-facing authority without repeating its already-verified health
 * request. This remains main-process-only; callers must have completed the
 * flow's identity, CAS, and promotion boundary first.
 */
export type VerifiedColdBootCohort = Readonly<{
  serverUrl: string;
  healthBody: Readonly<Record<string, unknown>>;
  fingerprint: string;
}>;

type PersistedColdBootTarget = {
  target: NormalizedServerTarget;
  /** Legacy config can be scoped below origin; keep that existing health base. */
  healthBase: string;
};

function planPersistedColdBootTarget(serverUrl: string): PersistedColdBootTarget | null {
  const strict = planServerTarget(serverUrl);
  if (strict.ok) {
    const candidate = strict.candidates[0];
    if (!candidate) return null;
    // A bare saved host has no URL scheme/base of its own. Fetch the exact
    // selected transport origin; only legacy scoped URLs retain a path base.
    return { target: strict, healthBase: candidate.origin };
  }

  // D514 deliberately does not migrate old scoped server URLs. Those are
  // still valid saved pairings, so health continues below their exact base
  // while receipts remain tightly origin-bound.
  try {
    const parsed = new URL(serverUrl);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password ||
      parsed.search || parsed.hash || parsed.pathname === "/" || !parsed.pathname) return null;
    const scheme = parsed.protocol.slice(0, -1) as "http" | "https";
    return {
      healthBase: serverUrl.replace(/\/$/, ""),
      target: {
        ok: true,
        enteredTarget: serverUrl,
        canonicalOrigin: parsed.origin,
        explicitScheme: scheme,
        candidates: [{ origin: parsed.origin, scheme, reason: "explicit" }],
        previousHttpsEvidence: false,
        requiresExplicitDowngradeConfirmation: false,
      },
    };
  } catch {
    return null;
  }
}

export class ColdBootObservationAuthority {
  private generation = 0;
  private current: ColdBootObservation = {
    kind: "connecting",
    generation: 0,
    serverUrl: null,
  };
  private inFlight: Promise<ColdBootObserveResult> | null = null;
  private abortController: AbortController | null = null;
  /** The authoritative D514 attempt behind the renderer-safe observation. */
  private attempt: ConnectionAttemptState | null = null;
  private pendingAcceptance: PendingWrongServerAcceptance | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: ColdBootObservationDeps) {
    this.now = deps.now ?? Date.now;
  }

  snapshot(): ColdBootObservation {
    return this.current;
  }

  /** Main-only audit projection; never send this attempt or its receipts to a renderer. */
  attemptSnapshot(): ConnectionAttemptState | null {
    return this.attempt;
  }

  /**
   * Projects one already-promoted connection cohort to the bootstrap authority.
   * It neither fetches nor manufactures an attempt: DesktopConnectionFlow owns
   * the verified transport, identity, and durable-CAS proof. A live probe or a
   * pending human identity acceptance can never be overwritten by this bridge.
   */
  projectVerifiedCohort(cohort: VerifiedColdBootCohort): ColdBootObservation {
    const target = planServerTarget(cohort.serverUrl);
    const candidate = target.ok ? target.candidates[0] : null;
    const observedFingerprint = this.deps.fingerprintFromHealthBody({ ...cohort.healthBody });
    const expectedFingerprint = this.deps.expectedFingerprint(cohort.serverUrl);
    if (
      !candidate ||
      candidate.origin !== cohort.serverUrl ||
      observedFingerprint !== cohort.fingerprint ||
      (expectedFingerprint !== null && expectedFingerprint !== cohort.fingerprint) ||
      this.inFlight !== null ||
      this.pendingAcceptance !== null
    ) return this.current;

    const generation = this.generation + 1;
    this.generation = generation;
    this.attempt = null;
    this.current = {
      kind: "live",
      generation,
      serverUrl: cohort.serverUrl,
      healthBody: { ...cohort.healthBody },
    };
    this.emit(generation, "identity", "verified", 0, true, true);
    return this.current;
  }

  observe(
    serverUrl: string,
    options: ColdBootObserveOptions = {},
  ): Promise<ColdBootObserveResult> {
    if (
      this.inFlight &&
      "serverUrl" in this.current &&
      this.current.serverUrl === serverUrl &&
      !options.forceFresh
    ) {
      return this.inFlight;
    }
    const acceptance = this.recordDisplayedAcceptance(serverUrl, options.acceptDisplayedWrongServer);
    const previousGeneration = this.generation;
    const generation = this.generation + 1;
    const nextAttemptId = connectionAttemptId((this.deps.mintAttemptId ?? randomUUID)());
    if (acceptance) {
      const acceptedAttempt = this.attempt;
      this.abortController?.abort();
      if (!acceptedAttempt || !this.transition({
        type: "retry-accepted-identity",
        attemptId: acceptedAttempt.attemptId,
        generation: acceptedAttempt.generation,
        nextAttemptId,
        nextGeneration: generation,
      })) {
        return Promise.resolve(this.current);
      }
      this.generation = generation;
    } else if (this.inFlight) {
      this.generation = generation;
      this.abortController?.abort();
      this.supersedeAttempt();
      this.emit(previousGeneration, "recovery", "superseded", 0, false, false);
    } else {
      this.generation = generation;
    }
    this.pendingAcceptance = acceptance;
    // Human acceptance keeps the displayed mismatch authoritative while the
    // fresh B proof is pending. A coalesced retry therefore cannot observe a
    // speculative live state or release boot.
    if (!acceptance) this.current = { kind: "connecting", generation, serverUrl };
    if (!acceptance) {
      this.attempt = beginConnectionAttempt({
        attemptId: nextAttemptId,
        generation,
        context: "cold-boot" satisfies ConnectionContext,
        priorActiveScope: this.deps.priorActiveScope?.() ?? null,
        enteredTarget: serverUrl,
      });
    }
    this.emit(generation, "health", "connecting", 0);
    const activeAttempt = this.attempt;
    if (!activeAttempt) return Promise.resolve(this.current);
    const promise = this.run(serverUrl, generation, activeAttempt.attemptId, acceptance);
    this.inFlight = promise;
    void promise.finally(() => {
      if (this.inFlight === promise) {
        this.inFlight = null;
        this.abortController = null;
      }
    });
    return promise;
  }

  /** Cancels any in-flight probe and prevents its late result becoming truth. */
  cancel(): void {
    if (!this.inFlight) return;
    const cancelledGeneration = this.generation;
    this.abortController?.abort();
    this.cancelAttempt();
    this.inFlight = null;
    this.abortController = null;
    this.pendingAcceptance = null;
    const cancelledServerUrl = "serverUrl" in this.current ? this.current.serverUrl : null;
    this.current = cancelledServerUrl
      ? { kind: "unavailable", generation: cancelledGeneration, serverUrl: cancelledServerUrl }
      : { kind: "no-pairing", generation: cancelledGeneration };
    this.emit(cancelledGeneration, "recovery", "cancelled", 0, false, true);
  }

  /**
   * The single synchronous linearization point after main has durably saved
   * the accepted fingerprint. A stale/provisional proof is never promotable.
   */
  commitAcceptedWrongServer(proof: ColdBootAcceptanceProof): ColdBootObservation {
    const pending = this.pendingAcceptance;
    const current = this.current;
    if (!pending || pending.proof !== proof ||
      current.kind !== "wrong-server" ||
      current.generation !== pending.displayed.generation ||
      current.serverUrl !== pending.displayed.serverUrl ||
      current.expectedFingerprint !== pending.displayed.expectedFingerprint ||
      current.observedFingerprint !== pending.displayed.observedFingerprint ||
      proof.serverUrl !== current.serverUrl ||
      proof.observedFingerprint !== current.observedFingerprint ||
      !this.isCurrentAttempt(proof.attemptId, proof.generation) ||
      this.attempt?.phase !== "setup" ||
      this.attempt.facts.health?.attemptId !== proof.attemptId ||
      this.attempt.facts.health?.generation !== proof.generation ||
      this.attempt.facts.health?.origin !== proof.receipt.origin ||
      this.attempt.facts.health?.observedAtMs !== proof.receipt.observedAtMs) return current;

    const accepted: ColdBootObservation = {
      kind: "live",
      generation: proof.generation,
      serverUrl: proof.serverUrl,
      healthBody: proof.healthBody,
    };
    this.pendingAcceptance = null;
    this.current = accepted;
    this.emit(proof.generation, "identity", "verified", 0, true, true);
    return accepted;
  }

  /** Restore the exact mismatch state when persistence fails before commit. */
  rollbackAcceptedWrongServer(proof: ColdBootAcceptanceProof): ColdBootObservation {
    const pending = this.pendingAcceptance;
    if (!pending || pending.proof !== proof ||
      !this.isCurrentAttempt(proof.attemptId, proof.generation) ||
      this.attempt?.phase !== "setup") return this.current;
    this.attempt = pending.displayedAttempt;
    this.current = pending.displayed;
    this.pendingAcceptance = null;
    return this.current;
  }

  private async run(
    serverUrl: string,
    generation: number,
    attemptId: ReturnType<typeof connectionAttemptId>,
    acceptance: PendingWrongServerAcceptance | null,
  ): Promise<ColdBootObserveResult> {
    const startedAt = this.now();
    const controller = new AbortController();
    this.abortController = controller;
    const finish = (
      observation: ColdBootObservation,
      phase: ColdBootPhase,
      category: ColdBootCategory,
    ): ColdBootObservation => {
      const durationMs = Math.max(0, this.now() - startedAt);
      if (!this.isCurrentAttempt(attemptId, generation)) return this.current;
      this.clearPendingAcceptance(attemptId, generation);
      this.current = observation;
      this.emit(generation, phase, category, durationMs);
      return observation;
    };
    const planned = planPersistedColdBootTarget(serverUrl);
    if (!planned) {
      this.transition({ type: "failed", attemptId, generation, code: "invalid-target" });
      return finish({ kind: "malformed", generation, serverUrl }, "health", "malformed");
    }
    if (!this.transition({ type: "target-normalized", attemptId, generation, target: planned.target })) {
      return this.current;
    }
    const candidate = this.attempt?.facts.target?.candidates[0];
    if (!candidate) {
      this.transition({ type: "failed", attemptId, generation, code: "transport-unavailable" });
      return finish({ kind: "unavailable", generation, serverUrl }, "health", "network");
    }

    const receiptFor = (responseUrl?: string): ObservationReceipt | null => {
      let origin = candidate.origin;
      if (responseUrl) {
        try {
          origin = new URL(responseUrl).origin;
        } catch {
          return null;
        }
      }
      return { attemptId, generation, origin, observedAtMs: this.now() };
    };
    try {
      const response = await this.deps.fetch(`${planned.healthBase}/health`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      const receipt = receiptFor(response.url);
      if (!receipt || !this.transition({ type: "transport-connected", attemptId, generation, receipt }) ||
        !this.transition({ type: "readiness-observed", attemptId, generation, receipt })) {
        this.failCurrentAttempt(attemptId, generation);
        return finish({ kind: "unavailable", generation, serverUrl }, "health", "network");
      }
      if (!response.ok) {
        this.transition({ type: "failed", attemptId, generation, code: "health-unavailable" });
        return finish({ kind: "unavailable", generation, serverUrl }, "health", "status");
      }
      let rawBody: unknown;
      try {
        rawBody = await response.json();
      } catch {
        this.transition({ type: "failed", attemptId, generation, code: "health-unavailable" });
        return finish({ kind: "malformed", generation, serverUrl }, "health", "invalid-json");
      }
      if (
        typeof rawBody !== "object" ||
        rawBody === null ||
        Array.isArray(rawBody) ||
        typeof (rawBody as Record<string, unknown>)["status"] !== "string"
      ) {
        this.transition({ type: "failed", attemptId, generation, code: "health-unavailable" });
        return finish({ kind: "malformed", generation, serverUrl }, "health", "malformed");
      }
      const healthBody = rawBody as Record<string, unknown>;
      const observedFingerprint = this.deps.fingerprintFromHealthBody(healthBody);
      if (!observedFingerprint) {
        this.transition({ type: "health-observed", attemptId, generation, receipt });
        this.transition({ type: "identity-observed", attemptId, generation, receipt, expected: acceptance?.acceptedIdentity ?? this.deps.expectedFingerprint(serverUrl), observed: null });
        return finish({ kind: "malformed", generation, serverUrl }, "identity", "missing");
      }
      const expectedFingerprint = acceptance?.acceptedIdentity ?? this.deps.expectedFingerprint(serverUrl);
      if (!this.transition({ type: "health-observed", attemptId, generation, receipt }) ||
        !this.transition({ type: "identity-observed", attemptId, generation, receipt, expected: expectedFingerprint, observed: observedFingerprint })) {
        this.failCurrentAttempt(attemptId, generation);
        return finish({ kind: "unavailable", generation, serverUrl }, "health", "network");
      }
      if (expectedFingerprint && expectedFingerprint !== observedFingerprint) {
        this.clearPendingAcceptance(attemptId, generation);
        return finish(
          {
            kind: "wrong-server",
            generation,
            serverUrl,
            expectedFingerprint,
            observedFingerprint,
            healthBody,
          },
          "identity",
          "mismatch",
        );
      }
      if (!this.isCurrentAttempt(attemptId, generation) || this.attempt?.phase !== "setup") {
        return this.current;
      }
      if (acceptance) {
        const proof: ColdBootAcceptanceProof = {
          kind: "acceptance-proof",
          attemptId,
          generation,
          serverUrl,
          displayedGeneration: acceptance.displayed.generation,
          observedFingerprint,
          healthBody,
          receipt,
        };
        if (!this.pendingAcceptance ||
          this.pendingAcceptance.displayed.generation !== acceptance.displayed.generation ||
          this.pendingAcceptance.acceptedIdentity !== observedFingerprint) return this.current;
        this.pendingAcceptance.proof = proof;
        return proof;
      }
      return finish({ kind: "live", generation, serverUrl, healthBody }, "health", "verified");
    } catch {
      if (this.isCurrentAttempt(attemptId, generation) && !controller.signal.aborted) {
        this.transition({ type: "failed", attemptId, generation, code: "transport-unavailable" });
      }
      return finish(
        { kind: "unavailable", generation, serverUrl },
        "health",
        "network",
      );
    }
  }

  private transition(event: Parameters<typeof transitionConnectionAttempt>[1]): boolean {
    if (!this.attempt) return false;
    const transition = transitionConnectionAttempt(this.attempt, event);
    if (!transition.accepted) return false;
    this.attempt = transition.state;
    return true;
  }

  private isCurrentAttempt(
    attemptId: ReturnType<typeof connectionAttemptId>,
    generation: number,
  ): boolean {
    return generation === this.generation &&
      this.attempt?.attemptId === attemptId &&
      this.attempt.generation === generation &&
      this.attempt.phase !== "cancelled" &&
      this.attempt.phase !== "superseded";
  }

  private cancelAttempt(): void {
    if (!this.attempt) return;
    this.transition({
      type: "cancel",
      attemptId: this.attempt.attemptId,
      generation: this.attempt.generation,
    });
  }

  private supersedeAttempt(): void {
    if (!this.attempt) return;
    this.transition({
      type: "supersede",
      attemptId: this.attempt.attemptId,
      generation: this.attempt.generation,
    });
  }

  private failCurrentAttempt(
    attemptId: ReturnType<typeof connectionAttemptId>,
    generation: number,
  ): void {
    if (!this.isCurrentAttempt(attemptId, generation)) return;
    const codeByPhase: Partial<Record<ConnectionAttemptState["phase"], "transport-unavailable" | "readiness-unavailable" | "health-unavailable" | "identity-missing">> = {
      transport: "transport-unavailable",
      readiness: "readiness-unavailable",
      health: "health-unavailable",
      identity: "identity-missing",
    };
    const code = codeByPhase[this.attempt?.phase ?? "failed"];
    if (code) this.transition({ type: "failed", attemptId, generation, code });
  }

  private recordDisplayedAcceptance(
    serverUrl: string,
    displayed: WrongServerAcceptance | undefined,
  ): PendingWrongServerAcceptance | null {
    const current = this.current;
    if (!displayed || displayed.serverUrl !== serverUrl ||
      current.kind !== "wrong-server" ||
      current.generation !== displayed.generation ||
      current.serverUrl !== displayed.serverUrl ||
      current.expectedFingerprint !== displayed.expectedFingerprint ||
      current.observedFingerprint !== displayed.observedFingerprint) return null;
    const displayedAttempt = this.attempt;
    const mismatch = this.attempt?.facts.mismatch;
    if (!displayedAttempt || !mismatch || mismatch.expectedIdentity !== displayed.expectedFingerprint ||
      mismatch.observedIdentity !== displayed.observedFingerprint ||
      mismatch.observation.attemptId !== this.attempt?.attemptId ||
      mismatch.observation.generation !== displayed.generation ||
      !this.transition({
        type: "accept-identity",
        attemptId: mismatch.observation.attemptId,
        generation: mismatch.observation.generation,
        mismatch,
      })) return null;
    // The reducer records the exact Human decision first. We then supersede
    // its post-acceptance health phase with a fresh B-proof generation.
    this.emit(displayed.generation, "identity", "accepted", 0, true, true);
    return { displayed, displayedAttempt, acceptedIdentity: displayed.observedFingerprint, proof: null };
  }

  private clearPendingAcceptance(
    attemptId: ConnectionAttemptId,
    generation: number,
  ): void {
    if (this.pendingAcceptance?.proof?.attemptId === attemptId &&
      this.pendingAcceptance.proof.generation === generation) this.pendingAcceptance = null;
    // Before a proof exists it is still owned by the current fresh generation.
    if (this.pendingAcceptance && this.attempt?.attemptId === attemptId &&
      this.attempt.generation === generation) this.pendingAcceptance = null;
  }

  private emit(
    generation: number,
    phase: ColdBootPhase,
    category: ColdBootCategory,
    durationMs: number,
    acceptedGeneration = true,
    stateChanged = true,
  ): void {
    try {
      this.deps.onDiagnostic?.({
        generation,
        phase,
        category,
        durationMs,
        acceptedGeneration,
        stateChanged,
      });
    } catch {
      // Diagnostics are never allowed to change connection authority.
    }
  }
}
