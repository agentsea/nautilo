import {
  createComposeDriver,
  createRemoteComposeDriver,
  type ComposeDriver,
  type ComposeDriverDeps,
  type ComposeDriverProfile,
  type CreateComposeDriverOptions,
  type RemoteRuntimeAcceptanceTransport,
} from "@nautilo/compose-driver";
import { isAbsolute } from "node:path";

import { createComposeLifecycleFromDriver } from "./lifecycle.ts";
import type { ComposeLifecycle, ComposeLifecyclePorts } from "./types.ts";

export interface CreateProductionComposeLifecycleOptions
  extends CreateComposeDriverOptions {
  readonly profile: ComposeDriverProfile;
  readonly ports?: ComposeLifecyclePorts;
  readonly releaseActiveWorkReadiness?: ComposeDriverDeps["assertReleaseActiveWorkReady"];
  readonly maintenanceDrain?: ComposeDriverDeps["drainMaintenanceWork"];
  readonly remoteRuntimeAcceptance?: RemoteRuntimeAcceptanceTransport;
  /** Unit-test seam. Production callers omit it. */
  readonly driverFactory?: (
    profile: ComposeDriverProfile,
    options: CreateComposeDriverOptions,
  ) => ComposeDriver;
}

export type CreateProductionComposeDriverOptions = Omit<
  CreateProductionComposeLifecycleOptions,
  "ports"
>;

export function createProductionComposeDriver(
  options: CreateProductionComposeDriverOptions,
): ComposeDriver {
  const {
    profile,
    releaseActiveWorkReadiness,
    maintenanceDrain,
    remoteRuntimeAcceptance,
    driverFactory,
    ...driverOptions
  } = options;
  if (driverOptions.managedServerEnvPath !== undefined) {
    if (profile.transport !== "local") {
      throw new Error("Managed server environment is currently supported only for local Compose targets");
    }
    if (!isAbsolute(driverOptions.managedServerEnvPath)) {
      throw new Error("Managed server environment path must be absolute");
    }
  }
  const createDriver = driverFactory ?? ((targetProfile, targetOptions) =>
    targetProfile.transport === "remote"
      ? createRemoteComposeDriver(targetProfile, targetOptions)
      : createComposeDriver(targetOptions));
  const driver = createDriver(profile, driverOptions);
  if (releaseActiveWorkReadiness !== undefined) {
    driver.setReleaseActiveWorkReadiness(releaseActiveWorkReadiness);
  }
  if (maintenanceDrain !== undefined) {
    driver.setMaintenanceDrain(maintenanceDrain);
  }
  if (remoteRuntimeAcceptance !== undefined) {
    if (profile.transport !== "remote") {
      throw new Error("Remote runtime acceptance can only be wired to a remote Compose target");
    }
    driver.setRemoteRuntimeAcceptanceTransport(remoteRuntimeAcceptance);
  }
  return driver;
}

/**
 * Construct the same production driver/lifecycle composition for CLI and
 * non-CLI callers. Profile, paths, authority, progress and maintenance ports
 * are explicit; this function never reads an active CLI profile.
 */
export function createProductionComposeLifecycle(
  options: CreateProductionComposeLifecycleOptions,
): ComposeLifecycle {
  const { profile, ports, ...driverOptions } = options;
  const driver = createProductionComposeDriver({ profile, ...driverOptions });
  return createComposeLifecycleFromDriver({
    profile,
    driver,
    ...(ports === undefined ? {} : { ports }),
  });
}
