import { isIP } from "node:net";

import {
  RailwayGraphqlReconcileExecutor,
  compileRailwayPortableRestorePreparation,
  reconcileRailwayResources,
  runRailwayBootstrapLifecycle,
  type RailwayBootstrapLifecycleExecutor,
  type RailwayDesiredStateTarget,
  type RailwayDeployment,
  type RailwayReconcileDesiredState,
  type RailwayReconcileExecutor,
  type RailwayReconcileExecutorTransport,
  type RailwayServiceInstance,
  type RailwayTopology,
  type RailwayVariableProjectionInputs,
} from "@nautilo/railway-hosting";

import {
  classifyRailwayBootstrapStepResult,
  createRailwayDeploymentDriverState,
  parseRailwayDeploymentDriverState,
  type RailwayDeploymentDriverState,
} from "./railway-deployment-runner";
import { RailwayMaintenanceStateStoreError } from "./railway-maintenance-state";
import type {
  RailwayUpgradeRestoreTargetStageContext,
  RailwayUpgradeStageOutcome,
} from "./railway-upgrade-runner";

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;

export interface RailwayRestorePreparationRunnerInput {
  readonly context: RailwayUpgradeRestoreTargetStageContext;
  readonly operationId: string;
  readonly authorityGenerationId: string;
  readonly targetLaunchId: string;
  readonly providers: readonly string[];
  readonly topology: RailwayTopology;
  readonly projectionInputs: RailwayVariableProjectionInputs;
  readonly target: RailwayDesiredStateTarget;
  readonly transport: RailwayReconcileExecutorTransport;
  readonly now: () => string;
  /** Provider primitives only; the durable coordinators themselves are never injected. */
  readonly executor?: RailwayRestorePreparationExecutor | undefined;
}

export interface RailwayRestorePreparationExecutor extends RailwayReconcileExecutor {
  readonly getDeployment: (input: { readonly deploymentId: string }) => Promise<RailwayDeployment>;
  readonly deleteService: (input: { readonly serviceId: string; readonly environmentId: string }) => Promise<void>;
  readonly listDeploymentsRaw: (input: {
    readonly projectId: string;
    readonly environmentId: string;
    readonly serviceId: string;
  }) => Promise<readonly RailwayDeployment[]>;
}

class RailwayRestorePreparationSemanticError extends Error {}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function publicHostname(value: string): boolean {
  return HOSTNAME.test(value) && value.includes(".") && isIP(value) === 0 && value !== "localhost";
}

function withoutExplicitDeploy(desired: RailwayReconcileDesiredState): RailwayReconcileDesiredState {
  return {
    ...desired,
    services: desired.services.map((service) => ({ ...service, deploy: false })),
  };
}

/** Reloads the composite immediately before every provider primitive. */
function authorityGuard<T extends object>(executor: T, assertFresh: () => Promise<void>): T {
  return new Proxy(executor, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return async (...args: readonly unknown[]) => {
        await assertFresh();
        const result: unknown = await Reflect.apply(value, target, args);
        return result;
      };
    },
  });
}

function exactResourceId(
  state: RailwayDeploymentDriverState,
  kind: string,
  name?: string,
): string | undefined {
  const matches = state.reconcile.receipt.resources.filter((resource) => (
    resource.kind === kind && (name === undefined || resource.name === name)
  ));
  return matches.length === 1 ? matches[0]!.id : undefined;
}

function reconcileContainsExactly(
  state: RailwayDeploymentDriverState,
  ...desiredStates: readonly RailwayReconcileDesiredState[]
): boolean {
  if (state.reconcile.pending !== undefined) return false;
  const expected = desiredResourceKeys(...desiredStates);
  const actual = state.reconcile.receipt.resources
    .map((resource) => `${resource.kind}\0${resource.name ?? ""}`).sort();
  return same(actual, expected);
}

