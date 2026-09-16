import {
  HOSTING_CAPABILITIES,
  parseLaunchReceipt,
  type CapabilityStatus,
  type CoreReadiness,
  type HostingNotice,
  type HostingResourceReference,
  type InfrastructureState,
  type LaunchReceipt,
} from "@nautilo/hosting";

import type {
  RailwayDeployment,
  RailwayEnvironment,
  RailwayProject,
  RailwayService,
  RailwayServiceDomain,
  RailwayVolume,
  RailwayVolumeInstance,
} from "./operations";

const PROJECT_KIND = "railway.project";
const ENVIRONMENT_KIND = "railway.environment";
const SERVICE_KIND = "railway.service";
const VOLUME_KIND = "railway.volume";
const VARIABLE_COLLECTION_KIND = "railway.variable-collection";
const DOMAIN_KIND = "railway.domain";
const DEPLOYMENT_KIND = "railway.deployment";

/** The result of observing one exact provider ID from a launch receipt. */
export type RailwayInspectionResourceState = "present" | "missing" | "drifted" | "not-observable";

export interface RailwayInspectionResource {
  readonly resource: HostingResourceReference;
  readonly state: RailwayInspectionResourceState;
  /** Stable field names which disagree with the receipt's scoped identity. */
  readonly drift?: readonly string[] | undefined;
}

/**
 * Health is deliberately supplied by the qualified target checker, not inferred
 * from a Railway deployment's status. A running resource can still be an
 * unusable Nautilo instance, and an optional enhancement warning is not core
 * degradation.
 */
export interface RailwayInspectReadiness {
  readonly coreReadiness: CoreReadiness;
  readonly capabilities: readonly CapabilityStatus[];
  readonly notices?: readonly HostingNotice[] | undefined;
}

/** Read-only Railway projection. Every query must be scoped by exact receipt IDs. */
export interface RailwayInspectExecutor {
  readonly getProject: (input: { readonly projectId: string }) => Promise<RailwayProject | null>;
  readonly getEnvironment: (input: { readonly projectId: string; readonly environmentId: string }) => Promise<RailwayEnvironment | null>;
  readonly listServices: (input: { readonly projectId: string }) => Promise<readonly RailwayService[]>;
  readonly getVolume: (input: { readonly projectId: string; readonly volumeId: string }) => Promise<RailwayVolume | null>;
  readonly listVolumeInstances: (input: { readonly projectId: string; readonly environmentId: string }) => Promise<readonly RailwayVolumeInstance[]>;
  readonly listDomains: (input: {
    readonly projectId: string;
    readonly environmentId: string;
    readonly serviceId: string;
  }) => Promise<readonly RailwayServiceDomain[]>;
  readonly getDeployment: (input: { readonly deploymentId: string }) => Promise<RailwayDeployment | null>;
}

export interface RailwayInspectRequest {
  readonly receipt: LaunchReceipt;
  readonly executor: RailwayInspectExecutor;
  readonly readiness: RailwayInspectReadiness;
}

export interface RailwayInspectionSnapshot {
  readonly backend: "railway";
  readonly infrastructure: InfrastructureState;
  readonly coreReadiness: CoreReadiness;
  readonly capabilities: readonly CapabilityStatus[];
  readonly notices: readonly HostingNotice[];
  /** Receipt-owned references only; inspection never adopts a name match. */
  readonly resources: readonly HostingResourceReference[];
}

export interface RailwayInspection {
  readonly operation: "inspect";
  readonly snapshot: RailwayInspectionSnapshot;
  readonly resources: readonly RailwayInspectionResource[];
}

function resourceFor(receipt: LaunchReceipt, kind: string): readonly HostingResourceReference[] {
  return receipt.resources.filter((resource) => resource.kind === kind);
}

function exact<T extends { readonly id: string }>(items: readonly T[], id: string): T | undefined {
  return items.find((item) => item.id === id);
}

