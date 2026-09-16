/**
 * D514 — cold boot recovery coordination.
 *
 * This deliberately owns no durable connection fact.  Config, the pending
 * journal, the session registry, and health observation stay authoritative;
 * this small reducer only gives a launch/retry cohort an abort fence and
 * keeps presentation local until the owner says it is safe to release.
 */

import type {
  CommittedHandoffPendingConnectionRecovery,
  PendingConnectionRecovery,
  PrecommitPendingConnectionRecovery,
} from "./pending-connection";

export type ColdBootPresentationState =
  | "connecting"
  | "recoverable"
  | "gated"
  | "released";

export type ColdBootPublicState = Readonly<{
  phase: ColdBootPresentationState;
  canRetry: boolean;
}>;

export type ColdBootCommittedReconstruction<Proof, Facts> = Readonly<{
  /** Main-private facts: never put these in the renderer projection. */
  proof: Proof;
  facts: Facts;
}>;

export type ColdBootPausedPromotionResult<Handle> =
  | Readonly<{ ok: true; paused: true; handle: Handle }>
  | Readonly<{ ok: false }>;

export type ColdBootPresentationReleaseResult<Handle> =
  | Readonly<{ ok: true; paused: false; handle: Handle }>
  | Readonly<{ ok: false }>;

export type ColdBootConnectionControllerDependencies<Handle, Proof, Facts, DisplayedIdentity = never> = Readonly<{
  /** Starts the local shell. It must happen before pending load or network. */
  initiateLocalShell(): void | Promise<void>;
  /** Registry hooks must exist before pending committed recovery fences it. */
  configureRegistry(): void;
  loadPending(): PendingConnectionRecovery | null;
  /**
   * Normal no-journal cold launch. True means all required setup, auth,
   * onboarding, and navigation gates completed and presentation is safe.
   * No elapsed time is terminal.
   */
  freshColdBoot(signal: AbortSignal): Promise<boolean>;
  /**
   * Precommit data is intent only: mint fresh attempt/generation and return
   * true only after all gates completed and presentation is safe.
   */
  restartPrecommit(
    recovery: PrecommitPendingConnectionRecovery,
    signal: AbortSignal,
  ): Promise<boolean>;
  /** Synchronous privilege fence; no await is permitted before this returns. */
  beginCommitted(
    recovery: CommittedHandoffPendingConnectionRecovery,
  ): Handle | null;
  /** Fresh readiness, health, setup, auth, and navigation reconstruction. */
  reconstructCommitted(
    recovery: CommittedHandoffPendingConnectionRecovery,
    handle: Handle,
    signal: AbortSignal,
  ): Promise<ColdBootCommittedReconstruction<Proof, Facts> | null>;
  completeCommitted(handle: Handle, proof: Proof): boolean;
  /** The first promotion pauses immediately before renderer authority. */
  promoteCommitted(
    handle: Handle,
    options: Readonly<{ pauseBeforeRendererAuthority: boolean }>,
  ): Promise<ColdBootPausedPromotionResult<Handle>>;
  /** Candidate-scoped auth/onboarding; must not derive state from active A. */
  runCandidateGates(handle: Handle, facts: Facts, signal: AbortSignal): Promise<boolean>;
  /** Replays the exact paused transaction only; it never recommits config. */
  resumePresentation(handle: Handle): Promise<ColdBootPresentationReleaseResult<Handle>>;
  /**
   * Explicit mismatch acceptance. The adapter must freshly prove the exact
   * displayed B, reject B→C, isolate its candidate, commit once, retire old
   * credentials after commit, then run candidate-only auth/onboarding while
   * presentation remains paused.
   */
  acceptDisplayedWrongServer?(
    displayed: DisplayedIdentity,
    signal: AbortSignal,
  ): Promise<boolean>;
  onState?(state: ColdBootPublicState): void;
}>;

/**
 * One cold launch controller per main process. Retry supersedes fresh and
 * precommit work; an already committed B instead recovers forward on its
 * exact fenced handle.
 */
export class ColdBootConnectionController<Handle, Proof, Facts, DisplayedIdentity = never> {
  private generation = 0;
  private current: AbortController | null = null;
  private committed: Readonly<{
    recovery: CommittedHandoffPendingConnectionRecovery;
    handle: Handle;
    stage: "reconstruct" | "promote" | "gates" | "resume";
    facts?: Facts;
  }> | null = null;
  private state: ColdBootPublicState = { phase: "connecting", canRetry: false };

  constructor(
    private readonly deps: ColdBootConnectionControllerDependencies<Handle, Proof, Facts, DisplayedIdentity>,
  ) {}

  snapshot(): ColdBootPublicState {
    return this.state;
  }

  /** Main-only: legacy IPC must not supersede a committed recovery handle. */
  hasCommittedRecovery(): boolean {
    return this.committed !== null;
  }

