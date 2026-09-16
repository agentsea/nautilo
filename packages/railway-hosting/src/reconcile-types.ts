import type { LaunchReceipt } from "@nautilo/hosting";

import type {
  RailwayDeployment,
  RailwayEnvironment,
  RailwayEnvironmentVariables,
  RailwayProject,
  RailwayService,
  RailwayServiceDomain,
  RailwayServiceInstance,
  RailwayVolume,
  RailwayVolumeInstance,
} from "./operations";

/**
 * Receipt resources have only provider IDs. This sidecar is the durable
 * before-effect intent that makes a retry safe when a process dies after a
 * provider accepted a non-idempotent create but before the receipt ID is
 * written. It is deliberately non-secret and caller-persisted.
 */
export interface RailwayReconcileCheckpoint {
  readonly receipt: LaunchReceipt;
  readonly pending?: RailwayReconcilePendingEffect | undefined;
}

export interface RailwayReconcilePendingEffect {
  readonly kind: RailwayReconcileEffectKind;
  readonly logicalName: string;
  /** Digest-only serviceConnect intent; non-secret and required for that effect. */
  readonly image?: string | undefined;
  /**
   * Project creation has no provider idempotency key. A second explicit resume
   * may advance an inventory-proven-absent first attempt to attempt 2 before
   * issuing exactly one final create. No other effect or attempt is retryable.
   */
  readonly attempt?: 1 | 2 | undefined;
}

export type RailwayReconcileEffectKind =
  | "project-create"
  | "environment-create"
  | "service-create"
  | "volume-create"
  | "variables-upsert"
  | "service-connect"
  | "domain-create"
  | "deployment-create";

export interface RailwayReconcileProjectIntent {
  readonly name: string;
  readonly workspaceId: string;
}

export interface RailwayReconcileEnvironmentIntent {
  readonly name: string;
}

/** A service is created empty; runtime source attachment is intentionally deferred. */
export interface RailwayReconcileServiceIntent {
  readonly name: string;
  /** Omitted only for an empty scaffold that must not boot yet. */
  readonly image?: string | undefined;
  /** Omitted to preserve the image's ENTRYPOINT/CMD. */
  readonly startCommand?: string | undefined;
  /** Values remain in request memory and are never copied into a checkpoint. */
  readonly variables: RailwayEnvironmentVariables;
  /** Start only after a qualified adapter has connected the certified image. */
  readonly deploy: boolean;
}

export interface RailwayReconcileVolumeIntent {
  readonly logicalName: string;
  readonly service: string;
  readonly mountPath: string;
  readonly region?: string | undefined;
}

export interface RailwayReconcileDomainIntent {
  readonly logicalName: string;
  readonly service: string;
  readonly targetPort: number;
}

export interface RailwayReconcileDesiredState {
  readonly project: RailwayReconcileProjectIntent;
  readonly environment: RailwayReconcileEnvironmentIntent;
  readonly services: readonly RailwayReconcileServiceIntent[];
  readonly volumes: readonly RailwayReconcileVolumeIntent[];
  readonly domains: readonly RailwayReconcileDomainIntent[];
}

/**
 * Provider effects are injected. The package does not construct a transport or
 * execute a Railway mutation itself, so unit tests and callers control the
 * authorization and process boundary.
 */
