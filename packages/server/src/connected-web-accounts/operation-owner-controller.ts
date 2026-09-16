import type { BrowserUseCloudAdapter } from "../browser-use/browser-use-cloud";
import type {
  ConnectedWebOperationProjection,
  ConnectedWebOperationTerminalReadResult,
} from "@nautilo/types";
import { ConnectedWebAccountStoreError, type ConnectedWebAccountStore, type ConnectedWebOperation } from "./store";
import type { ConnectedWebOperationSecrets } from "./operation-secrets";
import type { ConnectedWebOperationDirectRuntime } from "./operation-direct-runtime";

type OwnerOperationProvider = Pick<BrowserUseCloudAdapter, "observeHostedReadRun" | "cancelHostedReadRun">;
type OwnerOperationStore = Pick<ConnectedWebAccountStore, "getOperationForOwner" | "scheduleOperationCheck">;

function terminalResult(operation: ConnectedWebOperation): ConnectedWebOperationTerminalReadResult | null {
  const result = operation.terminalReadResult;
  return result === null || result === undefined ? null : {
    ok: true,
    status: "completed",
    account: result.account === null ? null : { ...result.account },
    page: { ...result.page },
    read: result.read === null ? null : { ...result.read, facts: result.read.facts.map((fact) => ({ ...fact })) },
    cost: { ...result.cost },
    outputs: [],
    outputsTruncated: result.outputsTruncated,
  };
}

function projected(operation: ConnectedWebOperation, capabilities: { canWatch: boolean; canStop: boolean }): ConnectedWebOperationProjection {
  return {
    operationId: operation.id,
    driver: operation.driver,
    lifecycle: operation.lifecycle,
    controlEpoch: operation.controlEpoch,
    activity: {
      phase: operation.safeActivity.phase,
      code: operation.safeActivity.code,
      summary: operation.safeActivity.summary,
    },
    receipt: operation.terminalReceipt === null ? null : {
      outcome: operation.terminalReceipt.outcome,
      code: operation.terminalReceipt.code,
      summary: operation.terminalReceipt.summary,
    },
    canWatch: capabilities.canWatch,
    canStop: capabilities.canStop,
    result: terminalResult(operation),
    ...(operation.activityLog ? { activityLog: operation.activityLog } : {}),
  };
}

function secretContext(operation: ConnectedWebOperation) {
  return { operationId: operation.id, ownerUserId: operation.ownerUserId, accountId: operation.accountId };
}

function providerFailure(value: unknown): value is { readonly kind: "failure" } {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "failure";
}

function active(status: "queued" | "dispatching" | "running" | "completed" | "failed" | "cancelled"): boolean {
  return status === "queued" || status === "dispatching" || status === "running";
}

/**
 * Owner HTTP authority deliberately does not reuse Genie/thread management.
 * It opens the exact row first, then derives ephemeral controls from a fresh
 * provider observation. Durable terminalization and account-fence release are
 * exclusively the supervisor's job.
 */
export class ConnectedWebOperationOwnerController {
  constructor(private readonly deps: {
    readonly store: OwnerOperationStore;
    readonly provider: OwnerOperationProvider;
    /** Null before listen: inject/createApp tests must remain DB/secret-free. */
    readonly secrets: () => ConnectedWebOperationSecrets | null;
    /** Listener-owned in-memory direct lease authority; absent before listen/recovery. */
    readonly direct?: () => ConnectedWebOperationDirectRuntime | null;
    readonly now?: () => Date;
  }) {}

  private now(): Date { return (this.deps.now ?? (() => new Date()))(); }

  private async load(ownerUserId: string, operationId: string, activityBefore?: number): Promise<ConnectedWebOperation> {
    try {
      return await this.deps.store.getOperationForOwner({ ownerUserId, operationId, ...(activityBefore === undefined ? {} : { activityBefore }) });
    } catch (error) {
      if (error instanceof ConnectedWebAccountStoreError) throw error;
      throw new ConnectedWebAccountStoreError("not_found");
    }
  }

  private openRun(operation: ConnectedWebOperation): string {
    const secrets = this.deps.secrets();
    if (!secrets || (operation.driver !== "hosted" && operation.driver !== "checking")) {
      throw new ConnectedWebAccountStoreError("provider_unavailable");
    }
    try {
      const runId = secrets.unsealProviderReferences({ context: secretContext(operation), references: operation.sealedProviderRefs }).runId;
      if (!runId) throw new Error("run unavailable");
      return runId;
    } catch {
      throw new ConnectedWebAccountStoreError("provider_unavailable");
    }
  }

