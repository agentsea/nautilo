import { RailwayBootstrapHandoffPendingError, type RailwayBootstrapHandoffOutput } from "./bootstrap-lifecycle";
import {
  compileRailwayPreparationDesiredStates,
  compileRailwayReconcileDesiredState,
  type RailwayDesiredStateTarget,
} from "./desired-state";
import type { RailwayReconcileDesiredState } from "./reconcile-types";
import type { RailwayBootstrapLifecycleFailureCode, RailwayBootstrapLifecycleStage } from "./bootstrap-lifecycle";
import type { RailwayReconcileFailureCode, RailwayReconcileStage } from "./reconcile-types";
import type { RailwayTopology } from "./topology";
import {
  projectRailwayRuntimeVariables,
  type RailwayVariableProjectionInputs,
} from "./variable-projection";

export const RAILWAY_DEPLOYMENT_WORKFLOW_SCHEMA_VERSION = 1 as const;

export type RailwayDeploymentWorkflowStage =
  | "databases"
  | "database-bootstrap"
  | "logto-seed"
  | "logto-seed-ready"
  | "public-scaffold"
  | "logto-core"
  | "logto-core-ready"
  | "logto-bootstrap"
  | "server-ready"
  | "complete";

export interface RailwayDeploymentWorkflowCheckpoint {
  readonly schemaVersion: typeof RAILWAY_DEPLOYMENT_WORKFLOW_SCHEMA_VERSION;
  readonly releaseId: string;
  readonly stage: RailwayDeploymentWorkflowStage;
}

export type RailwayWorkflowStepResult =
  | { readonly outcome: "complete" }
  | { readonly outcome: "pending" }
  | { readonly outcome: "failure"; readonly code?: RailwayWorkflowStepFailureCode | undefined };

export type RailwayWorkflowStepFailureCode =
  | `railway.reconcile.${RailwayReconcileStage}.${RailwayReconcileFailureCode}`
  | `railway.bootstrap.${RailwayBootstrapLifecycleStage}.${RailwayBootstrapLifecycleFailureCode}`
  | "railway.template-adoption.failed"
  | "railway.readiness.failed";

export interface RailwayDeploymentWorkflowExecutor {
  readonly reconcile: (desired: RailwayReconcileDesiredState) => Promise<RailwayWorkflowStepResult>;
  readonly runDatabaseBootstrap: (
    variables: Readonly<Record<string, string>>,
  ) => Promise<RailwayWorkflowStepResult>;
  readonly waitForService: (
    service: "app-postgres" | "logto-postgres" | "logto-seed" | "logto" | "nautilo-server",
  ) => Promise<RailwayWorkflowStepResult>;
  readonly runLogtoBootstrap: (input: {
    readonly variables: Readonly<Record<string, string>>;
    readonly token: string;
    readonly applyOutput: (output: RailwayBootstrapHandoffOutput) => Promise<void>;
  }) => Promise<RailwayWorkflowStepResult>;
}

export interface RailwayDeploymentWorkflowRequest {
  readonly topology: RailwayTopology;
  readonly projectionInputs: RailwayVariableProjectionInputs;
  readonly target: RailwayDesiredStateTarget;
  readonly checkpoint?: RailwayDeploymentWorkflowCheckpoint | undefined;
  readonly executor: RailwayDeploymentWorkflowExecutor;
  readonly persistCheckpoint: (checkpoint: RailwayDeploymentWorkflowCheckpoint) => Promise<void>;
}

export type RailwayDeploymentWorkflowFailureCode =
  | "invalid-checkpoint"
  | "compilation-failed"
  | "step-failed"
  | "persistence-failed";

export type RailwayDeploymentWorkflowResult =
  | { readonly outcome: "complete"; readonly checkpoint: RailwayDeploymentWorkflowCheckpoint }
  | { readonly outcome: "pending"; readonly checkpoint: RailwayDeploymentWorkflowCheckpoint }
  | {
      readonly outcome: "failure";
      readonly code: RailwayDeploymentWorkflowFailureCode;
      readonly stepCode?: RailwayWorkflowStepFailureCode | undefined;
      readonly checkpoint: RailwayDeploymentWorkflowCheckpoint;
    };

function initial(topology: RailwayTopology): RailwayDeploymentWorkflowCheckpoint {
  return {
    schemaVersion: RAILWAY_DEPLOYMENT_WORKFLOW_SCHEMA_VERSION,
    releaseId: topology.releaseId,
    stage: "databases",
  };
}

function valid(
  checkpoint: RailwayDeploymentWorkflowCheckpoint,
  topology: RailwayTopology,
): boolean {
  return checkpoint.schemaVersion === RAILWAY_DEPLOYMENT_WORKFLOW_SCHEMA_VERSION
    && checkpoint.releaseId === topology.releaseId
    && [
      "databases", "database-bootstrap", "logto-seed", "logto-seed-ready",
      "public-scaffold", "logto-core", "logto-core-ready", "logto-bootstrap",
      "server-ready", "complete",
    ].includes(checkpoint.stage);
}

async function advance(
  request: RailwayDeploymentWorkflowRequest,
  checkpoint: RailwayDeploymentWorkflowCheckpoint,
  stage: RailwayDeploymentWorkflowStage,
): Promise<RailwayDeploymentWorkflowCheckpoint | null> {
  const next = { ...checkpoint, stage };
  try {
    await request.persistCheckpoint(next);
    return next;
  } catch {
    return null;
  }
}

function failed(
  code: RailwayDeploymentWorkflowFailureCode,
  checkpoint: RailwayDeploymentWorkflowCheckpoint,
  stepCode?: RailwayWorkflowStepFailureCode,
): RailwayDeploymentWorkflowResult {
  return { outcome: "failure", code, checkpoint, ...(stepCode === undefined ? {} : { stepCode }) };
}

