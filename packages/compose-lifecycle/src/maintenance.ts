import type {
  ComposeDriverProfile,
  MaintenanceDrainHandle,
} from "@nautilo/compose-driver";
import type { MaintenanceOperatorStatus } from "@nautilo/types";

export interface ComposeMaintenanceTransport {
  readonly baseUrl: string;
  readonly bearer?: string;
}

export interface ComposeMaintenanceApiPort {
  enter(
    transport: ComposeMaintenanceTransport,
    input: { readonly hardMs: number },
  ): Promise<MaintenanceOperatorStatus>;
  status(transport: ComposeMaintenanceTransport): Promise<MaintenanceOperatorStatus>;
  renew(
    transport: ComposeMaintenanceTransport,
    operationId: string,
  ): Promise<MaintenanceOperatorStatus>;
  applying(
    transport: ComposeMaintenanceTransport,
    operationId: string,
  ): Promise<MaintenanceOperatorStatus>;
  cancel(
    transport: ComposeMaintenanceTransport,
    operationId: string,
  ): Promise<MaintenanceOperatorStatus>;
  cancelWork(
    transport: ComposeMaintenanceTransport,
    operationId: string,
  ): Promise<MaintenanceOperatorStatus>;
  complete(
    transport: ComposeMaintenanceTransport,
    operationId: string,
  ): Promise<MaintenanceOperatorStatus>;
}

export type ComposeMaintenanceDrain = (
  profile: ComposeDriverProfile,
  waitForMs: number,
) => Promise<MaintenanceDrainHandle>;

