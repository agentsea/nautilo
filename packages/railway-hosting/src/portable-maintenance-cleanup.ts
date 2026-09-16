import { createHash } from "node:crypto";

import type { RailwayServiceInstance } from "./operations";

export const RAILWAY_PORTABLE_MAINTENANCE_CLEANUP_SCHEMA_VERSION = 1 as const;

/** Exact temporary collection applied by RailwayPortableMaintenanceTarget. */
export const RAILWAY_PORTABLE_MAINTENANCE_CLEANUP_VARIABLES = [
  "NAUTILO_RECOVERY_APP_DATABASE_URL",
  "NAUTILO_RECOVERY_EXPECTED_SHA256",
  "NAUTILO_RECOVERY_KEY",
  "NAUTILO_RECOVERY_LOGTO_DATABASE_URL",
  "NAUTILO_RECOVERY_S3_ACCESS_KEY_ID",
  "NAUTILO_RECOVERY_S3_BUCKET",
  "NAUTILO_RECOVERY_S3_ENDPOINT",
  "NAUTILO_RECOVERY_S3_PREFIX",
  "NAUTILO_RECOVERY_S3_REGION",
  "NAUTILO_RECOVERY_S3_SECRET_ACCESS_KEY",
  "NAUTILO_RECOVERY_S3_SESSION_TOKEN",
  "NAUTILO_RECOVERY_SOURCE_RELEASE_ID",
] as const;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IMAGE_DIGEST = /@sha256:([a-f0-9]{64})$/;
const SHA256 = /^[a-f0-9]{64}$/;

export interface RailwayPortableMaintenanceCleanupBinding {
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly image: string;
  readonly direction: "export" | "restore";
  readonly operationId: string;
  readonly objectId: string;
  /** Must be the exact canonical image entrypoint command for the bound IDs. */
  readonly command: string;
}

interface CleanupCheckpointIdentity {
  readonly schemaVersion: typeof RAILWAY_PORTABLE_MAINTENANCE_CLEANUP_SCHEMA_VERSION;
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly operationId: string;
  readonly imageDigest: string;
  readonly commandSha256: string;
}

export type RailwayPortableMaintenanceCleanupCheckpoint = CleanupCheckpointIdentity & (
  | { readonly state: "deleting"; readonly completedDeletes: number }
  | { readonly state: "delete-pending"; readonly completedDeletes: number; readonly deleteIndex: number }
  | { readonly state: "reset-pending"; readonly completedDeletes: 12 }
  | { readonly state: "complete"; readonly completedDeletes: 12 }
);

export interface RailwayPortableMaintenanceCleanupExecutor {
  getServiceInstance(input: {
    readonly serviceId: string;
    readonly environmentId: string;
  }): Promise<RailwayServiceInstance | null>;
  deleteVariable(input: {
    readonly projectId: string;
    readonly environmentId: string;
    readonly serviceId: string;
    readonly name: string;
  }): Promise<void>;
  setServiceStartCommand(input: {
    readonly serviceId: string;
    readonly environmentId: string;
    readonly startCommand: null;
  }): Promise<void>;
}

export interface RailwayPortableMaintenanceCleanupOptions {
  readonly binding: RailwayPortableMaintenanceCleanupBinding;
  readonly executor: RailwayPortableMaintenanceCleanupExecutor;
  /** Reads the durable PortableTransferCoordinator ledger; request memory is insufficient. */
  readonly durableTransferComplete: (input: { readonly operationId: string }) => Promise<boolean>;
  readonly persistCheckpoint: (checkpoint: RailwayPortableMaintenanceCleanupCheckpoint) => Promise<void>;
}

export type RailwayPortableMaintenanceCleanupFailureCode =
  | "invalid-checkpoint"
  | "transfer-incomplete"
  | "identity-drift"
  | "executor-failure"
  | "persistence-failure"
  | "cleanup-pending";

export type RailwayPortableMaintenanceCleanupResult =
  | { readonly outcome: "complete"; readonly checkpoint: RailwayPortableMaintenanceCleanupCheckpoint }
  | {
      readonly outcome: "failure";
      readonly code: RailwayPortableMaintenanceCleanupFailureCode;
      readonly checkpoint?: RailwayPortableMaintenanceCleanupCheckpoint | undefined;
    };

