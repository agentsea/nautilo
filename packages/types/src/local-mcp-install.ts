/**
 * D503 Wave 1 — canonical, secret-free local MCP install contract.
 *
 * This module is deliberately browser-safe: the Workbench renders the same
 * preview that the server approves, while the server remains the only place
 * that binds a proposal to an actor, relay, and live prerequisite result.
 */

export const LOCAL_MCP_INSTALL_VERSION = "local-mcp-install-v1" as const;
export const LOCAL_MCP_INSTALL_DIGEST_DOMAIN = "nautilo.local-mcp-install.v1\0";

export type LocalMcpInstallFailureCode =
  | "invalid_request"
  | "approval_stale"
  | "relay_unavailable"
  | "relay_protocol_unsupported"
  | "missing_launcher"
  | "missing_environment"
  | "install_in_progress"
  | "spawn_failed"
  | "protocol_failed"
  | "discovery_timeout"
  | "empty_toolset"
  | "rollback_unconfirmed"
  | "internal";

export interface LocalMcpInstallFailure {
  readonly code: LocalMcpInstallFailureCode;
  readonly retryable: boolean;
  /** Fixed safe recovery guidance — never stderr, paths, URLs, or secrets. */
  readonly recovery: string;
}

export type LocalMcpInstallTransportIntent =
  | {
      readonly kind: "stdio";
      readonly command: string;
      /** Direct argv only. Order is semantically meaningful and preserved. */
      readonly args: readonly string[];
    }
  | {
      readonly kind: "streamable-http";
      readonly url: string;
    };

/** The only install proposal the model may make. It cannot contain headers or values. */
export interface LocalMcpInstallModelIntent {
  readonly version: typeof LOCAL_MCP_INSTALL_VERSION;
  readonly name: string;
  readonly relayId?: string | undefined;
  readonly transport: LocalMcpInstallTransportIntent;
  /** Authoritative documentation URL. Display provenance is server-derived. */
  readonly source?: {
    readonly url?: string | undefined;
  } | undefined;
  /** Evidence from authoritative docs. It is descriptive, never executable. */
  readonly package?: {
    readonly name: string;
    readonly version?: string | undefined;
  } | undefined;
  /** NAMES only. Values remain on the selected Desktop. */
  readonly environment?: readonly string[] | undefined;
}

export interface LocalMcpInstallSourceProvenance {
  readonly label: string;
  readonly url?: string | undefined;
}

export interface LocalMcpInstallPackageEvidence {
  readonly name: string;
  readonly version?: string | undefined;
}

export type LocalMcpInstallTransport =
  | {
      readonly kind: "stdio";
      readonly command: string;
      readonly args: readonly string[];
    }
  | {
      readonly kind: "streamable-http";
      readonly url: string;
    };

export interface LocalMcpInstallEnvironmentRequirement {
  readonly name: string;
  /** Unknown until the selected relay's preflight; never carries a value. */
  readonly present: boolean | null;
}

/** Server-canonical launch request. The actor/relay fields are server-owned. */
export interface LocalMcpInstallRequest {
  readonly version: typeof LOCAL_MCP_INSTALL_VERSION;
  readonly actorId: string;
  readonly relayId: string;
  /** Server-observed Desktop session identity, never model input. */
  readonly deviceSessionId: string;
  readonly name: string;
  readonly transport: LocalMcpInstallTransport;
  readonly source: LocalMcpInstallSourceProvenance;
  readonly package: LocalMcpInstallPackageEvidence | null;
  readonly mayDownloadOnFirstRun: boolean;
  readonly unpinnedPackage: boolean;
  readonly environment: readonly LocalMcpInstallEnvironmentRequirement[];
  readonly availability: "personal";
  readonly availabilitySummary: string;
  /** `null` means the HTTP transport launches no local subprocess. */
  readonly subprocessSandboxed: false | null;
  readonly digest: string;
}

