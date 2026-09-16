import { randomUUID } from "node:crypto";

import type { DirectDatabase } from "@nautilo/db";
import { warn } from "@nautilo/logger";

import type { BrowserUseCloudAdapter } from "../browser-use/browser-use-cloud";
import {
  ConnectedWebOperationSupervisor,
  type ConnectedWebOperationSupervisorOptions,
  type ConnectedWebOperationSupervisorRunOnceResult,
} from "./operation-supervisor";
import { ConnectedWebOperationSecrets } from "./operation-secrets";
import { deliverConnectedWebOperationWakes } from "./operation-wake";
import { stopIdleConnectedWebBrowser } from "./browser-idle-cleanup";
import { reconcileHostedExecutionCleanup } from "./hosted-execution-cleanup";
import type {
  ConnectedWebAccountStore,
  ConnectedWebOperation,
} from "./store";

/**
 * Operational scheduling policy for the durable supervisor, named here for
 * the limit review ledger. None of these values is an operation deadline:
 * claims expire durably and work is reclaimed after restart.
 *
 * - 200 events is the V4 adapter's existing `observeHostedReadRun` event-page
 *   size, so this page remains cursor-continuable rather than truncated.
 * - 32 is the connected-web store's explicit maximum claim batch.
 * - 60 seconds is the existing operation-wake claim lease; it bounds only a
 *   worker claim, not a Browser Use run or operation lifetime.
 * - 2 seconds matches the existing Browser Use read/action re-observation
 *   cadence in server composition and is a soft operational wake cadence.
 */
const CONNECTED_WEB_OPERATION_RUNTIME_POLICY = {
  eventPageSize: 200,
  claimBatch: 32,
  claimLeaseMs: 60_000,
  wakeLeaseMs: 60_000,
  tickMs: 2_000,
  recheckDelayMs: 2_000,
} as const;

export interface ConnectedWebOperationProductionRuntimeClock {
  now(): Date;
}

export interface ConnectedWebOperationProductionRuntimeScheduler {
  queue(callback: () => void): void;
  setInterval(callback: () => void, milliseconds: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
}

export interface ConnectedWebOperationProductionRuntimeOptions {
  readonly db: DirectDatabase;
  readonly store: Pick<
    ConnectedWebAccountStore,
    | "claimDueOperations"
    | "releaseOperationClaim"
    | "recordOperationCheckpoint"
    | "terminalizeOperation"
    | "terminalizeReadOperationAndCompleteExecution"
    | "getOperationForOwner"
    | "claimDueOperationWakes"
    | "completeOperationWake"
    | "releaseOperationWakeClaim"
  > & Partial<Pick<ConnectedWebAccountStore, "getForOwner" | "claimIdleBrowserOperations" | "completeIdleBrowserCleanup" | "requestExecutionCleanup" | "completeExecution" | "listPendingExecutionCleanup">>;
  readonly provider: Pick<
    BrowserUseCloudAdapter,
    "pollHostedReadRun" | "readHostedRunEventDelta" | "getHostedReadResult"
  > & Partial<Pick<BrowserUseCloudAdapter, "findHostedBrowsers" | "stopBrowser" | "stopHostedReadBrowser">>;
  readonly secrets: ConnectedWebOperationSecrets;
  readonly clock?: ConnectedWebOperationProductionRuntimeClock;
  readonly scheduler?: ConnectedWebOperationProductionRuntimeScheduler;
  /** Narrow test seam; production composes the landed supervisor below. */
  readonly runSupervisor?: (input: {
    readonly workerId: string;
    readonly signal: AbortSignal;
  }) => Promise<ConnectedWebOperationSupervisorRunOnceResult>;
  /** Narrow test seam; production delivers exact initiating-Genie wakes below. */
  readonly deliverWakes?: (input: {
    readonly workerId: string;
    readonly signal: AbortSignal;
  }) => Promise<void>;
}

const SYSTEM_CLOCK: ConnectedWebOperationProductionRuntimeClock = { now: () => new Date() };
const SYSTEM_SCHEDULER: ConnectedWebOperationProductionRuntimeScheduler = {
  queue: queueMicrotask,
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (timer) => clearInterval(timer),
};

function validPolicy(): boolean {
  return Object.values(CONNECTED_WEB_OPERATION_RUNTIME_POLICY)
    .every((value) => Number.isSafeInteger(value) && value > 0);
}

/**
 * Production-owned, restart-safe server pump. It deliberately has no total
 * operation timeout and creates no Browser Use run: DB claims decide what is
 * due. Supervision, exact initiating-Genie wakes and browser cleanup are
 * independent lanes; a slow provider poll cannot starve a requested wake.
 */
class ConnectedWebOperationProductionRuntime {
  private readonly clock: ConnectedWebOperationProductionRuntimeClock;
  private readonly scheduler: ConnectedWebOperationProductionRuntimeScheduler;
  private readonly workerId = `connected-web-operation:${randomUUID()}`;
  private readonly wakeWorkerId = `connected-web-operation-wake:${randomUUID()}`;
  private readonly runSupervisor: NonNullable<ConnectedWebOperationProductionRuntimeOptions["runSupervisor"]>;
  private readonly deliverWakes: NonNullable<ConnectedWebOperationProductionRuntimeOptions["deliverWakes"]>;
  private readonly cleanIdleBrowsers: () => Promise<void>;
  private timer: ReturnType<typeof setInterval> | undefined;
  private activeAbort: AbortController | undefined;
  private wakeAbort: AbortController | undefined;
  private queued = false;
  private pumping = false;
  private waking = false;
  private running = false;
  private cleaningIdle = false;
  private cleaningExecutions = false;
  private readonly cleanExecutions: () => Promise<void>;

