/** D514 — cold recovery for an uncommitted replacement while A remains active. */
import type { ColdBootPublicState } from "./cold-boot-connection-controller";
import type {
  ActiveAuthority,
  PendingConnectionLoadResult,
  PrecommitPendingConnectionRecovery,
} from "./pending-connection";
import type {
  DesktopConnectionResult,
  VerifiedConnectionCohort,
} from "./desktop-connection-flow";

export type ActivePrecommitColdBootOutcome =
  | Readonly<{ kind: "candidate"; cohort: VerifiedConnectionCohort }>
  | Readonly<{ kind: "prior-active" }>;

export type ActivePrecommitPairResult =
  | Readonly<{ ok: true; url: string }>
  | Readonly<{ ok: false; reason: "handoff-pending" | "cancelled" | "promotion-failed" }>;

export interface ActivePrecommitColdBootTerminalPorts {
  loadPending(): PendingConnectionLoadResult;
  projectPrecommit(
    loaded: Extract<PendingConnectionLoadResult, { disposition: "precommit" }>,
  ): PrecommitPendingConnectionRecovery;
  currentAuthority(): ActiveAuthority;
  /** The retained flow owns fresh attempt/generation, persistence, and promotion. */
  connect(enteredTarget: string): Promise<DesktopConnectionResult>;
  takeVerifiedCohort(url: string): VerifiedConnectionCohort | null;
  /** True proves the flow is still precommit and its candidate was retired. */
  cancel(): boolean;
  /** Uses the existing guarded picker after cancellation proved safe. */
  pairToDifferentServer(): Promise<
    | Readonly<{ kind: "candidate"; cohort: VerifiedConnectionCohort }>
    | Readonly<{ kind: "cancelled" }>
    | Readonly<{ kind: "failed" }>
  >;
  onState(state: ColdBootPublicState): void;
}

export interface ActivePrecommitColdBootTerminal {
  /** Canonical scope for renderer-safe recovery projection, not a routing base. */
  readonly priorActiveScope: string;
  /** Human-entered target only; never a transport, identity, or authority receipt. */
  readonly recoveryTarget: string;
  snapshot(): ColdBootPublicState;
  launch(): Promise<ActivePrecommitColdBootOutcome>;
  retry(): Promise<void>;
  pairToDifferentServer(): Promise<ActivePrecommitPairResult>;
}

function matchesPriorActive(
  recovery: PrecommitPendingConnectionRecovery,
  authority: ActiveAuthority,
): boolean {
  const prior = recovery.priorRecoveryGuard;
  return prior.scope !== null && prior.revision !== null &&
    authority.scope === prior.scope && authority.revision === prior.revision;
}

/**
 * A precommit journal is only an intent to retry B. Its old network facts and
 * candidate identity are deliberately ignored; the retained flow mints fresh
 * facts and keeps its own postcommit resume closure if promotion has started.
 */
export function prepareActivePrecommitColdBootTerminal(
  ports: ActivePrecommitColdBootTerminalPorts,
): ActivePrecommitColdBootTerminal | null {
  const loaded = ports.loadPending();
  if (loaded.disposition !== "precommit") return null;
  const recovery = ports.projectPrecommit(loaded);
  // Initial/no-active recovery has a different editable-first journey. Do not
  // pretend it can safely borrow the replacement terminal's active-A release.
  if (recovery.priorActiveScope === null ||
      recovery.priorRecoveryGuard.scope === null ||
      recovery.priorRecoveryGuard.revision === null ||
      recovery.priorActiveScope !== recovery.priorRecoveryGuard.scope) {
    return null;
  }

  let state: ColdBootPublicState = { phase: "connecting", canRetry: false };
  let settled = false;
  let cohort = 0;
  let running: Promise<void> | null = null;
  let pairing: Promise<ActivePrecommitPairResult> | null = null;
  let postcommitOrUnknown = false;
  let resolveOutcome!: (outcome: ActivePrecommitColdBootOutcome) => void;
  const outcome = new Promise<ActivePrecommitColdBootOutcome>((resolve) => { resolveOutcome = resolve; });
  const publish = (phase: ColdBootPublicState["phase"], canRetry: boolean) => {
    state = { phase, canRetry };
    ports.onState(state);
  };
  const settle = (next: ActivePrecommitColdBootOutcome) => {
    if (settled) return;
    settled = true;
    publish("released", false);
    resolveOutcome(next);
  };
  const resume = async (): Promise<void> => {
    if (settled || running) return running ?? Promise.resolve();
    const currentCohort = ++cohort;
    publish("connecting", false);
    const task = Promise.resolve().then(async () => {
      try {
        // Drift is checked before the retained flow can touch candidate I/O.
        if (!postcommitOrUnknown && !matchesPriorActive(recovery, ports.currentAuthority())) {
          if (!settled && currentCohort === cohort) publish("recoverable", true);
          return;
        }
        const result = await ports.connect(recovery.enteredTarget);
        if (settled || currentCohort !== cohort) return;
        if (!result.ok) {
          postcommitOrUnknown ||= result.reason === "promotion-failed" &&
            result.authoritativePairingChanged !== false;
          publish("recoverable", true);
          return;
        }
        const verified = ports.takeVerifiedCohort(result.url);
        if (!verified || verified.url !== result.url) {
          publish("recoverable", true);
          return;
        }
        settle({ kind: "candidate", cohort: verified });
      } catch {
        if (!settled && currentCohort === cohort) publish("recoverable", true);
      } finally {
        if (currentCohort === cohort) running = null;
      }
    });
    running = task;
    return task;
  };

  return {
    priorActiveScope: recovery.priorActiveScope,
    recoveryTarget: recovery.enteredTarget,
    snapshot: () => state,
    launch: () => {
      // Keep boot suspended on this outcome, not on one abortable network
      // promise: Pair may supersede an in-flight precommit candidate.
      void resume();
      return outcome;
    },
    retry: async () => {
      // The guarded picker owns the shared flow until it closes or settles.
      if (!pairing) await resume();
    },
    pairToDifferentServer: () => {
      if (pairing) return pairing;
      const task = (async (): Promise<ActivePrecommitPairResult> => {
        try {
          if (settled || !ports.cancel()) {
            publish("recoverable", true);
            return { ok: false, reason: "handoff-pending" };
          }
          // Fence the old terminal generation before the picker can start B'.
          cohort += 1;
          running = null;
          publish("connecting", false);
          const paired = await ports.pairToDifferentServer();
          if (settled) return { ok: false, reason: "cancelled" };
        if (paired.kind === "cancelled") {
          // Continue through the ordinary A boot gate; never assert A is live.
          settle({ kind: "prior-active" });
          return { ok: false, reason: "cancelled" };
        }
        if (paired.kind === "failed") {
          publish("recoverable", true);
          return { ok: false, reason: "promotion-failed" };
        }
        settle({ kind: "candidate", cohort: paired.cohort });
        return { ok: true, url: paired.cohort.url };
        } catch {
          if (!settled) publish("recoverable", true);
          return { ok: false, reason: "promotion-failed" };
        }
      })();
      pairing = task;
      const clearPairing = () => {
        if (pairing === task) pairing = null;
      };
      void task.then(clearPairing, clearPairing);
      return task;
    },
  };
}
