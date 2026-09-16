import {
  RailwayExactServiceActivation,
  RailwayGraphqlBootstrapExecutor,
  RailwayGraphqlReconcileExecutor,
  RAILWAY_LOGTO_BOOTSTRAP_PORT,
  runRailwayBootstrapLifecycle,
  runRailwayRestoredTargetActivation,
  waitForRailwayHttpsReadiness,
  type RailwayBootstrapLifecycleCheckpoint,
  type RailwayExactServiceActivationCheckpoint,
  type RailwayReconcileExecutorTransport,
  type RailwayRestoredTargetActivationCheckpoint,
  type RailwayRestoredTargetActivationResult,
  type RailwayTopology,
  type RailwayVariableProjectionInputs,
} from "@nautilo/railway-hosting";

import {
  RailwayMaintenanceStateStoreError,
  readRailwayMaintenanceState,
  updateRailwayMaintenanceState,
  type RailwayMaintenanceState,
  type RailwayRestoredLogtoBootstrapState,
} from "./railway-maintenance-state";

const DEFAULT_READINESS_ATTEMPTS = 60;
const DEFAULT_READINESS_DELAY_MS = 1_000;
const DEFAULT_READINESS_TIMEOUT_MS = 5_000;

type Slot = "logtoActivation" | "nautiloActivation" | "restoredTargetActivation";
type SlotValue = RailwayExactServiceActivationCheckpoint | RailwayRestoredTargetActivationCheckpoint;

