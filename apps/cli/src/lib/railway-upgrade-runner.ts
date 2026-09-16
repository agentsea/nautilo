import type { MaintenanceReceipt } from "@nautilo/hosting";
import type { RailwayDestroyCheckpoint, RailwayWholeManifestUpgradeCheckpoint } from "@nautilo/railway-hosting";

import {
  RailwayMaintenanceStateStoreError,
  createRailwaySourceTeardownReceipt,
  readRailwayMaintenanceState,
  updateRailwayMaintenanceState,
  type RailwayMaintenanceActiveLaunch,
  type RailwayMaintenanceState,
  type RailwayPortableOperationState,
} from "./railway-maintenance-state";

export type RailwayUpgradeStageOutcome =
  | { readonly outcome: "pending" }
  | { readonly outcome: "complete" }
  | { readonly outcome: "terminal-failure" };

export interface RailwayRestoreTargetCompletion {
  readonly targetNautiloHostname: string;
  readonly targetLogtoHostname: string;
}

/**
 * The only persistence surface given to stage implementations. Every callback
 * reloads and authority-checks the composite immediately before its CAS. A
 * stage may report complete only after its exact proof is durable here.
 */
export interface RailwayUpgradeStageContext {
  readonly state: RailwayMaintenanceState;
  readonly loadState: () => Promise<RailwayMaintenanceState>;
}
export interface RailwayUpgradeReceiptStageContext extends RailwayUpgradeStageContext {
  readonly persistReceipt: (receipt: MaintenanceReceipt) => Promise<RailwayMaintenanceState>;
}
export interface RailwayUpgradeExportStageContext extends RailwayUpgradeReceiptStageContext {
  readonly persistPortableExport: (portable: RailwayPortableOperationState) => Promise<RailwayMaintenanceState>;
}
export interface RailwayUpgradeCandidateStageContext extends RailwayUpgradeStageContext {
  readonly persistCandidateUpgrade: (checkpoint: RailwayWholeManifestUpgradeCheckpoint) => Promise<RailwayMaintenanceState>;
  readonly persistPostUpgradeSourceState: (state: RailwayMaintenanceState["postUpgradeSourceState"]) => Promise<RailwayMaintenanceState>;
}
export interface RailwayUpgradeRestoreTargetStageContext extends RailwayUpgradeStageContext {
  readonly persistRestoreTargetPreparation: (state: RailwayMaintenanceState["restoreTargetPreparation"]) => Promise<RailwayMaintenanceState>;
  readonly completeRestoreTarget: (completion: RailwayRestoreTargetCompletion) => Promise<RailwayMaintenanceState>;
}
export interface RailwayUpgradeRestoreStageContext extends RailwayUpgradeReceiptStageContext {
  readonly persistPortableRestore: (portable: RailwayPortableOperationState) => Promise<RailwayMaintenanceState>;
}
export interface RailwayUpgradeActivationStageContext extends RailwayUpgradeStageContext {
  /** Direct runners persist their own exact activation children through the same composite CAS store. */
  readonly assertRestoredActivationComplete: () => Promise<RailwayMaintenanceState>;
}

export interface RailwayUpgradeStageAdapters {
  readonly quiesce: (context: RailwayUpgradeReceiptStageContext) => Promise<RailwayUpgradeStageOutcome>;
  readonly backupExactlyThree: (context: RailwayUpgradeReceiptStageContext) => Promise<RailwayUpgradeStageOutcome>;
  readonly exportPortable: (context: RailwayUpgradeExportStageContext) => Promise<RailwayUpgradeStageOutcome>;
  readonly cleanupSourceMaintenance: (context: Pick<RailwayUpgradeExportStageContext, "state" | "loadState" | "persistPortableExport">) => Promise<RailwayUpgradeStageOutcome>;
  readonly candidateUpgrade: (context: RailwayUpgradeCandidateStageContext) => Promise<RailwayUpgradeStageOutcome>;
  readonly verifyCandidateHttps: (context: RailwayUpgradeReceiptStageContext) => Promise<RailwayUpgradeStageOutcome>;
  readonly prepareFreshRestoreTarget: (context: RailwayUpgradeRestoreTargetStageContext) => Promise<RailwayUpgradeStageOutcome>;
  readonly restorePortable: (context: RailwayUpgradeRestoreStageContext) => Promise<RailwayUpgradeStageOutcome>;
  readonly cleanupRestoreMaintenance: (context: Pick<RailwayUpgradeRestoreStageContext, "state" | "loadState" | "persistPortableRestore">) => Promise<RailwayUpgradeStageOutcome>;
  /** Must directly invoke runRailwayRestoredTargetActivationFromState. */
  readonly activateRestoredTarget: (context: RailwayUpgradeActivationStageContext) => Promise<RailwayUpgradeStageOutcome>;
  readonly verifyRestoredTargetHttps: (context: RailwayUpgradeReceiptStageContext) => Promise<RailwayUpgradeStageOutcome>;
}