  private async observe(operation: ConnectedWebOperation): Promise<{
    readonly runId: string;
    readonly canWatch: boolean;
    readonly canStop: boolean;
    readonly liveViewUrl: string | null;
  }> {
    const runId = this.openRun(operation);
    let observation: Awaited<ReturnType<OwnerOperationProvider["observeHostedReadRun"]>>;
    try { observation = await this.deps.provider.observeHostedReadRun(runId); } catch { throw new ConnectedWebAccountStoreError("provider_unavailable"); }
    if (providerFailure(observation) || observation.runId !== runId) throw new ConnectedWebAccountStoreError("provider_unavailable");
    const isActive = active(observation.status);
    return { runId, canWatch: isActive && observation.liveViewUrl !== null, canStop: isActive, liveViewUrl: isActive ? observation.liveViewUrl : null };
  }

  private direct(): ConnectedWebOperationDirectRuntime | null { return this.deps.direct?.() ?? null; }

  async get(input: { readonly ownerUserId: string; readonly operationId: string; readonly activityBefore?: number }): Promise<ConnectedWebOperationProjection> {
    const operation = await this.load(input.ownerUserId, input.operationId, input.activityBefore);
    if (operation.lifecycle === "terminal") return projected(operation, { canWatch: false, canStop: false });
    if (operation.driver === "direct") {
      const controls = await this.direct()?.ownerControls(input) ?? null;
      if (!controls) return projected(operation, { canWatch: false, canStop: false });
      return projected(controls.operation, { canWatch: controls.liveViewUrl !== null, canStop: true });
    }
    if (operation.driver !== "hosted" && operation.driver !== "checking") return projected(operation, { canWatch: false, canStop: false });
    const observed = await this.observe(operation);
    if (!observed.canStop) return projected({ ...operation, driver: "checking", safeActivity: {
      version: 1, phase: "finishing", code: "provider_terminal_pending",
      summary: "The browser run has ended. Nautilo is recording its outcome and cleaning up; a final result is not available yet.",
    } }, observed);
    return projected(operation, observed);
  }

  async watch(input: { readonly ownerUserId: string; readonly operationId: string }): Promise<{ readonly liveViewUrl: string }> {
    const operation = await this.load(input.ownerUserId, input.operationId);
    if (operation.lifecycle === "terminal") throw new ConnectedWebAccountStoreError("conflict");
    if (operation.driver === "direct") {
      const controls = await this.direct()?.ownerControls(input) ?? null;
      if (!controls || controls.liveViewUrl === null) throw new ConnectedWebAccountStoreError("conflict");
      return { liveViewUrl: controls.liveViewUrl };
    }
    const observed = await this.observe(operation);
    if (!observed.canWatch || observed.liveViewUrl === null) throw new ConnectedWebAccountStoreError("conflict");
    return { liveViewUrl: observed.liveViewUrl };
  }

  async stop(input: { readonly ownerUserId: string; readonly operationId: string }): Promise<ConnectedWebOperationProjection> {
    const operation = await this.load(input.ownerUserId, input.operationId);
    if (operation.lifecycle === "terminal") return projected(operation, { canWatch: false, canStop: false });
    if (operation.driver === "direct") {
      const stopped = await this.direct()?.stopForOwner(input) ?? null;
      if (!stopped) throw new ConnectedWebAccountStoreError("conflict");
      // Failed cleanup retains a closed-for-input lease at its recovery epoch.
      // Keep Stop actionable immediately, not only after the next UI poll.
      const retry = stopped.driver === "direct" ? await this.direct()?.ownerControls(input) ?? null : null;
      return projected(stopped, { canWatch: false, canStop: retry?.operation.controlEpoch === stopped.controlEpoch });
    }
    const observed = await this.observe(operation);
    if (!observed.canStop) throw new ConnectedWebAccountStoreError("conflict");
    let cancelled: Awaited<ReturnType<OwnerOperationProvider["cancelHostedReadRun"]>>;
    try { cancelled = await this.deps.provider.cancelHostedReadRun(observed.runId); } catch { throw new ConnectedWebAccountStoreError("provider_unavailable"); }
    if (providerFailure(cancelled) || cancelled.runId !== observed.runId) throw new ConnectedWebAccountStoreError("provider_unavailable");
    // This update only wakes the durable supervisor. It neither declares a
    // terminal outcome nor releases the account writer fence.
    const now = this.now();
    const scheduled = await this.deps.store.scheduleOperationCheck({
      operationId: operation.id,
      expectedControlEpoch: operation.controlEpoch,
      now,
      dueAt: now,
      safeActivity: {
        version: 1,
        phase: "checking",
        code: "stop_reconciliation_scheduled",
        summary: "Stop was requested; Nautilo is reconciling the connected website operation.",
      },
    }).catch(() => false);
    if (!scheduled) throw new ConnectedWebAccountStoreError("conflict");
    return projected({ ...operation, driver: "checking", lifecycle: "running", safeActivity: {
      version: 1, phase: "checking", code: "stop_reconciliation_scheduled",
      summary: "Stop was requested; Nautilo is reconciling the connected website operation.",
    // Provider cancellation acknowledgement is not terminal truth. Preserve
    // Stop while the provider still reports a live resource; the supervisor
    // alone later records terminal state and releases the account fence.
    } }, { canWatch: false, canStop: active(cancelled.status) });
  }
}
