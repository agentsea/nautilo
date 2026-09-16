/**
 * Strict pure contracts for versioned Workstation Profiles.
 *
 * A Workstation Profile is durable admin configuration — never authority by
 * itself. One PIN-confirmed activation binds an exact profile revision to an
 * app session; the profile is then compiled into explicit, contained authority
 * by {@link compileWorkstationProfile}.
 *
 * This module is contract-only and Electron-free. Like `parseDesktopFilesystemGrant`,
 * it validates record shape and lexically normalizes paths. It does not inspect
 * the filesystem, resolve symlinks, execute processes, mint grants, or decide
 * whether a compiled profile may be enforced. Parsing fails closed on every
 * shape drift, escape capability, or unknown identifier.
 */

import * as path from "node:path";
import {
  DESKTOP_FILESYSTEM_ACCESS_OPERATIONS,
  isPathWithinDesktopFilesystemGrantRoot,
  type DesktopFilesystemAccessOperation,
} from "@nautilo/desktop-filesystem-grants";

export const WORKSTATION_PROFILE_SCHEMA_VERSION = 1 as const;

/**
 * Execution backend every discovered capability must declare explicitly.
 * Full Workstation Mode fails closed when neither backend can contain a
 * capability; it never silently falls back to unsandboxed execution.
 */
export const PROFILE_CAPABILITY_BACKENDS = ["sandboxed", "brokered_host_service"] as const;
export type ProfileCapabilityBackend = (typeof PROFILE_CAPABILITY_BACKENDS)[number];

/**
 * Broad boolean capability flags a guarded profile may turn on. Escape
 * capabilities (Docker socket, raw host process control, unrestricted host
 * control) are deliberately absent: they require the separate Real Workstation
 * Host Control danger tier and can never be expressed as a guarded profile
 * capability. Docker Compose and OS signing are also absent here — they are
 * only permitted as typed {@link ProfileToolchainCapability} entries that
 * declare a backend and typed operation identifiers.
 */
export const PROFILE_CAPABILITIES = ["background_processes", "device_control", "mcp_hosts"] as const;
export type ProfileCapability = (typeof PROFILE_CAPABILITIES)[number];

/**
 * Discovery provider identifiers recognized by the profile compiler. Any other
 * provider id is rejected as unknown. Built-in discovery is a seed, not a
 * compatibility ceiling: an admin adds a missing provider's concrete facts via
 * an `admin`-originated toolchain capability delta, not by inventing a provider
 * id here.
 */
export const PROFILE_DISCOVERY_PROVIDERS = [
  "bun",
  "npm",
  "expo_metro",
  "gradle",
  "android_sdk",
  "xcode",
  "homebrew",
  "maestro",
] as const;
export type ProfileDiscoveryProvider = (typeof PROFILE_DISCOVERY_PROVIDERS)[number];

export const PROFILE_DISCOVERY_ORIGINS = [
  "fixed_argv",
  "well_known_path",
  "existing_config",
  "admin",
] as const;
export type ProfileDiscoveryOrigin = (typeof PROFILE_DISCOVERY_ORIGINS)[number];

export const PROFILE_NETWORK_MODES = ["host", "isolated", "proxy_allowlist"] as const;
export type ProfileNetworkMode = (typeof PROFILE_NETWORK_MODES)[number];

export const PROFILE_NETWORK_RULE_KINDS = ["host", "domain", "cidr", "port"] as const;
export type ProfileNetworkRuleKind = (typeof PROFILE_NETWORK_RULE_KINDS)[number];

/**
 * Tokens that name a sandbox-escape / host-control surface. They may never
 * appear in a typed operation identifier inside a guarded profile capability.
 * This is defense-in-depth on top of the closed capability/kind enumerations.
 */
const FORBIDDEN_CAPABILITY_TOKENS = [
  "docker_socket",
  "raw_host",
  "unrestricted_host",
  "host_control",
  "real_workstation",
  "privileged",
  "sudo",
  "root_shell",
] as const;

