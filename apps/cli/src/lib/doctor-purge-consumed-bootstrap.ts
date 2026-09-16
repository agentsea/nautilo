import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { purgeBootstrapDir } from "@nautilo/operator-secrets";
import { listNautiloInstanceRoots } from "./doctor-migrate-config.ts";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface PurgeConsumedBootstrapOptions {
  home?: string;
  now?: Date;
  dryRun?: boolean;
  /** TTL in ms before `.used` is eligible for purge. Default 24h. */
  ttlMs?: number;
}

export type PurgeScanReason =
  | "purged"
  | "too-young"
  | "no-used-sentinel"
  | "dry-run-would-purge";

export interface PurgeConsumedBootstrapResult {
  scanned: { instanceRoot: string; reason: PurgeScanReason }[];
  purgedCount: number;
}

export function runDoctorPurgeConsumedBootstrap(
  opts?: PurgeConsumedBootstrapOptions,
): PurgeConsumedBootstrapResult {
  const home = opts?.home?.trim() || process.env["HOME"] || "";
  if (!home) {
    throw new Error("HOME is not set (pass opts.home for tests)");
  }
  const now = opts?.now ?? new Date();
  const dryRun = Boolean(opts?.dryRun);
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;

  const scanned: { instanceRoot: string; reason: PurgeScanReason }[] = [];
  let purgedCount = 0;

  for (const instanceRoot of listNautiloInstanceRoots(home)) {
    const bootstrapDir = join(instanceRoot, ".bootstrap");
    if (!existsSync(bootstrapDir)) continue;
    const usedPath = join(bootstrapDir, ".used");
    if (!existsSync(usedPath)) {
      scanned.push({ instanceRoot, reason: "no-used-sentinel" });
      continue;
    }
    let mtimeMs: number;
    try {
      mtimeMs = statSync(usedPath).mtimeMs;
    } catch {
      scanned.push({ instanceRoot, reason: "no-used-sentinel" });
      continue;
    }
    if (now.getTime() - mtimeMs < ttlMs) {
      scanned.push({ instanceRoot, reason: "too-young" });
      continue;
    }
    if (dryRun) {
      scanned.push({ instanceRoot, reason: "dry-run-would-purge" });
      continue;
    }
    purgeBootstrapDir(bootstrapDir);
    scanned.push({ instanceRoot, reason: "purged" });
    purgedCount += 1;
  }

  return { scanned, purgedCount };
}
