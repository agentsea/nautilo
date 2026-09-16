import { createHash, randomBytes } from "node:crypto";
import {
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  computeAppSourceHash,
  scanInstalledApps,
  type AppStatus,
  type RegisteredMiniApp,
} from "./app-registry";
import { invalidateInstalledAppRegistry } from "./installed-app-registry";

export const APP_SOURCE_MAX_FILE_BYTES = 256 * 1024;

const APP_SOURCE_EXCLUDED_DIR_NAMES = new Set([
  "node_modules",
  ".cache",
  ".git",
  "dist",
  "build",
  "out",
  ".turbo",
  "coverage",
]);

export interface ResolvedAppSourcePath {
  appId: string;
  appRoot: string;
  relPath: string;
  absPath: string;
}

export type AppSourceTreeEntry = {
  path: string;
  kind: "file" | "directory";
  size?: number;
};

export class AppNotFoundError extends Error {
  readonly code = "app_not_found" as const;
  constructor(appId: string) {
    super(`app not found: ${appId}`);
    this.name = "AppNotFoundError";
  }
}

export class AppSourcePathError extends Error {
  readonly code = "invalid_path" as const;
  constructor(message: string) {
    super(message);
    this.name = "AppSourcePathError";
  }
}

export class AppSourceNotFoundError extends Error {
  readonly code = "not_found" as const;
  constructor(message: string) {
    super(message);
    this.name = "AppSourceNotFoundError";
  }
}

export class AppSourceNotFileError extends Error {
  readonly code = "not_a_file" as const;
  constructor(message: string) {
    super(message);
    this.name = "AppSourceNotFileError";
  }
}

export class AppSourceTooLargeError extends Error {
  readonly code = "file_too_large" as const;
  constructor(maxBytes: number) {
    super(`file exceeds ${maxBytes} byte limit`);
    this.name = "AppSourceTooLargeError";
  }
}

/** A caller requested a source range that cannot be represented safely. */
export class AppSourceRangeError extends Error {
  readonly code = "invalid_range" as const;
  constructor(
    message: string,
    readonly minimumBytes?: number,
  ) {
    super(message);
    this.name = "AppSourceRangeError";
  }
}

/** A continuation no longer refers to the source version on disk. */
export class AppSourceStaleSourceError extends Error {
  readonly code = "stale_source" as const;
  constructor(
    readonly expectedSha256: string,
    readonly currentSha256: string,
  ) {
    super("source changed since the previous range was read");
    this.name = "AppSourceStaleSourceError";
  }
}

export class AppSourceConflictError extends Error {
  readonly code = "conflict" as const;
  readonly currentSha256: string | null;
  constructor(currentSha256: string | null) {
    super("file content conflict");
    this.name = "AppSourceConflictError";
    this.currentSha256 = currentSha256;
  }
}

function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function validateRelativePath(relPath: string): string | null {
  if (relPath.length === 0) return "path must not be empty";
  if (hasControlChars(relPath)) return "path contains control characters";
  if (relPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(relPath)) {
    return "path must be relative";
  }
  const segments = relPath.split(/[/\\]/);
  if (segments.some((segment) => segment === "..")) {
    return "path must not contain parent traversal";
  }
  if (segments.some((segment) => segment.length === 0)) {
    return "path must not contain empty segments";
  }
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (APP_SOURCE_EXCLUDED_DIR_NAMES.has(segment)) {
      return "path contains excluded directory segment";
    }
    const isLast = i === segments.length - 1;
    if (!isLast && segment.startsWith(".")) {
      return "path contains excluded hidden directory segment";
    }
  }
  return null;
}

export function normalizeRelPath(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^\.\//, "");
}

async function findInstalledApp(
  appsRoot: string,
  appId: string,
): Promise<RegisteredMiniApp | null> {
  const installed = await scanInstalledApps(appsRoot);
  return installed.find((entry) => entry.id === appId) ?? null;
}