async function runStep(
  step: () => Promise<RailwayWorkflowStepResult>,
): Promise<RailwayWorkflowStepResult> {
  try {
    return await step();
  } catch {
    return { outcome: "failure" };
  }
}

/**
 * Runs until a provider readiness boundary yields pending, a safe failure is
 * reached, or the complete stack is ready. Secret-bearing outputs are applied
 * inside the Logto handoff callback and never enter the workflow checkpoint.
 */
export async function runRailwayDeploymentWorkflow(
  request: RailwayDeploymentWorkflowRequest,
): Promise<RailwayDeploymentWorkflowResult> {
  let checkpoint = request.checkpoint ?? initial(request.topology);
  if (!valid(checkpoint, request.topology)) return failed("invalid-checkpoint", checkpoint);
  const preparation = compileRailwayPreparationDesiredStates(
    request.topology,
    request.projectionInputs,
    request.target,
  );
  if (!preparation.ok) return failed("compilation-failed", checkpoint);

  const executeAndAdvance = async (
    step: () => Promise<RailwayWorkflowStepResult>,
    next: RailwayDeploymentWorkflowStage,
  ): Promise<RailwayDeploymentWorkflowResult | null> => {
    const result = await runStep(step);
    if (result.outcome === "pending") return { outcome: "pending", checkpoint };
    if (result.outcome === "failure") return failed("step-failed", checkpoint, result.code);
    const persisted = await advance(request, checkpoint, next);
    if (!persisted) return failed("persistence-failed", checkpoint);
    checkpoint = persisted;
    return null;
  };

  while (checkpoint.stage !== "complete") {
    let stopped: RailwayDeploymentWorkflowResult | null;
    switch (checkpoint.stage) {
      case "databases":
        stopped = await executeAndAdvance(
          () => request.executor.reconcile(preparation.preparation.databases),
          "database-bootstrap",
        );
        break;
      case "database-bootstrap":
        stopped = await executeAndAdvance(
          async () => {
            const appDatabase = await runStep(() => request.executor.waitForService("app-postgres"));
            if (appDatabase.outcome !== "complete") return appDatabase;
            const logtoDatabase = await runStep(() => request.executor.waitForService("logto-postgres"));
            if (logtoDatabase.outcome !== "complete") return logtoDatabase;
            return request.executor.runDatabaseBootstrap(preparation.preparation.databaseBootstrapVariables);
          },
          "logto-seed",
        );
        break;
      case "logto-seed":
        stopped = await executeAndAdvance(
          () => request.executor.reconcile(preparation.preparation.logtoSeed),
          "logto-seed-ready",
        );
        break;
      case "logto-seed-ready":
        stopped = await executeAndAdvance(
          () => request.executor.waitForService("logto-seed"),
          "public-scaffold",
        );
        break;
      case "public-scaffold":
        stopped = await executeAndAdvance(
          () => request.executor.reconcile(preparation.preparation.publicScaffold),
          "logto-core",
        );
        break;
      case "logto-core":
        stopped = await executeAndAdvance(
          () => request.executor.reconcile(preparation.preparation.logtoCore),
          "logto-core-ready",
        );
        break;
      case "logto-core-ready":
        stopped = await executeAndAdvance(
          () => request.executor.waitForService("logto"),
          "logto-bootstrap",
        );
        break;
      case "logto-bootstrap": {
        const token = preparation.preparation.logtoBootstrapVariables["NAUTILO_BOOTSTRAP_HANDOFF_TOKEN"];
        if (!token) return failed("compilation-failed", checkpoint);
        stopped = await executeAndAdvance(
          () => request.executor.runLogtoBootstrap({
            variables: preparation.preparation.logtoBootstrapVariables,
            token,
            applyOutput: async (output) => {
              const bootstrapOutputs = new Map(request.projectionInputs.bootstrapOutputs);
              bootstrapOutputs.set("logto-workbench-app-id", output["logto-workbench-app-id"]);
              bootstrapOutputs.set("logto-tui-app-id", output["logto-tui-app-id"]);
              bootstrapOutputs.set("logto-tui-loopback-app-id", output["logto-tui-loopback-app-id"]);
              bootstrapOutputs.set("logto-desktop-app-id", output["logto-desktop-app-id"]);
              bootstrapOutputs.set("logto-mobile-app-id", output["logto-mobile-app-id"]);
              bootstrapOutputs.set("logto-mobile-web-app-id", output["logto-mobile-web-app-id"]);
              bootstrapOutputs.set("logto-m2m-app-id", output["logto-m2m-app-id"]);
              bootstrapOutputs.set("logto-m2m-app-secret", output["logto-m2m-app-secret"]);
              bootstrapOutputs.set("logto-resource", output["logto-resource"]);
              const projection = projectRailwayRuntimeVariables(request.topology, {
                ...request.projectionInputs,
                bootstrapOutputs,
              });
              if (!projection.ok) throw new Error("runtime projection failed");
              const desired = compileRailwayReconcileDesiredState(
                request.topology,
                projection.projection,
                request.target,
              );
              if (!desired.ok) throw new Error("runtime desired state failed");
              const applied = await request.executor.reconcile(desired.desired);
              if (applied.outcome === "pending") throw new RailwayBootstrapHandoffPendingError();
              if (applied.outcome !== "complete") throw new Error("runtime reconciliation failed");
            },
          }),
          "server-ready",
        );
        break;
      }
      case "server-ready":
        stopped = await executeAndAdvance(
          () => request.executor.waitForService("nautilo-server"),
          "complete",
        );
        break;
      default:
        return failed("invalid-checkpoint", checkpoint);
    }
    if (stopped) return stopped;
  }
  return { outcome: "complete", checkpoint };
}