export interface RailwayUpgradeRunnerInput {
  readonly stateRoot: string;
  readonly statePath: string;
  readonly operationId: string;
  readonly authorityGenerationId: string;
  readonly adapters: RailwayUpgradeStageAdapters;
  readonly now: () => string;
}

export type RailwayUpgradeRunnerResult =
  | { readonly outcome: "pending"; readonly stage: RailwayMaintenanceState["maintenanceReceipt"]["stage"] }
  | { readonly outcome: "terminal-failure"; readonly stage: RailwayMaintenanceState["maintenanceReceipt"]["stage"] }
  | { readonly outcome: "complete" };

function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function completePortable(value: RailwayPortableOperationState | undefined): boolean {
  return value?.target.state === "started" && value.cleanup?.state === "complete";
}
function railwayRestoreActivationFailureIsResumable(state: RailwayMaintenanceState): boolean {
  const common = state.maintenanceReceipt.stage === "restore"
    && state.maintenanceReceipt.lastFailure?.operation === "restore-activation"
    && state.maintenanceReceipt.lastFailure.retryable === false
    && completePortable(state.portableRestore);
  if (!common) return false;
  const beforeEveryChildEffect = state.logtoActivation === undefined
    && state.restoredLogtoBootstrap === undefined
    && state.nautiloActivation === undefined
    && state.restoredTargetActivation === undefined;
  const retainedHandoffIsRefetchable = state.logtoActivation?.state === "complete"
    && state.restoredLogtoBootstrap?.exactActivation?.state === "complete"
    && state.restoredLogtoBootstrap.lifecycle.successfulDeploymentId !== undefined
    && state.restoredLogtoBootstrap.lifecycle.handoffDomainId !== undefined
    && state.restoredLogtoBootstrap.lifecycle.handoffDomain !== undefined
    && state.restoredLogtoBootstrap.lifecycle.handoffApplied === undefined
    && state.nautiloActivation === undefined
    && state.restoredTargetActivation?.stage === "bootstrap-nautilo-start";
  const activationIsDurablyComplete = state.restoredTargetActivation?.stage === "complete";
  return beforeEveryChildEffect || retainedHandoffIsRefetchable || activationIsDurablyComplete;
}
function recoverablePortableExportObservationFailure(state: RailwayMaintenanceState): boolean {
  const target = state.portableExport?.target;
  return state.maintenanceReceipt.stage === "provider-backup"
    && state.maintenanceReceipt.lastFailure?.operation === "portable-export"
    && state.maintenanceReceipt.lastFailure.retryable === false
    && exactlyThreeBackups(state.maintenanceReceipt)
    && target?.state === "started"
    && state.maintenanceReceipt.providerWorkflows?.some((workflow) => workflow.operation === "export-portable"
      && workflow.workflowId === target.jobId && workflow.state === "pending") === true;
}
function exportTransferComplete(state: RailwayMaintenanceState): boolean {
  const target = state.portableExport?.target;
  return target?.state === "started" && state.maintenanceReceipt.portableExport !== undefined
    && state.maintenanceReceipt.providerWorkflows?.some((workflow) => workflow.operation === "export-portable"
      && workflow.workflowId === target.jobId && workflow.state === "complete") === true;
}
function exactlyThreeBackups(receipt: MaintenanceReceipt): boolean {
  const kinds = ["application-postgres", "logto-postgres", "server-volume"] as const;
  return receipt.stage === "provider-backup" && receipt.backupSet?.backups.length === 3
    && kinds.every((kind) => receipt.backupSet!.backups.filter((item) => item.kind === kind).length === 1
      && receipt.providerWorkflows?.filter((item) => item.operation === `backup-${kind}` && item.state === "complete").length === 1);
}
function initialTeardown(state: RailwayMaintenanceState): RailwayDestroyCheckpoint {
  return { schemaVersion: 1, receipt: createRailwaySourceTeardownReceipt(
    state.sourceLaunchState, state.candidateUpgrade, state.sourceRecoveryDeployments,
  ), stage: "validate" };
}
function receiptAt(receipt: MaintenanceReceipt, stage: MaintenanceReceipt["stage"], now: string, extra: Partial<MaintenanceReceipt>): MaintenanceReceipt {
  return { ...receipt, ...extra, revision: receipt.revision + 1, stage, updatedAt: now };
}

