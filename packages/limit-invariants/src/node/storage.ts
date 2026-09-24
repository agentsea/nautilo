import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const LIMIT_AUDIT_FILENAMES = {
  inventory: "limit-inventory.jsonl",
  decisions: "reviewed-limit-decisions.jsonl",
  legacy: "legacy-unreviewed.jsonl",
  legacyLock: "legacy-lock.json",
  matrix: "limit-matrix.md",
  scout: "limit-scout.jsonl",
  investigationMap: "investigation-map.md",
} as const;

export function limitAuditPaths(packageRoot: string) {
  const baseline = join(packageRoot, "baseline");
  const generated = join(packageRoot, "generated");
  return {
    baseline,
    generated,
    inventory: join(baseline, LIMIT_AUDIT_FILENAMES.inventory),
    decisions: join(baseline, LIMIT_AUDIT_FILENAMES.decisions),
    legacy: join(baseline, LIMIT_AUDIT_FILENAMES.legacy),
    legacyLock: join(baseline, LIMIT_AUDIT_FILENAMES.legacyLock),
    matrix: join(generated, LIMIT_AUDIT_FILENAMES.matrix),
    scout: join(generated, LIMIT_AUDIT_FILENAMES.scout),
    investigationMap: join(generated, LIMIT_AUDIT_FILENAMES.investigationMap),
  } as const;
}

export async function ensureLimitAuditDirectories(paths: ReturnType<typeof limitAuditPaths>): Promise<void> {
  await Promise.all([
    mkdir(paths.baseline, { recursive: true }),
    mkdir(paths.generated, { recursive: true }),
  ]);
}

export async function readRequiredLimitAudit(path: string, label: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Missing tracked ${label} audit evidence at ${path}; restore or regenerate the canonical artifact before running this command`);
    }
    throw error;
  }
}
