import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  discoverNautiloLayoutRoots,
  InstanceJsonSchema,
  type InstanceJson,
} from "@nautilo/config";
import { canonicalInstanceIdFromRoot, displayInstanceIdFromRoot } from "./instance-ids";
import type { ListLocalInstancesDeps, LocalInstanceRow } from "./types";

const HEALTH_TIMEOUT_MS = 1500;
const INTERNAL_SUPPORT_ROOTS = new Set([
  ".nautilo-backups",
  ".nautilo-clone-seeds",
  ".nautilo-dev",
  ".nautilo-local-secrets",
]);

function isInternalSupportRoot(root: string): boolean {
  const name = basename(root);
  if (INTERNAL_SUPPORT_ROOTS.has(name)) return true;
  const tunnel = /^\.nautilo-(.+-tunnel)$/.exec(name);
  // Configured roots remain visible even when their JSON needs repair.
  if (!tunnel || existsSync(join(root, "instance.json"))) return false;
  try {
    return statSync(join(root, `ai.nautilo.${tunnel[1]}.plist`)).isFile();
  } catch {
    return false;
  }
}

async function defaultProbeHealth(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function readInstanceJson(root: string): { ok: true; data: InstanceJson } | { ok: false; detail: string } {
  const path = join(root, "instance.json");
  if (!existsSync(path)) {
    return { ok: false, detail: "missing instance.json" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (e) {
    return {
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
  const parsed = InstanceJsonSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, detail: parsed.error.message };
  }
  return { ok: true, data: parsed.data };
}

/**
 * Enumerate `~/.nautilo` and `~/.nautilo-*` with valid directory names.
 * Malformed `instance.json` yields a row with `invalid-json` and does not throw.
 */
export async function listLocalInstances(
  userHomeDir: string,
  deps: ListLocalInstancesDeps = {},
): Promise<LocalInstanceRow[]> {
  const probe = deps.probeHealth ?? defaultProbeHealth;
  const roots = discoverNautiloLayoutRoots(userHomeDir).filter(
    (root) => !isInternalSupportRoot(root),
  );
  const rows: LocalInstanceRow[] = [];

  for (const root of roots) {
    const instanceId = canonicalInstanceIdFromRoot(root);
    const displayId = displayInstanceIdFromRoot(root);
    const parsed = readInstanceJson(root);
    if (!parsed.ok) {
      rows.push({
        root,
        instanceId,
        displayId,
        projectName: instanceId === "" ? "nautilo" : `nautilo-${instanceId}`,
        serverPort: 0,
        workbenchPort: 0,
        state: parsed.detail.startsWith("missing") ? "no-instance-json" : "invalid-json",
        detail: parsed.detail,
      });
      continue;
    }
    const j = parsed.data;
    if (j.instanceId !== instanceId) {
      rows.push({
        root,
        instanceId,
        displayId,
        projectName: instanceId === "" ? "nautilo" : `nautilo-${instanceId}`,
        serverPort: 0,
        workbenchPort: 0,
        state: "invalid-json",
        detail: `instance.json instanceId '${j.instanceId}' contradicts root instance ID '${instanceId}'`,
      });
      continue;
    }
    const healthUrl = `${j.server.url.replace(/\/$/, "")}/health`;
    const alive = await probe(healthUrl);
    rows.push({
      root,
      instanceId,
      displayId,
      projectName: j.compose.projectName,
      serverPort: j.server.port,
      workbenchPort: j.workbench.port,
      state: alive ? "running" : "idle",
    });
  }

  rows.sort((a, b) => {
    if (a.instanceId === "") return -1;
    if (b.instanceId === "") return 1;
    return a.displayId.localeCompare(b.displayId);
  });
  return rows;
}
