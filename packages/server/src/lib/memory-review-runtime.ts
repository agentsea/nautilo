import { fromRuntimeConfig } from "@nautilo/config";
import { getProviderFromModelId } from "@nautilo/agent";
import type { CapabilityFundingSession } from "@nautilo/agent";
import type { OrganizerEvidenceBudget } from "@nautilo/reflection";
import type { DurableModelExposureDependency } from "@nautilo/reflection/durable";
import type { PersonalMemoryEvidencePort } from "@nautilo/reflection-bridge/server";
import {
  getServerContextConfig, getCachedServerModelConfigRow, kickServerModelConfigRefresh,
  getEncryptionTransitionPolicy, getServerModelConfigRow, queryMemoryReviewStatus,
  retryFailedMemoryReviews,
  type DirectDatabase, type MemoryReviewStatusInput,
} from "@nautilo/db";
import { MemoryReviewWorker, PostgresMemoryReviewRepository,
  recoverMemoryReviewTurnsAtStartup, readOrdinaryMemoryReviewCheckpoint, jobManager, resolveMemoryReviewModelId,
} from "@nautilo/runtime";
import { STENOGRAPHER_STATUS_WINDOW_MS } from "../routes/stenographer-status";
import { log, warn } from "@nautilo/logger";
import { getServerDirectDb } from "./server-direct-db";
import { enforceRegisteredStrictShadowBoundary } from "./strict-shadow-policy";
import { createPersonalMemoryReviewAdmitter } from "./personal-memory-review-funding";
import type { ProfileSoulFingerprintInput, MemoryReviewClaim } from "@nautilo/runtime";
import type { MemoryReviewOptions } from "@nautilo/agent";
import {
  ManualMemoryReviewRecoveryMaintenanceError,
  ManualMemoryReviewRecoveryPausedError,
  ManualMemoryReviewRecoveryPolicyError,
  requestManualReviewRecovery,
} from "./request-manual-review-recovery";

// Match existing Stenographer polling/lease/shutdown policy. The lease is
// renewable; it fences publication, not a limit on the number of Memory turns.
const MEMORY_REVIEW_RUNTIME_POLICY = {
  scanIntervalMs: 15_000, shutdownWaitMs: 10_000,
  leaseMs: 2 * 60_000, retryMs: 15_000, recoveryPageSize: 100,
} as const;

export function memoryReviewRuntimeAdmission(input: {
  enabled: boolean;
  maintenanceAccepting: boolean;
  ordinaryContentAvailable: boolean;
}): boolean {
  return input.enabled && input.maintenanceAccepting && input.ordinaryContentAvailable;
}

type ReviewSnapshot = Parameters<NonNullable<MemoryReviewOptions["onModelExposure"]>>[0][number];

export interface ServerMemoryReviewPersonalFundingOptions {
  readonly evidence: PersonalMemoryEvidencePort;
  readonly budget: OrganizerEvidenceBudget;
  readonly commitmentKey: Uint8Array;
  readonly fingerprintProfileSoul: (input: ProfileSoulFingerprintInput) => string;
  readonly resolveExposureDependencies: (claim: MemoryReviewClaim, snapshots: readonly ReviewSnapshot[]) =>
    Promise<readonly DurableModelExposureDependency[] | undefined>;
  readonly openHumanSession?: (humanUserId: string, recheck: () => Promise<void>) => CapabilityFundingSession;
}

export class MemoryReviewManualRecoveryUnavailableError extends Error {
  constructor(readonly code:
    | "runtime_stopped"
    | "paused"
    | "maintenance_unavailable"
    | "access_unavailable"
    | "model_unavailable") {
    super(`Memory review manual recovery is unavailable: ${code}`);
    this.name = "MemoryReviewManualRecoveryUnavailableError";
  }
}

