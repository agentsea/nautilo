/**
 * D513 Phase 3.2 — process-local lifecycle observations for a foreground
 * turn. These are deliberately not ServerEvents: they are neither persisted
 * nor published to a Room/client. The server uses them only to decide whether
 * a previously reserved exact-client binding may become eligible.
 */
import type { InitiatingClientSurfaceV1 } from "@nautilo/types";

export type ForegroundTurnLifecycleEvent = {
  kind: "human_persisted" | "human_persist_failed";
  turnId: string;
};

export type ForegroundTurnLifecycleObserver = (
  event: ForegroundTurnLifecycleEvent,
) => void;

/** Private, nonserializable exact-client context used only to fence bursts. */
export type ForegroundTurnCoalescingContext = {
  readonly clientSessionToken: symbol;
  /** Closed, server-validated declaration; still process-local and non-authoritative. */
  readonly initiatingClientSurface: InitiatingClientSurfaceV1;
};

/** Content-free pointer to the existing durable Full-encryption operation. */
export type FullEncryptionDurableJobInputReferenceV1 = Readonly<{
  kind: "full_encryption_foreground_operation_v1";
  operationId: string;
  policyRevision: number;
  roomId: string;
}>;

/**
 * Server-private, nonserializable lifecycle handle supplied at admission.
 * JobManager stores it by virtual id before enqueue, then calls one terminal
 * branch. It must never be copied into a job input, coalesced input, event,
 * DB row, or transcript.
 */
export interface ForegroundTurnCandidate {
  onMainTurn(turnId: string): void;
  /** Arm the same exact accepted turn for the scheduler's foreground fork. */
  onForkTurn?(turnId: string): void;
  onIneligible(): void;
  /** Optional exact-turn execution scope; never copied into serializable work. */
  runMainTurn?<T>(
    turnId: string,
    work: (
      inputOverride?: Readonly<{ message: string }>,
      authorizationSignal?: AbortSignal,
    ) => Promise<T>,
  ): Promise<T>;
  /** Optional exact-turn fork scope; never copied into serializable work. */
  runForkTurn?<T>(
    turnId: string,
    work: (
      inputOverride?: Readonly<{ message: string }>,
      authorizationSignal?: AbortSignal,
    ) => Promise<T>,
  ): Promise<T>;
  /** Never copied into Job input, coalesced input, event, DB row, or transcript. */
  readonly coalescingContext?: ForegroundTurnCoalescingContext;
  /**
   * Projected by the trusted capability owner. This is correlation only, not
   * serialized grant material and not authority to reopen after restart.
   */
  readonly durableJobInputReference?: FullEncryptionDurableJobInputReferenceV1;
  readonly durableJobInputDisposition?: "full";
}

let installed: { token: symbol; observer: ForegroundTurnLifecycleObserver } | null = null;

/**
 * Installs the one process-owned observer. Replacing an older observer is
 * intentional for repeated `createApp()` construction in tests; an older
 * cleanup closure cannot remove its replacement.
 */
export function installForegroundTurnLifecycleObserver(
  observer: ForegroundTurnLifecycleObserver,
): () => void {
  const token = Symbol("foreground-turn-lifecycle");
  installed = { token, observer };
  return () => {
    if (installed?.token === token) installed = null;
  };
}

export function notifyForegroundTurnLifecycle(event: ForegroundTurnLifecycleEvent): void {
  try {
    installed?.observer(event);
  } catch {
    // A delivery-eligibility observer is advisory to the durable turn. It may
    // only remove automatic-presentation eligibility; it can never turn a
    // successful append or scheduler operation into a failed Human message.
    // Do not include ids/content in this fixed diagnostic.
    console.warn("[foreground-turn-lifecycle] observer failed; eligibility dropped");
  }
}

/** Narrow test reset; production installation always goes through the guarded API. */
export function _resetForegroundTurnLifecycleObserverForTests(): void {
  installed = null;
}
