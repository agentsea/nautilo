import { fromRuntimeConfig } from "@nautilo/config";
import { getProviderFromModelId } from "@nautilo/agent";
import {
  getServerContextConfig, getCachedServerModelConfigRow, kickServerModelConfigRefresh,
  getEncryptionTransitionPolicy, queryMemoryReviewStatus, retryFailedMemoryReviews,
  type MemoryReviewStatusInput,
} from "@nautilo/db";
import { MemoryReviewWorker, PostgresMemoryReviewRepository,
  recoverMemoryReviewTurnsAtStartup, readOrdinaryMemoryReviewCheckpoint, jobManager, resolveMemoryReviewModelId,
} from "@nautilo/runtime";
import { STENOGRAPHER_STATUS_WINDOW_MS } from "../routes/stenographer-status";
import { log, warn } from "@nautilo/logger";
import { getServerDirectDb } from "./server-direct-db";
import { enforceRegisteredStrictShadowBoundary } from "./strict-shadow-policy";

// Match existing Stenographer polling/lease/shutdown policy. The lease is
// renewable; it fences publication, not a limit on the number of Memory turns.
const MEMORY_REVIEW_RUNTIME_POLICY = {
  scanIntervalMs: 15_000, shutdownWaitMs: 10_000,
  leaseMs: 2 * 60_000, retryMs: 15_000, recoveryPageSize: 100,
} as const;

export function createServerMemoryReviewRuntime(maintenanceGate: { isAcceptingWork(): Promise<boolean> }) {
  let worker: MemoryReviewWorker | null = null;
  let repository: PostgresMemoryReviewRepository | null = null;
  let stopped = false;
  const bootCutoff = new Date();
  let recovered = false;
  const model = (): MemoryReviewStatusInput["model"] => {
    kickServerModelConfigRefresh();
    const config = getCachedServerModelConfigRow();
    const configured = config?.memoryReviewModel?.trim();
    const runtimeConductor = fromRuntimeConfig().nautilo_conductor_model;
    const source = configured ? "server" : "conductor";
    let id: string | null = configured || config?.conductorModel?.trim() || runtimeConductor || null;
    let available = false;
    try {
      id = resolveMemoryReviewModelId({
        serverConfiguredModelId: configured,
        serverConfiguredConductorModelId: config?.conductorModel,
        runtimeConfiguredConductorModelId: runtimeConductor,
      });
      available = true;
    } catch { /* Unavailable selections remain visible without silent substitution. */ }
    return { id, provider: id ? getProviderFromModelId(id) : null, source, available };
  };
  const enabled = async () => (await getServerContextConfig(getServerDirectDb())).memoryReviewEnabled ?? fromRuntimeConfig().nautilo_reviewer_enabled;
  const protection = async () => {
    const result = await enforceRegisteredStrictShadowBoundary({ boundaryId: "background.memory.review", state: "unsupported", reason: "unsupported_operation", retryable: false });
    return result.result.disposition === "ordinary" || result.result.disposition === "protected";
  };
  const available = async () => {
    if (!(await enabled()) || !model().available || !(await maintenanceGate.isAcceptingWork()) || !(await protection())) return false;
    if (!recovered) {
      const recovery = await recoverMemoryReviewTurnsAtStartup({
        db: getServerDirectDb(), pageSize: MEMORY_REVIEW_RUNTIME_POLICY.recoveryPageSize,
        checkAvailable: protection, readCheckpoint: readOrdinaryMemoryReviewCheckpoint,
        bootCutoff, isTurnActive: (turnId) => jobManager.getActiveJobs().some((job) => job.input["turnId"] === turnId),
      });
      recovered = !recovery.unavailable;
    }
    return recovered;
  };
  const ensure = () => {
    if (worker && repository) return { worker, repository };
    repository = new PostgresMemoryReviewRepository({
      threshold: () => fromRuntimeConfig().nautilo_nudge_threshold,
      leaseMs: MEMORY_REVIEW_RUNTIME_POLICY.leaseMs, retryMs: MEMORY_REVIEW_RUNTIME_POLICY.retryMs,
      retentionMs: STENOGRAPHER_STATUS_WINDOW_MS, retentionBatchSize: MEMORY_REVIEW_RUNTIME_POLICY.recoveryPageSize,
      assertAvailable: async () => { if (!(await protection())) throw new Error("access_unavailable"); },
    }, getServerDirectDb());
    const store = repository;
    worker = new MemoryReviewWorker({
      repository: store, checkAvailable: available,
      resolveModelId: () => { const current = model(); if (!current.available || !current.id) throw new Error("model_unavailable"); return current.id; },
      openAccess: async (_identity, signal, claim) => {
        await store.assertCurrent(claim);
        let lost = false;
        let renewing: Promise<void> | null = null;
        const timer = setInterval(() => {
          if (signal.aborted || renewing) return;
          renewing = store.renew(claim).catch(() => { lost = true; }).finally(() => { renewing = null; });
        }, MEMORY_REVIEW_RUNTIME_POLICY.leaseMs / 3);
        timer.unref?.();
        return {
          assertCurrent: async () => { if (lost) throw new Error("lease_lost"); await store.assertCurrent(claim); },
          close: async () => { clearInterval(timer); await renewing; },
        };
      },
      observeAttempt: (observation) => { log("[memory-review] background attempt closed", { ...observation }); },
      onError: (phase) => warn(`[memory-review] ${phase} unavailable; durable work retained`),
    }, MEMORY_REVIEW_RUNTIME_POLICY);
    return { worker, repository };
  };
  return {
    start() {
      const current = ensure();
      if (!stopped) current.worker.start();
    },
    async stop() { stopped = true; await worker?.stop(); },
    wake() { worker?.wake(); },
    async queryStatus(input: Pick<MemoryReviewStatusInput, "now" | "since" | "until">) {
      const policy = await getEncryptionTransitionPolicy(getServerDirectDb());
      const mode = policy.mode === "plaintext_only" ? "ordinary" : policy.shadowBehavior;
      return queryMemoryReviewStatus(getServerDirectDb(), { ...input, enabled: await enabled(),
        threshold: fromRuntimeConfig().nautilo_nudge_threshold, model: model(),
        encryption: { mode, available: mode !== "strict" },
      });
    },
    async retryFailed() { const result = await retryFailedMemoryReviews(getServerDirectDb()); worker?.wake(); return result; },
  };
}
