import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { resolveNautiloRootDir } from "@nautilo/config";
import {
  getValueFromEntries,
  KEY_REGISTRY,
  parseEnvFile,
  type KeyDefinition,
} from "@nautilo/config-guard";
import { parse as parseToml } from "smol-toml";
import { HOSTING_PROVIDERS, type HostingProvider } from "@nautilo/hosting";

export const RAILWAY_RUNTIME_PROVIDERS = HOSTING_PROVIDERS;

export type RailwayRuntimeProvider = HostingProvider;

export type ProviderConfigFailureCode =
  | "railway.plan.provider-config-unreadable"
  | "railway.plan.provider-config-unsafe"
  | "railway.plan.provider-config-too-large"
  | "railway.plan.provider-config-invalid";

export interface ResolvedProviderValue {
  readonly value: string;
  readonly source: "environment" | "documented-config";
}

export type ProviderConfigResolution =
  | { readonly outcome: "resolved"; readonly providers: ReadonlyMap<RailwayRuntimeProvider, ResolvedProviderValue> }
  | { readonly outcome: "failure"; readonly code: ProviderConfigFailureCode };

export interface ResolveProviderConfigInput {
  readonly environment: NodeJS.ProcessEnv;
  readonly providerConfigPath?: string | undefined;
}

const MAX_PROVIDER_CONFIG_BYTES = 1024 * 1024;
const providerSet = new Set<string>(RAILWAY_RUNTIME_PROVIDERS);
const providerDefinitions = new Map<RailwayRuntimeProvider, KeyDefinition>(
  KEY_REGISTRY.flatMap((definition) => providerSet.has(definition.id)
    ? [[definition.id as RailwayRuntimeProvider, definition] as const]
    : []),
);

type SafeFileRead =
  | { readonly outcome: "missing" }
  | { readonly outcome: "read"; readonly body: string }
  | { readonly outcome: "failure"; readonly code: ProviderConfigFailureCode };

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownerOnlyRegularFile(status: Awaited<ReturnType<typeof lstat>>): boolean {
  return !status.isSymbolicLink()
    && status.isFile()
    && (typeof process.getuid !== "function" || status.uid === process.getuid())
    && (process.platform === "win32" || (Number(status.mode) & 0o077) === 0);
}

/**
 * Read one declared input only. The lstat/fstat identity check closes the
 * ordinary path-swap window; no source path is returned to callers or output.
 */
async function readSafeFile(path: string): Promise<SafeFileRead> {
  let initial;
  try {
    initial = await lstat(path);
  } catch (error) {
    return missing(error)
      ? { outcome: "missing" }
      : { outcome: "failure", code: "railway.plan.provider-config-unreadable" };
  }
  if (!ownerOnlyRegularFile(initial)) {
    return { outcome: "failure", code: "railway.plan.provider-config-unsafe" };
  }
  if (initial.size > MAX_PROVIDER_CONFIG_BYTES) {
    return { outcome: "failure", code: "railway.plan.provider-config-too-large" };
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
    handle = await open(path, flags);
    const opened = await handle.stat();
    if (!ownerOnlyRegularFile(opened) || opened.dev !== initial.dev || opened.ino !== initial.ino) {
      return { outcome: "failure", code: "railway.plan.provider-config-unsafe" };
    }
    if (opened.size > MAX_PROVIDER_CONFIG_BYTES) {
      return { outcome: "failure", code: "railway.plan.provider-config-too-large" };
    }
    const body = await handle.readFile();
    if (body.byteLength > MAX_PROVIDER_CONFIG_BYTES) {
      return { outcome: "failure", code: "railway.plan.provider-config-too-large" };
    }
    return { outcome: "read", body: body.toString("utf8") };
  } catch (error) {
    return missing(error)
      ? { outcome: "missing" }
      : { outcome: "failure", code: "railway.plan.provider-config-unreadable" };
  } finally {
    try {
      await handle?.close();
    } catch {
      // Closing a read-only descriptor cannot change the caller's input.
    }
  }
}

function parseProviderToml(
  body: string,
  environment: NodeJS.ProcessEnv,
): ProviderConfigResolution {
  let parsed: unknown;
  try {
    parsed = parseToml(body);
  } catch {
    return { outcome: "failure", code: "railway.plan.provider-config-invalid" };
  }
  if (!isRecord(parsed)
    || Object.keys(parsed).length !== 2
    || parsed["schemaVersion"] !== 1
    || !isRecord(parsed["providers"])) {
    return { outcome: "failure", code: "railway.plan.provider-config-invalid" };
  }

  const providers = new Map<RailwayRuntimeProvider, ResolvedProviderValue>();
  for (const [provider, rawEntry] of Object.entries(parsed["providers"])) {
    if (!providerSet.has(provider) || !isRecord(rawEntry)) {
      return { outcome: "failure", code: "railway.plan.provider-config-invalid" };
    }
    const keys = Object.keys(rawEntry);
    const hasValue = Object.hasOwn(rawEntry, "value");
    const hasFromEnv = Object.hasOwn(rawEntry, "fromEnv");
    if (keys.length !== 1 || hasValue === hasFromEnv) {
      return { outcome: "failure", code: "railway.plan.provider-config-invalid" };
    }

    const definition = providerDefinitions.get(provider as RailwayRuntimeProvider);
    if (definition === undefined) {
      return { outcome: "failure", code: "railway.plan.provider-config-invalid" };
    }
    let value: string | undefined;
    if (hasValue) {
      if (typeof rawEntry["value"] !== "string") {
        return { outcome: "failure", code: "railway.plan.provider-config-invalid" };
      }
      value = rawEntry["value"];
    } else {
      if (typeof rawEntry["fromEnv"] !== "string" || rawEntry["fromEnv"] !== definition.envVar) {
        return { outcome: "failure", code: "railway.plan.provider-config-invalid" };
      }
      value = environment[definition.envVar];
    }
    if (value === undefined || value.length === 0) continue;
    if (value.trim() !== value || !definition.formatCheck(value)) {
      return { outcome: "failure", code: "railway.plan.provider-config-invalid" };
    }
    providers.set(provider as RailwayRuntimeProvider, {
      value,
      source: "documented-config",
    });
  }
  return { outcome: "resolved", providers };
}