function desiredResourceKeys(...desiredStates: readonly RailwayReconcileDesiredState[]): readonly string[] {
  return [...new Set(desiredStates.flatMap((desired) => [
    ["railway.project", desired.project.name],
    ["railway.environment", desired.environment.name],
    ...desired.services.map((service) => ["railway.service", service.name]),
    ...desired.volumes.map((volume) => ["railway.volume", volume.logicalName]),
    ...desired.services.filter((service) => Object.keys(service.variables).length > 0)
      .map((service) => ["railway.variable-collection", `variables-${service.name}`]),
    ...desired.services.filter((service) => service.image !== undefined)
      .map((service) => ["railway.service-image", service.name]),
    ...desired.domains.map((domain) => ["railway.domain", domain.logicalName]),
    ...desired.services.filter((service) => service.deploy)
      .map((service) => ["railway.deployment", service.name]),
  ].map(([kind, name]) => `${kind}\0${name}`)))].sort();
}

function databaseDeploymentPrefix(
  state: RailwayDeploymentDriverState,
  databases: RailwayReconcileDesiredState,
): number | undefined {
  if (state.reconcile.pending !== undefined) return undefined;
  const core = desiredResourceKeys(databases);
  const names = databases.services.map((service) => service.name);
  const actual = state.reconcile.receipt.resources
    .map((resource) => `${resource.kind}\0${resource.name ?? ""}`).sort();
  for (let count = 0; count <= names.length; count += 1) {
    const expected = [...core, ...names.slice(0, count).map((name) => `railway.deployment\0${name}`)].sort();
    if (same(actual, expected)) return count;
  }
  return undefined;
}

function receiptAt(
  state: RailwayDeploymentDriverState,
  stage: "bootstrapping" | "claimable",
  now: string,
): RailwayDeploymentDriverState {
  return parseRailwayDeploymentDriverState({
    ...state,
    reconcile: {
      receipt: {
        ...state.reconcile.receipt,
        revision: state.reconcile.receipt.revision + 1,
        stage,
        updatedAt: now,
        ...(stage === "claimable" ? { claimableAt: now } : {}),
      },
    },
  });
}

function exactBootstrapExecutor(
  resources: RailwayRestorePreparationExecutor,
  semanticFailure: { value: boolean },
  image: string,
): RailwayBootstrapLifecycleExecutor {
  const exactSource = (
    observed: RailwayServiceInstance | null,
    serviceId: string,
    environmentId: string,
    image: string,
  ): boolean => observed?.serviceId === serviceId
    && observed.environmentId === environmentId
    && observed.source?.image === image
    && (observed.source.repo === null || observed.source.repo === undefined);
  return {
    inventoryServices: resources.listServices,
    createService: resources.createService,
    applyServiceVariables: async (input) => {
      const observed = await resources.getServiceInstance(input);
      const source = observed?.source;
      const hasSource = source !== null && source !== undefined
        && ((source.image !== null && source.image !== undefined)
          || (source.repo !== null && source.repo !== undefined));
      if (hasSource && !exactSource(observed, input.serviceId, input.environmentId, image)) {
        semanticFailure.value = true;
        throw new RailwayRestorePreparationSemanticError();
      }
      await resources.upsertVariables(input);
    },
    inventoryDeployments: async (input) => {
      const observed = await resources.getServiceInstance(input);
      const deployments = await resources.listDeploymentsRaw(input);
      if (deployments.length > 0 && !exactSource(observed, input.serviceId, input.environmentId, image)) {
        semanticFailure.value = true;
        throw new RailwayRestorePreparationSemanticError();
      }
      return deployments;
    },
    observeDeployment: resources.getDeployment,
    deleteService: resources.deleteService,
    startDeployment: async (input) => {
      const observed = await resources.getServiceInstance(input);
      if (!exactSource(observed, input.serviceId, input.environmentId, input.image)) {
        const source = observed?.source;
        const hasSource = source !== null && source !== undefined
          && ((source.image !== null && source.image !== undefined)
            || (source.repo !== null && source.repo !== undefined));
        if (hasSource) {
          semanticFailure.value = true;
          throw new RailwayRestorePreparationSemanticError();
        }
        const connected = await resources.connectService(input);
        if (!exactSource(connected, input.serviceId, input.environmentId, input.image)) {
          throw new Error("Railway bootstrap source was not observed");
        }
      }
      const deployments = await resources.listDeploymentsRaw(input);
      if (deployments.length > 1) {
        semanticFailure.value = true;
        throw new RailwayRestorePreparationSemanticError();
      }
      if (deployments.length === 0) throw new Error("Railway bootstrap deployment is unresolved");
      return deployments[0]!;
    },
  };
}

