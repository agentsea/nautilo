import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { publishPrivateFileAtomically } from "@nautilo/config/private-filesystem";
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
  const target = resolve(filePath);
  await mkdir(dirname(target), { recursive: true });
  await publishPrivateFileAtomically(target, Buffer.from(content));
}

/** Reload `.env` into `process.env` (override), then drop managed registry keys absent from the file. */
export async function reloadEnvAndStripRemovedRegistryKeys(envPath: string): Promise<void> {
  const managed = captureManagedProviderValues();
  loadEnv({ path: envPath, override: true });
  // This per-instance master key is read only by trusted custody code. A
  // config reload must not reintroduce it into child-process environments.
  delete process.env["NAUTILO_PERSONAL_PROVIDER_CUSTODY"];
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
  delete process.env["NAUTILO_PERSONAL_PROVIDER_CUSTODY"];
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
