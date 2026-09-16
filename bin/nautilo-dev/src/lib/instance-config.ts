import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  InstanceJsonSchema,
  resolveNautiloRootDir,
  writeInstanceJson,
  type InstanceJson,
} from "@nautilo/config";

/**
 * D172 Strategy B — read `workbenchDist` from `~/.nautilo<suffix>/instance.json`
 * when present. Returns null if the file or field is missing / invalid.
 */
export function readPersistedWorkbenchDist(resolvedInstanceId: string): string | null {
  const rootDir = resolveNautiloRootDir({
    env: { ...process.env, NAUTILO_INSTANCE_ID: resolvedInstanceId },
  });
  const path = join(rootDir, "instance.json");
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw !== "object" || raw === null) return null;
    const wd = (raw as { workbenchDist?: unknown }).workbenchDist;
    if (typeof wd === "string" && wd.trim() !== "") return wd;
    return null;
  } catch {
    return null;
  }
}

/**
 * D172 — merge `workbenchDist` into an existing validated `instance.json`.
 * No-op when the file is missing or JSON does not match {@link InstanceJsonSchema}.
 */
export function persistWorkbenchDistToInstanceJson(
  instanceRoot: string,
  workbenchDist: string,
): void {
  const path = join(instanceRoot, "instance.json");
  if (!existsSync(path)) {
    console.warn(
      `[dev-stack] skip persisting workbenchDist: missing instance.json at ${path}`,
    );
    return;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    console.warn(`[dev-stack] skip persisting workbenchDist: invalid JSON at ${path}`);
    return;
  }
  const parsed = InstanceJsonSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn(
      `[dev-stack] skip persisting workbenchDist: instance.json failed schema validation (${parsed.error.message})`,
    );
    return;
  }
  const next: InstanceJson = { ...parsed.data, workbenchDist };
  writeInstanceJson(instanceRoot, InstanceJsonSchema.parse(next));
}