/**
 * A canonical root a profile authorizes, with the operation levels it permits.
 * `path` is host-canonical and absolute; the filesystem root (`/`) and relative
 * or traversal paths are rejected by the parser.
 */
export interface ProfileRootRule {
  path: string;
  access: readonly DesktopFilesystemAccessOperation[];
}

/**
 * A bounded executable family the profile permits, with explicit argv tokens
 * and an explicit execution backend. Empty `argv` means no positional argv is
 * permitted for this rule.
 */
export interface ProfileExecutableRule {
  id: string;
  executable: string;
  argv: readonly string[];
  backend: ProfileCapabilityBackend;
}

export interface ProfileNetworkRule {
  id: string;
  kind: ProfileNetworkRuleKind;
  value: string;
}

export interface ProfileNetworkPolicy {
  mode: ProfileNetworkMode;
  allow: readonly ProfileNetworkRule[];
}

/**
 * Kind of a typed toolchain capability. `docker_compose` and `os_signing` are
 * the only permitted escape-adjacent surfaces and must declare a backend and a
 * non-empty typed `operations` list. Generic `toolchain` entries describe
 * discovered package managers / SDKs / test tools.
 */
export const PROFILE_TOOLCHAIN_CAPABILITY_KINDS = [
  "toolchain",
  "docker_compose",
  "os_signing",
] as const;
export type ProfileToolchainCapabilityKind = (typeof PROFILE_TOOLCHAIN_CAPABILITY_KINDS)[number];

/**
 * A typed, contained capability discovered or admin-added against a profile.
 * Every capability declares an explicit backend and typed operation
 * identifiers; unrestricted Docker socket / raw-host control is never
 * representable here.
 */
export interface ProfileToolchainCapability {
  id: string;
  kind: ProfileToolchainCapabilityKind;
  discoveredFrom: ProfileDiscoveryOrigin;
  executable: string;
  roots: readonly ProfileRootRule[];
  environmentKeys: readonly string[];
  backend: ProfileCapabilityBackend;
  /** Typed operation identifiers; required non-empty for docker_compose/os_signing. */
  operations: readonly string[];
}

/**
 * Versioned, JSON-safe admin configuration. One exact revision is bound to an
 * activated Full Workstation session; broadening an active revision requires a
 * fresh PIN, while narrowing or disabling applies immediately.
 */
export interface WorkstationProfile {
  schemaVersion: typeof WORKSTATION_PROFILE_SCHEMA_VERSION;
  id: string;
  revision: number;
  name: string;
  roots: readonly ProfileRootRule[];
  discoveryProviders: readonly ProfileDiscoveryProvider[];
  environmentKeys: readonly string[];
  executableRules: readonly ProfileExecutableRule[];
  network: ProfileNetworkPolicy;
  capabilities: readonly ProfileCapability[];
  toolchainCapabilities: readonly ProfileToolchainCapability[];
  protectedPolicyVersion: number;
  createdAt: string;
  updatedAt: string;
}

export type WorkstationProfileValidationErrorCode =
  | "invalid_record"
  | "unknown_schema_version"
  | "unknown_field"
  | "invalid_id"
  | "invalid_revision"
  | "invalid_name"
  | "invalid_roots"
  | "invalid_root_path"
  | "invalid_root_access"
  | "duplicate_root"
  | "invalid_discovery_providers"
  | "unknown_discovery_provider"
  | "duplicate_discovery_provider"
  | "invalid_environment_keys"
  | "duplicate_environment_key"
  | "invalid_executable_rules"
  | "invalid_executable_rule"
  | "duplicate_executable_rule_id"
  | "invalid_network"
  | "invalid_network_rule"
  | "duplicate_network_rule_id"
  | "invalid_capabilities"
  | "forbidden_capability"
  | "invalid_toolchain_capabilities"
  | "duplicate_toolchain_capability_id"
  | "missing_capability_backend"
  | "invalid_capability_operations"
  | "invalid_toolchain_capability_roots"
  | "invalid_protected_policy_version"
  | "invalid_created_at"
  | "invalid_updated_at";