export interface RailwayReconcileExecutor {
  readonly listProjects: (input: { readonly workspaceId: string }) => Promise<readonly RailwayProject[]>;
  readonly getProject: (input: { readonly projectId: string }) => Promise<RailwayProject | null>;
  readonly createProject: (input: RailwayReconcileProjectIntent) => Promise<RailwayProject>;
  readonly listEnvironments: (input: { readonly projectId: string }) => Promise<readonly RailwayEnvironment[]>;
  readonly getEnvironment: (input: { readonly projectId: string; readonly environmentId: string }) => Promise<RailwayEnvironment | null>;
  readonly createEnvironment: (input: { readonly projectId: string; readonly name: string }) => Promise<RailwayEnvironment>;
  readonly listServices: (input: { readonly projectId: string }) => Promise<readonly RailwayService[]>;
  readonly createService: (input: { readonly projectId: string; readonly environmentId: string; readonly name: string }) => Promise<RailwayService>;
  /** Observes the exact environment-scoped image source without reading variables. */
  readonly getServiceInstance: (input: { readonly serviceId: string; readonly environmentId: string }) => Promise<RailwayServiceInstance | null>;
  /** Railway's provider-declared most recent deployment; never inferred from history ordering. */
  readonly getLatestDeployment: (input: { readonly serviceId: string; readonly environmentId: string }) => Promise<RailwayDeployment | null>;
  /**
   * Bounded observation for the deployment Railway creates after a source is
   * connected. A nullable first read is eventual consistency, not permission
   * to create a second deployment.
   */
  readonly waitForLatestDeployment: (input: { readonly serviceId: string; readonly environmentId: string }) => Promise<RailwayDeployment | null>;
  /** Connects an image source, then returns its exact observed service instance. */
  readonly connectService: (input: { readonly serviceId: string; readonly environmentId: string; readonly image: string; readonly startCommand?: string | undefined }) => Promise<RailwayServiceInstance>;
  readonly listVolumeInstances: (input: { readonly projectId: string; readonly environmentId: string }) => Promise<readonly RailwayVolumeInstance[]>;
  readonly getVolume: (input: { readonly projectId: string; readonly volumeId: string }) => Promise<RailwayVolume | null>;
  readonly createVolume: (input: {
    readonly projectId: string;
    readonly environmentId: string;
    readonly serviceId: string;
    readonly mountPath: string;
    readonly region?: string | undefined;
  }) => Promise<RailwayVolume>;
  /** Idempotent at its exact project/environment/service scope. */
  readonly upsertVariables: (input: {
    readonly projectId: string;
    readonly environmentId: string;
    readonly serviceId: string;
    readonly variables: RailwayEnvironmentVariables;
  }) => Promise<void>;
  readonly listDomains: (input: { readonly projectId: string; readonly environmentId: string; readonly serviceId: string }) => Promise<readonly RailwayServiceDomain[]>;
  readonly createDomain: (input: { readonly serviceId: string; readonly environmentId: string; readonly targetPort: number }) => Promise<RailwayServiceDomain>;
  readonly listDeployments: (input: { readonly projectId: string; readonly environmentId: string; readonly serviceId: string }) => Promise<readonly RailwayDeployment[]>;
  readonly createDeployment: (input: { readonly serviceId: string; readonly environmentId: string }) => Promise<RailwayDeployment>;
  /** Best-effort, non-secret failure inventory for an operator/teardown receipt. */
  readonly inventorySurvivors: (input: { readonly projectId?: string | undefined; readonly environmentId?: string | undefined }) => Promise<readonly RailwayReconcileSurvivingResource[]>;
}

export interface RailwayReconcileSurvivingResource {
  readonly kind: string;
  readonly id: string;
  readonly name?: string | undefined;
}

export interface RailwayReconcileRequest {
  readonly desired: RailwayReconcileDesiredState;
  readonly checkpoint: RailwayReconcileCheckpoint;
  readonly executor: RailwayReconcileExecutor;
  /** Persists both valid receipt state and non-secret pending-effect state. */
  readonly persistCheckpoint: (checkpoint: RailwayReconcileCheckpoint) => Promise<void>;
  readonly now: () => string;
  /** Explicit continuation authority for one absent pending project create. */
  readonly retryAbsentProjectCreate?: boolean | undefined;
}

export type RailwayReconcileStage =
  | "validate"
  | "project"
  | "environment"
  | "service"
  | "volume"
  | "variables"
  | "image"
  | "domain"
  | "deployment";

export type RailwayReconcileFailureCode =
  | "invalid-checkpoint"
  | "invalid-desired-state"
  | "executor-failure"
  | "persistence-failure"
  | "identity-mismatch"
  | "ambiguous-resource"
  | "recovery-required";

export type RailwayReconcileResult =
  | { readonly outcome: "complete"; readonly checkpoint: RailwayReconcileCheckpoint }
  | {
      readonly outcome: "failure";
      readonly stage: RailwayReconcileStage;
      readonly code: RailwayReconcileFailureCode;
      readonly checkpoint: RailwayReconcileCheckpoint;
      readonly survivingResources: readonly RailwayReconcileSurvivingResource[];
    };
