/**
 * `status` command — print VM health for configured platforms.
 */

import { LimaDriver, TartDriver, type VmDriver, type Platform } from "@nautilo/smoke-runner";
import { getString, type ParsedArgs } from "../lib/args.ts";

export async function statusCommand(args: ParsedArgs): Promise<number> {
  const platformArg = getString(args, "platform", "both");
  const platforms: Platform[] =
    platformArg === "linux" ? ["linux"]
      : platformArg === "macos" ? ["macos"]
      : ["linux", "macos"];

  for (const p of platforms) {
    const driver: VmDriver = p === "linux" ? new LimaDriver() : new TartDriver();
    console.log(`# ${p} — ${driver.vmName}`);
    let status: string;
    try {
      status = await driver.status();
    } catch (err) {
      status = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
    console.log(`  status: ${status}`);

    if (status === "running") {
      try {
        const probe = await driver.healthProbe();
        console.log(`  health: ${probe.ok ? "OK" : `DEGRADED (${probe.reason ?? "unknown"})`}`);
        for (const pr of probe.probeResults) {
          const mark = pr.ok ? "✓" : "✗";
          const detail = pr.detail ? ` (${pr.detail})` : "";
          console.log(`    ${mark} ${pr.probe}${detail}`);
        }
      } catch (err) {
        console.log(`  health: probe threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    try {
      const snaps = await driver.snapshotList();
      console.log(`  snapshots: ${snaps.length > 0 ? snaps.join(", ") : "(none)"}`);
    } catch {
      console.log(`  snapshots: (unable to query)`);
    }
    console.log("");
  }
  return 0;
}
