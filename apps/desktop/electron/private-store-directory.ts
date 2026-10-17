import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ensurePrivateDirectorySync } from "@nautilo/config/private-filesystem";

const securedDirectories = new Set<string>();

/**
 * Store directories (normally `userData`) are secured once per process. On
 * Windows every synchronous privacy check starts a PowerShell helper, which
 * would otherwise block the main thread on each save. A directory that has
 * since disappeared is secured again when it is recreated.
 */
export function ensurePrivateStoreDirectorySync(directory: string): void {
  const absolute = resolve(directory);
  if (securedDirectories.has(absolute) && existsSync(absolute)) return;
  ensurePrivateDirectorySync(absolute);
  securedDirectories.add(absolute);
}