export async function assertRealPathUnderRoot(appRoot: string, absPath: string): Promise<void> {
  const rootReal = await realpath(appRoot);
  let targetReal: string;
  try {
    targetReal = await realpath(absPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
    const parentReal = await realpath(dirname(absPath));
    if (parentReal !== rootReal && !parentReal.startsWith(`${rootReal}${sep}`)) {
      throw new AppSourcePathError("path escapes app root");
    }
    return;
  }
  if (targetReal !== rootReal && !targetReal.startsWith(`${rootReal}${sep}`)) {
    throw new AppSourcePathError("path escapes app root");
  }
}

export async function resolveAppSourcePath(
  appsRoot: string,
  appId: string,
  relPath: string,
): Promise<ResolvedAppSourcePath> {
  const app = await findInstalledApp(appsRoot, appId);
  if (!app) {
    throw new AppNotFoundError(appId);
  }

  const validationError = validateRelativePath(relPath);
  if (validationError) {
    throw new AppSourcePathError(validationError);
  }

  const normalizedRelPath = normalizeRelPath(relPath);
  const absPath = resolve(app.root, normalizedRelPath);
  const rootResolved = resolve(app.root);
  if (absPath !== rootResolved && !absPath.startsWith(`${rootResolved}${sep}`)) {
    throw new AppSourcePathError("path escapes app root");
  }

  await assertRealPathUnderRoot(app.root, absPath);

  return {
    appId: app.id,
    appRoot: app.root,
    relPath: normalizedRelPath,
    absPath,
  };
}

function shouldSkipTreeEntry(name: string, isDirectory: boolean): boolean {
  if (isDirectory) {
    if (APP_SOURCE_EXCLUDED_DIR_NAMES.has(name)) return true;
    if (name.startsWith(".")) return true;
    return false;
  }
  return false;
}

async function collectTreeEntries(dir: string, appRoot: string, out: AppSourceTreeEntry[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldSkipTreeEntry(entry.name, entry.isDirectory())) {
      continue;
    }
    const absPath = join(dir, entry.name);
    const rel = relative(appRoot, absPath).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      out.push({ path: rel, kind: "directory" });
      await collectTreeEntries(absPath, appRoot, out);
      continue;
    }
    if (entry.isFile()) {
      const fileStat = await stat(absPath);
      out.push({ path: rel, kind: "file", size: fileStat.size });
    }
  }
}