export async function runRailwayUpgradeFromState(input: RailwayUpgradeRunnerInput): Promise<RailwayUpgradeRunnerResult> {
  const stable = Object.freeze({ ...input, stateRoot: `${input.stateRoot}`, statePath: `${input.statePath}`,
    operationId: `${input.operationId}`, authorityGenerationId: `${input.authorityGenerationId}` });
  const loadState = async (): Promise<RailwayMaintenanceState> => {
    const state = await readRailwayMaintenanceState(stable.stateRoot, stable.statePath);
    if (state === null || state.maintenanceId !== stable.operationId || state.authorityGenerationId !== stable.authorityGenerationId) {
      throw new RailwayMaintenanceStateStoreError("invalid-state");
    }
    return state;
  };
  const persist = async (mutate: (state: RailwayMaintenanceState) => RailwayMaintenanceState, expected: (state: RailwayMaintenanceState) => boolean): Promise<RailwayMaintenanceState> => {
    const current = await loadState();
    if (expected(current)) return current;
    try {
      return await updateRailwayMaintenanceState(stable.stateRoot, stable.statePath, { expectedRevision: current.revision }, (state) => ({
        ...mutate(state), revision: state.revision + 1,
      }));
    } catch (error) {
      if (!(error instanceof RailwayMaintenanceStateStoreError) || !["revision-conflict", "publish-unknown"].includes(error.code)) throw error;
      const recovered = await loadState();
      if (!expected(recovered)) throw error;
      return recovered;
    }
  };
  const initial = await loadState();
  const context = {
    state: initial,
    loadState,
    persistReceipt: (receipt: MaintenanceReceipt) => persist((state) => ({ ...state, maintenanceReceipt: receipt }), (state) => same(state.maintenanceReceipt, receipt)),
    persistPortableExport: (portable: RailwayPortableOperationState) => persist((state) => ({ ...state, portableExport: portable }), (state) => same(state.portableExport, portable)),
    persistCandidateUpgrade: (checkpoint: RailwayWholeManifestUpgradeCheckpoint) => persist((state) => ({ ...state, candidateUpgrade: checkpoint }), (state) => same(state.candidateUpgrade, checkpoint)),
    persistPostUpgradeSourceState: (postUpgradeSourceState: RailwayMaintenanceState["postUpgradeSourceState"]) => {
      if (postUpgradeSourceState === undefined) throw new RailwayMaintenanceStateStoreError("invalid-state");
      return persist((state) => ({ ...state, postUpgradeSourceState }), (state) => same(state.postUpgradeSourceState, postUpgradeSourceState));
    },
    persistRestoreTargetPreparation: (restoreTargetPreparation: RailwayMaintenanceState["restoreTargetPreparation"]) => {
      if (restoreTargetPreparation === undefined) throw new RailwayMaintenanceStateStoreError("invalid-state");
      return persist((state) => ({ ...state, restoreTargetPreparation }), (state) => same(state.restoreTargetPreparation, restoreTargetPreparation));
    },
    completeRestoreTarget: async (completion: RailwayRestoreTargetCompletion) => {
      const before = await loadState(); const target = before.restoreTargetPreparation;
      if (target === undefined) throw new RailwayMaintenanceStateStoreError("invalid-state");
      const resources = target.reconcile.receipt.resources;
      const projectId = resources.filter((item) => item.kind === "railway.project").at(0)?.id;
      const environmentId = resources.filter((item) => item.kind === "railway.environment").at(0)?.id;
      if (projectId === undefined || environmentId === undefined) throw new RailwayMaintenanceStateStoreError("invalid-state");
      const receipt = receiptAt(before.maintenanceReceipt, "restore-target", stable.now(), {
        restoreTarget: { projectId, environmentId, createdAt: stable.now() },
      });
      return persist((state) => ({ ...state, maintenanceReceipt: receipt, restoreTargetState: target,
        targetNautiloHostname: completion.targetNautiloHostname, targetLogtoHostname: completion.targetLogtoHostname }),
      (state) => same(state.maintenanceReceipt, receipt) && same(state.restoreTargetState, target)
        && state.targetNautiloHostname === completion.targetNautiloHostname && state.targetLogtoHostname === completion.targetLogtoHostname);
    },
    persistPortableRestore: (portable: RailwayPortableOperationState) => persist((state) => ({ ...state, portableRestore: portable }), (state) => same(state.portableRestore, portable)),
    assertRestoredActivationComplete: async () => {
      const state = await loadState();
      if (state.restoredTargetActivation?.stage !== "complete") throw new RailwayMaintenanceStateStoreError("invalid-state");
      return state;
    },
  };
  const call = async <T extends RailwayUpgradeStageContext>(adapter: (value: T) => Promise<RailwayUpgradeStageOutcome>, value: T): Promise<RailwayUpgradeStageOutcome> => {
    try { return await adapter(Object.freeze(value)); } catch (error) {
      if (error instanceof RailwayMaintenanceStateStoreError) throw error;
      return { outcome: "pending" };
    }
  };
  const base = { state: initial, loadState } as const;
  const receiptContext = { ...base, persistReceipt: context.persistReceipt };
  const exportContext = { ...receiptContext, persistPortableExport: context.persistPortableExport };
  const exportCleanupContext = { ...base, persistPortableExport: context.persistPortableExport };
  const candidateContext = { ...base, persistCandidateUpgrade: context.persistCandidateUpgrade, persistPostUpgradeSourceState: context.persistPostUpgradeSourceState };
  const targetContext = { ...base, persistRestoreTargetPreparation: context.persistRestoreTargetPreparation, completeRestoreTarget: context.completeRestoreTarget };
  const restoreContext = { ...receiptContext, persistPortableRestore: context.persistPortableRestore };
  const restoreCleanupContext = { ...base, persistPortableRestore: context.persistPortableRestore };
  const activationContext = { ...base, assertRestoredActivationComplete: context.assertRestoredActivationComplete };
  const pending = (stage = initial.maintenanceReceipt.stage): RailwayUpgradeRunnerResult => ({ outcome: "pending", stage });
  const terminal = async (operation: string): Promise<RailwayUpgradeRunnerResult> => {
    const current = await loadState();
    if (current.maintenanceReceipt.lastFailure?.operation !== operation || current.maintenanceReceipt.lastFailure.retryable !== false) {
      await context.persistReceipt(receiptAt(current.maintenanceReceipt, current.maintenanceReceipt.stage, stable.now(), {
        lastFailure: { operation, retryable: false, occurredAt: stable.now() },
      }));
    }
    return { outcome: "terminal-failure", stage: current.maintenanceReceipt.stage };
  };
  const retainedTerminal = (operation: string): RailwayUpgradeRunnerResult | undefined => (
    initial.maintenanceReceipt.lastFailure?.operation === operation && initial.maintenanceReceipt.lastFailure.retryable === false
      && !(operation === "restore-activation" && railwayRestoreActivationFailureIsResumable(initial))
      && !(operation === "portable-export" && recoverablePortableExportObservationFailure(initial))
      ? { outcome: "terminal-failure", stage: initial.maintenanceReceipt.stage } : undefined
  );
  const enterFallback = async (operation: "candidate-upgrade" | "candidate-verification"): Promise<RailwayUpgradeRunnerResult> => {
    const current = await loadState();
    if (current.restoreTargetState !== undefined && current.maintenanceReceipt.stage === "restore-target") return pending("restore-target");
    const existingDecision = current.fallbackDecision;
    const fallbackDecision = existingDecision ?? { reason: operation, decidedAt: stable.now() };
    if (fallbackDecision.reason !== operation) throw new RailwayMaintenanceStateStoreError("invalid-state");
    const receipt = current.maintenanceReceipt.lastFailure?.operation === operation
      && current.maintenanceReceipt.lastFailure.retryable === false
      ? current.maintenanceReceipt
      : receiptAt(current.maintenanceReceipt, current.maintenanceReceipt.stage, stable.now(), {
        lastFailure: { operation, retryable: false, occurredAt: stable.now() },
      });
    await persist((state) => ({ ...state, maintenanceReceipt: receipt, fallbackDecision }),
      (state) => same(state.maintenanceReceipt, receipt) && same(state.fallbackDecision, fallbackDecision));
    if (existingDecision === undefined) return pending(current.maintenanceReceipt.stage);
    const prepared = await call(stable.adapters.prepareFreshRestoreTarget, targetContext);
    const reloaded = await loadState();
    if (reloaded.maintenanceReceipt.stage === "restore-target" && reloaded.restoreTargetState !== undefined) return pending("restore-target");
    if (prepared.outcome === "terminal-failure") return terminal("restore-target-preparation");
    return prepared.outcome === "complete" && reloaded.maintenanceReceipt.stage !== "restore-target" ? pending() : pending(reloaded.maintenanceReceipt.stage);
  };

  const retainedFailure = initial.maintenanceReceipt.lastFailure;
  if (retainedFailure?.retryable === false) {
    if (retainedFailure.operation === "candidate-upgrade" || retainedFailure.operation === "candidate-verification") {
      if (initial.restoreTargetState === undefined) return enterFallback(retainedFailure.operation);
    } else if (retainedFailure.operation === "restore-target-preparation"
      && initial.fallbackDecision !== undefined
      && initial.restoreTargetState === undefined
      && initial.restoreTargetPreparation?.reconcile.receipt.resources.length === 0
      && initial.restoreTargetPreparation.reconcile.pending?.kind === "project-create"
      && (initial.restoreTargetPreparation.reconcile.pending.attempt ?? 1) === 1) {
      const resumed = receiptAt(initial.maintenanceReceipt, initial.maintenanceReceipt.stage, stable.now(), {
        lastFailure: { operation: initial.fallbackDecision.reason, retryable: false, occurredAt: stable.now() },
      });
      await context.persistReceipt(resumed);
      return pending(resumed.stage);
    } else if (retainedFailure.operation === "restore-activation"
      && initial.restoredTargetActivation?.stage === "complete") {
      await context.persistReceipt(receiptAt(initial.maintenanceReceipt, initial.maintenanceReceipt.stage, stable.now(), {
        lastFailure: undefined,
      }));
      return pending(initial.maintenanceReceipt.stage);
    } else if (retainedFailure.operation === "restore-activation" && railwayRestoreActivationFailureIsResumable(initial)) {
      // A corrected binary may safely re-enter either before every child
      // effect or at the authenticated, retained, idempotent handoff boundary.
    } else if (retainedFailure.operation === "portable-export" && recoverablePortableExportObservationFailure(initial)) {
      // Older clients terminalized a descriptor-last store while its two
      // objects were briefly inconsistent. Re-enter only the exact started
      // job; the target still requires the immutable descriptor proof.
    } else {
      return { outcome: "terminal-failure", stage: initial.maintenanceReceipt.stage };
    }
  }

  if (initial.maintenanceReceipt.stage === "planned") {
    const retained = retainedTerminal("quiesce"); if (retained !== undefined) return retained;
    const result = await call(stable.adapters.quiesce, receiptContext); const state = await loadState();
    if (state.maintenanceReceipt.stage === "quiesced") return pending("quiesced");
    if (result.outcome === "terminal-failure") return terminal("quiesce");
    return pending();
  }
  if (initial.maintenanceReceipt.stage === "quiesced"
    || (initial.maintenanceReceipt.stage === "provider-backup" && !exactlyThreeBackups(initial.maintenanceReceipt))) {
    const retained = retainedTerminal("provider-backup"); if (retained !== undefined) return retained;
    const result = await call(stable.adapters.backupExactlyThree, receiptContext); const state = await loadState();
    if (exactlyThreeBackups(state.maintenanceReceipt)) return pending("provider-backup");
    if (result.outcome === "terminal-failure") return terminal("provider-backup");
    return pending();
  }
  if (initial.maintenanceReceipt.stage === "provider-backup") {
    const retained = retainedTerminal("portable-export"); if (retained !== undefined) return retained;
    const result = await call(stable.adapters.exportPortable, exportContext); const state = await loadState();
    if (state.maintenanceReceipt.stage === "portable-export" && state.portableExport !== undefined) return pending("portable-export");
    if (result.outcome === "terminal-failure") return terminal("portable-export");
    return pending();
  }
  if (initial.maintenanceReceipt.stage === "portable-export" && !exportTransferComplete(initial)) {
    const retained = retainedTerminal("portable-export"); if (retained !== undefined) return retained;
    const result = await call(stable.adapters.exportPortable, exportContext); const state = await loadState();
    if (exportTransferComplete(state)) return pending();
    return result.outcome === "terminal-failure" ? terminal("portable-export") : pending();
  }
  if (initial.maintenanceReceipt.stage === "portable-export" && !completePortable(initial.portableExport)) {
    const retained = retainedTerminal("source-maintenance-cleanup"); if (retained !== undefined) return retained;
    const result = await call(stable.adapters.cleanupSourceMaintenance, exportCleanupContext);
    if (completePortable((await loadState()).portableExport)) return pending();
    return result.outcome === "terminal-failure" ? terminal("source-maintenance-cleanup") : pending();
  }
  if (initial.maintenanceReceipt.stage === "portable-export" && initial.restoreTargetState === undefined) {
    const preparationFailure = retainedTerminal("restore-target-preparation"); if (preparationFailure !== undefined) return preparationFailure;
    if (initial.fallbackDecision !== undefined) return enterFallback(initial.fallbackDecision.reason);
    if (initial.candidateUpgrade?.stage === "start-ambiguous"
      || initial.candidateUpgrade?.stage === "migration-start-ambiguous"
      || initial.candidateUpgrade?.stage === "migration-start-unresolved") return enterFallback("candidate-upgrade");
    if (initial.maintenanceReceipt.lastFailure?.operation === "candidate-upgrade" && initial.maintenanceReceipt.lastFailure.retryable === false) {
      return enterFallback("candidate-upgrade");
    }
    const result = await call(stable.adapters.candidateUpgrade, candidateContext); const state = await loadState();
    if (state.candidateUpgrade?.stage !== "complete" || state.postUpgradeSourceState === undefined) {
      return result.outcome === "terminal-failure" ? enterFallback("candidate-upgrade") : pending();
    }
    const release = receiptAt(state.maintenanceReceipt, "release", stable.now(), { release: { releaseId: state.maintenanceReceipt.targetReleaseId, appliedAt: stable.now() } });
    await context.persistReceipt(release); return pending("release");
  }
  if (initial.maintenanceReceipt.stage === "release" && initial.restoreTargetState === undefined) {
    if (initial.candidateUpgrade?.stage !== "complete") return pending();
    await context.persistReceipt(receiptAt(initial.maintenanceReceipt, "migration", stable.now(), {
      migration: { migrationId: initial.candidateUpgrade.migrationId, completedAt: stable.now() },
    })); return pending("migration");
  }
  if (initial.maintenanceReceipt.stage === "migration" && initial.restoreTargetState === undefined) {
    if (initial.maintenanceReceipt.lastFailure?.operation === "candidate-verification" && initial.maintenanceReceipt.lastFailure.retryable === false) {
      return enterFallback("candidate-verification");
    }
    const result = await call(stable.adapters.verifyCandidateHttps, receiptContext); const state = await loadState();
    if (state.maintenanceReceipt.stage === "verification" && state.maintenanceReceipt.verification?.subject === "candidate") return pending("verification");
    if (result.outcome === "terminal-failure") return enterFallback("candidate-verification");
    return result.outcome === "complete" && state.maintenanceReceipt.stage === "verification"
      && state.maintenanceReceipt.verification?.subject === "candidate" ? pending("verification") : pending();
  }
  if (initial.maintenanceReceipt.stage === "verification" && initial.restoreTargetState === undefined) {
    if (initial.postUpgradeSourceState === undefined) return pending();
    const activeLaunch: RailwayMaintenanceActiveLaunch = { kind: "source", launchId: initial.postUpgradeSourceState.launchId,
      releaseId: initial.postUpgradeSourceState.releaseId, selectedAt: stable.now() };
    const complete = receiptAt(initial.maintenanceReceipt, "complete", stable.now(), {});
    await persist((state) => ({ ...state, maintenanceReceipt: complete, activeLaunch }),
      (state) => same(state.maintenanceReceipt, complete) && same(state.activeLaunch, activeLaunch));
    return { outcome: "complete" };
  }
  if (["portable-export", "release", "migration"].includes(initial.maintenanceReceipt.stage) && initial.restoreTargetState === undefined
    && initial.restoreTargetPreparation !== undefined) {
    const retained = retainedTerminal("restore-target-preparation"); if (retained !== undefined) return retained;
    const result = await call(stable.adapters.prepareFreshRestoreTarget, targetContext);
    if ((await loadState()).maintenanceReceipt.stage === "restore-target") return pending("restore-target");
    return result.outcome === "terminal-failure" ? terminal("restore-target-preparation") : pending();
  }
  if (initial.maintenanceReceipt.stage === "restore-target") {
    const retained = retainedTerminal("restore-portable"); if (retained !== undefined) return retained;
    const result = await call(stable.adapters.restorePortable, restoreContext); const state = await loadState();
    if (state.maintenanceReceipt.stage === "restore" && state.portableRestore !== undefined) return pending("restore");
    if (result.outcome === "terminal-failure") return terminal("restore-portable");
    return pending();
  }
  if (initial.maintenanceReceipt.stage === "restore" && !completePortable(initial.portableRestore)) {
    const retained = retainedTerminal("restore-maintenance-cleanup"); if (retained !== undefined) return retained;
    const result = await call(stable.adapters.cleanupRestoreMaintenance, restoreCleanupContext);
    if (completePortable((await loadState()).portableRestore)) return pending();
    return result.outcome === "terminal-failure" ? terminal("restore-maintenance-cleanup") : pending();
  }
  if (initial.maintenanceReceipt.stage === "restore" && initial.restoredTargetActivation?.stage !== "complete") {
    const retained = retainedTerminal("restore-activation"); if (retained !== undefined) return retained;
    const result = await call(stable.adapters.activateRestoredTarget, activationContext);
    const activated = await loadState();
    if (activated.restoredTargetActivation?.stage === "complete") {
      if (activated.maintenanceReceipt.lastFailure?.operation === "restore-activation") {
        await context.persistReceipt(receiptAt(activated.maintenanceReceipt, activated.maintenanceReceipt.stage, stable.now(), {
          lastFailure: undefined,
        }));
      }
      return pending();
    }
    return result.outcome === "terminal-failure" ? terminal("restore-activation") : pending();
  }
  if (initial.maintenanceReceipt.stage === "restore") {
    const retained = retainedTerminal("restore-verification"); if (retained !== undefined) return retained;
    const result = await call(stable.adapters.verifyRestoredTargetHttps, receiptContext); const state = await loadState();
    if (state.maintenanceReceipt.stage === "restore-verification" && state.maintenanceReceipt.verification?.subject === "restore-target") return pending("restore-verification");
    if (result.outcome === "terminal-failure") return terminal("restore-verification");
    return result.outcome === "complete" && state.maintenanceReceipt.stage === "restore-verification"
      && state.maintenanceReceipt.verification?.subject === "restore-target" ? pending("restore-verification") : pending();
  }
  if (initial.maintenanceReceipt.stage === "restore-verification") {
    const target = initial.restoreTargetState;
    if (target === undefined || initial.restoredTargetActivation?.stage !== "complete") return pending();
    const activeLaunch: RailwayMaintenanceActiveLaunch = { kind: "restore-target", launchId: target.launchId, releaseId: target.releaseId, selectedAt: stable.now() };
    const sourceTeardown = initialTeardown(initial);
    const cutover = receiptAt(initial.maintenanceReceipt, "cutover", stable.now(), { cutover: { committedAt: stable.now() } });
    await persist((state) => ({ ...state, maintenanceReceipt: cutover, activeLaunch, sourceTeardown }),
      (state) => same(state.maintenanceReceipt, cutover) && same(state.activeLaunch, activeLaunch) && same(state.sourceTeardown, sourceTeardown));
    return pending("cutover");
  }
  if (initial.maintenanceReceipt.stage === "cutover") {
    const complete = receiptAt(initial.maintenanceReceipt, "complete", stable.now(), {});
    await context.persistReceipt(complete); return { outcome: "complete" };
  }
  if (initial.maintenanceReceipt.stage !== "complete") return pending();
  const validActive = initial.restoreTargetState === undefined
    ? initial.activeLaunch?.kind === "source" && initial.postUpgradeSourceState !== undefined
    : initial.activeLaunch?.kind === "restore-target" && initial.sourceTeardown !== undefined;
  return validActive ? { outcome: "complete" } : { outcome: "terminal-failure", stage: "complete" };
}