  constructor(options: ConnectedWebOperationProductionRuntimeOptions) {
    if (!validPolicy()) throw new Error("connected website operation runtime policy unavailable");
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.scheduler = options.scheduler ?? SYSTEM_SCHEDULER;
    this.runSupervisor = options.runSupervisor ?? this.createSupervisorRunner(options);
    this.cleanExecutions = async () => {
      if (!options.store.requestExecutionCleanup || !options.store.completeExecution
        || !options.store.listPendingExecutionCleanup || !options.provider.stopHostedReadBrowser) return;
      await reconcileHostedExecutionCleanup({
        requestExecutionCleanup: options.store.requestExecutionCleanup.bind(options.store),
        completeExecution: options.store.completeExecution.bind(options.store),
        listPendingExecutionCleanup: options.store.listPendingExecutionCleanup.bind(options.store),
      }, { stopHostedReadBrowser: options.provider.stopHostedReadBrowser.bind(options.provider) });
    };
    this.cleanIdleBrowsers = async () => {
      if (!options.store.claimIdleBrowserOperations || !options.store.completeIdleBrowserCleanup
        || !options.provider.findHostedBrowsers || !options.provider.stopBrowser) return;
      const due = await options.store.claimIdleBrowserOperations({
        now: this.clock.now(), batch: CONNECTED_WEB_OPERATION_RUNTIME_POLICY.claimBatch,
      });
      for (const operation of due) {
        const stopped = await stopIdleConnectedWebBrowser({ operation, secrets: options.secrets, provider: {
          findHostedBrowsers: options.provider.findHostedBrowsers.bind(options.provider),
          stopBrowser: options.provider.stopBrowser.bind(options.provider),
        } });
        await options.store.completeIdleBrowserCleanup({ operationId: operation.id, now: this.clock.now(), stopped });
      }
    };
    this.deliverWakes = options.deliverWakes ?? (async ({ workerId, signal }) => {
      if (signal.aborted) return;
      await deliverConnectedWebOperationWakes({
        db: options.db,
        workerId,
        secrets: options.secrets,
        now: () => this.clock.now(),
        batch: CONNECTED_WEB_OPERATION_RUNTIME_POLICY.claimBatch,
        leaseMs: CONNECTED_WEB_OPERATION_RUNTIME_POLICY.wakeLeaseMs,
        operations: {
          claim: options.store.claimDueOperationWakes.bind(options.store),
          load: options.store.getOperationForOwner.bind(options.store),
          complete: options.store.completeOperationWake.bind(options.store),
          release: options.store.releaseOperationWakeClaim.bind(options.store),
        },
      });
    });
  }