export type WorkstationProfileValidationResult =
  | { ok: true; profile: WorkstationProfile }
  | { ok: false; error: { code: WorkstationProfileValidationErrorCode; message: string } };

export interface WorkstationProfileValidationOptions {
  /** Inject a clock for deterministic timestamp validation. No disk or process access. */
  now?: Date;
}

// ── Discovered concrete facts ───────────────────────────────────────────────

export interface DiscoveredProfileRoot {
  path: string;
  access: readonly DesktopFilesystemAccessOperation[];
  sourceProvider?: string;
}

export interface DiscoveredProfileCapability {
  id: string;
  executable: string;
  roots: readonly DiscoveredProfileRoot[];
  environmentKeys: readonly string[];
  backend: ProfileCapabilityBackend;
  operations: readonly string[];
}

/**
 * Canonical concrete facts emitted by discovery adapters. They are advisory
 * only: {@link compileWorkstationProfile} rejects any fact the bound profile
 * does not already authorize. Discovery never creates authority.
 */
export interface DiscoveredWorkstationFacts {
  roots: readonly DiscoveredProfileRoot[];
  environmentKeys: readonly string[];
  capabilities: readonly DiscoveredProfileCapability[];
}

export interface CompiledProfileRoot {
  path: string;
  access: readonly DesktopFilesystemAccessOperation[];
  sourceProvider?: string;
}

export interface CompiledProfileCapability {
  id: string;
  executable: string;
  roots: readonly CompiledProfileRoot[];
  environmentKeys: readonly string[];
  backend: ProfileCapabilityBackend;
  operations: readonly string[];
}

export interface CompiledWorkstationProfile {
  profileId: string;
  profileRevision: number;
  roots: readonly CompiledProfileRoot[];
  environmentKeys: readonly string[];
  capabilities: readonly CompiledProfileCapability[];
  compiledAt: string;
}

export type WorkstationProfileCompileErrorCode =
  | "invalid_discovered_facts"
  | "discovered_root_not_allowed"
  | "discovered_environment_key_not_allowed"
  | "discovered_capability_not_allowed"
  | "discovered_capability_backend_mismatch"
  | "discovered_capability_root_not_allowed"
  | "discovered_capability_environment_key_not_allowed"
  | "discovered_capability_operation_not_allowed"
  | "forbidden_discovered_capability"
  | "invalid_compile_clock";

export type WorkstationProfileCompileResult =
  | { ok: true; compiled: CompiledWorkstationProfile }
  | { ok: false; error: { code: WorkstationProfileCompileErrorCode; message: string } };

export interface WorkstationProfileCompileOptions {
  /** Inject a clock for deterministic `compiledAt`. No disk or process access. */
  now?: Date;
}

// eslint-disable-next-line no-control-regex -- rejects control bytes in profile strings
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const ISO_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const PORT_VALUE = /^\d{1,5}$/;

const PROFILE_KEYS = new Set([
  "schemaVersion",
  "id",
  "revision",
  "name",
  "roots",
  "discoveryProviders",
  "environmentKeys",
  "executableRules",
  "network",
  "capabilities",
  "toolchainCapabilities",
  "protectedPolicyVersion",
  "createdAt",
  "updatedAt",
]);

const ROOT_RULE_KEYS = new Set(["path", "access"]);
const EXECUTABLE_RULE_KEYS = new Set(["id", "executable", "argv", "backend"]);
const NETWORK_POLICY_KEYS = new Set(["mode", "allow"]);
const NETWORK_RULE_KEYS = new Set(["id", "kind", "value"]);
const TOOLCHAIN_CAPABILITY_KEYS = new Set([
  "id",
  "kind",
  "discoveredFrom",
  "executable",
  "roots",
  "environmentKeys",
  "backend",
  "operations",
]);