export class RailwayPortableMaintenanceCleanupError extends Error {
  constructor() {
    super("Railway portable maintenance cleanup binding is invalid");
    this.name = "RailwayPortableMaintenanceCleanupError";
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function exactCommand(binding: RailwayPortableMaintenanceCleanupBinding): string {
  return `bun /srv/repo/bin/nautilo-server/src/maintenance-job.ts ${binding.direction} ${binding.operationId} ${binding.objectId}`;
}

function snapshotBinding(input: RailwayPortableMaintenanceCleanupBinding): RailwayPortableMaintenanceCleanupBinding {
  return Object.freeze({
    projectId: `${input.projectId}`,
    environmentId: `${input.environmentId}`,
    serviceId: `${input.serviceId}`,
    image: `${input.image}`,
    direction: input.direction,
    operationId: `${input.operationId}`,
    objectId: `${input.objectId}`,
    command: `${input.command}`,
  });
}

function validBinding(binding: RailwayPortableMaintenanceCleanupBinding): boolean {
  const match = IMAGE_DIGEST.exec(binding.image);
  return match !== null && binding.image.split("@").length === 2 && !/\s/.test(binding.image)
    && [binding.projectId, binding.environmentId, binding.serviceId].every((value) => SAFE_ID.test(value))
    && [binding.operationId, binding.objectId].every((value) => SAFE_COMMAND_ID.test(value))
    && (binding.direction === "export" || binding.direction === "restore")
    && binding.command === exactCommand(binding);
}

function identity(binding: RailwayPortableMaintenanceCleanupBinding): CleanupCheckpointIdentity {
  const digest = IMAGE_DIGEST.exec(binding.image)?.[1];
  if (!digest) throw new RailwayPortableMaintenanceCleanupError();
  return {
    schemaVersion: RAILWAY_PORTABLE_MAINTENANCE_CLEANUP_SCHEMA_VERSION,
    projectId: binding.projectId,
    environmentId: binding.environmentId,
    serviceId: binding.serviceId,
    operationId: binding.operationId,
    imageDigest: digest,
    commandSha256: hash(binding.command),
  };
}

function checkpointMatches(
  checkpoint: RailwayPortableMaintenanceCleanupCheckpoint,
  expected: CleanupCheckpointIdentity,
): boolean {
  if (checkpoint.state !== "deleting" && checkpoint.state !== "delete-pending"
    && checkpoint.state !== "reset-pending" && checkpoint.state !== "complete") return false;
  const expectedKeys = [
    "commandSha256", "completedDeletes", ...(checkpoint.state === "delete-pending" ? ["deleteIndex"] : []),
    "environmentId", "imageDigest", "operationId", "projectId", "schemaVersion", "serviceId", "state",
  ].sort();
  const actualKeys = Object.keys(checkpoint).sort();
  const count = checkpoint.completedDeletes;
  return actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index])
    && checkpoint.schemaVersion === expected.schemaVersion
    && checkpoint.projectId === expected.projectId
    && checkpoint.environmentId === expected.environmentId
    && checkpoint.serviceId === expected.serviceId
    && checkpoint.operationId === expected.operationId
    && checkpoint.imageDigest === expected.imageDigest && SHA256.test(checkpoint.imageDigest)
    && checkpoint.commandSha256 === expected.commandSha256 && SHA256.test(checkpoint.commandSha256)
    && Number.isSafeInteger(count) && count >= 0 && count <= RAILWAY_PORTABLE_MAINTENANCE_CLEANUP_VARIABLES.length
    && (checkpoint.state === "deleting" || checkpoint.state === "delete-pending" || count === RAILWAY_PORTABLE_MAINTENANCE_CLEANUP_VARIABLES.length)
    && (checkpoint.state !== "delete-pending" || (checkpoint.deleteIndex === count && count < RAILWAY_PORTABLE_MAINTENANCE_CLEANUP_VARIABLES.length));
}

function failure(
  code: RailwayPortableMaintenanceCleanupFailureCode,
  checkpoint?: RailwayPortableMaintenanceCleanupCheckpoint,
): RailwayPortableMaintenanceCleanupResult {
  return checkpoint === undefined ? { outcome: "failure", code } : { outcome: "failure", code, checkpoint };
}

function sourceExact(instance: RailwayServiceInstance | null, binding: RailwayPortableMaintenanceCleanupBinding): boolean {
  return instance !== null
    && instance.serviceId === binding.serviceId
    && instance.environmentId === binding.environmentId
    && instance.source?.image === binding.image
    && (instance.source.repo ?? null) === null;
}

export class RailwayPortableMaintenanceCleanup {
  readonly #binding: RailwayPortableMaintenanceCleanupBinding;
  readonly #identity: CleanupCheckpointIdentity;
  readonly #executor: RailwayPortableMaintenanceCleanupExecutor;
  readonly #durableTransferComplete: RailwayPortableMaintenanceCleanupOptions["durableTransferComplete"];
  readonly #persistCheckpoint: RailwayPortableMaintenanceCleanupOptions["persistCheckpoint"];

  constructor(options: RailwayPortableMaintenanceCleanupOptions) {
    this.#binding = snapshotBinding(options.binding);
    if (!validBinding(this.#binding)) throw new RailwayPortableMaintenanceCleanupError();
    this.#identity = identity(this.#binding);
    this.#executor = options.executor;
    this.#durableTransferComplete = options.durableTransferComplete;
    this.#persistCheckpoint = options.persistCheckpoint;
  }

  /** True is the only signal that permits this exact bound operation to continue. */
  allowsContinuation(checkpoint: RailwayPortableMaintenanceCleanupCheckpoint | undefined): boolean {
    return checkpoint !== undefined
      && checkpointMatches(checkpoint, this.#identity)
      && checkpoint.state === "complete";
  }

  async #persist(checkpoint: RailwayPortableMaintenanceCleanupCheckpoint): Promise<boolean> {
    try { await this.#persistCheckpoint(checkpoint); return true; } catch { return false; }
  }

  async #instance(): Promise<RailwayServiceInstance | null | undefined> {
    try {
      return await this.#executor.getServiceInstance({
        serviceId: this.#binding.serviceId,
        environmentId: this.#binding.environmentId,
      });
    } catch {
      return undefined;
    }
  }

