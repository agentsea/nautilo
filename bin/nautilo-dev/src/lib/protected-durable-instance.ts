import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InstanceAuthorityDecision } from "@nautilo/instance-discovery/node";

const PROTECTED_DURABLE_INSTANCE_MARKER = ".protected-instance";

/**
 * Durable operator-owned fixtures are preservation authorities, not ordinary
 * named developer stacks. The marker is the explicit, instance-local authority
 * that distinguishes them without reserving private or well-known instance IDs.
 */
export function isProtectedDurableInstance(
  instanceRoot: string,
  profileAuthority?: InstanceAuthorityDecision | null,
): boolean {
  return existsSync(join(instanceRoot, PROTECTED_DURABLE_INSTANCE_MARKER))
    || profileAuthority?.retention === "durable";
}

/**
 * Mark an existing instance root as operator-owned durable state.
 *
 * The marker is deliberately local to the instance and excluded from clones
 * and backups, so protection never transfers accidentally to disposable copies.
 */
export function protectDurableInstance(instanceRoot: string): void {
  const markerPath = join(instanceRoot, PROTECTED_DURABLE_INSTANCE_MARKER);
  try {
    writeFileSync(markerPath, "protected-by=operator\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
  }
  chmodSync(markerPath, 0o600);
}