type UnknownRecord = {
  schemaVersion?: unknown;
  id?: unknown;
  revision?: unknown;
  name?: unknown;
  roots?: unknown;
  discoveryProviders?: unknown;
  environmentKeys?: unknown;
  executableRules?: unknown;
  network?: unknown;
  capabilities?: unknown;
  toolchainCapabilities?: unknown;
  protectedPolicyVersion?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  path?: unknown;
  access?: unknown;
  executable?: unknown;
  argv?: unknown;
  backend?: unknown;
  mode?: unknown;
  allow?: unknown;
  kind?: unknown;
  value?: unknown;
  discoveredFrom?: unknown;
  operations?: unknown;
  sourceProvider?: unknown;
  [key: string]: unknown;
};

function fail(
  code: WorkstationProfileValidationErrorCode,
  message: string,
): WorkstationProfileValidationResult {
  return { ok: false, error: { code, message } };
}

function compileFail(
  code: WorkstationProfileCompileErrorCode,
  message: string,
): WorkstationProfileCompileResult {
  return { ok: false, error: { code, message } };
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(record: UnknownRecord, allowed: Set<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isSafeNonBlankString(value: unknown): value is string {
  return isNonBlankString(value) && !CONTROL_CHARACTER.test(value);
}

function containsForbiddenToken(value: string): boolean {
  const lower = value.toLowerCase();
  return FORBIDDEN_CAPABILITY_TOKENS.some((token) => lower.includes(token));
}

function parseUtcTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !ISO_UTC_TIMESTAMP.test(value)) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const canonical = date.toISOString();
  const match = /^(.{19})(?:\.(\d{1,3}))?Z$/.exec(value);
  const expectedCanonical = match ? `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z` : undefined;
  return canonical === expectedCanonical ? canonical : undefined;
}

function parseAccessOperations(value: unknown): readonly DesktopFilesystemAccessOperation[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (!value.every((operation) => isOneOf(operation, DESKTOP_FILESYSTEM_ACCESS_OPERATIONS))) return undefined;
  if (new Set(value as readonly string[]).size !== value.length) return undefined;
  return value as readonly DesktopFilesystemAccessOperation[];
}

/**
 * Canonicalizes an absolute root path and rejects the filesystem root, relative
 * input, traversal segments, and control bytes. The literal `/` guarded root
 * is reserved for a post-v1 broad-access mode and is never accepted here.
 */
function canonicalizeRootPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || CONTROL_CHARACTER.test(value)) {
    return undefined;
  }
  if (!path.isAbsolute(value)) return undefined;
  const normalized = path.normalize(value);
  if (normalized !== path.normalize(normalized)) return undefined;
  if (path.parse(normalized).root === normalized) return undefined;
  return normalized;
}

function parseRootRule(value: unknown): ProfileRootRule | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ROOT_RULE_KEYS)) return undefined;
  const canonical = canonicalizeRootPath(value.path);
  if (canonical === undefined) return undefined;
  const access = parseAccessOperations(value.access);
  if (access === undefined) return undefined;
  return { path: canonical, access };
}

function parseExecutableRule(value: unknown): ProfileExecutableRule | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, EXECUTABLE_RULE_KEYS)) return undefined;
  if (!isSafeNonBlankString(value.id)) return undefined;
  if (!isSafeNonBlankString(value.executable)) return undefined;
  if (!isStringArray(value.argv)) return undefined;
  if (value.argv.some((token) => CONTROL_CHARACTER.test(token))) return undefined;
  if (!isOneOf(value.backend, PROFILE_CAPABILITY_BACKENDS)) return undefined;
  return {
    id: value.id,
    executable: value.executable,
    argv: [...value.argv],
    backend: value.backend,
  };
}

function parseNetworkRule(value: unknown): ProfileNetworkRule | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, NETWORK_RULE_KEYS)) return undefined;
  if (!isSafeNonBlankString(value.id)) return undefined;
  if (!isOneOf(value.kind, PROFILE_NETWORK_RULE_KINDS)) return undefined;
  const raw = value.value;
  if (typeof raw !== "string" || raw.length === 0 || CONTROL_CHARACTER.test(raw)) return undefined;
  const kind = value.kind;
  if (kind === "port") {
    if (!PORT_VALUE.test(raw)) return undefined;
    const port = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return undefined;
  } else if (kind === "cidr") {
    if (!raw.includes("/") || raw.includes(" ")) return undefined;
  } else {
    if (raw.includes(" ")) return undefined;
  }
  return { id: value.id, kind, value: raw };
}

