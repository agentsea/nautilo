import type { RailwayReconcileDesiredState } from "./reconcile-types";
import type { RailwayEnvironmentVariables } from "./operations";
import type { RailwayFinalServiceIntent, RailwayFinalServiceName, RailwayTopology } from "./topology";
import {
  projectRailwayBootstrapVariables,
  projectRailwayServiceVariables,
  type RailwayVariableProjection,
  type RailwayVariableProjectionInputs,
} from "./variable-projection";

export interface RailwayDesiredStateTarget {
  readonly workspaceId: string;
  readonly projectName: string;
  readonly environmentName: string;
}

export type RailwayDesiredStateCompilationBlockerCode =
  | "railway.desired-state.invalid-target"
  | "railway.desired-state.topology-qualification"
  | "railway.desired-state.projection-mismatch";

export type RailwayDesiredStateCompilationResult =
  | { readonly ok: true; readonly desired: RailwayReconcileDesiredState }
  | {
      readonly ok: false;
      /** Metadata-free and safe for JSON receipts. */
      readonly blockers: readonly { readonly code: RailwayDesiredStateCompilationBlockerCode }[];
    };

export interface RailwayPreparationDesiredStates {
  readonly databases: RailwayReconcileDesiredState;
  readonly logtoSeed: RailwayReconcileDesiredState;
  readonly publicScaffold: RailwayReconcileDesiredState;
  readonly logtoCore: RailwayReconcileDesiredState;
  readonly databaseBootstrapVariables: RailwayEnvironmentVariables;
  readonly logtoBootstrapVariables: RailwayEnvironmentVariables;
}

export type RailwayPreparationCompilationResult =
  | { readonly ok: true; readonly preparation: RailwayPreparationDesiredStates }
  | { readonly ok: false; readonly blockers: readonly { readonly code: RailwayDesiredStateCompilationBlockerCode }[] };

function failed(code: RailwayDesiredStateCompilationBlockerCode): RailwayDesiredStateCompilationResult {
  return { ok: false, blockers: [{ code }] };
}

function preparationFailed(code: RailwayDesiredStateCompilationBlockerCode): RailwayPreparationCompilationResult {
  return { ok: false, blockers: [{ code }] };
}

function targetValid(target: RailwayDesiredStateTarget): boolean {
  return target.workspaceId.trim().length > 0
    && target.projectName.trim().length > 0
    && target.environmentName.trim().length > 0;
}

function base(target: RailwayDesiredStateTarget) {
  return {
    project: { name: target.projectName, workspaceId: target.workspaceId },
    environment: { name: target.environmentName },
  } as const;
}

function service(topology: RailwayTopology, name: RailwayFinalServiceName): RailwayFinalServiceIntent | undefined {
  return topology.finalServices.find((candidate) => candidate.name === name);
}

/**
 * Produces the ordered pre-runtime vertical slices. Empty scaffold services
 * intentionally omit image sources so Railway cannot boot Logto/Nautilo before
 * their domains and prerequisite reconciliation exist.
 */
