import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";

import {
  resolveNautiloSshConnection,
  type NautiloSshConnection,
  type NautiloSshConnectionResult,
  type StructuredSshConnectionSourceKind,
} from "./connection-catalog.ts";
import {
  resolveOpenSshFiniteAlias,
  type OpenSshConnectionIndexResult,
} from "./open-ssh-connection-index.ts";
import { SYSTEM_OPENSSH_PATHS, type StructuredSshProcessResult } from "./process-runner.ts";

const OPEN_SSH_PLAN_ENVIRONMENT = Object.freeze({ PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" });
const OPEN_SSH_PLAN_TIMEOUT_MS = 5_000;
const OPEN_SSH_PLAN_MAX_STDOUT_BYTES = 64 * 1024;
const OPEN_SSH_PLAN_MAX_STDERR_BYTES = 8 * 1024;
const MAX_INTENT_HOST_BYTES = 253;
const MAX_INTENT_USER_BYTES = 64;
const MAX_CONFIG_LINES = 512;
const MAX_CONFIG_LINE_BYTES = 8 * 1024;
/** One shared resolver/broker ceiling for locally observed OpenSSH identities. */
export const OPEN_SSH_PLAN_MAX_IDENTITY_FILES = 64;
const MAX_KNOWN_HOST_FILES = 32;
const MAX_PATH_BYTES = 4 * 1024;

const HOST_ALIAS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const REMOTE_USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const NAMED_USER_SENTINEL_PREFIX = "__nautilo_probe_";
export const OPEN_SSH_NAMED_CONNECTION_PROBE_SENTINEL = new RegExp(`^${NAMED_USER_SENTINEL_PREFIX}[a-f0-9]{32}$`);
/** Creates an Electron-local, non-returned fallback User for one named probe. */
function createOpenSshNamedConnectionProbe(): { readonly sentinel: string; readonly stdin: string } {
  const sentinel = `${NAMED_USER_SENTINEL_PREFIX}${randomBytes(16).toString("hex")}`;
  return Object.freeze({ sentinel, stdin: `Include ~/.ssh/config\nHost *\n  User ${sentinel}\n` });
}
const UNSAFE_DIRECTIVES = Object.freeze({
  proxycommand: new Set(["none"]), proxyjump: new Set(["none"]), forwardagent: new Set(["no", "false"]),
  permitlocalcommand: new Set(["no", "false"]), localcommand: new Set(["none"]), localforward: new Set(["none"]),
  remoteforward: new Set(["none"]), dynamicforward: new Set(["none"]), canonicalizehostname: new Set(["no", "false"]),
  controlmaster: new Set(["no", "false"]), controlpath: new Set(["none"]), remotecommand: new Set(["none"]), knownhostscommand: new Set(["none"]),
} as const);
type SafetyDirective = keyof typeof UNSAFE_DIRECTIVES;

export type OpenSshDestinationIntent =
  | { readonly connection: string; readonly host?: undefined; readonly user?: undefined; readonly port?: undefined }
  | { readonly host: string; readonly user: string; readonly port?: number | undefined; readonly connection?: undefined };

/** This runner admits one fixed Apple binary invocation; it has no shell API. */
export interface OpenSshPlanRunnerInput {
  readonly executable: typeof SYSTEM_OPENSSH_PATHS.ssh;
  readonly argv: readonly string[];
  readonly stdin?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly signal?: AbortSignal;
}
export interface OpenSshPlanRunner { (input: OpenSshPlanRunnerInput): Promise<StructuredSshProcessResult>; }
export interface ResolveOpenSshDestinationPlanDependencies {
  readonly run: OpenSshPlanRunner;
  readonly signal?: AbortSignal;
  readonly resolveNautiloConnection?: (reference: string) => Promise<NautiloSshConnectionResult>;
  readonly resolveOpenSshConnection?: (reference: string) => Promise<OpenSshConnectionIndexResult>;
}
export type OpenSshIdentitySourceKind = "file" | "agent";
export type OpenSshPrivateIdentitySource =
  | { readonly kind: "file"; readonly identityFile: string }
  | { readonly kind: "agent"; readonly identityAgent: string | null };
export interface OpenSshDestinationPlan {
  readonly destination: { readonly host: string; readonly remoteUser: string; readonly port: number };
  readonly identitySources: readonly OpenSshPrivateIdentitySource[];
  readonly knownHostFiles: readonly string[];
  readonly safetyDirectives: Readonly<Record<SafetyDirective, string>>;
}
export interface OpenSshDestinationPlanSummary {
  readonly destination: OpenSshDestinationPlan["destination"];
  readonly connectionSource: { readonly kind: StructuredSshConnectionSourceKind; readonly name?: string };
  readonly identitySourceCount: number;
  readonly identitySourceKinds: readonly OpenSshIdentitySourceKind[];
  readonly knownHostFileCount: number;
}
export type OpenSshPlanRecovery = "correct_destination" | "provide_remote_user" | "choose_connection" | "repair_connection_source" | "reduce_connection_catalog" | "retry";
export type OpenSshPlanFailurePhase = "intent" | "resolve" | "parse" | "policy" | "catalog";
export type OpenSshPlanFailureCode =
  | "invalid_destination" | "invalid_host" | "invalid_remote_user" | "invalid_port"
  | "connection_not_found" | "connection_ambiguous" | "connection_catalog_malformed"
  | "connection_catalog_unreadable" | "connection_catalog_overflow" | "connection_catalog_unavailable" | "remote_user_missing"
  | "openssh_connection_catalog_unreadable" | "openssh_connection_catalog_malformed" | "openssh_connection_catalog_overflow"
  | "openssh_connection_catalog_unsupported_match" | "openssh_connection_catalog_unsupported_source"
  | "resolve_aborted" | "resolve_spawn_failed" | "resolve_timed_out" | "resolve_output_limited" | "resolve_failed"
  | "config_output_invalid" | "config_required_value_missing" | "config_value_invalid" | "config_unsafe_directive" | "config_destination_mismatch";
export interface OpenSshPlanFailure {
  readonly phase: OpenSshPlanFailurePhase; readonly code: OpenSshPlanFailureCode; readonly retrySafe: true; readonly sideEffectStarted: false; readonly stateChanged: false; readonly recovery: OpenSshPlanRecovery;
  readonly source?: "openssh" | "nautilo-profile";
  readonly observed?: { readonly files: number; readonly records: number; readonly bytes: number };
  readonly configuredBounds?: { readonly files?: number; readonly records?: number; readonly bytes?: number; readonly includeDepth?: number };
  readonly completeness?: false;
  readonly candidates?: readonly { readonly source: "openssh" | "nautilo-profile"; readonly name: string }[];
}
export type ResolveOpenSshDestinationPlanResult =
  | { readonly ok: true; readonly intent: OpenSshDestinationIntent; readonly plan: OpenSshDestinationPlan; readonly summary: OpenSshDestinationPlanSummary; /** Electron-private fingerprint of all selected plan semantics. */ readonly semanticFingerprint: string }
  | { readonly ok: false; readonly failure: OpenSshPlanFailure };
function recoveryFor(code: OpenSshPlanFailureCode): OpenSshPlanRecovery {
  if (code === "connection_not_found" || code === "connection_ambiguous") return "choose_connection";
  if (code === "remote_user_missing") return "provide_remote_user";
  if (code.includes("catalog_overflow")) return "reduce_connection_catalog";
  if (code.includes("catalog_") || code === "connection_catalog_unavailable") return "repair_connection_source";
  if (code.startsWith("invalid_") || code === "config_destination_mismatch") return "correct_destination";
  return "retry";
}
function failure(phase: OpenSshPlanFailurePhase, code: OpenSshPlanFailureCode, extra: Omit<OpenSshPlanFailure, "phase" | "code" | "retrySafe" | "sideEffectStarted" | "stateChanged" | "recovery"> = {}): ResolveOpenSshDestinationPlanResult {
  return { ok: false, failure: { phase, code, retrySafe: true, sideEffectStarted: false, stateChanged: false, recovery: recoveryFor(code), ...extra } };
}

function hasControl(value: string): boolean { return /[\0\r\n]/.test(value); }
function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maximum && !hasControl(value);
}
function canonicalHost(value: unknown): string | null {
  if (!isBoundedText(value, MAX_INTENT_HOST_BYTES) || value !== value.trim() || value.startsWith("-") || /[\s@]/.test(value)) return null;
  const lower = value.toLowerCase();
  if (isIP(lower) === 4) return lower.split(".").every((part) => String(Number(part)) === part && Number(part) <= 255) ? lower : null;
  if (isIP(lower) === 6) return lower.includes("%") ? null : lower;
  return !lower.endsWith(".") && lower.split(".").every((label) => HOST_ALIAS_LABEL.test(label)) ? lower : null;
}
function canonicalRemoteUser(value: unknown): string | null { return isBoundedText(value, MAX_INTENT_USER_BYTES) && REMOTE_USER.test(value) ? value : null; }
function canonicalPort(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 65_535 ? value : null; }
function safeConfigPath(value: string): boolean { return isBoundedText(value, MAX_PATH_BYTES) && value !== "none" && !/[\t ]/.test(value); }

function processFailure(result: StructuredSshProcessResult): ResolveOpenSshDestinationPlanResult | null {
  if (result.termination === "aborted") return failure("resolve", "resolve_aborted");
  if (result.termination === "spawn_failed") return failure("resolve", "resolve_spawn_failed");
  if (result.termination === "timed_out") return failure("resolve", "resolve_timed_out");
  if (result.termination === "stdout_limit" || result.termination === "stderr_limit") return failure("resolve", "resolve_output_limited");
  return result.termination !== "exited" || result.code !== 0 ? failure("resolve", "resolve_failed") : null;
}
type ParsedConfig = ReadonlyMap<string, readonly string[]>;
function parseConfig(stdout: string): ParsedConfig | null {
  if (Buffer.byteLength(stdout, "utf8") > OPEN_SSH_PLAN_MAX_STDOUT_BYTES || hasControl(stdout.replaceAll("\n", ""))) return null;
  const lines = stdout.split("\n");
  if (lines.length > MAX_CONFIG_LINES + 1) return null;
  const parsed = new Map<string, string[]>();
  for (const line of lines) {
    if (line.length === 0) continue;
    if (Buffer.byteLength(line, "utf8") > MAX_CONFIG_LINE_BYTES || hasControl(line)) return null;
    const separator = line.indexOf(" ");
    if (separator <= 0 || separator === line.length - 1) return null;
    const rawKey = line.slice(0, separator); const value = line.slice(separator + 1);
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(rawKey) || !isBoundedText(value, MAX_CONFIG_LINE_BYTES)) return null;
    const key = rawKey.toLowerCase(); const values = parsed.get(key) ?? [];
    values.push(value); if (values.length > OPEN_SSH_PLAN_MAX_IDENTITY_FILES) return null; parsed.set(key, values);
  }
  return parsed;
}
function oneValue(config: ParsedConfig, key: string): string | null { const values = config.get(key); return values?.length === 1 ? values[0]! : null; }
function optionalOneValue(config: ParsedConfig, key: string): string | null | undefined { const values = config.get(key); return values === undefined ? undefined : values.length === 1 ? values[0]! : null; }
function paths(config: ParsedConfig, key: "identityfile" | "userknownhostsfile" | "globalknownhostsfile", maximum: number): string[] | null {
  const result: string[] = [];
  for (const value of config.get(key) ?? []) {
    if (value === "none") continue;
    const entries = key === "identityfile" ? [value] : value.split(" ");
    if (entries.some((entry) => !safeConfigPath(entry))) return null;
    result.push(...entries); if (result.length > maximum) return null;
  }
  return result;
}
function planFromConfig(
  config: ParsedConfig,
  intent: OpenSshDestinationIntent,
  connectionSource: OpenSshDestinationPlanSummary["connectionSource"],
  profile?: NautiloSshConnection,
  expectedDestination?: { readonly host: string; readonly remoteUser: string; readonly port: number },
): ResolveOpenSshDestinationPlanResult {
  const host = oneValue(config, "hostname"); const remoteUser = oneValue(config, "user"); const portText = oneValue(config, "port");
  if (host === null || remoteUser === null || portText === null) return failure("parse", "config_required_value_missing");
  const destinationHost = canonicalHost(host); const destinationUser = canonicalRemoteUser(remoteUser); const destinationPort = /^\d{1,5}$/.test(portText) ? canonicalPort(Number(portText)) : null;
  if (destinationHost === null || destinationUser === null || destinationPort === null) return failure("parse", "config_value_invalid");
  if (expectedDestination !== undefined && (destinationHost !== expectedDestination.host || destinationUser !== expectedDestination.remoteUser || destinationPort !== expectedDestination.port)) {
    return failure("policy", "config_destination_mismatch");
  }
  const safety = {} as Record<SafetyDirective, string>;
  for (const [directive, safeValues] of Object.entries(UNSAFE_DIRECTIVES) as [SafetyDirective, ReadonlySet<string>][]) {
    const value = optionalOneValue(config, directive); if (value === null) return failure("parse", "config_value_invalid");
    const normalized = value === undefined ? [...safeValues][0]! : value.toLowerCase();
    if (!safeValues.has(normalized)) return failure("policy", "config_unsafe_directive"); safety[directive] = normalized;
  }
  const identityFiles = paths(config, "identityfile", OPEN_SSH_PLAN_MAX_IDENTITY_FILES); const userKnownHosts = paths(config, "userknownhostsfile", MAX_KNOWN_HOST_FILES); const globalKnownHosts = paths(config, "globalknownhostsfile", MAX_KNOWN_HOST_FILES);
  if (identityFiles === null || userKnownHosts === null || globalKnownHosts === null) return failure("parse", "config_value_invalid");
  const identityAgent = optionalOneValue(config, "identityagent");
  if (identityAgent === null || (identityAgent !== undefined && !isBoundedText(identityAgent, MAX_PATH_BYTES))) return failure("parse", "config_value_invalid");
  const identitySources: OpenSshPrivateIdentitySource[] = profile === undefined
    ? identityFiles.map((identityFile) => ({ kind: "file" as const, identityFile }))
    : profile.identityFile === undefined ? [] : [{ kind: "file" as const, identityFile: profile.identityFile }];
  if (profile === undefined && identityAgent === undefined) identitySources.push({ kind: "agent", identityAgent: null });
  else if (profile === undefined && identityAgent !== undefined && identityAgent.toLowerCase() !== "none") identitySources.push({ kind: "agent", identityAgent });
  const knownHostFiles = profile === undefined
    ? [...userKnownHosts, ...globalKnownHosts]
    : profile.knownHostsFile === undefined ? [] : [profile.knownHostsFile];
  const plan: OpenSshDestinationPlan = Object.freeze({ destination: Object.freeze({ host: destinationHost, remoteUser: destinationUser, port: destinationPort }), identitySources: Object.freeze(identitySources), knownHostFiles: Object.freeze(knownHostFiles), safetyDirectives: Object.freeze(safety) });
  const identitySourceKinds = [...new Set(identitySources.map((source) => source.kind))].sort() as OpenSshIdentitySourceKind[];
  const summary = Object.freeze({ destination: plan.destination, connectionSource: Object.freeze({ ...connectionSource }), identitySourceCount: identitySources.length, identitySourceKinds: Object.freeze(identitySourceKinds), knownHostFileCount: plan.knownHostFiles.length });
  return { ok: true, intent: Object.freeze({ ...intent }) as OpenSshDestinationIntent, plan, summary, semanticFingerprint: openSshPlanSemanticFingerprint(plan, summary.connectionSource) };
}