function parseNetworkPolicy(value: unknown): ProfileNetworkPolicy | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, NETWORK_POLICY_KEYS)) return undefined;
  if (!isOneOf(value.mode, PROFILE_NETWORK_MODES)) return undefined;
  if (!Array.isArray(value.allow)) return undefined;
  const rules: ProfileNetworkRule[] = [];
  for (const entry of value.allow) {
    const rule = parseNetworkRule(entry);
    if (rule === undefined) return undefined;
    rules.push(rule);
  }
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) return undefined;
  if (value.mode === "proxy_allowlist" && rules.length === 0) return undefined;
  return { mode: value.mode, allow: rules };
}

function parseToolchainCapability(value: unknown): ProfileToolchainCapability | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, TOOLCHAIN_CAPABILITY_KEYS)) return undefined;
  if (!isSafeNonBlankString(value.id)) return undefined;
  if (!isOneOf(value.kind, PROFILE_TOOLCHAIN_CAPABILITY_KINDS)) return undefined;
  if (!isOneOf(value.discoveredFrom, PROFILE_DISCOVERY_ORIGINS)) return undefined;
  if (!isSafeNonBlankString(value.executable)) return undefined;
  if (!isOneOf(value.backend, PROFILE_CAPABILITY_BACKENDS)) return undefined;
  if (!isStringArray(value.environmentKeys)) return undefined;
  if (value.environmentKeys.some((key) => !isNonBlankString(key))) return undefined;
  if (!isStringArray(value.operations)) return undefined;
  if (value.operations.some((op) => !isNonBlankString(op) || containsForbiddenToken(op))) {
    return undefined;
  }
  if (!Array.isArray(value.roots)) return undefined;
  const roots: ProfileRootRule[] = [];
  const seenRootPaths = new Set<string>();
  for (const entry of value.roots) {
    const rule = parseRootRule(entry);
    if (rule === undefined) return undefined;
    if (seenRootPaths.has(rule.path)) return undefined;
    seenRootPaths.add(rule.path);
    roots.push(rule);
  }
  const kind = value.kind;
  if ((kind === "docker_compose" || kind === "os_signing") && value.operations.length === 0) {
    return undefined;
  }
  return {
    id: value.id,
    kind,
    discoveredFrom: value.discoveredFrom,
    executable: value.executable,
    roots,
    environmentKeys: [...value.environmentKeys],
    backend: value.backend,
    operations: [...value.operations],
  };
}

/**
 * Parses a persisted Workstation Profile fail-closed.
 *
 * Lexical path normalization uses the host platform's `node:path` semantics.
 * Filesystem existence, symlink resolution, TCC, OS permissions, and any
 * enforcement decision are intentionally outside this schema gate.
 */