  async run(input?: RailwayPortableMaintenanceCleanupCheckpoint): Promise<RailwayPortableMaintenanceCleanupResult> {
    const checkpointInput = input === undefined ? undefined : structuredClone(input);
    if (checkpointInput !== undefined && !checkpointMatches(checkpointInput, this.#identity)) {
      // The rejected object is attacker-controlled and may contain fields that
      // are forbidden from every result/receipt surface.
      return failure("invalid-checkpoint");
    }

    let transferComplete: boolean;
    try { transferComplete = await this.#durableTransferComplete({ operationId: this.#binding.operationId }); }
    catch { return failure("executor-failure", checkpointInput); }
    if (!transferComplete) return failure("transfer-incomplete", checkpointInput);

    let checkpoint: RailwayPortableMaintenanceCleanupCheckpoint = checkpointInput ?? {
      ...this.#identity,
      state: "deleting",
      completedDeletes: 0,
    };
    if (checkpoint.state === "complete") return { outcome: "complete", checkpoint };

    let instance = await this.#instance();
    if (instance === undefined) return failure("executor-failure", checkpoint);
    if (!sourceExact(instance, this.#binding)) return failure("identity-drift", checkpoint);

    if (checkpoint.state === "delete-pending") {
      // The delete may have committed. Until Railway's absent-delete behavior
      // is live-qualified, neither replay nor variable-value observation is safe.
      return failure("cleanup-pending", checkpoint);
    }

    if (checkpoint.state === "reset-pending") {
      if (instance?.startCommand === null) {
        const complete: RailwayPortableMaintenanceCleanupCheckpoint = { ...this.#identity, state: "complete", completedDeletes: 12 };
        return await this.#persist(complete) ? { outcome: "complete", checkpoint: complete } : failure("persistence-failure", checkpoint);
      }
      if (instance?.startCommand !== this.#binding.command) return failure("identity-drift", checkpoint);
      if (!await this.#persist(checkpoint)) return failure("persistence-failure", checkpoint);
      try {
        await this.#executor.setServiceStartCommand({ serviceId: this.#binding.serviceId, environmentId: this.#binding.environmentId, startCommand: null });
      } catch {
        // A lost reset response is recoverable because null is directly observable.
      }
      instance = await this.#instance();
      if (instance === undefined) return failure("executor-failure", checkpoint);
      if (!sourceExact(instance, this.#binding)) return failure("identity-drift", checkpoint);
      if (instance?.startCommand !== null) {
        return instance?.startCommand === this.#binding.command
          ? failure("cleanup-pending", checkpoint)
          : failure("identity-drift", checkpoint);
      }
      const complete: RailwayPortableMaintenanceCleanupCheckpoint = { ...this.#identity, state: "complete", completedDeletes: 12 };
      return await this.#persist(complete) ? { outcome: "complete", checkpoint: complete } : failure("persistence-failure", checkpoint);
    }

    if (instance?.startCommand !== this.#binding.command) return failure("identity-drift", checkpoint);
    if (input === undefined && !await this.#persist(checkpoint)) return failure("persistence-failure", checkpoint);

    while (checkpoint.completedDeletes < RAILWAY_PORTABLE_MAINTENANCE_CLEANUP_VARIABLES.length) {
      const deleteIndex: number = checkpoint.completedDeletes;
      const pending: RailwayPortableMaintenanceCleanupCheckpoint = {
        ...this.#identity,
        state: "delete-pending",
        completedDeletes: deleteIndex,
        deleteIndex,
      };
      if (!await this.#persist(pending)) return failure("persistence-failure", checkpoint);
      try {
        await this.#executor.deleteVariable({
          projectId: this.#binding.projectId,
          environmentId: this.#binding.environmentId,
          serviceId: this.#binding.serviceId,
          name: RAILWAY_PORTABLE_MAINTENANCE_CLEANUP_VARIABLES[deleteIndex]!,
        });
      } catch {
        return failure("cleanup-pending", pending);
      }
      const confirmed: RailwayPortableMaintenanceCleanupCheckpoint = {
        ...this.#identity,
        state: "deleting",
        completedDeletes: deleteIndex + 1,
      };
      if (!await this.#persist(confirmed)) return failure("cleanup-pending", pending);
      checkpoint = confirmed;
    }

    const resetPending: RailwayPortableMaintenanceCleanupCheckpoint = {
      ...this.#identity,
      state: "reset-pending",
      completedDeletes: 12,
    };
    if (!await this.#persist(resetPending)) return failure("persistence-failure", checkpoint);
    return this.run(resetPending);
  }
}