/** Never cross the relay boundary: paths and safety facts are only SHA-256 input. */
function openSshPlanSemanticFingerprint(
  plan: OpenSshDestinationPlan,
  connectionSource: OpenSshDestinationPlanSummary["connectionSource"],
): string {
  return createHash("sha256").update(JSON.stringify({
    destination: plan.destination,
    connectionSource,
    identitySources: plan.identitySources,
    knownHostFiles: plan.knownHostFiles,
    safetyDirectives: plan.safetyDirectives,
  }), "utf8").digest("hex");
}

async function observeConfig(run: OpenSshPlanRunner, argv: readonly string[], signal: AbortSignal | undefined, stdin?: string): Promise<ParsedConfig | ResolveOpenSshDestinationPlanResult> {
  let result: StructuredSshProcessResult;
  try { result = await run({ executable: SYSTEM_OPENSSH_PATHS.ssh, argv, ...(stdin === undefined ? {} : { stdin }), env: OPEN_SSH_PLAN_ENVIRONMENT, timeoutMs: OPEN_SSH_PLAN_TIMEOUT_MS, maxStdoutBytes: OPEN_SSH_PLAN_MAX_STDOUT_BYTES, maxStderrBytes: OPEN_SSH_PLAN_MAX_STDERR_BYTES, ...(signal === undefined ? {} : { signal }) }); }
  catch { return failure("resolve", "resolve_spawn_failed"); }
  const failed = processFailure(result); if (failed !== null) return failed;
  return parseConfig(result.stdout) ?? failure("parse", "config_output_invalid");
}
function isResult(value: ParsedConfig | ResolveOpenSshDestinationPlanResult): value is ResolveOpenSshDestinationPlanResult { return "ok" in value; }
/**
 * Resolves strict local intent only. Ad hoc endpoints never read either named
 * catalog, and ssh -G may only confirm their exact requested destination.
 */