export function parseWorkstationProfile(
  value: unknown,
  options: WorkstationProfileValidationOptions = {},
): WorkstationProfileValidationResult {
  if (!isRecord(value)) {
    return fail("invalid_record", "workstation profile must be an object");
  }
  if (!hasOnlyKeys(value, PROFILE_KEYS)) {
    return fail("unknown_field", "workstation profile contains an unsupported field");
  }
  if (value.schemaVersion !== WORKSTATION_PROFILE_SCHEMA_VERSION) {
    return fail("unknown_schema_version", "workstation profile has an unsupported schema version");
  }
  if (!isSafeNonBlankString(value.id)) {
    return fail("invalid_id", "workstation profile id must be a non-empty opaque string");
  }
  const revision = value.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
    return fail("invalid_revision", "revision must be a positive safe integer");
  }
  if (!isSafeNonBlankString(value.name)) {
    return fail("invalid_name", "name must be a non-empty string without control characters");
  }

  if (!Array.isArray(value.roots)) {
    return fail("invalid_roots", "roots must be an array of root rules");
  }
  const roots: ProfileRootRule[] = [];
  const seenRootPaths = new Set<string>();
  for (const entry of value.roots) {
    const rule = parseRootRule(entry);
    if (rule === undefined) {
      return fail("invalid_root_path", "each root must be an absolute, traversal-free path with valid access");
    }
    if (seenRootPaths.has(rule.path)) {
      return fail("duplicate_root", "profile roots must not repeat a canonical path");
    }
    seenRootPaths.add(rule.path);
    roots.push(rule);
  }

  if (!Array.isArray(value.discoveryProviders)) {
    return fail("invalid_discovery_providers", "discoveryProviders must be an array of provider ids");
  }
  const discoveryProviders: ProfileDiscoveryProvider[] = [];
  const seenProviders = new Set<string>();
  for (const provider of value.discoveryProviders) {
    if (!isOneOf(provider, PROFILE_DISCOVERY_PROVIDERS)) {
      return fail("unknown_discovery_provider", "discoveryProviders contains an unknown provider id");
    }
    if (seenProviders.has(provider)) {
      return fail("duplicate_discovery_provider", "discoveryProviders must not repeat a provider id");
    }
    seenProviders.add(provider);
    discoveryProviders.push(provider);
  }

  if (!isStringArray(value.environmentKeys)) {
    return fail("invalid_environment_keys", "environmentKeys must be an array of non-empty strings");
  }
  const environmentKeys: string[] = [];
  const seenEnvKeys = new Set<string>();
  for (const key of value.environmentKeys) {
    if (!isNonBlankString(key) || CONTROL_CHARACTER.test(key)) {
      return fail("invalid_environment_keys", "environmentKeys must be an array of non-empty strings");
    }
    if (seenEnvKeys.has(key)) {
      return fail("duplicate_environment_key", "environmentKeys must not repeat a key");
    }
    seenEnvKeys.add(key);
    environmentKeys.push(key);
  }

  if (!Array.isArray(value.executableRules)) {
    return fail("invalid_executable_rules", "executableRules must be an array of executable rules");
  }
  const executableRules: ProfileExecutableRule[] = [];
  const seenExecutableIds = new Set<string>();
  for (const entry of value.executableRules) {
    const rule = parseExecutableRule(entry);
    if (rule === undefined) {
      return fail("invalid_executable_rule", "each executable rule must declare id, executable, argv, and an explicit backend");
    }
    if (seenExecutableIds.has(rule.id)) {
      return fail("duplicate_executable_rule_id", "executableRules must not repeat an id");
    }
    seenExecutableIds.add(rule.id);
    executableRules.push(rule);
  }

  const network = parseNetworkPolicy(value.network);
  if (network === undefined) {
    return fail("invalid_network", "network policy must declare a supported mode and well-formed allow rules");
  }

  if (!Array.isArray(value.capabilities)) {
    return fail("invalid_capabilities", "capabilities must be an array of supported capability flags");
  }
  const capabilities: ProfileCapability[] = [];
  const seenCapabilities = new Set<string>();
  for (const capability of value.capabilities) {
    if (!isOneOf(capability, PROFILE_CAPABILITIES)) {
      return fail("forbidden_capability", "capabilities contains an unsupported or escape capability");
    }
    if (seenCapabilities.has(capability)) {
      return fail("invalid_capabilities", "capabilities must not repeat a flag");
    }
    seenCapabilities.add(capability);
    capabilities.push(capability);
  }

  if (!Array.isArray(value.toolchainCapabilities)) {
    return fail("invalid_toolchain_capabilities", "toolchainCapabilities must be an array of typed capabilities");
  }
  const toolchainCapabilities: ProfileToolchainCapability[] = [];
  const seenCapabilityIds = new Set<string>();
  for (const entry of value.toolchainCapabilities) {
    const capability = parseToolchainCapability(entry);
    if (capability === undefined) {
      return fail(
        "missing_capability_backend",
        "each toolchain capability must declare an explicit backend, typed operations, and valid roots",
      );
    }
    if (seenCapabilityIds.has(capability.id)) {
      return fail("duplicate_toolchain_capability_id", "toolchainCapabilities must not repeat an id");
    }
    seenCapabilityIds.add(capability.id);
    toolchainCapabilities.push(capability);
  }

  const protectedPolicyVersion = value.protectedPolicyVersion;
  if (
    typeof protectedPolicyVersion !== "number" ||
    !Number.isSafeInteger(protectedPolicyVersion) ||
    protectedPolicyVersion < 1
  ) {
    return fail("invalid_protected_policy_version", "protectedPolicyVersion must be a positive safe integer");
  }

  const createdAt = parseUtcTimestamp(value.createdAt);
  if (createdAt === undefined) {
    return fail("invalid_created_at", "createdAt must be a valid UTC ISO-8601 timestamp");
  }
  const updatedAt = parseUtcTimestamp(value.updatedAt);
  if (updatedAt === undefined) {
    return fail("invalid_updated_at", "updatedAt must be a valid UTC ISO-8601 timestamp");
  }
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    return fail("invalid_updated_at", "updatedAt must be on or after createdAt");
  }

  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) {
    return fail("invalid_record", "validation clock must be a valid date");
  }

  return {
    ok: true,
    profile: {
      schemaVersion: WORKSTATION_PROFILE_SCHEMA_VERSION,
      id: value.id,
      revision,
      name: value.name,
      roots,
      discoveryProviders,
      environmentKeys,
      executableRules,
      network,
      capabilities,
      toolchainCapabilities,
      protectedPolicyVersion,
      createdAt,
      updatedAt,
    },
  };
}

