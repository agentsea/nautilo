import { createHmac } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { parse as parseToml } from "smol-toml";

/**
 * Request-memory-only recovery authority. Callers must pass this directly to
 * the target-side portable-transfer job; it must never enter a receipt, log,
 * progress event, command argument, or error.
 */
export interface RailwayRecoveryConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly objectPrefix?: string | undefined;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string | undefined;
  readonly encryptionKey: Uint8Array;
}

export type RailwayRecoveryConfigFailureCode =
  | "railway.maintenance.recovery-config-invalid"
  | "railway.maintenance.recovery-config-unreadable"
  | "railway.maintenance.recovery-config-unsafe"
  | "railway.maintenance.recovery-config-too-large"
  | "railway.maintenance.recovery-config-environment-missing";

export type RailwayRecoveryConfigResolution =
  | {
    readonly outcome: "resolved";
    readonly config: RailwayRecoveryConfig;
    /** Non-secret identity for invalidating resumes when recovery custody rotates. */
    readonly authorityGenerationId: string;
  }
  | { readonly outcome: "failure"; readonly code: RailwayRecoveryConfigFailureCode };

export interface ResolveRailwayRecoveryConfigInput {
  /** The explicit --recovery-config input. No default or ambient path exists. */
  readonly recoveryConfigPath?: string | undefined;
  readonly environment: NodeJS.ProcessEnv;
}

const MAX_RECOVERY_CONFIG_BYTES = 64 * 1024;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REGION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BUCKET = /^(?![0-9]+(?:\.[0-9]+){3}$)(?!.*\.\.)(?!.*\.-)(?!.*-\.)[a-z0-9](?:[a-z0-9.-]{1,61})?[a-z0-9]$/;
const PREFIX_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9!_.*'()-]{0,127}$/;
const AUTHORITY_GENERATION_DOMAIN = "nautilo.railway.recovery-authority.v1";

type SafeFileRead =
  | { readonly outcome: "read"; readonly body: string }
  | { readonly outcome: "failure"; readonly code: RailwayRecoveryConfigFailureCode };