/**
 * Production fresh-target preparation. Each invocation advances one durable
 * phase and accepts completion only after the composite contains the exact
 * child proof and both provider-generated domain hostnames.
 */
export async function runRailwayRestorePreparationFromState(
  input: RailwayRestorePreparationRunnerInput,
): Promise<RailwayUpgradeStageOutcome> {
  let child: RailwayDeploymentDriverState | undefined;
  const assertEnvelope = async (): Promise<ReturnType<RailwayUpgradeRestoreTargetStageContext["loadState"]> extends Promise<infer T> ? T : never> => {
    const state = await input.context.loadState();
    if (state.maintenanceId !== input.operationId
      || state.authorityGenerationId !== input.authorityGenerationId
      || state.sourceLaunchId === input.targetLaunchId
      || state.maintenanceReceipt.targetReleaseId !== input.topology.releaseId) {
      throw new RailwayMaintenanceStateStoreError("invalid-state");
    }
    if (state.restoreTargetPreparation !== undefined) {
      let parsed: RailwayDeploymentDriverState;
      try { parsed = parseRailwayDeploymentDriverState(state.restoreTargetPreparation); } catch {
        throw new RailwayMaintenanceStateStoreError("invalid-state");
      }
      if (parsed.launchId !== input.targetLaunchId
        || parsed.releaseId !== input.topology.releaseId
        || !same(parsed.providers, [...input.providers].sort())
        || !same(parsed.target, input.target)
        || (child !== undefined && !same(parsed, child))) {
        throw new RailwayMaintenanceStateStoreError("invalid-state");
      }
      child = parsed;
    } else if (child !== undefined) {
      throw new RailwayMaintenanceStateStoreError("invalid-state");
    }
    return state;
  };

  const initial = await assertEnvelope();
  const compiled = compileRailwayPortableRestorePreparation(
    input.topology,
    input.projectionInputs,
    input.target,
  );
  if (!compiled.ok) return { outcome: "terminal-failure" };

  if (initial.restoreTargetState !== undefined) {
    if (initial.restoreTargetPreparation === undefined
      || !same(initial.restoreTargetState, initial.restoreTargetPreparation)
      || initial.maintenanceReceipt.stage !== "restore-target"
      || typeof initial.targetNautiloHostname !== "string"
      || typeof initial.targetLogtoHostname !== "string") {
      throw new RailwayMaintenanceStateStoreError("invalid-state");
    }
    return { outcome: "complete" };
  }

  if (initial.restoreTargetPreparation === undefined) {
    const created = createRailwayDeploymentDriverState({
      launchId: input.targetLaunchId,
      releaseId: input.topology.releaseId,
      providers: input.providers,
      target: input.target,
      now: input.now(),
    });
    const persisted = await input.context.persistRestoreTargetPreparation(created);
    child = parseRailwayDeploymentDriverState(persisted.restoreTargetPreparation);
    return { outcome: "pending" };
  }
  child = parseRailwayDeploymentDriverState(initial.restoreTargetPreparation);

  const rawResources: RailwayRestorePreparationExecutor = input.executor
    ?? new RailwayGraphqlReconcileExecutor({ transport: input.transport });
  const resources = authorityGuard(rawResources, async () => { await assertEnvelope(); });
  const persistChild = async (next: RailwayDeploymentDriverState): Promise<void> => {
    const validated = parseRailwayDeploymentDriverState(next);
    await assertEnvelope();
    const persisted = await input.context.persistRestoreTargetPreparation(validated);
    child = parseRailwayDeploymentDriverState(persisted.restoreTargetPreparation);
  };

  const databases = withoutExplicitDeploy(compiled.preparation.databases);
  const deploymentPrefix = databaseDeploymentPrefix(child, databases);
  if (child.reconcile.receipt.stage === "authorized"
    || (child.reconcile.receipt.stage === "provisioning" && deploymentPrefix === undefined)) {
    const result = await reconcileRailwayResources({
      desired: databases,
      checkpoint: child.reconcile,
      executor: resources,
      now: input.now,
      retryAbsentProjectCreate: true,
      persistCheckpoint: (reconcile) => persistChild({ ...child!, reconcile }),
    });
    if (result.outcome === "failure") {
      return result.code === "executor-failure" ? { outcome: "pending" } : { outcome: "terminal-failure" };
    }
    return databaseDeploymentPrefix(child, databases) === undefined
      ? { outcome: "terminal-failure" }
      : { outcome: "pending" };
  }

  if (child.reconcile.receipt.stage === "provisioning") {
    if (deploymentPrefix === undefined) return { outcome: "terminal-failure" };
    if (deploymentPrefix < databases.services.length) {
      const service = databases.services[deploymentPrefix]!;
      const projectId = exactResourceId(child, "railway.project");
      const environmentId = exactResourceId(child, "railway.environment");
      const serviceId = exactResourceId(child, "railway.service", service.name);
      if (projectId === undefined || environmentId === undefined || serviceId === undefined) {
        return { outcome: "terminal-failure" };
      }
      let deployments;
      try {
        deployments = await resources.listDeploymentsRaw({ projectId, environmentId, serviceId });
      } catch (error) {
        if (error instanceof RailwayMaintenanceStateStoreError) throw error;
        return { outcome: "pending" };
      }
      if (deployments.length === 0) return { outcome: "pending" };
      if (deployments.length !== 1) return { outcome: "terminal-failure" };
      await persistChild(parseRailwayDeploymentDriverState({ ...child, reconcile: { receipt: {
        ...child.reconcile.receipt,
        revision: child.reconcile.receipt.revision + 1,
        resources: [...child.reconcile.receipt.resources, {
          kind: "railway.deployment", id: deployments[0]!.id, name: service.name,
        }],
        updatedAt: input.now(),
      } } }));
      return { outcome: "pending" };
    }
    const projectId = exactResourceId(child, "railway.project");
    const environmentId = exactResourceId(child, "railway.environment");
    if (projectId === undefined || environmentId === undefined) return { outcome: "terminal-failure" };
    let result;
    const semanticFailure = { value: false };
    try {
      result = await runRailwayBootstrapLifecycle({
        target: { projectId, environmentId, intent: compiled.preparation.databaseBootstrapIntent },
        variables: compiled.preparation.databaseBootstrapVariables,
        checkpoint: child.databaseBootstrap,
        executor: exactBootstrapExecutor(resources, semanticFailure, compiled.preparation.databaseBootstrapIntent.image),
        persistCheckpoint: (databaseBootstrap) => persistChild({ ...child!, databaseBootstrap }),
      });
    } catch (error) {
      if (error instanceof RailwayRestorePreparationSemanticError) return { outcome: "terminal-failure" };
      if (error instanceof RailwayMaintenanceStateStoreError) throw error;
      return { outcome: "pending" };
    }
    if (semanticFailure.value) return { outcome: "terminal-failure" };
    const classified = classifyRailwayBootstrapStepResult(result);
    if (classified.outcome === "failure") {
      return result.outcome === "failure" && result.code === "executor-failure"
        ? { outcome: "pending" }
        : { outcome: "terminal-failure" };
    }
    if (classified.outcome === "pending") return { outcome: "pending" };
    await persistChild(receiptAt(child, "bootstrapping", input.now()));
    return { outcome: "pending" };
  }

  if (child.reconcile.receipt.stage === "bootstrapping") {
    const result = await reconcileRailwayResources({
      desired: compiled.preparation.publicScaffold,
      checkpoint: child.reconcile,
      executor: resources,
      now: input.now,
      retryAbsentProjectCreate: true,
      persistCheckpoint: (reconcile) => persistChild({ ...child!, reconcile }),
    });
    if (result.outcome === "failure") {
      return result.code === "executor-failure" ? { outcome: "pending" } : { outcome: "terminal-failure" };
    }
    const completedDatabases: RailwayReconcileDesiredState = {
      ...databases,
      services: databases.services.map((service) => ({ ...service, deploy: true })),
    };
    if (!reconcileContainsExactly(child, completedDatabases, compiled.preparation.publicScaffold)) {
      return { outcome: "terminal-failure" };
    }
    await persistChild(receiptAt(child, "claimable", input.now()));
    return { outcome: "pending" };
  }

  if (child.reconcile.receipt.stage !== "claimable") return { outcome: "terminal-failure" };
  const projectId = exactResourceId(child, "railway.project");
  const environmentId = exactResourceId(child, "railway.environment");
  const nautiloServiceId = exactResourceId(child, "railway.service", "nautilo-server");
  const logtoServiceId = exactResourceId(child, "railway.service", "logto");
  const nautiloDomainId = exactResourceId(child, "railway.domain", "nautilo-public");
  const logtoDomainId = exactResourceId(child, "railway.domain", "logto-public");
  if ([projectId, environmentId, nautiloServiceId, logtoServiceId, nautiloDomainId, logtoDomainId]
    .some((value) => value === undefined)) return { outcome: "terminal-failure" };
  let nautiloDomains;
  let logtoDomains;
  try {
    [nautiloDomains, logtoDomains] = await Promise.all([
      resources.listDomains({ projectId: projectId!, environmentId: environmentId!, serviceId: nautiloServiceId! }),
      resources.listDomains({ projectId: projectId!, environmentId: environmentId!, serviceId: logtoServiceId! }),
    ]);
  } catch (error) {
    if (error instanceof RailwayMaintenanceStateStoreError) throw error;
    return { outcome: "pending" };
  }
  const nautilo = nautiloDomains.filter((domain) => domain.id === nautiloDomainId);
  const logto = logtoDomains.filter((domain) => domain.id === logtoDomainId);
  const nautiloPort = compiled.preparation.publicScaffold.domains.find((domain) => domain.logicalName === "nautilo-public")?.targetPort;
  const logtoPort = compiled.preparation.publicScaffold.domains.find((domain) => domain.logicalName === "logto-public")?.targetPort;
  if (nautilo.length !== 1 || logto.length !== 1
    || nautilo[0]!.targetPort !== nautiloPort || logto[0]!.targetPort !== logtoPort
    || !publicHostname(nautilo[0]!.domain) || !publicHostname(logto[0]!.domain)
    || nautilo[0]!.domain === logto[0]!.domain
    || nautilo[0]!.domain === initial.sourceManagedWorkbenchHostname
    || logto[0]!.domain === initial.sourceManagedWorkbenchHostname) {
    return { outcome: "terminal-failure" };
  }
  try {
    await input.context.completeRestoreTarget({
      targetNautiloHostname: nautilo[0]!.domain,
      targetLogtoHostname: logto[0]!.domain,
    });
  } catch (error) {
    if (error instanceof RailwayMaintenanceStateStoreError) throw error;
    return { outcome: "pending" };
  }
  const completed = await assertEnvelope();
  return completed.restoreTargetState !== undefined
    && completed.targetNautiloHostname === nautilo[0]!.domain
    && completed.targetLogtoHostname === logto[0]!.domain
    ? { outcome: "complete" }
    : { outcome: "pending" };
}
