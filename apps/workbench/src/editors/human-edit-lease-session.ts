import type {
  AnchoredTextPatch,
  HumanEditLeaseCandidateTarget,
  HumanEditLeaseRecord,
  HumanEditLeaseState,
  HumanEditLeaseStoreResult,
  RegisterHumanEditLeaseRequest,
  ReleaseHumanEditLeaseRequest,
  RenewHumanEditLeaseRequest,
  UpdateHumanEditLeaseRequest,
} from "@nautilo/types";

/** Narrow client boundary so this controller remains DOM/React independent. */
export interface HumanEditLeaseTransport {
  registerHumanEditLease(
    input: RegisterHumanEditLeaseRequest,
    opts?: { roomId?: string; targetKind?: HumanEditLeaseCandidateTarget["kind"] },
  ): Promise<HumanEditLeaseStoreResult>;
  updateHumanEditLease(
    leaseId: string,
    input: UpdateHumanEditLeaseRequest,
    opts?: { roomId?: string; targetKind?: HumanEditLeaseCandidateTarget["kind"] },
  ): Promise<HumanEditLeaseStoreResult>;
  renewHumanEditLease(
    leaseId: string,
    input: RenewHumanEditLeaseRequest,
    opts?: { roomId?: string; targetKind?: HumanEditLeaseCandidateTarget["kind"] },
  ): Promise<HumanEditLeaseStoreResult>;
  releaseHumanEditLease(
    leaseId: string,
    input: ReleaseHumanEditLeaseRequest,
    opts?: { targetKind?: HumanEditLeaseCandidateTarget["kind"] },
  ): Promise<HumanEditLeaseStoreResult>;
}

export type HumanEditLeaseDesiredState = {
  target: HumanEditLeaseCandidateTarget;
  state: HumanEditLeaseState;
  draftPatch?: AnchoredTextPatch;
  roomId?: string;
};

export type HumanEditLeaseSessionOptions = {
  transport: HumanEditLeaseTransport;
  sessionId: string;
  onRecord?: (record: HumanEditLeaseRecord | null) => void;
  onError?: (error: unknown) => void;
};

