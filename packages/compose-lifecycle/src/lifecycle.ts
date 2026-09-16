import {
  composeProjectName,
  type ComposeDriver,
  type ComposeDriverProfile,
} from "@nautilo/compose-driver";

import type {
  ComposeBackupResult,
  ComposeDeployRequest,
  ComposeDeployResult,
  ComposeDestroyResult,
  ComposeInspectResult,
  ComposeLifecycle,
  ComposeLifecycleOperation,
  ComposeLifecyclePorts,
  ComposeRestoreResult,
  ComposeTargetIdentity,
  ComposeUpgradeResult,
} from "./types.ts";
import type { BackupOptions, RestoreOptions, UpgradeOptions } from "@nautilo/compose-driver";

let operationTail: Promise<void> = Promise.resolve();

export class ComposeCustodyCleanupError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super("Compose owner-claim custody cleanup failed", { cause });
    this.name = "ComposeCustodyCleanupError";
    this.cause = cause;
  }
}

export class ComposeLifecycleError extends Error {
  override readonly cause: unknown;
  readonly operation: ComposeLifecycleOperation;
  readonly target: ComposeTargetIdentity;
  readonly recovery: "retry-after-inspect" | "preserve-and-inspect";

  constructor(input: {
    readonly operation: ComposeLifecycleOperation;
    readonly target: ComposeTargetIdentity;
    readonly cause: unknown;
  }) {
    super(`Compose ${input.operation} failed; inspect the exact target before retrying.`, {
      cause: input.cause,
    });
    this.name = "ComposeLifecycleError";
    this.operation = input.operation;
    this.target = input.target;
    this.recovery = input.operation === "destroy"
      ? "preserve-and-inspect"
      : "retry-after-inspect";
    this.cause = input.cause;
  }
}

/** CLI presentation may unwrap its own trusted driver error to preserve legacy text. */
export function unwrapComposeLifecycleError(error: unknown): unknown {
  return error instanceof ComposeLifecycleError ? error.cause : error;
}

async function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const predecessor = operationTail;
  let release!: () => void;
  operationTail = new Promise<void>((resolve) => { release = resolve; });
  await predecessor;
  try {
    return await operation();
  } finally {
    release();
  }
}

function targetFor(profile: ComposeDriverProfile): ComposeTargetIdentity {
  return {
    profileName: profile.name,
    instanceId: profile.instance_id ?? "",
    composeProjectName: composeProjectName(profile),
    transport: profile.transport,
  };
}

export function createComposeLifecycleFromDriver(input: {
  readonly profile: ComposeDriverProfile;
  readonly driver: ComposeDriver;
  readonly ports?: ComposeLifecyclePorts;
}): ComposeLifecycle {
  const { profile, driver } = input;
  const ports = input.ports ?? {};
  const target = targetFor(profile);

  const run = async <T>(operation: ComposeLifecycleOperation, work: () => Promise<T>): Promise<T> =>
    serialized(async () => {
      ports.progress?.({ operation, phase: "started" });
      try {
        const result = await work();
        ports.progress?.({ operation, phase: "completed" });
        return result;
      } catch (error) {
        ports.progress?.({ operation, phase: "failed" });
        throw new ComposeLifecycleError({ operation, target, cause: error });
      }
    });

  return {
    target,
    deploy: (request: ComposeDeployRequest = {}): Promise<ComposeDeployResult> =>
      run("deploy", async () => {
        await driver.deploy(profile, request);
        return { operation: "deploy", target, readiness: "ready", recovery: "none" };
      }),
    inspect: (): Promise<ComposeInspectResult> =>
      run("inspect", async () => ({
        operation: "inspect",
        target,
        observation: await driver.status(profile),
      })),
    upgrade: (request?: UpgradeOptions): Promise<ComposeUpgradeResult> =>
      run("upgrade", async () => {
        await driver.upgrade(profile, request);
        return { operation: "upgrade", target, readiness: "ready", recovery: "none" };
      }),
    backup: (request?: BackupOptions): Promise<ComposeBackupResult> =>
      run("backup", async () => ({
        operation: "backup",
        target,
        backupPath: await driver.backup(profile, request),
      })),
    restore: (request: RestoreOptions): Promise<ComposeRestoreResult> =>
      run("restore", async () => {
        await driver.restore(profile, request);
        return { operation: "restore", target, readiness: "ready", recovery: "none" };
      }),
    destroyHard: (request = {}): Promise<ComposeDestroyResult> =>
      run("destroy", async () => {
        if (ports.clearOwnerClaimCustody === undefined) {
          throw new Error("Hard destroy requires an explicit owner-claim custody cleanup port");
        }
        await driver.destroy(profile, { hard: true, ...request });
        const cleanup = await driver.inspectCleanup(profile, request.keepCerts === true);
        if (!cleanup.containersAbsent || !cleanup.networksAbsent || !cleanup.dataVolumesAbsent) {
          throw new Error("Hard destroy could not prove exact Compose resource cleanup");
        }
        try {
          await ports.clearOwnerClaimCustody(profile);
        } catch (error) {
          throw new ComposeCustodyCleanupError(error);
        }
        return {
          operation: "destroy",
          target,
          cleanup: {
            containersAbsent: true,
            networksAbsent: true,
            dataVolumesAbsent: true,
            ownerClaimCustodyCleared: true,
          },
          recovery: "none",
        };
      }),
  };
}