  async launch(): Promise<void> {
    await this.start("launch");
  }

  async retry(): Promise<void> {
    await this.start("retry");
  }

  async useDisplayedWrongServer(displayed: DisplayedIdentity): Promise<void> {
    if (this.committed) {
      this.publish("recoverable", true);
      return;
    }
    if (!this.deps.acceptDisplayedWrongServer) {
      this.publish("recoverable", true);
      return;
    }
    this.current?.abort();
    const controller = new AbortController();
    this.current = controller;
    const cohort = ++this.generation;
    this.publish("connecting", false);
    try {
      const released = await this.deps.acceptDisplayedWrongServer(displayed, controller.signal);
      if (this.active(cohort, controller.signal)) {
        this.publish(released ? "released" : "recoverable", !released);
      }
    } catch {
      if (this.active(cohort, controller.signal)) this.publish("recoverable", true);
    }
  }

  private publish(phase: ColdBootPresentationState, canRetry: boolean): void {
    this.state = { phase, canRetry };
    this.deps.onState?.(this.state);
  }

  private active(cohort: number, signal: AbortSignal): boolean {
    return !signal.aborted && cohort === this.generation;
  }

  private async start(_reason: "launch" | "retry"): Promise<void> {
    this.current?.abort();
    const controller = new AbortController();
    this.current = controller;
    const cohort = ++this.generation;
    this.publish("connecting", false);

    // This is intentionally before `loadPending`, which can synchronously
    // touch disk and may lead to a network recovery below.
    try {
      await this.deps.initiateLocalShell();
      if (!this.active(cohort, controller.signal)) return;
      this.deps.configureRegistry();
      if (!this.active(cohort, controller.signal)) return;
      if (this.committed) {
        await this.resumeCommitted(this.committed, cohort, controller.signal);
        return;
      }
      const recovery = this.deps.loadPending();
      if (!this.active(cohort, controller.signal)) return;
      if (!recovery) {
        const released = await this.deps.freshColdBoot(controller.signal);
        if (this.active(cohort, controller.signal)) this.publish(released ? "released" : "recoverable", !released);
        return;
      }
      if (recovery.disposition === "precommit") {
        const resumed = await this.deps.restartPrecommit(recovery, controller.signal);
        if (this.active(cohort, controller.signal)) this.publish(resumed ? "released" : "recoverable", !resumed);
        return;
      }
      // Fence B synchronously before one await or fresh network reconstruction.
      const handle = this.deps.beginCommitted(recovery);
      if (!this.active(cohort, controller.signal)) return;
      if (!handle) {
        this.publish("recoverable", true);
        return;
      }
      this.committed = { recovery, handle, stage: "reconstruct" };
      await this.resumeCommitted(this.committed, cohort, controller.signal);
    } catch {
      // Network/disk/view failures must retain local recovery; the controller
      // never rejects into the ordinary boot tail.
      if (this.active(cohort, controller.signal)) this.publish("recoverable", true);
    }
  }

  private async resumeCommitted(
    committed: Readonly<{
      recovery: CommittedHandoffPendingConnectionRecovery;
      handle: Handle;
      stage: "reconstruct" | "promote" | "gates" | "resume";
      facts?: Facts;
    }>,
    cohort: number,
    signal: AbortSignal,
  ): Promise<void> {
    let current = committed;
    if (current.stage === "reconstruct") {
      const reconstructed = await this.deps.reconstructCommitted(current.recovery, current.handle, signal);
      if (!this.active(cohort, signal)) return;
      if (!reconstructed || !this.deps.completeCommitted(current.handle, reconstructed.proof)) {
        this.publish("recoverable", true);
        return;
      }
      current = { ...current, stage: "promote", facts: reconstructed.facts };
      this.committed = current;
    }
    if (current.stage === "promote") {
      const paused = await this.deps.promoteCommitted(current.handle, { pauseBeforeRendererAuthority: true });
      if (!this.active(cohort, signal)) return;
      if (!paused.ok || !paused.paused) {
        this.publish("recoverable", true);
        return;
      }
      current = { ...current, handle: paused.handle, stage: "gates" };
      this.committed = current;
    }
    if (current.stage === "gates") {
      this.publish("gated", false);
      if (current.facts === undefined) {
        this.publish("recoverable", true);
        return;
      }
      const gatesPassed = await this.deps.runCandidateGates(current.handle, current.facts, signal);
      if (!this.active(cohort, signal)) return;
      if (!gatesPassed) {
        this.publish("recoverable", true);
        return;
      }
      current = { ...current, stage: "resume" };
      this.committed = current;
    }
    const released = await this.deps.resumePresentation(current.handle);
    if (!this.active(cohort, signal)) return;
    const complete = released.ok;
    if (complete) this.committed = null;
    this.publish(complete ? "released" : "recoverable", !complete);
  }
}