export async function listAppSourceTree(appsRoot: string, appId: string): Promise<AppSourceTreeEntry[]> {
  const app = await findInstalledApp(appsRoot, appId);
  if (!app) {
    throw new AppNotFoundError(appId);
  }

  const files: AppSourceTreeEntry[] = [];
  await collectTreeEntries(app.root, app.root, files);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

export interface ReadAppSourceRangeInput {
  /** UTF-8 byte offset. Defaults to the first byte. */
  offsetBytes?: number | undefined;
  /** UTF-8 byte count. Omit to request every byte through EOF. */
  lengthBytes?: number | undefined;
  /** Required when continuing past byte zero. */
  expectedSha256?: string | undefined;
}

export interface ReadAppSourceFileRangeResult {
  path: string;
  content: string;
  sha256: string;
  totalBytes: number;
  offsetBytes: number;
  returnedBytes: number;
  nextOffsetBytes: number;
  complete: boolean;
}

function isUtf8Boundary(bytes: Buffer, offset: number): boolean {
  return offset === 0 || offset === bytes.length || (bytes[offset]! & 0xc0) !== 0x80;
}

function utf8SequenceLengthAt(bytes: Buffer, offset: number): number {
  const first = bytes[offset];
  if (first === undefined) return 0;
  if ((first & 0x80) === 0) return 1;
  if ((first & 0xe0) === 0xc0) return 2;
  if ((first & 0xf0) === 0xe0) return 3;
  if ((first & 0xf8) === 0xf0) return 4;
  throw new AppSourceRangeError("source contains an invalid UTF-8 leading byte");
}

function validateRangeInput(input: ReadAppSourceRangeInput): {
  offsetBytes: number;
  lengthBytes?: number | undefined;
  expectedSha256?: string | undefined;
} {
  const offsetBytes = input.offsetBytes ?? 0;
  if (!Number.isSafeInteger(offsetBytes) || offsetBytes < 0) {
    throw new AppSourceRangeError("offsetBytes must be a non-negative safe integer");
  }
  if (
    input.lengthBytes !== undefined &&
    (!Number.isSafeInteger(input.lengthBytes) || input.lengthBytes <= 0)
  ) {
    throw new AppSourceRangeError("lengthBytes must be a positive safe integer when provided");
  }
  if (offsetBytes > 0 && (typeof input.expectedSha256 !== "string" || input.expectedSha256.length === 0)) {
    throw new AppSourceRangeError("expectedSha256 is required for continuation beyond offsetBytes 0");
  }
  return {
    offsetBytes,
    ...(input.lengthBytes === undefined ? {} : { lengthBytes: input.lengthBytes }),
    ...(input.expectedSha256 === undefined ? {} : { expectedSha256: input.expectedSha256 }),
  };
}

/**
 * Read a caller-selected UTF-8-safe source range from one immutable source
 * version. This is deliberately a range reader, not a model-result limiter:
 * callers decide whether to request a finite range or every remaining byte.
 */
export async function readAppSourceFileRange(
  appsRoot: string,
  appId: string,
  relPath: string,
  input: ReadAppSourceRangeInput = {},
): Promise<ReadAppSourceFileRangeResult> {
  const range = validateRangeInput(input);
  const resolved = await resolveAppSourcePath(appsRoot, appId, relPath);
  let fileStat;
  try {
    fileStat = await stat(resolved.absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AppSourceNotFoundError("file not found");
    }
    throw err;
  }
  if (!fileStat.isFile()) {
    throw new AppSourceNotFileError("path is not a file");
  }

  const bytes = await readFile(resolved.absPath);
  if (bytes.length > APP_SOURCE_MAX_FILE_BYTES) {
    throw new AppSourceTooLargeError(APP_SOURCE_MAX_FILE_BYTES);
  }

  const totalBytes = bytes.length;
  const sha256 = sha256Hex(bytes);
  if (range.expectedSha256 !== undefined && range.expectedSha256 !== sha256) {
    throw new AppSourceStaleSourceError(range.expectedSha256, sha256);
  }
  if (range.offsetBytes > totalBytes) {
    throw new AppSourceRangeError("offsetBytes is beyond the end of the source file");
  }
  if (!isUtf8Boundary(bytes, range.offsetBytes)) {
    throw new AppSourceRangeError("offsetBytes must start at a UTF-8 character boundary");
  }

  const requestedEnd = range.lengthBytes === undefined
    ? totalBytes
    : range.offsetBytes + Math.min(totalBytes - range.offsetBytes, range.lengthBytes);
  let nextOffsetBytes = requestedEnd;
  while (nextOffsetBytes > range.offsetBytes && !isUtf8Boundary(bytes, nextOffsetBytes)) {
    nextOffsetBytes -= 1;
  }
  if (nextOffsetBytes === range.offsetBytes && range.offsetBytes < totalBytes) {
    const minimumBytes = utf8SequenceLengthAt(bytes, range.offsetBytes);
    throw new AppSourceRangeError(
      `lengthBytes is too small to include the next UTF-8 character; request at least ${minimumBytes} bytes`,
      minimumBytes,
    );
  }
  const content = bytes.subarray(range.offsetBytes, nextOffsetBytes).toString("utf8");

  return {
    path: resolved.relPath,
    content,
    sha256,
    totalBytes,
    offsetBytes: range.offsetBytes,
    returnedBytes: nextOffsetBytes - range.offsetBytes,
    nextOffsetBytes,
    complete: nextOffsetBytes === totalBytes,
  };
}

/** Preserve the established whole-file API for non-agent callers. */
export async function readAppSourceFile(
  appsRoot: string,
  appId: string,
  relPath: string,
): Promise<{ path: string; content: string; sha256: string }> {
  const result = await readAppSourceFileRange(appsRoot, appId, relPath);
  return { path: result.path, content: result.content, sha256: result.sha256 };
}

async function readCurrentFileSha256(absPath: string): Promise<string | null> {
  try {
    const fileStat = await stat(absPath);
    if (!fileStat.isFile()) {
      throw new AppSourceNotFileError("path is not a file");
    }
    const content = await readFile(absPath);
    return sha256Hex(content);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export interface WriteAppSourceFileResult {
  ok: true;
  path: string;
  sha256: string;
  sourceHash: string;
  status: AppStatus;
}

export async function writeAppSourceFile(
  appsRoot: string,
  appId: string,
  relPath: string,
  content: string,
  baseSha256: string,
): Promise<WriteAppSourceFileResult> {
  if (typeof baseSha256 !== "string" || baseSha256.length === 0) {
    throw new AppSourcePathError("baseSha256 is required");
  }
  if (Buffer.byteLength(content, "utf8") > APP_SOURCE_MAX_FILE_BYTES) {
    throw new AppSourceTooLargeError(APP_SOURCE_MAX_FILE_BYTES);
  }

  const resolved = await resolveAppSourcePath(appsRoot, appId, relPath);
  const currentSha256 = await readCurrentFileSha256(resolved.absPath);
  if (currentSha256 !== baseSha256) {
    throw new AppSourceConflictError(currentSha256);
  }

  const parentDir = dirname(resolved.absPath);
  let parentStat;
  try {
    parentStat = await stat(parentDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AppSourcePathError("parent directory does not exist");
    }
    throw err;
  }
  if (!parentStat.isDirectory()) {
    throw new AppSourcePathError("parent path is not a directory");
  }
  await assertRealPathUnderRoot(resolved.appRoot, parentDir);

  const tempPath = join(parentDir, `.nautilo-source-${randomBytes(8).toString("hex")}.tmp`);
  try {
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, resolved.absPath);
  } catch (err) {
    await unlink(tempPath).catch(() => undefined);
    throw err;
  }

  const sha256 = sha256Hex(content);
  const sourceHash = await computeAppSourceHash(resolved.appRoot);
  const installed = await scanInstalledApps(appsRoot);
  const app = installed.find((entry) => entry.id === appId);
  const status = app?.status ?? "invalid_manifest";

  invalidateInstalledAppRegistry();

  return {
    ok: true,
    path: resolved.relPath,
    sha256,
    sourceHash,
    status,
  };
}