function samePatch(a: AnchoredTextPatch | undefined, b: AnchoredTextPatch | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function recordMatchesDesired(
  record: HumanEditLeaseRecord,
  desired: HumanEditLeaseDesiredState,
): boolean {
  return record.lease.state === desired.state && samePatch(record.lease.draftPatch, desired.draftPatch);
}

/**
 * Serialized, best-effort client for the advisory human-edit lease registry.
 *
 * This owns only registry lifecycle. It deliberately has no knowledge of an
 * editor's write machinery: network failures are reported and retained for a
 * later wake-up, never propagated into a document save.
 */
export class HumanEditLeaseSession {
  private desired: HumanEditLeaseDesiredState | null = null;
  private record: HumanEditLeaseRecord | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  private releaseRequested = false;
  private reRegisterRequested = false;
  private reconcileRequested = false;
  private releaseRetryRequested = false;
  private releaseRetryAttempted = false;

  constructor(private readonly options: HumanEditLeaseSessionOptions) {}

  getRecord(): HumanEditLeaseRecord | null {
    return this.record;
  }

  /** Test/diagnostic helper: resolves once the currently queued work settles. */
  async whenIdle(): Promise<void> {
    const active = this.inFlight;
    if (active === null) return;
    await active;
    if (this.inFlight !== null && this.inFlight !== active) await this.whenIdle();
  }

  /** Retain the newest desired state; the single worker coalesces older ones. */
  setDesired(desired: HumanEditLeaseDesiredState): void {
    this.stopped = false;
    this.releaseRequested = false;
    this.desired = desired;
    this.wake();
  }

  /** Retry retained work after visibility/online recovery. */
  wake(): void {
    if (this.stopped || this.releaseRequested || this.desired === null || this.inFlight !== null) return;
    const desiredAtStart = this.desired;
    this.inFlight = this.drain().finally(() => {
      this.inFlight = null;
      if (this.releaseRequested) {
        this.releaseHeldRecord();
      } else if (!this.stopped && this.desired !== null) {
        // A newer desired state may have arrived while the previous request ran.
        if (
          this.reRegisterRequested ||
          this.reconcileRequested ||
          this.desired !== desiredAtStart
        ) {
          this.reRegisterRequested = false;
          this.reconcileRequested = false;
          this.wake();
        }
      }
    });
  }

  /**
   * Heartbeat is serialized with state updates. It renews only an already
   * matching held record; otherwise it lets the normal CAS update win first.
   */
  heartbeat(): void {
    if (this.stopped || this.releaseRequested || this.desired === null || this.inFlight !== null) return;
    if (this.record === null || !recordMatchesDesired(this.record, this.desired)) {
      this.wake();
      return;
    }
    this.inFlight = this.renew().finally(() => {
      this.inFlight = null;
      if (
        !this.stopped &&
        !this.releaseRequested &&
        this.desired !== null &&
        (this.record === null || !recordMatchesDesired(this.record, this.desired))
      ) {
        this.wake();
      }
    });
  }

  /** Explicit teardown; TTL is the only crash/unload fallback. */
  release(): void {
    this.stopped = true;
    this.releaseRequested = true;
    this.releaseRetryAttempted = false;
    this.desired = null;
    this.releaseHeldRecord();
  }

  private releaseHeldRecord(): void {
    const record = this.record;
    if (record === null || this.inFlight !== null) return;
    this.inFlight = this.options.transport
      .releaseHumanEditLease(record.lease.leaseId, {
        sessionId: this.options.sessionId,
        expectedGeneration: record.lease.generation,
      }, { targetKind: record.lease.identity.kind })
      .then((result) => {
        if (result.status === "ok" || result.status === "not_found") this.adopt(null);
        else if (result.status === "stale_generation") {
          this.adopt(result.record);
          // Release newer registry truth exactly once. A repeated stale or a
          // network/invalid failure falls back to TTL instead of looping.
          if (!this.releaseRetryAttempted) {
            this.releaseRetryAttempted = true;
            this.releaseRetryRequested = true;
          }
        }
      })
      .catch((error: unknown) => this.options.onError?.(error))
      .finally(() => {
        this.inFlight = null;
        if (this.releaseRetryRequested) {
          this.releaseRetryRequested = false;
          this.releaseHeldRecord();
        }
      });
  }

  private async drain(): Promise<void> {
    const desired = this.desired;
    if (desired === null || this.stopped || this.releaseRequested) return;

    try {
      if (this.record === null) {
        const result = await this.options.transport.registerHumanEditLease(
          {
            sessionId: this.options.sessionId,
            target: desired.target,
            state: desired.state,
            ...(desired.draftPatch !== undefined ? { draftPatch: desired.draftPatch } : {}),
          },
          desired.target.kind === "workspace_artifact" && desired.roomId !== undefined
            ? { roomId: desired.roomId, targetKind: desired.target.kind }
            : { targetKind: desired.target.kind },
        );
        this.consumeRegister(result);
        return;
      }

      const result = await this.options.transport.updateHumanEditLease(
        this.record.lease.leaseId,
        {
          sessionId: this.options.sessionId,
          target: desired.target,
          expectedGeneration: this.record.lease.generation,
          state: desired.state,
          ...(desired.draftPatch !== undefined ? { draftPatch: desired.draftPatch } : {}),
        },
        desired.target.kind === "workspace_artifact" && desired.roomId !== undefined
          ? { roomId: desired.roomId, targetKind: desired.target.kind }
          : { targetKind: desired.target.kind },
      );
      this.consumeUpdate(result);
    } catch (error) {
      // Retain desired + current record. `wake` is driven by online/visibility
      // and heartbeat, so a lease outage never becomes an editor failure.
      this.options.onError?.(error);
    }
  }

  private async renew(): Promise<void> {
    const record = this.record;
    const desired = this.desired;
    if (record === null || desired === null || this.stopped || this.releaseRequested) return;
    try {
      const result = await this.options.transport.renewHumanEditLease(record.lease.leaseId, {
        sessionId: this.options.sessionId,
        target: desired.target,
        expectedGeneration: record.lease.generation,
      }, desired.target.kind === "workspace_artifact" && desired.roomId !== undefined
        ? { roomId: desired.roomId, targetKind: desired.target.kind }
        : { targetKind: desired.target.kind });
      if (result.status === "ok") this.adopt(result.record);
      else if (result.status === "not_found") this.adopt(null);
      else if (result.status === "stale_generation") this.adopt(result.record);
      // invalid is terminal for this call; desired remains available for an
      // explicit next lifecycle wake after its cause has changed.
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private consumeRegister(result: HumanEditLeaseStoreResult): void {
    if (result.status === "ok" || result.status === "stale_generation") {
      // Idempotent register retries return the already-held record. Never
      // presume the registry overwrote its generation, state, or expiry.
      this.adopt(result.record);
      if (this.desired !== null && !recordMatchesDesired(result.record, this.desired)) {
        this.reconcileRequested = true;
      }
    }
  }

  private consumeUpdate(result: HumanEditLeaseStoreResult): void {
    if (result.status === "ok" || result.status === "stale_generation") {
      // A stale result is registry truth. The finalizer runs a CAS update if
      // that truth still differs from our retained desired editor state.
      this.adopt(result.record);
      if (result.status === "stale_generation") this.reconcileRequested = true;
    } else if (result.status === "not_found") {
      this.adopt(null);
      this.reRegisterRequested = true;
    }
  }

  private adopt(record: HumanEditLeaseRecord | null): void {
    this.record = record;
    this.options.onRecord?.(record);
  }
}