function resourceNotice(
  resource: HostingResourceReference,
  state: Exclude<RailwayInspectionResourceState, "present" | "not-observable">,
): HostingNotice {
  return {
    severity: "error",
    code: "hosting.operation-failed",
    message: state === "missing"
      ? "A receipt-owned Railway resource is no longer present."
      : "A receipt-owned Railway resource no longer matches its required scope.",
    resources: [resource],
    repairTarget: { kind: "authenticated-provider-api" },
  };
}

function invalidReceiptNotice(): HostingNotice {
  return {
    severity: "blocking",
    code: "hosting.receipt-action-required",
    message: "The Railway launch receipt is invalid or does not identify a Railway launch.",
    repairTarget: { kind: "rerun-plan" },
  };
}

function executorFailureNotice(): HostingNotice {
  return {
    severity: "error",
    code: "hosting.operation-failed",
    message: "Railway resource inspection did not complete safely; retry before changing resources.",
    repairTarget: { kind: "authenticated-provider-api" },
  };
}

function validReadiness(readiness: RailwayInspectReadiness): boolean {
  const capabilities = readiness.capabilities;
  return capabilities.length === HOSTING_CAPABILITIES.length
    && new Set(capabilities.map((capability) => capability.capability)).size === HOSTING_CAPABILITIES.length
    && HOSTING_CAPABILITIES.every((capability) => capabilities.some((entry) => entry.capability === capability));
}

function invalidReadinessNotice(): HostingNotice {
  return {
    severity: "blocking",
    code: "hosting.input-invalid",
    message: "Inspection requires one qualified status for every Nautilo capability.",
    repairTarget: { kind: "rerun-plan" },
  };
}

function infrastructureFor(
  receipt: LaunchReceipt,
  resources: readonly RailwayInspectionResource[],
): InfrastructureState {
  if (resources.some((resource) => resource.state === "missing" || resource.state === "drifted")) return "failed";
  return receipt.stage === "claimable" ? "claimable" : "provisioning";
}

function invalidInspection(receipt: LaunchReceipt, readiness: RailwayInspectReadiness, notice: HostingNotice): RailwayInspection {
  return {
    operation: "inspect",
    snapshot: {
      backend: "railway",
      infrastructure: "failed",
      coreReadiness: validReadiness(readiness) ? readiness.coreReadiness : "blocked",
      capabilities: validReadiness(readiness) ? readiness.capabilities : [],
      notices: [...(readiness.notices ?? []), notice],
      resources: receipt.resources,
    },
    resources: receipt.resources.map((resource) => ({ resource, state: "not-observable" })),
  };
}

/**
 * Observes only IDs already recorded in a valid Railway launch receipt. It
 * never searches by name, creates a resource, or turns a `claimable` receipt
 * into a claim that Nautilo is useful-ready.
 */
