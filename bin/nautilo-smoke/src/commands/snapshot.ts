/**
 * `snapshot <take|restore|list> <platform> [<name>]` — thin wrapper over
 * the driver's snapshot API. Also the quick escape hatch when the
 * runner isn't handy.
 */

import { LimaDriver, TartDriver, type VmDriver, type Platform } from "@nautilo/smoke-runner";
import type { ParsedArgs } from "../lib/args.ts";

export async function snapshotCommand(args: ParsedArgs): Promise<number> {
  const [sub, platformArg, name] = args._;
  if (!sub) return usageError("snapshot: subcommand required");
  if (!["take", "restore", "list"].includes(sub)) return usageError(`snapshot: unknown subcommand '${sub}'`);

  if (!platformArg || !["linux", "macos"].includes(platformArg))
    return usageError("snapshot: platform required (linux | macos)");

  const platform = platformArg as Platform;
  const driver: VmDriver = platform === "linux" ? new LimaDriver() : new TartDriver();

  if (sub === "take") {
    if (!name) return usageError("snapshot take: name required");
    await driver.snapshotTake(name);
    console.log(`snapshot: took '${name}' on ${platform}`);
    return 0;
  }

  if (sub === "restore") {
    const n = name ?? "baseline";
    await driver.snapshotRestore(n);
    console.log(`snapshot: restored '${n}' on ${platform}`);
    return 0;
  }

  // list
  const snaps = await driver.snapshotList();
  if (snaps.length === 0) {
    console.log(`(no snapshots on ${platform})`);
  } else {
    for (const s of snaps) console.log(s);
  }
  return 0;
}

function usageError(msg: string): number {
  console.error(msg);
  console.error("");
  console.error("Usage:");
  console.error("  nautilo-smoke snapshot take <platform> <name>");
  console.error("  nautilo-smoke snapshot restore <platform> [<name>]   # default: baseline");
  console.error("  nautilo-smoke snapshot list <platform>");
  return 64;
}
