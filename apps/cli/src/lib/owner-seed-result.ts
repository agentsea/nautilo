import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  link,
  lstat,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import { HANDLE_RE } from "@nautilo/types";

export const OWNER_SEED_RESULT_SCHEMA = "nautilo.owner-seed-result.v1" as const;

const OWNER_FILE_MODE = 0o600;
const MAX_PROFILE_BYTES = 128;
const RECOVERY_CODE_COUNT = 8;
const RECOVERY_CODE_RE = /^[a-f0-9]{24}$/u;
// The escaped worst-case canonical result is at most about 738 bytes. A 1 KiB
// cap leaves roughly 286 bytes of structural margin while bounding pre-parse reads.
const MAX_RESULT_BYTES = 1024;

export interface OwnerSeedResult {
  readonly schema: typeof OWNER_SEED_RESULT_SCHEMA;
  readonly profile: string;
  readonly targetFingerprint: string;
  readonly handle: string;
  readonly recoveryCodes: readonly string[];
}

export interface OwnerSeedResultFileHandle {
  writeFile(data: string, encoding: BufferEncoding): Promise<void>;
  readFile(): Promise<Buffer>;
  stat(): Promise<Stats>;
  chmod(mode: number): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface OwnerSeedResultFilesystem {
  lstat(path: string): Promise<Stats>;
  realpath(path: string): Promise<string>;
  open(path: string, flags: number, mode?: number): Promise<OwnerSeedResultFileHandle>;
  link(existingPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const defaultFilesystem: OwnerSeedResultFilesystem = {
  lstat,
  realpath,
  open: (path, flags, mode) => open(path, flags, mode),
  link,
  unlink,
};

export type OwnerSeedResultErrorCode =
  | "invalid-result"
  | "invalid-destination"
  | "unsafe-parent"
  | "server-root-target"
  | "destination-exists"
  | "result-read-failed"
  | "result-publish-failed";

export class OwnerSeedResultError extends Error {
  readonly code: OwnerSeedResultErrorCode;

  constructor(code: OwnerSeedResultErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OwnerSeedResultError";
    this.code = code;
  }
}

export interface OwnerSeedResultDestinationInput {
  readonly path: string;
  /** Known local server-mounted or backup roots that must never receive codes. */
  readonly serverRootPaths?: readonly string[];
  readonly filesystem?: OwnerSeedResultFilesystem;
}

export type OwnerSeedResultPreflight =
  | { readonly kind: "available"; readonly path: string }
  | { readonly kind: "existing"; readonly path: string; readonly result: OwnerSeedResult };

export type OwnerSeedResultPublication =
  | { readonly kind: "published"; readonly path: string; readonly result: OwnerSeedResult }
  | { readonly kind: "existing"; readonly path: string; readonly result: OwnerSeedResult };

interface ResolvedDestination {
  readonly path: string;
  readonly parent: string;
  readonly filesystem: OwnerSeedResultFilesystem;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function safeBoundedText(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && byteLength(value) <= maximumBytes
    && [...value].every((character) => {
      const point = character.codePointAt(0);
      return point !== undefined && point >= 0x20 && point !== 0x7f;
    });
}

function sameResult(left: OwnerSeedResult, right: OwnerSeedResult): boolean {
  return left.schema === right.schema
    && left.profile === right.profile
    && left.targetFingerprint === right.targetFingerprint
    && left.handle === right.handle
    && left.recoveryCodes.length === right.recoveryCodes.length
    && left.recoveryCodes.every((code, index) => code === right.recoveryCodes[index]);
}

function inside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === ""
    || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).sort().join("\0") === [...keys].sort().join("\0");
}

/** Validate and normalize the only plaintext recovery result persisted by the CLI. */
export function validateOwnerSeedResult(value: unknown): OwnerSeedResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OwnerSeedResultError("invalid-result", "Invalid owner seed result");
  }
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["schema", "profile", "targetFingerprint", "handle", "recoveryCodes"])
    || record["schema"] !== OWNER_SEED_RESULT_SCHEMA
    || !safeBoundedText(record["profile"], MAX_PROFILE_BYTES)
    || typeof record["targetFingerprint"] !== "string"
    || !/^[a-f0-9]{64}$/u.test(record["targetFingerprint"])
    || typeof record["handle"] !== "string"
    || !HANDLE_RE.test(record["handle"])
    || !Array.isArray(record["recoveryCodes"])
    || record["recoveryCodes"].length !== RECOVERY_CODE_COUNT
    || !record["recoveryCodes"].every((code) => (
      typeof code === "string" && RECOVERY_CODE_RE.test(code)
    ))
    || new Set(record["recoveryCodes"]).size !== record["recoveryCodes"].length) {
    throw new OwnerSeedResultError("invalid-result", "Invalid owner seed result");
  }

  const profile = record["profile"];
  const targetFingerprint = record["targetFingerprint"];
  const handle = record["handle"];
  const recoveryCodes = record["recoveryCodes"] as string[];
  const result: OwnerSeedResult = {
    schema: OWNER_SEED_RESULT_SCHEMA,
    profile,
    targetFingerprint,
    handle,
    recoveryCodes: [...recoveryCodes],
  };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (byteLength(serialized) > MAX_RESULT_BYTES) {
    throw new OwnerSeedResultError("invalid-result", "Invalid owner seed result");
  }
  return result;
}