export interface BuildComposeMaintenanceDrainOptions {
  readonly api: ComposeMaintenanceApiPort;
  readonly home: string;
  readonly resolveServerUrl: (profile: ComposeDriverProfile) => string;
  readonly readBootstrapToken: (profileName: string, home: string) => string | null;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly pollIntervalMs?: number;
  readonly renewBufferMs?: number;
  readonly reconcileBudgetMs?: number;
  readonly log?: (message: string) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_RENEW_BUFFER_MS = 60_000;
const DEFAULT_RECONCILE_BUDGET_MS = 30_000;
export const DEFAULT_MAINTENANCE_HARD_LEASE_MS = 30 * 60_000;
export const MAINTENANCE_POST_DEADLINE_BUFFER_MS = 25 * 60_000;

export function maintenanceHardLeaseMs(waitForMs: number): number {
  const requestedCeiling = waitForMs + MAINTENANCE_POST_DEADLINE_BUFFER_MS;
  if (!Number.isSafeInteger(requestedCeiling)) {
    throw new Error("maintenance drain failed closed: --wait-for exceeds the supported lease duration.");
  }
  return Math.max(DEFAULT_MAINTENANCE_HARD_LEASE_MS, requestedCeiling);
}

function idle(status: MaintenanceOperatorStatus): boolean {
  const work = status.work;
  return work.runningForegroundJobs === 0
    && work.runningBackgroundJobs === 0
    && work.queuedTurns === 0
    && work.bufferedLanes === 0
    && work.acceptedWork === 0
    && work.runningTaskRuns === 0
    && work.claimedTasks === 0;
}

function transportFor(
  profile: ComposeDriverProfile,
  options: BuildComposeMaintenanceDrainOptions,
): ComposeMaintenanceTransport {
  const baseUrl = options.resolveServerUrl(profile);
  if (profile.transport === "remote") return { baseUrl };
  const bearer = options.readBootstrapToken(profile.name, options.home);
  return bearer ? { baseUrl, bearer } : { baseUrl };
}

function maintenanceHandle(input: {
  readonly api: ComposeMaintenanceApiPort;
  readonly transport: ComposeMaintenanceTransport;
  readonly operationId: string;
  readonly log: (message: string) => void;
}): MaintenanceDrainHandle {
  const { api, transport, operationId, log } = input;
  return {
    operationId,
    transitionApplying: async () => {
      const status = await api.applying(transport, operationId);
      if (status.state !== "applying" || status.operationId !== operationId) {
        throw new Error(
          `maintenance drain → applying transition failed closed: server reported state=${status.state}, operationId=${status.operationId ?? "null"} (expected applying/${operationId}); no server stop or backup performed.`,
        );
      }
      log("upgrade: maintenance drain transitioned to applying; lease retained through stop+snapshot.");
    },
    releaseLease: async () => {
      try {
        await api.cancel(transport, operationId);
        return { cancelled: true };
      } catch (error) {
        return {
          cancelled: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    completeLease: async () => {
      const status = await api.complete(transport, operationId);
      if (status.state !== "normal" || status.operationId !== null) {
        throw new Error(
          `maintenance completion failed closed: server reported state=${status.state}, operationId=${status.operationId ?? "null"} (expected normal/null); lease not confirmed cleared; left in applying for hard-expiry to reclaim.`,
        );
      }
      log("upgrade: maintenance lease completed (applying → normal).");
      return { completed: true };
    },
  };
}

async function cancelAndReconcile(input: {
  readonly api: ComposeMaintenanceApiPort;
  readonly transport: ComposeMaintenanceTransport;
  readonly operationId: string;
  readonly drainDeadline: number;
  readonly waitForMs: number;
  readonly pollIntervalMs: number;
  readonly reconcileBudgetMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly log: (message: string) => void;
}): Promise<void> {
  const {
    api,
    transport,
    operationId,
    drainDeadline,
    waitForMs,
    pollIntervalMs,
    reconcileBudgetMs,
    sleep,
    now,
    log,
  } = input;
  log(`upgrade: drain deadline reached after ${waitForMs}ms; cancelling remaining executable work...`);
  let status: MaintenanceOperatorStatus;
  try {
    status = await api.cancelWork(transport, operationId);
  } catch (error) {
    throw new Error(
      `maintenance drain failed closed: cancel-work request failed: ${error instanceof Error ? error.message : String(error)}; no upgrade mutation performed.`,
    );
  }
  if (idle(status)) return;
  const deadline = now() + reconcileBudgetMs;
  while (now() < deadline) {
    await sleep(pollIntervalMs);
    try {
      status = await api.status(transport);
    } catch (error) {
      throw new Error(
        `maintenance drain failed closed: reconcile status read failed: ${error instanceof Error ? error.message : String(error)}; no upgrade mutation performed.`,
      );
    }
    if (idle(status)) return;
    if (now() >= drainDeadline + reconcileBudgetMs) break;
  }
  throw new Error(
    `maintenance drain failed closed: cancellation did not reconcile to zero within ${reconcileBudgetMs}ms (remaining work: ${JSON.stringify(status.work)}); no upgrade mutation performed.`,
  );
}

export function buildComposeMaintenanceDrain(
  options: BuildComposeMaintenanceDrainOptions,
): ComposeMaintenanceDrain {
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const renewBufferMs = options.renewBufferMs ?? DEFAULT_RENEW_BUFFER_MS;
  const reconcileBudgetMs = options.reconcileBudgetMs ?? DEFAULT_RECONCILE_BUDGET_MS;
  const log = options.log ?? (() => undefined);

  return async (profile, waitForMs) => {
    const deadline = now() + waitForMs;
    const hardMs = maintenanceHardLeaseMs(waitForMs);
    let transport: ComposeMaintenanceTransport;
    try {
      transport = transportFor(profile, options);
    } catch (error) {
      throw new Error(
        `maintenance drain failed closed: could not resolve operator transport: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let status: MaintenanceOperatorStatus;
    try {
      log("upgrade: entering maintenance drain...");
      status = await options.api.enter(transport, { hardMs });
    } catch (error) {
      throw new Error(
        `maintenance drain failed closed: enter refused: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const operationId = status.operationId;
    if (!operationId) throw new Error("maintenance drain failed closed: enter returned no operationId");
    const clearLease = async (): Promise<void> => {
      try {
        await options.api.cancel(transport, operationId);
      } catch {
        // The original failure wins; hard expiry remains the safety net.
      }
    };
    const handle = () => maintenanceHandle({ api: options.api, transport, operationId, log });
    try {
      if (idle(status)) {
        log("upgrade: drain reached zero immediately; retaining lease for applying transition.");
        return handle();
      }
      while (true) {
        if (now() >= deadline) {
          await cancelAndReconcile({
            api: options.api,
            transport,
            operationId,
            drainDeadline: deadline,
            waitForMs,
            pollIntervalMs,
            reconcileBudgetMs,
            sleep,
            now,
            log,
          });
          log("upgrade: cancellation reconciled to zero; retaining lease for applying transition.");
          return handle();
        }
        if (status.leaseExpiresAt) {
          const leaseMs = Date.parse(status.leaseExpiresAt) - now();
          if (leaseMs < renewBufferMs) status = await options.api.renew(transport, operationId);
        }
        await sleep(pollIntervalMs);
        status = await options.api.status(transport);
        if (idle(status)) {
          log("upgrade: drain reached zero; retaining lease for applying transition.");
          return handle();
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await clearLease();
      if (/timed out|did not reconcile|cancel-work/i.test(reason)) throw error;
      throw new Error(
        `maintenance drain failed closed: ${reason}; lease cleared best-effort; no upgrade mutation performed.`,
      );
    }
  };
}