export function createServerMemoryReviewRuntime(
  maintenanceGate: {
    isAcceptingWork(): Promise<boolean>;
    isAcceptingWorkInTransaction(db: DirectDatabase, now: Date): Promise<boolean>;
  },
  personalFunding?: ServerMemoryReviewPersonalFundingOptions,
) {
  let worker: MemoryReviewWorker | null = null;
  let repository: PostgresMemoryReviewRepository | null = null;
  let stopped = false;
  const bootCutoff = new Date();
  let recovered = false;
  const resolveModel = (config: Readonly<{
    memoryReviewModel: string | null | undefined;
    conductorModel: string | null | undefined;
  }>): MemoryReviewStatusInput["model"] => {
    const configured = config?.memoryReviewModel?.trim();
    const runtimeConductor = fromRuntimeConfig().nautilo_conductor_model;
    const source: MemoryReviewStatusInput["model"]["source"] = configured
      ? "server" : "conductor";
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
  const model = (): MemoryReviewStatusInput["model"] => {
    kickServerModelConfigRefresh();
    return resolveModel(getCachedServerModelConfigRow() ?? {
      memoryReviewModel: null,
      conductorModel: null,
    });
  };
  const manualModel = async (
    db: Pick<DirectDatabase, "select">,
  ): Promise<MemoryReviewStatusInput["model"]> => resolveModel(
    await getServerModelConfigRow(db) ?? {
      memoryReviewModel: null,
      conductorModel: null,
    },
  );
  const enabled = async () =>
    (await getServerContextConfig(getServerDirectDb())).memoryReviewEnabled
      ?? fromRuntimeConfig().nautilo_reviewer_enabled;
  const protection = async () => {
    const result = await enforceRegisteredStrictShadowBoundary({ boundaryId: "background.memory.review", state: "unsupported", reason: "unsupported_operation", retryable: false });
    // No protected-content Memory review adapter exists yet. Strict must stay
    // unavailable rather than running the ordinary transcript reader.
    return result.result.disposition === "ordinary";
  };
  const admitted = async () => memoryReviewRuntimeAdmission({
    enabled: await enabled(),
    maintenanceAccepting: await maintenanceGate.isAcceptingWork(),
    ordinaryContentAvailable: await protection(),
  });
  const available = async () => {
    if (!await admitted()) return false;
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
      ...(personalFunding === undefined ? {} : { fingerprintProfileSoul: personalFunding.fingerprintProfileSoul }),
    }, getServerDirectDb());
    const store = repository;
    const admitModel = personalFunding === undefined ? undefined : createPersonalMemoryReviewAdmitter({
      repository: store, evidence: personalFunding.evidence, budget: personalFunding.budget,
      commitmentKey: personalFunding.commitmentKey,
      resolveServiceModel: () => { const current = model(); if (!current.available || !current.id) throw new Error("model_unavailable"); return current.id; },
      resolveExposureDependencies: personalFunding.resolveExposureDependencies,
      ...(personalFunding.openHumanSession === undefined ? {} : { openHumanSession: personalFunding.openHumanSession }),
    });
    worker = new MemoryReviewWorker({
      repository: store, checkAvailable: available,
      resolveModelId: () => { const current = model(); if (!current.available || !current.id) throw new Error("model_unavailable"); return current.id; },
      ...(admitModel === undefined ? {} : { admitModel }),
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
    async requestModelRecovery(input: Parameters<PostgresMemoryReviewRepository["requestModelRecovery"]>[0]) {
      if (stopped || !await admitted()) return "blocked" as const;
      const current = ensure();
      const result = await current.repository.requestModelRecovery(input);
      if (result === "queued") current.worker.wake();
      return result;
    },
    async requestManualRecovery(input: Readonly<{
      db: Pick<DirectDatabase, "transaction" | "select" | "insert" | "update" | "execute">;
      now: Date;
      observedThrough: Date;
      authorizedBy: string;
    }>) {
      if (stopped) throw new MemoryReviewManualRecoveryUnavailableError("runtime_stopped");
      // The manual-recovery coordinator checks maintenance before opening its
      // durable receipt transaction. Database-backed enablement and policy
      // admission run inside requestManualReviewRecovery's supplied savepoint.
      const selected = await manualModel(input.db);
      if (!selected.available || !selected.id) {
        throw new MemoryReviewManualRecoveryUnavailableError("model_unavailable");
      }
      try {
        return await requestManualReviewRecovery({
          ...input,
          modelId: selected.id,
          enabledByDefault: fromRuntimeConfig().nautilo_reviewer_enabled,
          maintenanceAccepting: (db, now) =>
            maintenanceGate.isAcceptingWorkInTransaction(db, now),
        });
      } catch (error) {
        if (error instanceof ManualMemoryReviewRecoveryMaintenanceError) {
          throw new MemoryReviewManualRecoveryUnavailableError("maintenance_unavailable");
        }
        if (error instanceof ManualMemoryReviewRecoveryPausedError) {
          throw new MemoryReviewManualRecoveryUnavailableError("paused");
        }
        if (error instanceof ManualMemoryReviewRecoveryPolicyError) {
          throw new MemoryReviewManualRecoveryUnavailableError("access_unavailable");
        }
        throw error;
      }
    },
  };
}