async function canonicalRoot(path: string, filesystem: OwnerSeedResultFilesystem): Promise<string> {
  const normalized = resolve(path);
  try {
    return await filesystem.realpath(normalized);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return normalized;
    throw error;
  }
}

async function resolveDestination(input: OwnerSeedResultDestinationInput): Promise<ResolvedDestination> {
  if (!isAbsolute(input.path) || resolve(input.path) !== input.path || basename(input.path) === "") {
    throw new OwnerSeedResultError(
      "invalid-destination",
      "Owner seed result path must be an absolute normalized file path",
    );
  }
  const filesystem = input.filesystem ?? defaultFilesystem;
  const requestedParent = dirname(input.path);
  let status: Stats;
  let canonicalParent: string;
  try {
    status = await filesystem.lstat(requestedParent);
    canonicalParent = await filesystem.realpath(requestedParent);
  } catch (error) {
    throw new OwnerSeedResultError("unsafe-parent", "Owner seed result parent is unavailable", { cause: error });
  }
  if (status.isSymbolicLink() || !status.isDirectory()
    || (typeof process.getuid === "function" && status.uid !== process.getuid())
    || (process.platform !== "win32" && (status.mode & 0o022) !== 0)) {
    throw new OwnerSeedResultError("unsafe-parent", "Owner seed result parent is not operator-safe");
  }

  const path = join(canonicalParent, basename(input.path));
  for (const serverRootPath of input.serverRootPaths ?? []) {
    if (!isAbsolute(serverRootPath)) {
      throw new OwnerSeedResultError("invalid-destination", "Server root paths must be absolute");
    }
    let root: string;
    try {
      root = await canonicalRoot(serverRootPath, filesystem);
    } catch (error) {
      throw new OwnerSeedResultError("invalid-destination", "Server root path could not be resolved", { cause: error });
    }
    if (inside(root, path)) {
      throw new OwnerSeedResultError(
        "server-root-target",
        "Owner seed result must be outside server-mounted and backup roots",
      );
    }
  }
  return { path, parent: canonicalParent, filesystem };
}