// ── Compile ─────────────────────────────────────────────────────────────────

function isDiscoveredRoot(value: unknown): value is DiscoveredProfileRoot {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, new Set(["path", "access", "sourceProvider"]))) return false;
  if (canonicalizeRootPath(value.path) === undefined) return false;
  if (parseAccessOperations(value.access) === undefined) return false;
  if (value.sourceProvider !== undefined && !isSafeNonBlankString(value.sourceProvider)) return false;
  return true;
}

function isDiscoveredCapability(value: unknown): value is DiscoveredProfileCapability {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, TOOLCHAIN_CAPABILITY_KEYS)) return false;
  if (!isSafeNonBlankString(value.id)) return false;
  if (!isSafeNonBlankString(value.executable)) return false;
  if (!isOneOf(value.backend, PROFILE_CAPABILITY_BACKENDS)) return false;
  if (!isStringArray(value.environmentKeys)) return false;
  if (value.environmentKeys.some((key) => !isNonBlankString(key) || CONTROL_CHARACTER.test(key))) return false;
  if (!isStringArray(value.operations)) return false;
  if (value.operations.some((op) => !isNonBlankString(op) || containsForbiddenToken(op))) return false;
  if (!Array.isArray(value.roots)) return false;
  for (const entry of value.roots) {
    if (!isDiscoveredRoot(entry)) return false;
  }
  return true;
}

function isDiscoveredFacts(value: unknown): value is DiscoveredWorkstationFacts {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, new Set(["roots", "environmentKeys", "capabilities"]))) return false;
  if (!Array.isArray(value.roots)) return false;
  for (const entry of value.roots) {
    if (!isDiscoveredRoot(entry)) return false;
  }
  if (!isStringArray(value.environmentKeys)) return false;
  if (value.environmentKeys.some((key) => !isNonBlankString(key) || CONTROL_CHARACTER.test(key))) return false;
  if (!Array.isArray(value.capabilities)) return false;
  for (const entry of value.capabilities) {
    if (!isDiscoveredCapability(entry)) return false;
  }
  return true;
}

function accessIsSubsetOf(
  candidate: readonly DesktopFilesystemAccessOperation[],
  allowed: readonly DesktopFilesystemAccessOperation[],
): boolean {
  return candidate.every((operation) => allowed.includes(operation));
}

function rootAllowedByRule(
  candidatePath: string,
  candidateAccess: readonly DesktopFilesystemAccessOperation[],
  rule: ProfileRootRule,
): boolean {
  return (
    isPathWithinDesktopFilesystemGrantRoot(rule.path, candidatePath) &&
    accessIsSubsetOf(candidateAccess, rule.access)
  );
}