export interface LocalMcpInstallApprovalPreview {
  readonly version: typeof LOCAL_MCP_INSTALL_VERSION;
  readonly human: string;
  readonly machine: string;
  readonly relayId: string;
  readonly name: string;
  readonly transport: LocalMcpInstallTransport;
  readonly source: LocalMcpInstallSourceProvenance;
  readonly package: LocalMcpInstallPackageEvidence | null;
  readonly mayDownloadOnFirstRun: boolean;
  readonly unpinnedPackage: boolean;
  readonly environment: readonly LocalMcpInstallEnvironmentRequirement[];
  readonly availabilitySummary: string;
  readonly subprocessSandboxed: false | null;
  readonly digest: string;
}

/** Opaque server preparation associated with one tool call and approval checkpoint. */
export interface LocalMcpInstallApprovalBinding {
  readonly version: typeof LOCAL_MCP_INSTALL_VERSION;
  readonly approvalId: string;
  /** Graph checkpoint/thread that emitted this exact approval. */
  readonly threadId: string;
  /** Delivery lane expected by the reply route. */
  readonly laneKey: string;
  readonly toolCallId: string;
  readonly checkpointKey: string;
  readonly digest: string;
}

export interface LocalMcpInstallPrepared {
  readonly binding: LocalMcpInstallApprovalBinding;
  readonly request: LocalMcpInstallRequest;
  readonly preview: LocalMcpInstallApprovalPreview;
}

export interface LocalMcpInstallResult {
  readonly ok: boolean;
  readonly name: string;
  readonly relayId: string;
  readonly digest: string;
  readonly toolNames?: readonly string[] | undefined;
  readonly failure?: LocalMcpInstallFailure | undefined;
}

export class LocalMcpInstallValidationError extends Error {
  readonly code = "invalid_request" as const;
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SHELLISH_COMMAND = /[\s;&|`$<>\n\r]/;
const SECRET_SHAPED = /(?:^|[^A-Za-z0-9])(ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|(?:basic|bearer)\s+\S+|authorization\s*[:=]|(?:token|secret|password|credential|api[_-]?key)\s*[:=])/i;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const ENV_VALUE_FLAG = /^(?:--(?:env|environment)(?:=|$)|-e(?:[A-Za-z_][A-Za-z0-9_]*=|$))/i;
const SECRET_ARGUMENT = /^--?(?:[A-Za-z0-9_-]*(?:access[-_]?token|api[-_]?key|authorization|credential|password|passwd|secret|token)[A-Za-z0-9_-]*)(?:=|$)/i;
const SHELL_SWITCH = /^(?:-c|--(?:command|eval|execute|shell|shell-file)|-e)$/i;
const PACKAGE_SPEC = /^(?<name>@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?<separator>@|==)(?<version>v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)$/;
const FILESYSTEM_MCP_PACKAGE = "@modelcontextprotocol/server-filesystem";
const MAX_FILESYSTEM_ROOTS = 16;
const CREDENTIAL_SEGMENT_MARKER = /(?:^|[-_.])(?:token|api[-_]?key|secret|password|passwd|credential(?:s)?|auth(?:orization)?)(?:[-_.]|$)/i;
const LONG_HEX_SEGMENT = /^[A-Fa-f0-9]{32,}$/;
const HIGH_ENTROPY_URL_SEGMENT = /^(?=[A-Za-z0-9_-]{32,}$)(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z0-9_-]+$/;

function invalid(message: string): never {
  throw new LocalMcpInstallValidationError(message);
}

function normalizedText(value: unknown, field: string, max = 2_048): string {
  if (typeof value !== "string") invalid(`${field} must be a string.`);
  const normalized = value.normalize("NFC").trim();
  if (!normalized) invalid(`${field} is required.`);
  if (new TextEncoder().encode(normalized).byteLength > max) invalid(`${field} is too long.`);
  if (/\p{Cc}/u.test(normalized)) invalid(`${field} contains control characters.`);
  if (SECRET_SHAPED.test(normalized)) invalid(`${field} appears to contain a credential.`);
  return normalized;
}

function normalizeOptionalText(value: unknown, field: string, max = 2_048): string | undefined {
  if (value === undefined) return undefined;
  return normalizedText(value, field, max);
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], field: string): void {
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    invalid(`${field} contains unsupported fields.`);
  }
}

function normalizeEndpointUrl(value: unknown, field: string): string {
  const raw = normalizedText(value, field, 2_048);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return invalid(`${field} must be an absolute URL.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    invalid(`${field} must use http or https.`);
  }
  if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    invalid(`${field} must not contain credentials, a query, or a fragment.`);
  }
  rejectCredentialHostname(parsed, raw, field);
  const segments = parsed.pathname.split("/").filter(Boolean).map((segment) => {
    try { return decodeURIComponent(segment); } catch { return segment; }
  });
  if (segments.some(isCredentialLikeUrlSegment)) {
    invalid(`${field} contains a credential-bearing path convention.`);
  }
  return parsed.toString();
}