async function readResolved(destination: ResolvedDestination): Promise<OwnerSeedResult | undefined> {
  const { filesystem, path } = destination;
  let status: Stats;
  try {
    status = await filesystem.lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw new OwnerSeedResultError("result-read-failed", "Owner seed result could not be inspected", { cause: error });
  }
  if (status.isSymbolicLink() || !status.isFile() || status.size > MAX_RESULT_BYTES
    || (typeof process.getuid === "function" && status.uid !== process.getuid())
    || (process.platform !== "win32" && (status.mode & 0o777) !== OWNER_FILE_MODE)) {
    throw new OwnerSeedResultError("result-read-failed", "Owner seed result is not a safe owner-only file");
  }

  const flags = constants.O_RDONLY
    | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
  let handle: OwnerSeedResultFileHandle | undefined;
  try {
    handle = await filesystem.open(path, flags);
    const openedStatus = await handle.stat();
    if (!openedStatus.isFile() || openedStatus.size > MAX_RESULT_BYTES
      || (typeof process.getuid === "function" && openedStatus.uid !== process.getuid())
      || (process.platform !== "win32" && (openedStatus.mode & 0o777) !== OWNER_FILE_MODE)) {
      throw new Error("opened result is not a safe owner-only file");
    }
    const body = await handle.readFile();
    if (body.byteLength > MAX_RESULT_BYTES) throw new Error("result exceeds byte limit");
    return validateOwnerSeedResult(JSON.parse(body.toString("utf8")) as unknown);
  } catch (error) {
    throw new OwnerSeedResultError("result-read-failed", "Owner seed result could not be read", { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Observe an existing durable result without weakening path or schema checks. */
export async function readOwnerSeedResult(
  input: OwnerSeedResultDestinationInput,
): Promise<OwnerSeedResult | undefined> {
  return readResolved(await resolveDestination(input));
}

/**
 * Validate the result destination before any server-side owner mutation.
 * Existing valid output remains observable so callers can resume safely.
 */
export async function preflightOwnerSeedResultDestination(
  input: OwnerSeedResultDestinationInput,
): Promise<OwnerSeedResultPreflight> {
  const destination = await resolveDestination(input);
  const existing = await readResolved(destination);
  return existing === undefined
    ? { kind: "available", path: destination.path }
    : { kind: "existing", path: destination.path, result: existing };
}

async function syncDirectory(destination: ResolvedDestination): Promise<void> {
  const handle = await destination.filesystem.open(destination.parent, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Re-establish durability after a crash that may have occurred after the
 * no-clobber link was published but before its parent directory was synced.
 * Callers must do this before an existing exact result authorizes custody
 * deletion or completion.
 */
export async function durabilizeExistingOwnerSeedResult(
  input: OwnerSeedResultDestinationInput,
): Promise<OwnerSeedResult> {
  const destination = await resolveDestination(input);
  const result = await readResolved(destination);
  if (result === undefined) {
    throw new OwnerSeedResultError("result-read-failed", "Owner seed result does not exist");
  }
  let handle: OwnerSeedResultFileHandle | undefined;
  try {
    handle = await destination.filesystem.open(destination.path, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    throw new OwnerSeedResultError("result-read-failed", "Owner seed result could not be synchronized", { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
  }
  await syncDirectory(destination);
  return result;
}

/**
 * Durably publish one recovery-code result without ever replacing a path.
 * A same-directory hard link is the atomic no-clobber publication primitive;
 * the temporary name is removed only after the new directory entry is synced.
 * A process death any time after temporary creation can leave an owner-only
 * `.<result>.tmp-<suffix>` hard link beside the valid result. Recovery is to
 * verify the exact result (or verify that no result was published) before
 * removing that sibling; publication never removes an unknown path
 * automatically.
 */
export async function publishOwnerSeedResult(input: OwnerSeedResultDestinationInput & {
  readonly result: OwnerSeedResult;
  readonly temporarySuffix?: () => string;
}): Promise<OwnerSeedResultPublication> {
  const result = validateOwnerSeedResult(input.result);
  const destination = await resolveDestination(input);
  const existing = await readResolved(destination);
  if (existing !== undefined) {
    if (sameResult(existing, result)) {
      return { kind: "existing", path: destination.path, result: existing };
    }
    throw new OwnerSeedResultError("destination-exists", "Owner seed result destination already exists");
  }

  const suffix = input.temporarySuffix?.() ?? randomBytes(12).toString("hex");
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(suffix)) {
    throw new OwnerSeedResultError("invalid-destination", "Invalid owner seed result temporary suffix");
  }
  const temporary = join(destination.parent, `.${basename(destination.path)}.tmp-${suffix}`);
  const body = `${JSON.stringify(result, null, 2)}\n`;
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
  let temporaryCreated = false;
  let handle: OwnerSeedResultFileHandle | undefined;
  try {
    handle = await destination.filesystem.open(temporary, flags, OWNER_FILE_MODE);
    temporaryCreated = true;
    await handle.writeFile(body, "utf8");
    await handle.chmod(OWNER_FILE_MODE);
    await handle.sync();
    await handle.close();
    handle = undefined;

    try {
      await destination.filesystem.link(temporary, destination.path);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const raced = await readResolved(destination);
      if (raced === undefined || !sameResult(raced, result)) {
        throw new OwnerSeedResultError("destination-exists", "Owner seed result destination already exists");
      }
      await destination.filesystem.unlink(temporary);
      temporaryCreated = false;
      await syncDirectory(destination);
      return { kind: "existing", path: destination.path, result: raced };
    }

    await syncDirectory(destination);
    await destination.filesystem.unlink(temporary);
    temporaryCreated = false;
    await syncDirectory(destination);
    return { kind: "published", path: destination.path, result };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (temporaryCreated) {
      await destination.filesystem.unlink(temporary).catch(() => undefined);
    }
    if (error instanceof OwnerSeedResultError) throw error;
    throw new OwnerSeedResultError("result-publish-failed", "Owner seed result publication failed", { cause: error });
  }
}
