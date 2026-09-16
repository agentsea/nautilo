import type {
  BackupOptions,
  ComposeDriverProfile,
  ComposeStatusObservation,
  DestroyOptions,
  RestoreOptions,
  UpgradeOptions,
} from "@nautilo/compose-driver";

export type ComposeLifecycleOperation =
  | "deploy"
  | "inspect"
  | "upgrade"
  | "backup"
  | "restore"
  | "destroy";

export interface ComposeTargetIdentity {
  readonly profileName: string;
  readonly instanceId: string;
  readonly composeProjectName: string;
  readonly transport: "local" | "remote";
}

export interface ComposeProgressEvent {
  readonly operation: ComposeLifecycleOperation;
  readonly phase: "started" | "completed" | "failed";
}

export interface ComposeLifecyclePorts {
  readonly progress?: (event: ComposeProgressEvent) => void;
  readonly clearOwnerClaimCustody?: (profile: ComposeDriverProfile) => Promise<void>;
}

export interface ComposeDeployRequest {
  readonly allowArtifactLoss?: boolean;
}

export interface ComposeDeployResult {
  readonly operation: "deploy";
  readonly target: ComposeTargetIdentity;
  readonly readiness: "ready";
  readonly recovery: "none";
}

export interface ComposeInspectResult {
  readonly operation: "inspect";
  readonly target: ComposeTargetIdentity;
  readonly observation: ComposeStatusObservation;
}

export interface ComposeUpgradeResult {
  readonly operation: "upgrade";
  readonly target: ComposeTargetIdentity;
  readonly readiness: "ready";
  readonly recovery: "none";
}

export interface ComposeBackupResult {
  readonly operation: "backup";
  readonly target: ComposeTargetIdentity;
  readonly backupPath: string;
}

export interface ComposeRestoreResult {
  readonly operation: "restore";
  readonly target: ComposeTargetIdentity;
  readonly readiness: "ready";
  readonly recovery: "none";
}

export interface ComposeDestroyResult {
  readonly operation: "destroy";
  readonly target: ComposeTargetIdentity;
  readonly cleanup: {
    readonly containersAbsent: true;
    readonly networksAbsent: true;
    readonly dataVolumesAbsent: true;
    readonly ownerClaimCustodyCleared: true;
  };
  readonly recovery: "none";
}

export interface ComposeLifecycle {
  readonly target: ComposeTargetIdentity;
  deploy(request?: ComposeDeployRequest): Promise<ComposeDeployResult>;
  inspect(): Promise<ComposeInspectResult>;
  upgrade(request?: UpgradeOptions): Promise<ComposeUpgradeResult>;
  backup(request?: BackupOptions): Promise<ComposeBackupResult>;
  restore(request: RestoreOptions): Promise<ComposeRestoreResult>;
  destroyHard(request?: Pick<DestroyOptions, "keepCerts">): Promise<ComposeDestroyResult>;
}
