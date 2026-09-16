/** One-shot Railway/portable-maintenance image entry point. */

import {
  PortableRecoveryJobError,
  createDefaultPortableRecoveryObjectStore,
  createNodePortableRecoveryFilesystem,
  createNodePortableRecoveryRunner,
  createPortableRecoveryFreshTargetPrecondition,
  readPortableRecoveryJobEnvironment,
  runPortableRecoveryJob,
  type PortableRecoveryDirection,
} from "@nautilo/server";
import { ensureDatabase } from "@nautilo/db";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ParsedPortableMaintenanceJobArgs {
  readonly direction: PortableRecoveryDirection;
  readonly operationId: string;
  readonly objectId: string;
}

export interface ParsedMigrationMaintenanceJobArgs {
  readonly direction: "migrate";
  readonly migrationId: string;
  readonly executionId: string;
}

export type ParsedMaintenanceJobArgs = ParsedPortableMaintenanceJobArgs | ParsedMigrationMaintenanceJobArgs;

/** Accepted values are identifiers only; credentials never belong in argv. */
export function parseMaintenanceJobArgs(argv: readonly string[]): ParsedMaintenanceJobArgs {
  const args = argv.slice(2);
  if (args.length !== 3 || !SAFE_ID.test(args[1] ?? "") || !SAFE_ID.test(args[2] ?? "") || args[1] === "." || args[1] === ".." || args[2] === "." || args[2] === "..") {
    throw new PortableRecoveryJobError("INVALID_INPUT", "invalid maintenance job arguments");
  }
  if (args[0] === "migrate") return { direction: "migrate", migrationId: args[1]!, executionId: args[2]! };
  if (args[0] === "export" || args[0] === "restore") return { direction: args[0], operationId: args[1]!, objectId: args[2]! };
  throw new PortableRecoveryJobError("INVALID_INPUT", "invalid maintenance job arguments");
}

async function main(argv: readonly string[] = process.argv, env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  const parsed = parseMaintenanceJobArgs(argv);
  if (parsed.direction === "migrate") {
    await ensureDatabase(() => undefined);
    return;
  }
  const environment = readPortableRecoveryJobEnvironment(env);
  // The one-shot service is authorized only for the Nautilo data volume. A
  // provider variable must never be able to redirect export to image paths.
  const fs = createNodePortableRecoveryFilesystem("/var/lib/nautilo");
  const runner = createNodePortableRecoveryRunner();
  await runPortableRecoveryJob({
    ...parsed,
    environment,
    fs,
    runner,
    storage: createDefaultPortableRecoveryObjectStore(environment),
    assertFreshTarget: createPortableRecoveryFreshTargetPrecondition({ fs, runner, environment }),
  });
}

if (import.meta.main) {
  main().catch((cause: unknown) => {
    // A maintenance job deliberately has no stdout protocol.  Error messages
    // are fixed/redacted by the core and must never contain authority values.
    const message = cause instanceof PortableRecoveryJobError ? cause.message : "portable recovery job failed";
    console.error(message);
    process.exitCode = cause instanceof PortableRecoveryJobError && cause.code === "INVALID_INPUT" ? 2 : 1;
  });
}