type SecretResolution =
  | { readonly outcome: "resolved"; readonly value: string }
  | { readonly outcome: "failure"; readonly code: "invalid" | "environment-missing" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExactCurrentUser0600File(status: Awaited<ReturnType<typeof lstat>>): boolean {
  return !status.isSymbolicLink()
    && status.isFile()
    && (typeof process.getuid !== "function" || status.uid === process.getuid())
    && (process.platform === "win32" || (Number(status.mode) & 0o777) === 0o600);
}

function validExplicitPath(path: string | undefined): path is string {
  return path !== undefined && path.length > 0 && isAbsolute(path) && resolve(path) === path;
}

/**
 * Reads the one caller-named recovery file only. lstat/fstat identity checking
 * and O_NOFOLLOW close the ordinary symlink/path-swap route. The path and all
 * file-system errors are deliberately collapsed into stable redacted codes.
 */
async function readProtectedRecoveryConfig(path: string): Promise<SafeFileRead> {
  let initial: Awaited<ReturnType<typeof lstat>>;
  try {
    initial = await lstat(path);
  } catch {
    return { outcome: "failure", code: "railway.maintenance.recovery-config-unreadable" };
  }
  if (!isExactCurrentUser0600File(initial)) {
    return { outcome: "failure", code: "railway.maintenance.recovery-config-unsafe" };
  }
  if (initial.size > MAX_RECOVERY_CONFIG_BYTES) {
    return { outcome: "failure", code: "railway.maintenance.recovery-config-too-large" };
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
    handle = await open(path, flags);
    const opened = await handle.stat();
    if (!isExactCurrentUser0600File(opened) || opened.dev !== initial.dev || opened.ino !== initial.ino) {
      return { outcome: "failure", code: "railway.maintenance.recovery-config-unsafe" };
    }
    if (opened.size > MAX_RECOVERY_CONFIG_BYTES) {
      return { outcome: "failure", code: "railway.maintenance.recovery-config-too-large" };
    }
    const body = await handle.readFile();
    if (body.byteLength > MAX_RECOVERY_CONFIG_BYTES) {
      return { outcome: "failure", code: "railway.maintenance.recovery-config-too-large" };
    }
    return { outcome: "read", body: body.toString("utf8") };
  } catch {
    return { outcome: "failure", code: "railway.maintenance.recovery-config-unreadable" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function resolveSecret(value: unknown, environment: NodeJS.ProcessEnv): SecretResolution {
  if (!isRecord(value)) return { outcome: "failure", code: "invalid" };
  const keys = Object.keys(value);
  const hasValue = Object.hasOwn(value, "value");
  const hasFromEnv = Object.hasOwn(value, "fromEnv");
  if (keys.length !== 1 || hasValue === hasFromEnv) return { outcome: "failure", code: "invalid" };
  if (hasValue) {
    return typeof value["value"] === "string"
      ? { outcome: "resolved", value: value["value"] }
      : { outcome: "failure", code: "invalid" };
  }
  if (typeof value["fromEnv"] !== "string" || !ENVIRONMENT_NAME.test(value["fromEnv"])) {
    return { outcome: "failure", code: "invalid" };
  }
  const resolved = environment[value["fromEnv"]];
  return resolved === undefined || resolved.length === 0
    ? { outcome: "failure", code: "environment-missing" }
    : { outcome: "resolved", value: resolved };
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function exactString(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string" && utf8Length(value) > 0 && utf8Length(value) <= maximumBytes && value.trim() === value;
}

function validEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) return false;
  try {
    const endpoint = new URL(value);
    return endpoint.protocol === "https:"
      && endpoint.username === ""
      && endpoint.password === ""
      && endpoint.search === ""
      && endpoint.hash === ""
      && endpoint.hostname.length > 0
      && (endpoint.pathname === "" || endpoint.pathname === "/");
  } catch {
    return false;
  }
}

function normalizeObjectPrefix(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) return undefined;
  const canonical = value.endsWith("/") ? value.slice(0, -1) : value;
  if (canonical.length === 0 || utf8Length(canonical) > 256 || canonical.startsWith("/") || canonical.includes("//")) return undefined;
  return canonical.split("/").every((segment) => PREFIX_SEGMENT.test(segment)) ? canonical : undefined;
}

function decodeEncryptionKey(value: string): Uint8Array | undefined {
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === 32 && decoded.toString("base64url") === value
    ? new Uint8Array(decoded)
    : undefined;
}

function lengthPrefixedUtf8(value: string): Buffer {
  const encoded = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(encoded.byteLength);
  return Buffer.concat([length, encoded]);
}

/**
 * Derives a safe resume-generation identifier without persisting any recovery
 * authority. Fixed field order plus byte lengths makes the encoding
 * unambiguous; the HMAC key and domain keep the identifier purpose-bound.
 */
function deriveAuthorityGenerationId(config: RailwayRecoveryConfig): string {
  const endpoint = new URL(config.endpoint).toString();
  const message = Buffer.concat([
    AUTHORITY_GENERATION_DOMAIN,
    endpoint,
    config.region,
    config.bucket,
    config.objectPrefix ?? "",
    config.accessKeyId,
    config.secretAccessKey,
    config.sessionToken ?? "",
  ].map(lengthPrefixedUtf8));
  const digest = createHmac("sha256", config.encryptionKey).update(message).digest("hex");
  return `recovery-v1-${digest}`;
}

function failure(code: "invalid" | "environment-missing"): RailwayRecoveryConfigResolution {
  return {
    outcome: "failure",
    code: code === "environment-missing"
      ? "railway.maintenance.recovery-config-environment-missing"
      : "railway.maintenance.recovery-config-invalid",
  };
}

function parseRecoveryConfig(
  body: string,
  environment: NodeJS.ProcessEnv,
): RailwayRecoveryConfigResolution {
  let parsed: unknown;
  try {
    parsed = parseToml(body);
  } catch {
    return failure("invalid");
  }
  if (!isRecord(parsed)
    || Object.keys(parsed).sort().join("\0") !== ["schemaVersion", "storage"].join("\0")
    || parsed["schemaVersion"] !== 1
    || !isRecord(parsed["storage"])) {
    return failure("invalid");
  }
  const storage = parsed["storage"];
  const expectedKeys = [
    "accessKeyId",
    "bucket",
    "encryptionKey",
    "endpoint",
    "objectPrefix",
    "region",
    "secretAccessKey",
    "sessionToken",
  ];
  const actualKeys = Object.keys(storage).sort();
  const requiredKeys = expectedKeys.filter((key) => key !== "objectPrefix" && key !== "sessionToken");
  if (!requiredKeys.every((key) => Object.hasOwn(storage, key))
    || !actualKeys.every((key) => expectedKeys.includes(key))) {
    return failure("invalid");
  }
  if (!validEndpoint(storage["endpoint"])
    || !exactString(storage["region"], 64) || !REGION.test(storage["region"])
    || !exactString(storage["bucket"], 63) || !BUCKET.test(storage["bucket"])) {
    return failure("invalid");
  }
  const objectPrefix = normalizeObjectPrefix(storage["objectPrefix"]);
  if (Object.hasOwn(storage, "objectPrefix") && objectPrefix === undefined) return failure("invalid");

  const accessKeyId = resolveSecret(storage["accessKeyId"], environment);
  const secretAccessKey = resolveSecret(storage["secretAccessKey"], environment);
  const encryptionKey = resolveSecret(storage["encryptionKey"], environment);
  const sessionToken = Object.hasOwn(storage, "sessionToken")
    ? resolveSecret(storage["sessionToken"], environment)
    : undefined;
  for (const secret of [accessKeyId, secretAccessKey, encryptionKey, sessionToken]) {
    if (secret !== undefined && secret.outcome === "failure") return failure(secret.code);
  }
  if (accessKeyId.outcome !== "resolved" || secretAccessKey.outcome !== "resolved"
    || encryptionKey.outcome !== "resolved"
    || (sessionToken !== undefined && sessionToken.outcome !== "resolved")
    || !exactString(accessKeyId.value, 2 * 1024)
    || !exactString(secretAccessKey.value, 8 * 1024)
    || (sessionToken !== undefined && !exactString(sessionToken.value, 16 * 1024))) {
    return failure("invalid");
  }
  const decodedKey = decodeEncryptionKey(encryptionKey.value);
  if (decodedKey === undefined) return failure("invalid");

  const config: RailwayRecoveryConfig = {
    endpoint: storage["endpoint"],
    region: storage["region"],
    bucket: storage["bucket"],
    ...(objectPrefix === undefined ? {} : { objectPrefix }),
    accessKeyId: accessKeyId.value,
    secretAccessKey: secretAccessKey.value,
    ...(sessionToken === undefined ? {} : { sessionToken: sessionToken.value }),
    encryptionKey: decodedKey,
  };
  return { outcome: "resolved", config, authorityGenerationId: deriveAuthorityGenerationId(config) };
}

/**
 * Resolve a separately supplied protected recovery TOML. This function has no
 * default location and no compatibility fallback, so it cannot harvest an
 * unrelated file or ambient secret source.
 */
export async function resolveRailwayRecoveryConfig(
  input: ResolveRailwayRecoveryConfigInput,
): Promise<RailwayRecoveryConfigResolution> {
  if (!validExplicitPath(input.recoveryConfigPath)) return failure("invalid");
  const read = await readProtectedRecoveryConfig(input.recoveryConfigPath);
  return read.outcome === "failure" ? read : parseRecoveryConfig(read.body, input.environment);
}