/**
 * Compiles a validated profile against canonical discovered concrete facts.
 *
 * Pure and side-effect-free: it does not inspect disk, execute processes, or
 * mint grants. Any discovered root, environment key, or capability not already
 * authorized by the bound profile is rejected — discovery never creates
 * authority. The caller persists or activates the result; this function only
 * computes the contained intersection.
 */
export function compileWorkstationProfile(
  profile: WorkstationProfile,
  facts: unknown,
  options: WorkstationProfileCompileOptions = {},
): WorkstationProfileCompileResult {
  if (!isDiscoveredFacts(facts)) {
    return compileFail("invalid_discovered_facts", "discovered facts must be canonical concrete roots, env keys, and capabilities");
  }

  for (const root of facts.roots) {
    const canonical = canonicalizeRootPath(root.path) ?? root.path;
    const allowed = profile.roots.some((rule) => rootAllowedByRule(canonical, root.access, rule));
    if (!allowed) {
      return compileFail(
        "discovered_root_not_allowed",
        "a discovered root is not within any profile root rule with sufficient access",
      );
    }
  }

  for (const key of facts.environmentKeys) {
    if (!profile.environmentKeys.includes(key)) {
      return compileFail(
        "discovered_environment_key_not_allowed",
        "a discovered environment key is not declared by the profile",
      );
    }
  }

  const compiledCapabilities: CompiledProfileCapability[] = [];
  for (const discovered of facts.capabilities) {
    const spec = profile.toolchainCapabilities.find((entry) => entry.id === discovered.id);
    if (spec === undefined) {
      return compileFail(
        "discovered_capability_not_allowed",
        "a discovered capability id is not declared by the profile",
      );
    }
    if (discovered.backend !== spec.backend) {
      return compileFail(
        "discovered_capability_backend_mismatch",
        "a discovered capability backend does not match the profile declaration",
      );
    }
    if (spec.operations.length > 0) {
      const everyOpAllowed = discovered.operations.every((op) => spec.operations.includes(op));
      if (!everyOpAllowed) {
        return compileFail(
          "discovered_capability_operation_not_allowed",
          "a discovered capability operation is not declared by the profile",
        );
      }
    }
    for (const key of discovered.environmentKeys) {
      if (!spec.environmentKeys.includes(key)) {
        return compileFail(
          "discovered_capability_environment_key_not_allowed",
          "a discovered capability environment key is not declared by the profile",
        );
      }
    }
    const compiledRoots: CompiledProfileRoot[] = [];
    for (const root of discovered.roots) {
      const canonical = canonicalizeRootPath(root.path) ?? root.path;
      const allowed = spec.roots.some((rule) => rootAllowedByRule(canonical, root.access, rule));
      if (!allowed) {
        return compileFail(
          "discovered_capability_root_not_allowed",
          "a discovered capability root is not within any profile-declared capability root with sufficient access",
        );
      }
      compiledRoots.push({
        path: canonical,
        access: [...root.access],
        ...(root.sourceProvider !== undefined ? { sourceProvider: root.sourceProvider } : {}),
      });
    }
    compiledCapabilities.push({
      id: discovered.id,
      executable: discovered.executable,
      roots: compiledRoots,
      environmentKeys: [...discovered.environmentKeys],
      backend: discovered.backend,
      operations: [...discovered.operations],
    });
  }

  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) {
    return compileFail("invalid_compile_clock", "compile clock must be a valid date");
  }

  const compiledRoots: CompiledProfileRoot[] = facts.roots.map((root) => {
    const canonical = canonicalizeRootPath(root.path) ?? root.path;
    return {
      path: canonical,
      access: [...root.access],
      ...(root.sourceProvider !== undefined ? { sourceProvider: root.sourceProvider } : {}),
    };
  });

  return {
    ok: true,
    compiled: {
      profileId: profile.id,
      profileRevision: profile.revision,
      roots: compiledRoots,
      environmentKeys: [...facts.environmentKeys],
      capabilities: compiledCapabilities,
      compiledAt: now.toISOString(),
    },
  };
}