export async function resolveOpenSshDestinationPlan(
  rawIntent: unknown,
  dependencies: ResolveOpenSshDestinationPlanDependencies,
): Promise<ResolveOpenSshDestinationPlanResult> {
  if (dependencies.signal?.aborted) return failure("resolve", "resolve_aborted");
  const value = rawIntent !== null && typeof rawIntent === "object" && !Array.isArray(rawIntent) ? rawIntent as Record<string, unknown> : null;
  if (value === null) return failure("intent", "invalid_destination");
  const keys = Object.keys(value).sort();
  const isNamed = keys.length === 1 && keys[0] === "connection";
  const isAdHoc = keys.length >= 2 && keys.length <= 3 && keys.every((key) => key === "host" || key === "user" || key === "port") && "host" in value && "user" in value;
  if (!isNamed && !isAdHoc) return failure("intent", "invalid_destination");
  if (isAdHoc) {
    const host = canonicalHost(value["host"]); const remoteUser = canonicalRemoteUser(value["user"]); const port = value["port"] === undefined ? undefined : canonicalPort(value["port"]);
    if (host === null) return failure("intent", "invalid_host"); if (remoteUser === null) return failure("intent", "invalid_remote_user"); if (port === null) return failure("intent", "invalid_port");
    const intent: OpenSshDestinationIntent = Object.freeze({ host, user: remoteUser, ...(port === undefined ? {} : { port }) });
    const config = await observeConfig(dependencies.run, Object.freeze(["-G", "-l", remoteUser, ...(port === undefined ? [] : ["-p", String(port)]), "--", host]), dependencies.signal);
    return isResult(config) ? config : planFromConfig(config, intent, { kind: "explicit" }, undefined, { host, remoteUser, port: port ?? 22 });
  }
  const reference = canonicalHost(value["connection"]); if (reference === null) return failure("intent", "invalid_destination");
  const intent: OpenSshDestinationIntent = Object.freeze({ connection: reference });
  const resolveOpenSsh = dependencies.resolveOpenSshConnection ?? resolveOpenSshFiniteAlias;
  const resolveProfiles = dependencies.resolveNautiloConnection ?? resolveNautiloSshConnection;
  let index: OpenSshConnectionIndexResult;
  let profiles: NautiloSshConnectionResult;
  try { [index, profiles] = await Promise.all([resolveOpenSsh(reference), resolveProfiles(reference)]); }
  catch { return failure("catalog", "connection_catalog_unavailable"); }
  if (!index.ok) return failure("catalog", index.code, {
    source: "openssh", observed: { files: index.observed.configFiles, records: index.observed.hostRecords, bytes: index.observed.bytes },
    ...(index.configuredBound === undefined ? {} : { configuredBounds: {
      ...(index.configuredBound.configFiles === undefined ? {} : { files: index.configuredBound.configFiles }),
      ...(index.configuredBound.hostRecords === undefined ? {} : { records: index.configuredBound.hostRecords }),
      ...(index.configuredBound.bytes === undefined ? {} : { bytes: index.configuredBound.bytes }),
      ...(index.configuredBound.includeDepth === undefined ? {} : { includeDepth: index.configuredBound.includeDepth }),
    } }), completeness: false,
  });
  if (!profiles.ok) return failure("catalog", profiles.code, {
    source: "nautilo-profile", observed: { files: profiles.observed.profileFiles, records: profiles.observed.matchingProfiles, bytes: profiles.observed.bytes },
    ...(profiles.configuredBound === undefined ? {} : { configuredBounds: {
      ...(profiles.configuredBound.profileFiles === undefined ? {} : { files: profiles.configuredBound.profileFiles }),
      ...(profiles.configuredBound.profileBytes === undefined ? {} : { bytes: profiles.configuredBound.profileBytes }),
    } }), completeness: false,
  });
  const candidates = index.records.length + profiles.connections.length;
  if (candidates === 0) return failure("catalog", "connection_not_found");
  if (candidates > 1) return failure("catalog", "connection_ambiguous", {
    source: index.records.length > 0 ? "openssh" : "nautilo-profile",
    observed: { files: index.observed.configFiles + profiles.observed.profileFiles, records: index.records.length + profiles.connections.length, bytes: index.observed.bytes + (Number.isSafeInteger(profiles.observed.bytes) ? profiles.observed.bytes : 0) },
    completeness: false,
    candidates: Object.freeze([
      ...index.records.map(() => ({ source: "openssh" as const, name: reference })),
      ...profiles.connections.map((connection) => ({ source: "nautilo-profile" as const, name: connection.source.name })),
    ].slice(0, 16)),
  });
  if (index.records.length === 1) {
    const probe = createOpenSshNamedConnectionProbe();
    const config = await observeConfig(dependencies.run, Object.freeze(["-G", "-F", "/dev/stdin", "--", reference]), dependencies.signal, probe.stdin);
    if (isResult(config)) return config;
    // This is provenance, not a value-difference guess: the finite index
    // proved the declaration and only its randomly generated fallback means
    // no applicable User was configured by OpenSSH.
    if (oneValue(config, "user") === probe.sentinel) return failure("resolve", "remote_user_missing");
    return planFromConfig(config, intent, { kind: "openssh", name: reference });
  }
  const profile = profiles.connections[0]!;
  const profileConfig = await observeConfig(dependencies.run, Object.freeze(["-G", "-l", profile.destination.remoteUser, "-p", String(profile.destination.port), "--", profile.destination.host]), dependencies.signal);
  if (isResult(profileConfig)) return profileConfig;
  return planFromConfig(profileConfig, intent, { kind: "nautilo-profile", name: profile.source.name }, profile, profile.destination);
}