async function resolvePrimaryToml(
  input: ResolveProviderConfigInput,
): Promise<ProviderConfigResolution> {
  const hasExplicitPath = input.providerConfigPath !== undefined;
  const explicit = input.providerConfigPath?.trim();
  if (hasExplicitPath && (explicit === undefined || explicit.length === 0)) {
    return { outcome: "failure", code: "railway.plan.provider-config-invalid" };
  }
  const home = input.environment["HOME"];
  const path = hasExplicitPath
    ? isAbsolute(explicit!) ? explicit! : resolve(explicit!)
    : home === undefined || home.trim() === ""
      ? undefined
      : join(home, ".config", "nautilo", "providers.toml");
  if (path === undefined) return { outcome: "resolved", providers: new Map() };

  const read = await readSafeFile(path);
  if (read.outcome === "missing") {
    return !hasExplicitPath
      ? { outcome: "resolved", providers: new Map() }
      : { outcome: "failure", code: "railway.plan.provider-config-unreadable" };
  }
  if (read.outcome === "failure") return read;
  return parseProviderToml(read.body, input.environment);
}

async function readCompatibilityEntries(environment: NodeJS.ProcessEnv): Promise<
  | { readonly outcome: "resolved"; readonly entries: ReturnType<typeof parseEnvFile> }
  | { readonly outcome: "failure"; readonly code: ProviderConfigFailureCode }
> {
  let paths: readonly string[];
  try {
    const explicit = environment["NAUTILO_DOTENV_PATH"]?.trim();
    if (explicit !== undefined && explicit.length > 0) {
      paths = [isAbsolute(explicit) ? explicit : resolve(explicit)];
    } else {
      const root = resolveNautiloRootDir({ env: environment });
      paths = [join(root, "runtime-config", "instance.env"), join(root, "instance.env")];
    }
  } catch {
    return { outcome: "failure", code: "railway.plan.provider-config-unsafe" };
  }

  for (const path of paths) {
    const read = await readSafeFile(path);
    if (read.outcome === "missing") continue;
    if (read.outcome === "failure") return read;
    return { outcome: "resolved", entries: parseEnvFile(read.body) };
  }
  return { outcome: "resolved", entries: [] };
}

/**
 * Resolve only the documented provider sources. It never scans the filesystem,
 * mutates an input, returns a source path, or allows non-provider TOML state.
 */
export async function resolveRailwayProviderConfig(
  input: ResolveProviderConfigInput,
): Promise<ProviderConfigResolution> {
  const toml = await resolvePrimaryToml(input);
  if (toml.outcome === "failure") return toml;
  const providers = new Map(toml.providers);
  for (const provider of RAILWAY_RUNTIME_PROVIDERS) {
    if (providers.has(provider)) continue;
    const definition = providerDefinitions.get(provider);
    if (definition === undefined) continue;
    const environmentValue = input.environment[definition.envVar];
    if (environmentValue !== undefined && environmentValue.length > 0) {
      if (environmentValue.trim() !== environmentValue || !definition.formatCheck(environmentValue)) {
        return { outcome: "failure", code: "railway.plan.provider-config-invalid" };
      }
      providers.set(provider, { value: environmentValue, source: "environment" });
    }
  }
  if (providers.size === RAILWAY_RUNTIME_PROVIDERS.length) {
    return { outcome: "resolved", providers };
  }

  const compatibility = await readCompatibilityEntries(input.environment);
  if (compatibility.outcome === "failure") return compatibility;
  for (const provider of RAILWAY_RUNTIME_PROVIDERS) {
    if (providers.has(provider)) continue;
    const definition = providerDefinitions.get(provider);
    if (definition === undefined) continue;
    const compatibilityValue = getValueFromEntries(compatibility.entries, definition.envVar);
    if (compatibilityValue !== undefined && compatibilityValue.length > 0) {
      if (compatibilityValue.trim() !== compatibilityValue || !definition.formatCheck(compatibilityValue)) {
        return { outcome: "failure", code: "railway.plan.provider-config-invalid" };
      }
      providers.set(provider, { value: compatibilityValue, source: "documented-config" });
    }
  }
  return { outcome: "resolved", providers };
}