  private createSupervisorRunner(options: ConnectedWebOperationProductionRuntimeOptions): NonNullable<ConnectedWebOperationProductionRuntimeOptions["runSupervisor"]> {
    return async ({ workerId, signal }) => {
      if (signal.aborted) return { claimed: 0, reconciled: 0, rescheduled: 0, terminalized: 0, stale: 0 };
      // The supervisor's legacy narrow codec receives only operationId and
      // sealed refs. This per-turn map comes exclusively from the exact DB
      // claim and supplies owner/account/id AAD to the secrets codec.
      const claimedContexts = new Map<string, ConnectedWebOperation>();
      const store: ConnectedWebOperationSupervisorOptions["store"] = {
        claimDueOperations: async (input) => {
          const claimed = await options.store.claimDueOperations(input);
          for (const operation of claimed) claimedContexts.set(operation.id, operation);
          return claimed;
        },
        releaseOperationClaim: options.store.releaseOperationClaim.bind(options.store),
        recordOperationCheckpoint: options.store.recordOperationCheckpoint.bind(options.store),
        terminalizeOperation: options.store.terminalizeOperation.bind(options.store),
        terminalizeReadOperationAndCompleteExecution: options.store.terminalizeReadOperationAndCompleteExecution.bind(options.store),
        ...(options.store.getForOwner === undefined ? {} : { getForOwner: options.store.getForOwner.bind(options.store) }),
      };
      const supervisor = new ConnectedWebOperationSupervisor({
        store,
        provider: options.provider,
        providerReferences: {
          unseal: ({ operationId, references }) => {
            const operation = claimedContexts.get(operationId);
            // The exact claimed object must be the coordinate envelope the
            // supervisor is reconciling; otherwise no AAD context is trusted.
            if (!operation || operation.sealedProviderRefs !== references) return Promise.resolve(null);
            const coordinates = options.secrets.unsealProviderReferences({
              context: {
                operationId: operation.id,
                ownerUserId: operation.ownerUserId,
                accountId: operation.accountId,
              },
              references,
            });
            return Promise.resolve({
              runId: coordinates.runId ?? null,
              sessionId: coordinates.sessionId ?? null,
              workspaceId: coordinates.workspaceId ?? null,
              browserId: coordinates.browserId ?? null,
            });
          },
          unsealIntent: ({ operation }) => {
            const claimed = claimedContexts.get(operation.id);
            // The supervisor advances its durable event cursor by cloning the
            // claimed row after every checkpoint. Object identity therefore
            // cannot be the authority boundary at terminalization. Bind the
            // ciphertext to the immutable claim coordinates instead; any
            // concurrent control-epoch change still loses the store CAS.
            if (!claimed
              || claimed.ownerUserId !== operation.ownerUserId
              || claimed.accountId !== operation.accountId
              || claimed.controlEpoch !== operation.controlEpoch
              || claimed.deliveryId !== operation.deliveryId
              || claimed.initiatingThreadId !== operation.initiatingThreadId
              || claimed.initiatingLane !== operation.initiatingLane
              || claimed.requestDigest !== operation.requestDigest
              || claimed.sealedIntent !== operation.sealedIntent) return Promise.resolve(null);
            try {
              return Promise.resolve(options.secrets.unsealIntent({
                context: { operationId: operation.id, ownerUserId: operation.ownerUserId, accountId: operation.accountId },
                sealedIntent: operation.sealedIntent,
              }));
            } catch {
              return Promise.resolve(null);
            }
          },
        },
        clock: this.clock,
        eventPageLimit: CONNECTED_WEB_OPERATION_RUNTIME_POLICY.eventPageSize,
        nextCheckAt: ({ now }) => new Date(now.getTime() + CONNECTED_WEB_OPERATION_RUNTIME_POLICY.recheckDelayMs),
      });
      try {
        return await supervisor.runOnce({
          workerId,
          leaseMs: CONNECTED_WEB_OPERATION_RUNTIME_POLICY.claimLeaseMs,
          batch: CONNECTED_WEB_OPERATION_RUNTIME_POLICY.claimBatch,
        });
      } finally {
        // No provider coordinate or operation context survives an idle turn.
        claimedContexts.clear();
      }
    };
  }

