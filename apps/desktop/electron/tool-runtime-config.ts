import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const TOOL_RUNTIME_CONFIG_VERSION = 1 as const;

export const TOOL_RUNTIME_NAMES = ["agent-browser", "gog"] as const;
export type ToolRuntimeName = (typeof TOOL_RUNTIME_NAMES)[number];
export type ToolRuntimeToolName = ToolRuntimeName;

const TOOL_RUNTIME_SET = new Set<string>(TOOL_RUNTIME_NAMES);

export type ToolRuntimeSource = "manual" | "auto-detected" | "bundled" | "app-managed";
export type ToolRuntimeHealth =
  | "unknown"
  | "healthy"
  | "missing"
  | "not-runnable"
  | "auth-missing"
  | "auth-healthy";

export interface ToolRuntimeEntry {
  configuredPath: string;
  source: ToolRuntimeSource;
  lastKnownVersion?: string;
  lastHealth?: ToolRuntimeHealth;
  lastCheckedAt?: string;
}

export interface ToolRuntimeConfig {
  version: typeof TOOL_RUNTIME_CONFIG_VERSION;
  tools: Partial<Record<ToolRuntimeName, ToolRuntimeEntry>>;
}

function isToolRuntimeName(value: string): value is ToolRuntimeName {
  return TOOL_RUNTIME_SET.has(value);
}

function parseSource(value: unknown): ToolRuntimeSource | null {
  return value === "manual" ||
    value === "auto-detected" ||
    value === "bundled" ||
    value === "app-managed"
    ? value
    : null;
}

function parseHealth(value: unknown): ToolRuntimeHealth | undefined {
  if (
    value === "unknown" ||
    value === "healthy" ||
    value === "missing" ||
    value === "not-runnable" ||
    value === "auth-missing" ||
    value === "auth-healthy"
  ) {
    return value;
  }
  return undefined;
}

function parseEntry(raw: unknown): ToolRuntimeEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const configuredPath = obj["configuredPath"];
  if (typeof configuredPath !== "string" || configuredPath.length === 0) return null;
  const source = parseSource(obj["source"]);
  if (!source) return null;
  const entry: ToolRuntimeEntry = {
    configuredPath,
    source,
  };
  if (typeof obj["lastKnownVersion"] === "string" && obj["lastKnownVersion"].length > 0) {
    entry.lastKnownVersion = obj["lastKnownVersion"];
  }
  const health = parseHealth(obj["lastHealth"]);
  if (health) entry.lastHealth = health;
  if (typeof obj["lastCheckedAt"] === "string" && obj["lastCheckedAt"].length > 0) {
    entry.lastCheckedAt = obj["lastCheckedAt"];
  }
  return entry;
}

export function emptyToolRuntimeConfig(): ToolRuntimeConfig {
  return { version: TOOL_RUNTIME_CONFIG_VERSION, tools: {} };
}

export function parseToolRuntimeConfig(raw: unknown): ToolRuntimeConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj["version"] !== TOOL_RUNTIME_CONFIG_VERSION) return null;
  const toolsRaw = obj["tools"];
  if (!toolsRaw || typeof toolsRaw !== "object" || Array.isArray(toolsRaw)) return null;
  const tools: Partial<Record<ToolRuntimeName, ToolRuntimeEntry>> = {};
  for (const [name, value] of Object.entries(toolsRaw as Record<string, unknown>)) {
    if (!isToolRuntimeName(name)) continue;
    const entry = parseEntry(value);
    if (entry) tools[name] = entry;
  }
  return { version: TOOL_RUNTIME_CONFIG_VERSION, tools };
}

function loadToolRuntimeConfig(configPath: string): ToolRuntimeConfig {
  if (!existsSync(configPath)) return emptyToolRuntimeConfig();
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    return parseToolRuntimeConfig(parsed) ?? emptyToolRuntimeConfig();
  } catch {
    return emptyToolRuntimeConfig();
  }
}

function saveToolRuntimeConfig(configPath: string, config: ToolRuntimeConfig): void {
  const parsed = parseToolRuntimeConfig(config);
  if (!parsed) throw new Error("invalid tool runtime config");
  mkdirSync(dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  try {
    renameSync(tmp, configPath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

export function upsertToolRuntimePath(
  config: ToolRuntimeConfig,
  tool: ToolRuntimeName,
  configuredPath: string,
  source: ToolRuntimeSource,
  metadata: Partial<Omit<ToolRuntimeEntry, "configuredPath" | "source">> = {},
): ToolRuntimeConfig {
  return {
    version: TOOL_RUNTIME_CONFIG_VERSION,
    tools: {
      ...config.tools,
      [tool]: {
        configuredPath,
        source,
        ...metadata,
      },
    },
  };
}

export function clearToolRuntimePath(
  config: ToolRuntimeConfig,
  tool: ToolRuntimeName,
): ToolRuntimeConfig {
  const tools = { ...config.tools };
  delete tools[tool];
  return { version: TOOL_RUNTIME_CONFIG_VERSION, tools };
}

export function getConfiguredToolRuntimePath(configPath: string, tool: ToolRuntimeName): string | null {
  return loadToolRuntimeConfig(configPath).tools[tool]?.configuredPath ?? null;
}

export function persistToolRuntimePath(
  configPath: string,
  tool: ToolRuntimeName,
  configuredPath: string,
  source: ToolRuntimeSource,
  metadata: Partial<Omit<ToolRuntimeEntry, "configuredPath" | "source">> = {},
): ToolRuntimeConfig {
  const next = upsertToolRuntimePath(
    loadToolRuntimeConfig(configPath),
    tool,
    configuredPath,
    source,
    metadata,
  );
  saveToolRuntimeConfig(configPath, next);
  return next;
}

export function clearPersistedToolRuntimePath(
  configPath: string,
  tool: ToolRuntimeName,
): ToolRuntimeConfig {
  const next = clearToolRuntimePath(loadToolRuntimeConfig(configPath), tool);
  saveToolRuntimeConfig(configPath, next);
  return next;
}
