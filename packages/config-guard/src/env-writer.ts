import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config as loadEnv } from "dotenv";
import { warn as logWarn } from "@nautilo/logger";
import { getAllKeyDefinitions } from "./key-registry";
import { getValueFromEntries, parseEnvFile } from "./env-parser";
import { CLOUD_MANAGED_PROVIDER_KEYS, isCloudManagedDeployment } from "./managed-provider-keys";

const reloadListeners = new Set<() => void>();

/** Server-owned clients can refresh after the effective environment is replaced. */
export function subscribeEnvReload(listener: () => void): () => void {
  reloadListeners.add(listener);
  return () => { reloadListeners.delete(listener); };
}

function notifyEnvReload(): void {
  for (const listener of reloadListeners) {
    try {
      listener();
    } catch {
      logWarn("[config-guard] Environment reload listener failed");
    }
  }
}

export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, content, { encoding: "utf-8", mode: 0o600 });
    await rename(tmp, filePath);
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
}

/** Reload `.env` into `process.env` (override), then drop managed registry keys absent from the file. */
export async function reloadEnvAndStripRemovedRegistryKeys(envPath: string): Promise<void> {
  const managed = captureManagedProviderValues();
  loadEnv({ path: envPath, override: true });
  let content = "";
  try {
    content = await readFile(envPath, "utf-8");
  } catch {
    /* missing or empty */
  }
  const entries = parseEnvFile(content);
  for (const def of getAllKeyDefinitions()) {
    if (managed?.has(def.envVar)) continue;
    if (getValueFromEntries(entries, def.envVar) === undefined) {
      delete process.env[def.envVar];
    }
  }
  restoreManagedProviderValues(managed);
  notifyEnvReload();
}

/** Load an override-only provider file without deleting platform-owned keys. */
export function reloadEnvOverlay(envPath: string): void {
  const managed = captureManagedProviderValues();
  loadEnv({ path: envPath, override: true });
  restoreManagedProviderValues(managed);
  notifyEnvReload();
}

function captureManagedProviderValues(): Map<string, string | undefined> | undefined {
  return isCloudManagedDeployment()
    ? new Map(CLOUD_MANAGED_PROVIDER_KEYS.map((key) => [key, process.env[key]]))
    : undefined;
}

function restoreManagedProviderValues(managed: Map<string, string | undefined> | undefined): void {
  for (const [key, value] of managed ?? []) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