function rejectCredentialHostname(parsed: URL, raw: string, field: string): void {
  // URL canonicalization lowercases DNS names. Inspect the original authority
  // too so a base64-like label cannot evade the mixed-case entropy check.
  const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]+)/.exec(raw)?.[1] ?? "";
  const originalHostname = authority.startsWith("[")
    ? authority
    : authority.replace(/:\d+$/, "");
  if (parsed.hostname.split(".").some(isCredentialLikeUrlSegment) ||
    originalHostname.split(".").some(isCredentialLikeUrlSegment)) {
    invalid(`${field} contains a credential-shaped hostname.`);
  }
}

function isCredentialLikeUrlSegment(segment: string): boolean {
  return CREDENTIAL_SEGMENT_MARKER.test(segment) ||
    LONG_HEX_SEGMENT.test(segment) ||
    HIGH_ENTROPY_URL_SEGMENT.test(segment);
}

/** Documentation provenance retains only a safe authority origin. */
function normalizeDocumentationUrl(value: unknown, field: string): string {
  if (typeof value !== "string") invalid(`${field} must be a string.`);
  const raw = value.normalize("NFC").trim();
  if (!raw || new TextEncoder().encode(raw).byteLength > 2_048 || /\p{Cc}/u.test(raw)) {
    invalid(`${field} is invalid.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return invalid(`${field} must be an absolute URL.`);
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    !parsed.hostname || parsed.username || parsed.password) {
    invalid(`${field} must be an http(s) URL without credentials.`);
  }
  rejectCredentialHostname(parsed, raw, field);
  // Paths, anchors, and tracking query strings are not provenance. Keeping
  // only the origin prevents pasted documentation URLs from becoming an
  // arbitrary secret-bearing audit/approval/checkpoint channel.
  return `${parsed.origin}/`;
}

function normalizeEnvironment(value: unknown): readonly LocalMcpInstallEnvironmentRequirement[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid("environment must be an array of environment variable names.");
  const names = value.map((entry) => normalizedText(entry, "environment name", 128));
  if (names.some((name) => !ENV_NAME.test(name))) {
    invalid("environment names must use uppercase letters, digits, and underscores only.");
  }
  return [...new Set(names)].sort((a, b) => a.localeCompare(b)).map((name) => ({ name, present: null }));
}

function normalizePackage(value: LocalMcpInstallModelIntent["package"]): LocalMcpInstallPackageEvidence | null {
  if (!value) return null;
  const record = asRecord(value, "package");
  rejectUnknownKeys(record, ["name", "version"], "package");
  const name = normalizedText(value.name, "package name", 256);
  const version = normalizeOptionalText(value.version, "package version", 256);
  return { name, ...(version ? { version } : {}) };
}

function rejectCredentialBearingArgv(args: readonly string[]): void {
  for (const arg of args) {
    if (ENV_ASSIGNMENT.test(arg) || ENV_VALUE_FLAG.test(arg) || SECRET_ARGUMENT.test(arg)) {
      invalid("stdio arguments must not carry environment or credential values.");
    }
    if (SHELL_SWITCH.test(arg)) {
      invalid("stdio arguments must not include shell evaluation switches.");
    }
  }
}

function isAbsoluteFilesystemRoot(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function validatePackageArguments(
  command: "npx" | "uvx",
  packageName: string,
  args: readonly string[],
  packageIndex: number,
): void {
  const trailing = args.slice(packageIndex + 1);
  if (packageName !== FILESYSTEM_MCP_PACKAGE) {
    if (trailing.length > 0) {
      invalid("stdio install supports only launcher options followed by one exact MCP package spec.");
    }
    return;
  }
  if (command !== "npx") {
    invalid("the official Filesystem MCP must use the npx launcher.");
  }
  if (trailing.length < 1 || trailing.length > MAX_FILESYSTEM_ROOTS) {
    invalid("the official Filesystem MCP requires between 1 and 16 allowed directory roots.");
  }
  if (trailing.some((root) => root.startsWith("-") || !isAbsoluteFilesystemRoot(root))) {
    invalid("Filesystem MCP roots must be absolute paths without options.");
  }
}

function parsePackageSpec(command: "npx" | "uvx", args: readonly string[]): LocalMcpInstallPackageEvidence {
  let spec: string | undefined;
  let packageIndex = -1;
  for (const [index, arg] of args.entries()) {
    if (!arg.startsWith("-")) {
      spec = arg;
      packageIndex = index;
      break;
    }
    const allowedBeforePackage = command === "npx" && (arg === "-y" || arg === "--yes");
    if (!allowedBeforePackage) {
      invalid("only the npx -y/--yes installer option is supported before the MCP package.");
    }
  }
  if (!spec) invalid("stdio install requires an exact MCP package spec.");
  const parsed = PACKAGE_SPEC.exec(spec);
  if (!parsed?.groups || (command === "npx" && parsed.groups["separator"] !== "@")) {
    invalid("stdio install requires a pinned package@version matching the package evidence.");
  }
  // Generic package arguments remain forbidden because they create an
  // arbitrary process-execution escape hatch. The official Filesystem MCP is
  // earned narrowly: its documented absolute directory roots are data, not
  // executable options, and are part of the canonical approval digest.
  validatePackageArguments(command, parsed.groups["name"]!, args, packageIndex);
  return { name: parsed.groups["name"]!, version: parsed.groups["version"]! };
}

function validateEarnedStdioLaunch(
  transport: Extract<LocalMcpInstallTransport, { kind: "stdio" }>,
  suppliedPackage: LocalMcpInstallPackageEvidence | null,
): LocalMcpInstallPackageEvidence {
  if (transport.command !== "npx" && transport.command !== "uvx") {
    invalid("stdio installation supports only the npx and uvx MCP package launchers.");
  }
  rejectCredentialBearingArgv(transport.args);
  const fromArgv = parsePackageSpec(transport.command, transport.args);
  if (!suppliedPackage?.version || suppliedPackage.name !== fromArgv.name || suppliedPackage.version !== fromArgv.version) {
    invalid("authoritative package evidence must exactly match the pinned package spec in argv.");
  }
  return fromArgv;
}

function normalizeTransport(value: unknown): LocalMcpInstallTransport {
  const record = asRecord(value, "transport");
  if (record["kind"] === "stdio") {
    rejectUnknownKeys(record, ["kind", "command", "args"], "stdio transport");
    const command = normalizedText(record["command"], "stdio command", 512);
    if (SHELLISH_COMMAND.test(command)) invalid("stdio command must be one direct executable, not a shell string.");
    if (!Array.isArray(record["args"])) invalid("stdio args must be an array.");
    const args = record["args"].map((arg) => normalizedText(arg, "stdio argument", 2_048));
    return { kind: "stdio", command, args };
  }
  if (record["kind"] === "streamable-http") {
    rejectUnknownKeys(record, ["kind", "url"], "streamable HTTP transport");
    return { kind: "streamable-http", url: normalizeEndpointUrl(record["url"], "streamable HTTP URL") };
  }
  invalid("transport kind must be stdio or streamable-http; SSE is not supported for installation.");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Stable canonical JSON serialization used as the digest payload. */
export function canonicalLocalMcpInstallJson(request: Omit<LocalMcpInstallRequest, "digest">): string {
  return stableJson(request);
}

/** Browser-safe SHA-256 base64url digest of the exact install effect. */
export async function digestLocalMcpInstallRequest(
  request: Omit<LocalMcpInstallRequest, "digest">,
): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto subtle.digest is unavailable");
  const bytes = new TextEncoder().encode(LOCAL_MCP_INSTALL_DIGEST_DOMAIN + canonicalLocalMcpInstallJson(request));
  return toBase64Url(new Uint8Array(await subtle.digest("SHA-256", bytes)));
}

/**
 * Normalize a model proposal into a server-owned request. Caller selects the
 * authenticated actor and owned relay; neither is accepted from model input.
 */
export async function prepareLocalMcpInstallRequest(input: {
  readonly intent: LocalMcpInstallModelIntent;
  readonly actorId: string;
  readonly relayId: string;
  readonly deviceSessionId: string;
}): Promise<LocalMcpInstallRequest> {
  const intentRecord = asRecord(input.intent, "local MCP install request");
  rejectUnknownKeys(
    intentRecord,
    ["version", "name", "relayId", "transport", "source", "package", "environment"],
    "local MCP install request",
  );
  if (intentRecord["version"] !== LOCAL_MCP_INSTALL_VERSION) {
    invalid("Unsupported local MCP install request version.");
  }
  const actorId = normalizedText(input.actorId, "actor id", 256);
  const relayId = normalizedText(input.relayId, "relay id", 256);
  const deviceSessionId = normalizedText(input.deviceSessionId, "Desktop session id", 256);
  const name = normalizedText(input.intent.name, "MCP name", 160);
  if (!SAFE_NAME.test(name)) invalid("MCP name must use letters, digits, dots, underscores, or hyphens.");
  const transport = normalizeTransport(input.intent.transport);
  const suppliedPackage = normalizePackage(input.intent.package);
  if (transport.kind === "streamable-http" && suppliedPackage !== null) {
    invalid("streamable HTTP MCP installs do not accept package evidence.");
  }
  const packageEvidence = transport.kind === "stdio"
    ? validateEarnedStdioLaunch(transport, suppliedPackage)
    : null;
  const source = input.intent.source === undefined ? undefined : asRecord(input.intent.source, "source");
  if (source) rejectUnknownKeys(source, ["url"], "source");
  const sourceUrl = source?.["url"] === undefined
    ? undefined
    : normalizeDocumentationUrl(source["url"], "source URL");
  const sourceLabel = sourceUrl ? new URL(sourceUrl).hostname : "No documentation source provided";
  const mayDownloadOnFirstRun = transport.kind === "stdio";
  const request = {
    version: LOCAL_MCP_INSTALL_VERSION,
    actorId,
    relayId,
    deviceSessionId,
    name,
    transport,
    source: { label: sourceLabel, ...(sourceUrl ? { url: sourceUrl } : {}) },
    package: packageEvidence,
    mayDownloadOnFirstRun,
    unpinnedPackage: mayDownloadOnFirstRun && (packageEvidence?.version === undefined),
    environment: normalizeEnvironment(input.intent.environment),
    availability: "personal" as const,
    availabilitySummary: "Personal — only you can use tools from this MCP.",
    subprocessSandboxed: transport.kind === "stdio" ? false as const : null,
  } satisfies Omit<LocalMcpInstallRequest, "digest">;
  return { ...request, digest: await digestLocalMcpInstallRequest(request) };
}

export function localMcpInstallFailure(
  code: LocalMcpInstallFailureCode,
): LocalMcpInstallFailure {
  const recovery: Record<LocalMcpInstallFailureCode, string> = {
    invalid_request: "Review the MCP launch details and try again.",
    approval_stale: "Review and approve the current MCP launch again.",
    relay_unavailable: "Reconnect the selected Desktop and try again.",
    relay_protocol_unsupported: "Update the selected Desktop relay and try again.",
    missing_launcher: "Install the required launcher on the selected Desktop, then retry.",
    missing_environment: "Set the required environment variable on the selected Desktop, then retry.",
    install_in_progress: "Wait for the existing install to finish, then check its status.",
    spawn_failed: "Check the MCP package and launcher on the selected Desktop, then retry.",
    protocol_failed: "Check the MCP's documented transport and retry.",
    discovery_timeout: "The MCP did not become ready in time; retry after checking its prerequisites.",
    empty_toolset: "The MCP started but advertised no tools; check its documented configuration.",
    rollback_unconfirmed: "The Desktop connection was closed for safety. Reconnect it, then retry the install.",
    internal: "Retry the install. If it keeps failing, contact the server administrator.",
  };
  return {
    code,
    retryable: !["invalid_request", "approval_stale"].includes(code),
    recovery: recovery[code],
  };
}