export async function inspectRailwayDeployment(request: RailwayInspectRequest): Promise<RailwayInspection> {
  const parsed = parseLaunchReceipt(request.receipt);
  if (!parsed.ok || request.receipt.backend !== "railway") {
    return invalidInspection(request.receipt, request.readiness, invalidReceiptNotice());
  }
  if (!validReadiness(request.readiness)) {
    return invalidInspection(parsed.receipt, request.readiness, invalidReadinessNotice());
  }

  const receipt = parsed.receipt;
  const project = resourceFor(receipt, PROJECT_KIND);
  if (project.length !== 1) {
    return invalidInspection(receipt, request.readiness, invalidReceiptNotice());
  }
  const projectId = project[0]!.id;
  const environment = resourceFor(receipt, ENVIRONMENT_KIND);
  const environmentId = environment.length === 1 ? environment[0]!.id : undefined;

  try {
    const observedProject = await request.executor.getProject({ projectId });
    const observations: RailwayInspectionResource[] = [
      {
        resource: project[0]!,
        state: observedProject === null ? "missing" : observedProject.id === projectId ? "present" : "drifted",
        ...(observedProject !== null && observedProject.id !== projectId ? { drift: ["id"] } : {}),
      },
    ];

    for (const entry of environment) {
      const observed = await request.executor.getEnvironment({ projectId, environmentId: entry.id });
      observations.push({
        resource: entry,
        state: observed === null ? "missing" : observed.id === entry.id ? "present" : "drifted",
        ...(observed !== null && observed.id !== entry.id ? { drift: ["id"] } : {}),
      });
    }

    const services = await request.executor.listServices({ projectId });
    for (const entry of resourceFor(receipt, SERVICE_KIND)) {
      observations.push({ resource: entry, state: exact(services, entry.id) === undefined ? "missing" : "present" });
    }

    for (const entry of resourceFor(receipt, VOLUME_KIND)) {
      const observed = await request.executor.getVolume({ projectId, volumeId: entry.id });
      observations.push({
        resource: entry,
        state: observed === null ? "missing" : observed.id !== entry.id || observed.projectId !== projectId ? "drifted" : "present",
        ...(observed !== null && (observed.id !== entry.id || observed.projectId !== projectId)
          ? { drift: ["projectId"] }
          : {}),
      });
    }

    if (environmentId !== undefined) {
      // Query mount inventory even though the receipt has only the volume ID;
      // it detects an exact volume which has lost every in-environment mount.
      const instances = await request.executor.listVolumeInstances({ projectId, environmentId });
      for (const entry of resourceFor(receipt, VOLUME_KIND)) {
        const observation = observations.find((item) => item.resource.kind === entry.kind && item.resource.id === entry.id);
        if (observation?.state === "present" && !instances.some((instance) => instance.volumeId === entry.id)) {
          const index = observations.indexOf(observation);
          observations[index] = { resource: entry, state: "drifted", drift: ["mount"] };
        }
      }

      const domains = new Map<string, RailwayServiceDomain>();
      for (const service of services) {
        for (const domain of await request.executor.listDomains({ projectId, environmentId, serviceId: service.id })) {
          domains.set(domain.id, domain);
        }
      }
      for (const entry of resourceFor(receipt, DOMAIN_KIND)) {
        observations.push({ resource: entry, state: domains.has(entry.id) ? "present" : "missing" });
      }
    } else {
      for (const entry of resourceFor(receipt, DOMAIN_KIND)) observations.push({ resource: entry, state: "drifted", drift: ["environment"] });
    }

    for (const entry of resourceFor(receipt, DEPLOYMENT_KIND)) {
      const observed = await request.executor.getDeployment({ deploymentId: entry.id });
      observations.push({ resource: entry, state: observed === null ? "missing" : observed.id === entry.id ? "present" : "drifted" });
    }

    // Variable collections are secret-bearing provider state. Their synthetic
    // receipt scope is deliberately not treated as evidence that a variable
    // value is present or absent.
    for (const entry of resourceFor(receipt, VARIABLE_COLLECTION_KIND)) {
      observations.push({ resource: entry, state: "not-observable" });
    }
    for (const entry of receipt.resources) {
      if (![PROJECT_KIND, ENVIRONMENT_KIND, SERVICE_KIND, VOLUME_KIND, VARIABLE_COLLECTION_KIND, DOMAIN_KIND, DEPLOYMENT_KIND].includes(entry.kind)) {
        observations.push({ resource: entry, state: "not-observable" });
      }
    }

    const notices = [
      ...(request.readiness.notices ?? []),
      ...observations
        .filter((item): item is RailwayInspectionResource & { readonly state: "missing" | "drifted" } => item.state === "missing" || item.state === "drifted")
        .map((item) => resourceNotice(item.resource, item.state)),
    ];
    return {
      operation: "inspect",
      snapshot: {
        backend: "railway",
        infrastructure: infrastructureFor(receipt, observations),
        coreReadiness: request.readiness.coreReadiness,
        capabilities: request.readiness.capabilities,
        notices,
        resources: receipt.resources,
      },
      resources: observations,
    };
  } catch {
    return {
      operation: "inspect",
      snapshot: {
        backend: "railway",
        infrastructure: "failed",
        coreReadiness: request.readiness.coreReadiness,
        capabilities: request.readiness.capabilities,
        notices: [...(request.readiness.notices ?? []), executorFailureNotice()],
        resources: receipt.resources,
      },
      resources: receipt.resources.map((resource) => ({ resource, state: "not-observable" })),
    };
  }
}