export function compileRailwayPreparationDesiredStates(
  topology: RailwayTopology,
  inputs: RailwayVariableProjectionInputs,
  target: RailwayDesiredStateTarget,
): RailwayPreparationCompilationResult {
  if (!targetValid(target)) return preparationFailed("railway.desired-state.invalid-target");
  const requiredNames = ["app-postgres", "logto-postgres", "logto-seed", "logto", "nautilo-server"] as const;
  const services = new Map(requiredNames.map((name) => [name, service(topology, name)]));
  if ([...services.values()].some((value) => value === undefined)) {
    return preparationFailed("railway.desired-state.projection-mismatch");
  }
  const projected = new Map<RailwayFinalServiceName, RailwayEnvironmentVariables>();
  for (const name of ["app-postgres", "logto-postgres", "logto-seed", "logto"] as const) {
    const attempt = projectRailwayServiceVariables(services.get(name)!, inputs);
    if (!attempt.ok) return preparationFailed("railway.desired-state.projection-mismatch");
    projected.set(name, attempt.variables);
  }
  const databaseBootstrap = projectRailwayBootstrapVariables(topology.transientBootstrap, inputs);
  const logtoBootstrap = projectRailwayBootstrapVariables(topology.transientLogtoBootstrap, inputs);
  if (!databaseBootstrap.ok || !logtoBootstrap.ok) {
    return preparationFailed("railway.desired-state.projection-mismatch");
  }
  const intent = (name: RailwayFinalServiceName, deploy: boolean, image = true) => ({
    name,
    ...(image ? { image: services.get(name)!.image } : {}),
    ...(services.get(name)!.startCommand === undefined ? {} : { startCommand: services.get(name)!.startCommand }),
    variables: projected.get(name) ?? {},
    deploy,
  });
  const shared = base(target);
  return {
    ok: true,
    preparation: {
      databases: {
        ...shared,
        services: [intent("app-postgres", true), intent("logto-postgres", true)],
        volumes: topology.mounts.filter((mount) => mount.service === "app-postgres" || mount.service === "logto-postgres"),
        domains: [],
      },
      logtoSeed: {
        ...shared,
        services: [intent("logto-seed", true)],
        volumes: [],
        domains: [],
      },
      publicScaffold: {
        ...shared,
        services: [intent("logto", false, false), intent("nautilo-server", false, false)],
        volumes: topology.mounts.filter((mount) => mount.service === "nautilo-server"),
        domains: topology.generatedPublicDomains,
      },
      logtoCore: {
        ...shared,
        services: [intent("logto", true)],
        volumes: [],
        domains: topology.generatedPublicDomains.filter((domain) => domain.service === "logto"),
      },
      databaseBootstrapVariables: databaseBootstrap.variables,
      logtoBootstrapVariables: logtoBootstrap.variables,
    },
  };
}

/**
 * Compiles a fully resolved, request-memory-only topology into the exact input
 * consumed by the receipt-backed reconciler. Secrets remain only inside each
 * service's variable collection and are never copied to compilation blockers.
 */
export function compileRailwayReconcileDesiredState(
  topology: RailwayTopology,
  projection: RailwayVariableProjection,
  target: RailwayDesiredStateTarget,
): RailwayDesiredStateCompilationResult {
  if (!targetValid(target)) {
    return failed("railway.desired-state.invalid-target");
  }
  if (topology.qualifications.some((qualification) => qualification.disposition === "blocking")) {
    return failed("railway.desired-state.topology-qualification");
  }

  const serviceNames = new Set(topology.finalServices.map((service) => service.name));
  const projectedNames = Object.keys(projection.finalServices);
  if (serviceNames.size !== topology.finalServices.length
    || projectedNames.length !== topology.finalServices.length
    || projectedNames.some((name) => !serviceNames.has(name as RailwayFinalServiceName))
    || topology.mounts.some((mount) => !serviceNames.has(mount.service))
    || topology.generatedPublicDomains.some((domain) => !serviceNames.has(domain.service))) {
    return failed("railway.desired-state.projection-mismatch");
  }

  return {
    ok: true,
    desired: {
      project: { name: target.projectName, workspaceId: target.workspaceId },
      environment: { name: target.environmentName },
      services: topology.finalServices.map((service) => ({
        name: service.name,
        image: service.image,
        ...(service.startCommand === undefined ? {} : { startCommand: service.startCommand }),
        variables: projection.finalServices[service.name],
        deploy: true,
      })),
      volumes: topology.mounts.map((mount) => ({
        logicalName: mount.logicalName,
        service: mount.service,
        mountPath: mount.mountPath,
      })),
      domains: topology.generatedPublicDomains.map((domain) => ({
        logicalName: domain.logicalName,
        service: domain.service,
        targetPort: domain.targetPort,
      })),
    },
  };
}