/** Request-memory authorities and projections are deliberately absent from every result and checkpoint. */
export interface RailwayRestoredTargetActivationRunnerInput {
  readonly stateRoot: string;
  readonly statePath: string;
  readonly operationId: string;
  /** Current request-memory recovery-config custody generation. */
  readonly authorityGenerationId: string;
  readonly topology: RailwayTopology;
  /** Must be projected from the receipt-owned generated-domain and current recovery authority. */
  readonly projectionInputs: RailwayVariableProjectionInputs;
  readonly transport: RailwayReconcileExecutorTransport;
  readonly fetch?: typeof fetch | undefined;
  readonly wait?: ((milliseconds: number) => Promise<void>) | undefined;
  readonly readinessAttempts?: number | undefined;
  readonly readinessDelayMs?: number | undefined;
  readonly readinessTimeoutMs?: number | undefined;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cloneProjectionInputs(input: RailwayVariableProjectionInputs): RailwayVariableProjectionInputs {
  return {
    generatedSecrets: new Map(input.generatedSecrets),
    generatedPublicDomains: new Map(input.generatedPublicDomains),
    bootstrapOutputs: new Map(input.bootstrapOutputs),
    externalProviderSecrets: new Map(input.externalProviderSecrets),
  };
}

function completedTransfer(state: RailwayMaintenanceState, operationId: string): boolean {
  const transfer = state.portableRestore?.target;
  if (transfer?.operationId !== operationId || transfer.direction !== "restore" || transfer.state !== "started") return false;
  return state.maintenanceReceipt.providerWorkflows?.some((workflow) => (
    workflow.operation === "restore-portable"
      && workflow.workflowId === transfer.jobId
      && workflow.state === "complete"
  )) === true;
}

function completedCleanup(state: RailwayMaintenanceState, operationId: string): boolean {
  return state.portableRestore?.cleanup?.operationId === operationId
    && state.portableRestore.cleanup.state === "complete";
}

/**
 * CAS-persist one child while preserving every sibling. A racing writer is
 * accepted only when it wrote the exact intended child; this never overwrites
 * a divergent or merely "later-looking" value.
 */
async function persistSlot(
  root: string,
  path: string,
  slot: Slot,
  intended: SlotValue,
): Promise<void> {
  const current = await readRailwayMaintenanceState(root, path);
  if (current === null) throw new RailwayMaintenanceStateStoreError("invalid-state");
  if (same(current[slot], intended)) return;
  try {
    await updateRailwayMaintenanceState(root, path, { expectedRevision: current.revision }, (observed) => ({
      ...observed,
      revision: observed.revision + 1,
      [slot]: intended,
    }));
  } catch (error) {
    if (!(error instanceof RailwayMaintenanceStateStoreError)
      || (error.code !== "revision-conflict" && error.code !== "publish-unknown")) throw error;
    const recovered = await readRailwayMaintenanceState(root, path);
    if (recovered === null || !same(recovered[slot], intended)) throw error;
  }
}

async function persistBootstrap(
  root: string,
  path: string,
  intended: RailwayRestoredLogtoBootstrapState,
): Promise<void> {
  const current = await readRailwayMaintenanceState(root, path);
  if (current === null) throw new RailwayMaintenanceStateStoreError("invalid-state");
  if (same(current.restoredLogtoBootstrap, intended)) return;
  try {
    await updateRailwayMaintenanceState(root, path, { expectedRevision: current.revision }, (observed) => ({
      ...observed,
      revision: observed.revision + 1,
      restoredLogtoBootstrap: intended,
    }));
  } catch (error) {
    if (!(error instanceof RailwayMaintenanceStateStoreError)
      || (error.code !== "revision-conflict" && error.code !== "publish-unknown")) throw error;
    const recovered = await readRailwayMaintenanceState(root, path);
    if (recovered === null || !same(recovered.restoredLogtoBootstrap, intended)) throw error;
  }
}

function image(topology: RailwayTopology, name: "logto" | "nautilo-server"): string {
  const service = topology.finalServices.find((candidate) => candidate.name === name);
  if (service === undefined) throw new Error("invalid restored activation input");
  return service.image;
}

/** Concrete, receipt-backed Railway restored-target activation composition. */
export async function runRailwayRestoredTargetActivationFromState(
  input: RailwayRestoredTargetActivationRunnerInput,
): Promise<RailwayRestoredTargetActivationResult> {
  // Snapshot every request-memory authority, callback and public intent before the first await.
  const stable = Object.freeze({
    stateRoot: `${input.stateRoot}`,
    statePath: `${input.statePath}`,
    operationId: `${input.operationId}`,
    authorityGenerationId: `${input.authorityGenerationId}`,
    topology: structuredClone(input.topology),
    projectionInputs: cloneProjectionInputs(input.projectionInputs),
    transport: Object.freeze({ execute: input.transport.execute.bind(input.transport) }),
    fetch: input.fetch ?? fetch,
    wait: input.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))),
    readinessAttempts: input.readinessAttempts ?? DEFAULT_READINESS_ATTEMPTS,
    readinessDelayMs: input.readinessDelayMs ?? DEFAULT_READINESS_DELAY_MS,
    readinessTimeoutMs: input.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
  });
  const initial = await readRailwayMaintenanceState(stable.stateRoot, stable.statePath);
  if (initial === null || initial.maintenanceId !== stable.operationId
    || initial.authorityGenerationId !== stable.authorityGenerationId) {
    throw new RailwayMaintenanceStateStoreError("invalid-state");
  }
  const targetState = initial.restoreTargetState;
  const sourceState = initial.sourceLaunchState;
  const targetNautiloHostname = initial.targetNautiloHostname;
  const targetLogtoHostname = initial.targetLogtoHostname;
  const restoreTarget = initial.maintenanceReceipt.restoreTarget;
  if (targetState === undefined || targetNautiloHostname === undefined || targetLogtoHostname === undefined || restoreTarget === undefined
    || initial.portableRestore?.target.projectId !== restoreTarget.projectId
    || initial.portableRestore.target.environmentId !== restoreTarget.environmentId
    || targetState.releaseId !== initial.maintenanceReceipt.targetReleaseId
    || stable.topology.releaseId !== targetState.releaseId) {
    throw new RailwayMaintenanceStateStoreError("invalid-state");
  }
  const portableOperationId = initial.portableRestore.target.operationId;
  const resourcesBy = (kind: string, name?: string) => targetState.reconcile.receipt.resources.filter((resource) => (
    resource.kind === kind && (name === undefined || resource.name === name)
  ));
  const project = resourcesBy("railway.project").filter(({ id }) => id === restoreTarget.projectId);
  const environment = resourcesBy("railway.environment").filter(({ id }) => id === restoreTarget.environmentId);
  const logtoServices = resourcesBy("railway.service", "logto");
  const nautiloServices = resourcesBy("railway.service", "nautilo-server");
  if (project.length !== 1 || environment.length !== 1 || logtoServices.length !== 1 || nautiloServices.length !== 1) {
    throw new RailwayMaintenanceStateStoreError("invalid-state");
  }
  const projectId = restoreTarget.projectId;
  const environmentId = restoreTarget.environmentId;
  const logtoServiceId = logtoServices[0]!.id;
  const nautiloServiceId = nautiloServices[0]!.id;
  const authorityGenerationId = stable.authorityGenerationId;
  const sourceOrigin = `https://${initial.sourceManagedWorkbenchHostname}`;
  const targetOrigin = `https://${targetNautiloHostname}`;
  const targetLogtoOrigin = `https://${targetLogtoHostname}`;
  const assertedTargetOrigin = stable.projectionInputs.generatedPublicDomains.get("nautilo-public");
  const assertedLogtoOrigin = stable.projectionInputs.generatedPublicDomains.get("logto-public");
  if ((assertedTargetOrigin !== undefined && assertedTargetOrigin !== targetOrigin)
    || (assertedLogtoOrigin !== undefined && assertedLogtoOrigin !== targetLogtoOrigin)) {
    throw new RailwayMaintenanceStateStoreError("invalid-state");
  }
  const generatedPublicDomains = new Map(stable.projectionInputs.generatedPublicDomains);
  generatedPublicDomains.set("nautilo-public", targetOrigin);
  generatedPublicDomains.set("logto-public", targetLogtoOrigin);
  const projectionInputs: RailwayVariableProjectionInputs = {
    ...stable.projectionInputs,
    generatedPublicDomains,
  };
  const resources = new RailwayGraphqlReconcileExecutor({ transport: stable.transport, sleep: stable.wait });
  const handoffClient = new RailwayGraphqlBootstrapExecutor({
    transport: stable.transport,
    fetch: stable.fetch,
    sleep: stable.wait,
  });

  const load = async (): Promise<RailwayMaintenanceState> => {
    const state = await readRailwayMaintenanceState(stable.stateRoot, stable.statePath);
    if (state === null || state.maintenanceId !== stable.operationId
      || state.authorityGenerationId !== authorityGenerationId
      || `https://${state.sourceManagedWorkbenchHostname}` !== sourceOrigin
      || !same(state.sourceLaunchState, sourceState)
      || state.targetNautiloHostname !== targetNautiloHostname
      || state.targetLogtoHostname !== targetLogtoHostname
      || !same(state.restoreTargetState, targetState)) {
      throw new RailwayMaintenanceStateStoreError("invalid-state");
    }
    return state;
  };
  const cleanupComplete = async (): Promise<boolean> => completedCleanup(await load(), portableOperationId);

  const exactActivation = (
    serviceId: string,
    serviceImage: string,
    effect: "connect" | "deploy",
    slot: "logtoActivation" | "nautiloActivation",
  ) => new RailwayExactServiceActivation({
    binding: {
      projectId,
      environmentId,
      serviceId,
      image: serviceImage,
      effect,
    },
    executor: resources,
    maintenanceCleanupComplete: cleanupComplete,
    loadCheckpoint: async () => (await load())[slot],
    persistCheckpoint: async (checkpoint) => persistSlot(stable.stateRoot, stable.statePath, slot, checkpoint),
    wait: stable.wait,
  });
  const logto = exactActivation(logtoServiceId, image(stable.topology, "logto"), "connect", "logtoActivation");
  const nautilo = exactActivation(nautiloServiceId, image(stable.topology, "nautilo-server"), "deploy", "nautiloActivation");

  return runRailwayRestoredTargetActivation({
    operationId: stable.operationId,
    projectId,
    environmentId,
    logtoServiceId,
    nautiloServiceId,
    authorityGenerationId,
    topology: stable.topology,
    projectionInputs,
    sourceManagedWorkbenchOrigin: sourceOrigin,
    checkpoint: initial.restoredTargetActivation,
    persistCheckpoint: async (checkpoint) => persistSlot(stable.stateRoot, stable.statePath, "restoredTargetActivation", checkpoint),
    executor: {
      transferComplete: async ({ operationId }) => operationId === stable.operationId
        && completedTransfer(await load(), portableOperationId),
      maintenanceCleanupComplete: async ({ operationId }) => operationId === stable.operationId
        && completedCleanup(await load(), portableOperationId),
      ensureLogtoActivation: async ({ variables }) => (await logto.find()) ?? logto.start({ variables }),
      observeLogtoActivation: ({ jobId }) => logto.observe(jobId),
      upsertFinalNautiloVariables: ({ variables }) => resources.upsertVariables({
        projectId,
        environmentId,
        serviceId: nautiloServiceId,
        variables,
      }),
      findNautiloActivation: () => nautilo.find(),
      ensureNautiloActivation: async ({ variables }) => (await nautilo.find()) ?? nautilo.start({ variables }),
      observeNautiloActivation: ({ jobId }) => nautilo.observe(jobId),
      runRestoredLogtoBootstrap: async ({ variables, token, applyOutput }) => {
        let retainedHandoff: "running" | "error" | undefined;
        const before = await load();
        const lifecycle = before.restoredLogtoBootstrap?.lifecycle;
        const bootstrapExecutor = {
          inventoryServices: (value: { readonly projectId: string }) => resources.listServices(value),
          createService: (value: { readonly projectId: string; readonly environmentId: string; readonly name: "nautilo-bootstrap" }) => resources.createService(value),
          applyServiceVariables: (value: { readonly projectId: string; readonly environmentId: string; readonly serviceId: string; readonly variables: Readonly<Record<string, string>> }) => resources.upsertVariables(value),
          inventoryDeployments: async (value: { readonly projectId: string; readonly environmentId: string; readonly serviceId: string }) => {
            const state = await load();
            const checkpoint = state.restoredLogtoBootstrap?.exactActivation;
            if (checkpoint === undefined) {
              const raw = await resources.listDeploymentsRaw(value);
              if (raw.length !== 0) throw new Error("unowned bootstrap deployment");
              return [];
            }
            const activation = new RailwayExactServiceActivation({
              binding: { projectId: value.projectId, environmentId: value.environmentId, serviceId: value.serviceId, image: stable.topology.transientLogtoBootstrap.image, effect: "connect" },
              executor: resources,
              maintenanceCleanupComplete: cleanupComplete,
              loadCheckpoint: async () => (await load()).restoredLogtoBootstrap?.exactActivation,
              persistCheckpoint: async (exactActivation) => {
                const latest = await load();
                const currentLifecycle = latest.restoredLogtoBootstrap?.lifecycle;
                if (currentLifecycle === undefined) throw new Error("missing bootstrap lifecycle");
                await persistBootstrap(stable.stateRoot, stable.statePath, { lifecycle: currentLifecycle, exactActivation });
              },
              wait: stable.wait,
            });
            const found = await activation.find();
            return found === undefined ? [] : [await resources.getDeployment({ deploymentId: found.jobId })];
          },
          startDeployment: async (value: { readonly projectId: string; readonly environmentId: string; readonly serviceId: string; readonly image: string }) => {
            const activation = new RailwayExactServiceActivation({
              binding: { projectId: value.projectId, environmentId: value.environmentId, serviceId: value.serviceId, image: value.image, effect: "connect" },
              executor: resources,
              maintenanceCleanupComplete: cleanupComplete,
              loadCheckpoint: async () => (await load()).restoredLogtoBootstrap?.exactActivation,
              persistCheckpoint: async (exactActivation) => {
                const latest = await load();
                const currentLifecycle = latest.restoredLogtoBootstrap?.lifecycle;
                if (currentLifecycle === undefined) throw new Error("missing bootstrap lifecycle");
                await persistBootstrap(stable.stateRoot, stable.statePath, { lifecycle: currentLifecycle, exactActivation });
              },
              wait: stable.wait,
            });
            const job = (await activation.find()) ?? await activation.start({ variables });
            return resources.getDeployment({ deploymentId: job.jobId });
          },
          observeDeployment: async ({ deploymentId }: { readonly deploymentId: string }) => {
            const state = await load();
            const checkpoint = state.restoredLogtoBootstrap?.exactActivation;
            const serviceId = state.restoredLogtoBootstrap?.lifecycle.serviceId;
            if (checkpoint === undefined || serviceId === undefined) throw new Error("missing exact bootstrap activation");
            const activation = new RailwayExactServiceActivation({
              binding: { projectId, environmentId, serviceId, image: stable.topology.transientLogtoBootstrap.image, effect: "connect" },
              executor: resources,
              maintenanceCleanupComplete: cleanupComplete,
              loadCheckpoint: async () => (await load()).restoredLogtoBootstrap?.exactActivation,
              persistCheckpoint: async (exactActivation) => {
                const latest = await load();
                const currentLifecycle = latest.restoredLogtoBootstrap?.lifecycle;
                if (currentLifecycle === undefined) throw new Error("missing bootstrap lifecycle");
                await persistBootstrap(stable.stateRoot, stable.statePath, { lifecycle: currentLifecycle, exactActivation });
              },
              wait: stable.wait,
            });
            await activation.observe(deploymentId);
            return resources.getDeployment({ deploymentId });
          },
          listDomains: (value: { readonly projectId: string; readonly environmentId: string; readonly serviceId: string }) => resources.listDomains(value),
          createDomain: (value: { readonly serviceId: string; readonly environmentId: string; readonly targetPort: number }) => resources.createDomain(value),
          fetchHandoff: handoffClient.fetchHandoff.bind(handoffClient),
          deleteService: (value: { readonly serviceId: string; readonly environmentId: string }) => resources.deleteService(value),
        };
        const result = await runRailwayBootstrapLifecycle({
          target: {
            projectId,
            environmentId,
            intent: stable.topology.transientLogtoBootstrap,
          },
          variables,
          checkpoint: lifecycle,
          executor: bootstrapExecutor,
          persistCheckpoint: async (nextLifecycle: RailwayBootstrapLifecycleCheckpoint) => {
            const latest = await load();
            await persistBootstrap(stable.stateRoot, stable.statePath, {
              lifecycle: nextLifecycle,
              ...(latest.restoredLogtoBootstrap?.exactActivation === undefined
                ? {} : { exactActivation: latest.restoredLogtoBootstrap.exactActivation }),
            });
          },
          handoff: {
            token,
            targetPort: RAILWAY_LOGTO_BOOTSTRAP_PORT,
            applyOutput: async (output) => {
              const observed = await applyOutput(output);
              if (observed.state !== "complete") {
                retainedHandoff = observed.state;
                throw new Error("activation remains pending");
              }
            },
          },
        });
        if (result.outcome === "complete") return { outcome: "complete" };
        if (result.outcome === "pending") return { outcome: "pending" };
        if (result.stage === "handoff-fetch" && result.code === "handoff-transient-exhausted") {
          return { outcome: "pending" };
        }
        if (retainedHandoff !== undefined && result.stage === "handoff-apply" && result.code === "executor-failure") {
          return { outcome: "pending" };
        }
        if (result.stage === "start-deployment" && result.code === "executor-failure") {
          const state = await load();
          const exact = state.restoredLogtoBootstrap?.exactActivation;
          if (exact?.state === "start-pending" || exact?.state === "start-unknown") return { outcome: "pending" };
        }
        return { outcome: "failure" };
      },
      waitForNautiloReadiness: ({ origin }) => waitForRailwayHttpsReadiness({
        origin,
        fetch: stable.fetch,
        wait: stable.wait,
        requestTimeoutMs: stable.readinessTimeoutMs,
        retryDelayMs: stable.readinessDelayMs,
        maxAttempts: stable.readinessAttempts,
      }),
    },
  });
}
