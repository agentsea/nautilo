import type { ComposeDriver, ComposeDriverProfile } from "@nautilo/compose-driver";
import {
  createComposeLifecycleFromDriver,
  unwrapComposeLifecycleError,
  type ComposeLifecycle,
} from "@nautilo/compose-lifecycle";

import {
  createDriverForCli,
  loadActiveProfileForCompose,
  type FactoryOptions,
} from "./compose-driver-factory.ts";

export async function runComposeVerb(
  argv: Record<string, unknown>,
  run: (
    profile: ComposeDriverProfile,
    driver: ComposeDriver,
    lifecycle: ComposeLifecycle,
  ) => Promise<void | ComposeVerbOutcome>,
  factoryOpts?: FactoryOptions,
  hooks?: {
    readonly beforeDriver?: (profile: ComposeDriverProfile) => Promise<void>;
    readonly factoryOptions?: (profile: ComposeDriverProfile) => FactoryOptions | undefined;
  },
): Promise<void> {
  try {
    const profileFlag =
      typeof argv["profile"] === "string" ? argv["profile"] : undefined;
    const profile = loadActiveProfileForCompose(profileFlag);
    await hooks?.beforeDriver?.(profile);
    const driver = createDriverForCli(profile, hooks?.factoryOptions?.(profile) ?? factoryOpts);
    const lifecycle = createComposeLifecycleFromDriver({ profile, driver });
    const outcome = await run(profile, driver, lifecycle);
    process.exitCode = outcome?.exitCode ?? 0;
  } catch (e) {
    const error = unwrapComposeLifecycleError(e);
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

export interface ComposeVerbOutcome {
  readonly exitCode: 0 | 1 | 130;
}

/** Profile-only Compose command runner. It never constructs a deployment driver. */
export async function runComposeProfileVerb(
  argv: Record<string, unknown>,
  run: (profile: ComposeDriverProfile) => Promise<void | ComposeVerbOutcome>,
): Promise<void> {
  try {
    const profileFlag = typeof argv["profile"] === "string" ? argv["profile"] : undefined;
    const profile = loadActiveProfileForCompose(profileFlag);
    const outcome = await run(profile);
    process.exitCode = outcome?.exitCode ?? 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