  /** Start only after Fastify listens so app construction and inject stay DB-free. */
  start(): void {
    if (this.timer !== undefined) return;
    this.running = true;
    this.timer = this.scheduler.setInterval(
      () => this.requestPump(),
      CONNECTED_WEB_OPERATION_RUNTIME_POLICY.tickMs,
    );
    this.timer.unref?.();
    this.requestPump();
  }

  /** Stop future scheduling; durable DB claim leases make an interrupted pass restart-safe. */
  stop(): void {
    this.running = false;
    if (this.timer !== undefined) this.scheduler.clearInterval(this.timer);
    this.timer = undefined;
    this.activeAbort?.abort();
    this.wakeAbort?.abort();
    this.activeAbort = undefined;
    this.queued = false;
  }

  /** Non-blocking kick for tests and future durable admission hooks. */
  requestPump(): void {
    if (!this.running || this.queued) return;
    this.queued = true;
    this.scheduler.queue(() => {
      this.queued = false;
      void this.pump().catch(() => {
        // Do not log exception strings: provider coordinates and untrusted
        // payloads must never become server logs. Claims will expire safely.
        warn("[connected-web-operation] background pump deferred");
      });
      void this.pumpWakes();
      this.pumpIdleCleanup();
      void this.pumpExecutionCleanup();
    });
  }

  private async pumpExecutionCleanup(): Promise<void> {
    if (!this.running || this.cleaningExecutions) return;
    this.cleaningExecutions = true;
    try { await this.cleanExecutions(); }
    catch { warn("[connected-web-operation] finished browser cleanup needs another attempt"); }
    finally { this.cleaningExecutions = false; }
  }

  private async pump(): Promise<void> {
    if (!this.running || this.pumping) return;
    this.pumping = true;
    const controller = new AbortController();
    this.activeAbort = controller;
    try {
      // Provider polling cannot delay a previously scheduled Genie wake or
      // expired-browser cleanup; each lane has independent in-flight custody.
      await this.runSupervisor({ workerId: this.workerId, signal: controller.signal }).catch(() => {
        // A supervisor failure must not suppress an already-durable wake from
        // an earlier checkpoint. Both workers remain restart-safe by DB lease.
        warn("[connected-web-operation] supervisor pass deferred");
      });
    } finally {
      if (this.activeAbort === controller) this.activeAbort = undefined;
      this.pumping = false;
      // The named operational timer owns the next turn. Do not hot-loop an
      // empty queue or a transient provider failure in the same event turn.
    }
  }

  private async pumpWakes(): Promise<void> {
    if (!this.running || this.waking) return;
    this.waking = true;
    const controller = new AbortController();
    this.wakeAbort = controller;
    try {
      await this.deliverWakes({ workerId: this.wakeWorkerId, signal: controller.signal });
    } catch {
      warn("[connected-web-operation] wake delivery deferred");
    } finally {
      if (this.wakeAbort === controller) this.wakeAbort = undefined;
      this.waking = false;
    }
  }

  private pumpIdleCleanup(): void {
    if (!this.running || this.cleaningIdle) return;
    this.cleaningIdle = true;
    void this.cleanIdleBrowsers().catch(() => {
      warn("[connected-web-operation] idle browser cleanup deferred");
    }).finally(() => { this.cleaningIdle = false; });
  }
}

export function createConnectedWebOperationProductionRuntime(
  options: ConnectedWebOperationProductionRuntimeOptions,
): ConnectedWebOperationProductionRuntime {
  return new ConnectedWebOperationProductionRuntime(options);
}
