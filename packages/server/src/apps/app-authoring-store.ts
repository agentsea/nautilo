import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { buildMiniApp, type MiniAppBuildResult } from "./app-builder";
import { isSafeMiniAppId, parseMiniAppManifestJson } from "./app-manifest";
import {
  computeAppSourceHash,
  scanInstalledApps,
  type AppStatus,
  type RegisteredMiniApp,
} from "./app-registry";
import { publishAppSourceEvent } from "./app-source-events";
import {
  AppNotFoundError,
  AppSourceConflictError,
  AppSourcePathError,
  AppSourceTooLargeError,
  APP_SOURCE_MAX_FILE_BYTES,
  assertRealPathUnderRoot,
  normalizeRelPath,
  validateRelativePath,
} from "./app-source-store";
import { invalidateInstalledAppRegistry } from "./installed-app-registry";
import {
  registerAppToolsForApp,
  type AppToolRegistrationResult,
  type RegisterAppToolsOptions,
} from "./app-tool-registration";

export const APP_AUTHORING_MAX_FILE_COUNT = 64;
export const APP_AUTHORING_MAX_FILE_BYTES = APP_SOURCE_MAX_FILE_BYTES;
const APP_AUTHORING_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const APP_AUTHORING_MAX_PATH_LENGTH = 512;
const APP_AUTHORING_MAX_RESULT_ENTRIES = 64;

export class AppAuthoringConflictError extends Error {
  readonly code = "app_conflict" as const;
  constructor(message: string) {
    super(message);
    this.name = "AppAuthoringConflictError";
  }
}

export class AppAuthoringPayloadError extends Error {
  readonly code = "payload_limit" as const;
  constructor(message: string) {
    super(message);
    this.name = "AppAuthoringPayloadError";
  }
}

export class AppAuthoringManifestError extends Error {
  readonly code = "invalid_manifest" as const;
  constructor(message: string) {
    super(message);
    this.name = "AppAuthoringManifestError";
  }
}

class AppAuthoringSourceHashError extends Error {
  readonly code = "source_hash_mismatch" as const;
  readonly currentSourceHash: string | null;
  constructor(currentSourceHash: string | null) {
    super("source hash mismatch");
    this.name = "AppAuthoringSourceHashError";
    this.currentSourceHash = currentSourceHash;
  }
}

export type MiniAppSourceFile = {
  path: string;
  content: string;
};

export type MiniAppSourceWrite = {
  path: string;
  content: string;
  baseSha256?: string;
};

export type MiniAppAuthoringRegistration =
  | AppToolRegistrationResult
  | { status: "warning"; message: string };

export type MiniAppAuthoringResult = {
  ok: true;
  appId: string;
  status: AppStatus;
  sourceHash: string;
  filesWritten: string[];
  registration: MiniAppAuthoringRegistration;
};

export type MiniAppValidationResult = {
  ok: boolean;
  appId: string;
  status: AppStatus;
  sourceHash: string | null;
  manifestError?: string;
  runtimeBuild?: MiniAppBuildResult;
  registration?: MiniAppAuthoringRegistration;
};

export type MiniAppAuthoringStoreOptions = {
  registerAppTools?: (
    appsRoot: string,
    appId: string,
    options?: RegisterAppToolsOptions,
  ) => Promise<AppToolRegistrationResult>;
};

type ValidatedSourceEntry = {
  relPath: string;
  content: string;
  absPath: string;
};

function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function packageJsonDeclaresDeps(content: string): boolean {
  let pkg: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  try {
    pkg = JSON.parse(content) as typeof pkg;
  } catch {
    return false;
  }
  return (
    ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const
  ).some((key) => Object.keys(pkg[key] ?? {}).length > 0);
}

function validatePayloadCaps(
  entries: Array<{ path: string; content: string }>,
  label: string,
): void {
  if (entries.length === 0) {
    throw new AppAuthoringPayloadError(`${label} must include at least one entry`);
  }
  if (entries.length > APP_AUTHORING_MAX_FILE_COUNT) {
    throw new AppAuthoringPayloadError(
      `${label} exceeds maximum file count (${APP_AUTHORING_MAX_FILE_COUNT})`,
    );
  }

  const seenPaths = new Set<string>();
  let totalBytes = 0;
  for (const entry of entries) {
    const normalizedPath = normalizeRelPath(entry.path);
    if (seenPaths.has(normalizedPath)) {
      throw new AppSourcePathError(`duplicate path: ${normalizedPath}`);
    }
    seenPaths.add(normalizedPath);

    if (normalizedPath.length > APP_AUTHORING_MAX_PATH_LENGTH) {
      throw new AppAuthoringPayloadError(
        `path exceeds maximum length (${APP_AUTHORING_MAX_PATH_LENGTH})`,
      );
    }

    const pathError = validateRelativePath(normalizedPath);
    if (pathError) {
      throw new AppSourcePathError(pathError);
    }

    const bytes = Buffer.byteLength(entry.content, "utf8");
    if (bytes > APP_AUTHORING_MAX_FILE_BYTES) {
      throw new AppSourceTooLargeError(APP_AUTHORING_MAX_FILE_BYTES);
    }
    totalBytes += bytes;
    if (totalBytes > APP_AUTHORING_MAX_TOTAL_BYTES) {
      throw new AppAuthoringPayloadError(
        `${label} exceeds maximum total bytes (${APP_AUTHORING_MAX_TOTAL_BYTES})`,
      );
    }

    if (basename(normalizedPath) === "package.json" && packageJsonDeclaresDeps(entry.content)) {
      throw new AppAuthoringManifestError("package.json must not declare dependencies in V1");
    }
  }
}

async function findInstalledApp(
  appsRoot: string,
  appId: string,
): Promise<RegisteredMiniApp | null> {
  const installed = await scanInstalledApps(appsRoot);
  return installed.find((entry) => entry.id === appId) ?? null;
}

async function appDirectoryExists(appsRoot: string, appId: string): Promise<boolean> {
  try {
    const appStat = await stat(join(appsRoot, appId));
    return appStat.isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function assertAppDoesNotExist(appsRoot: string, appId: string): Promise<void> {
  if (await appDirectoryExists(appsRoot, appId)) {
    throw new AppAuthoringConflictError(`app already exists: ${appId}`);
  }
  const installed = await findInstalledApp(appsRoot, appId);
  if (installed) {
    throw new AppAuthoringConflictError(`app already exists: ${appId}`);
  }
}

function parseAndValidateManifestFromFiles(
  files: MiniAppSourceFile[],
  appId: string,
): ReturnType<typeof parseMiniAppManifestJson> {
  const appJson = files.find((file) => normalizeRelPath(file.path) === "app.json");
  if (!appJson) {
    throw new AppAuthoringManifestError("app.json is required");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(appJson.content);
  } catch {
    throw new AppAuthoringManifestError("app.json must be valid JSON");
  }

  const validated = parseMiniAppManifestJson(raw);
  if (!validated.ok) {
    throw new AppAuthoringManifestError(validated.error);
  }
  if (validated.manifest.id !== appId) {
    throw new AppAuthoringManifestError("app id must match manifest id");
  }
  return validated;
}

async function validateStagedAppRoot(
  stagedRoot: string,
  appId: string,
): Promise<{ status: AppStatus; sourceHash: string; manifestError?: string }> {
  const manifestPath = join(stagedRoot, "app.json");
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (err) {
    return {
      status: "invalid_manifest",
      sourceHash: await computeAppSourceHash(stagedRoot),
      manifestError: err instanceof Error ? err.message : "failed to read app.json",
    };
  }

  const validated = parseMiniAppManifestJson(rawManifest);
  if (!validated.ok) {
    return {
      status: "invalid_manifest",
      sourceHash: await computeAppSourceHash(stagedRoot),
      manifestError: validated.error,
    };
  }
  if (validated.manifest.id !== appId) {
    return {
      status: "invalid_manifest",
      sourceHash: await computeAppSourceHash(stagedRoot),
      manifestError: "app id must match manifest id",
    };
  }

  const packageJsonPath = join(stagedRoot, "package.json");
  try {
    const packageStat = await stat(packageJsonPath);
    if (packageStat.isFile()) {
      const packageContent = await readFile(packageJsonPath, "utf8");
      if (packageJsonDeclaresDeps(packageContent)) {
        return {
          status: "needs_dependencies",
          sourceHash: await computeAppSourceHash(stagedRoot),
          manifestError: "package.json declares dependencies",
        };
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const sourceHash = await computeAppSourceHash(stagedRoot);
  return { status: "ready", sourceHash };
}

function resolveValidatedEntries(
  appRoot: string,
  entries: Array<{ path: string; content: string }>,
): ValidatedSourceEntry[] {
  const rootResolved = resolve(appRoot);
  const resolvedEntries: ValidatedSourceEntry[] = [];

  for (const entry of entries) {
    const relPath = normalizeRelPath(entry.path);
    const absPath = resolve(appRoot, relPath);
    if (absPath !== rootResolved && !absPath.startsWith(`${rootResolved}${sep}`)) {
      throw new AppSourcePathError("path escapes app root");
    }
    resolvedEntries.push({ relPath, content: entry.content, absPath });
  }

  return resolvedEntries;
}

async function writeValidatedEntries(
  appRoot: string,
  entries: ValidatedSourceEntry[],
): Promise<string[]> {
  const sorted = [...entries].sort((a, b) => a.relPath.localeCompare(b.relPath));
  const written: string[] = [];

  for (const entry of sorted) {
    const parentDir = dirname(entry.absPath);
    await mkdir(parentDir, { recursive: true });
    await assertRealPathUnderRoot(appRoot, parentDir);
    await assertRealPathUnderRoot(appRoot, entry.absPath);

    const tempPath = join(parentDir, `.nautilo-authoring-${randomBytes(8).toString("hex")}.tmp`);
    try {
      await writeFile(tempPath, entry.content, "utf8");
      await rename(tempPath, entry.absPath);
    } catch (err) {
      await unlink(tempPath).catch(() => undefined);
      throw err;
    }
    written.push(entry.relPath);
  }

  return written.slice(0, APP_AUTHORING_MAX_RESULT_ENTRIES);
}

async function readCurrentFileSha256(absPath: string): Promise<string | null> {
  try {
    const fileStat = await stat(absPath);
    if (!fileStat.isFile()) {
      throw new AppSourcePathError("path is not a file");
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

async function preflightBatchWrites(
  appRoot: string,
  writes: MiniAppSourceWrite[],
): Promise<ValidatedSourceEntry[]> {
  const resolved = resolveValidatedEntries(appRoot, writes);

  for (let i = 0; i < writes.length; i++) {
    const write = writes[i]!;
    const entry = resolved[i]!;
    const currentSha256 = await readCurrentFileSha256(entry.absPath);

    if (currentSha256 !== null) {
      if (typeof write.baseSha256 !== "string" || write.baseSha256.length === 0) {
        throw new AppSourcePathError("baseSha256 is required when replacing an existing file");
      }
      if (currentSha256 !== write.baseSha256) {
        throw new AppSourceConflictError(currentSha256);
      }

      const parentDir = dirname(entry.absPath);
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
      await assertRealPathUnderRoot(appRoot, parentDir);
    }
  }

  return resolved;
}

async function refreshAfterMutation(
  appsRoot: string,
  appId: string,
  options: MiniAppAuthoringStoreOptions = {},
): Promise<{
  status: AppStatus;
  sourceHash: string;
  registration: MiniAppAuthoringRegistration;
}> {
  invalidateInstalledAppRegistry();

  const installed = await scanInstalledApps(appsRoot);
  const app = installed.find((entry) => entry.id === appId);
  const status = app?.status ?? "invalid_manifest";
  const appRoot = app?.root ?? join(appsRoot, appId);
  const sourceHash = app?.sourceHash ?? (await computeAppSourceHash(appRoot));

  publishAppSourceEvent({ type: "changed", appId, sourceHash });
  if (status === "invalid_manifest" || status === "needs_dependencies") {
    publishAppSourceEvent({ type: "status", appId, status });
  }

  const register = options.registerAppTools ?? registerAppToolsForApp;
  let registration: MiniAppAuthoringRegistration;
  try {
    registration = await register(appsRoot, appId);
  } catch (err) {
    registration = {
      status: "warning",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  return { status, sourceHash, registration };
}

export async function createMiniAppSource(
  appsRoot: string,
  input: {
    appId: string;
    files: MiniAppSourceFile[];
    expectedSourceHash?: string;
  },
  options: MiniAppAuthoringStoreOptions = {},
): Promise<MiniAppAuthoringResult> {
  const { appId, files } = input;

  if (!isSafeMiniAppId(appId)) {
    throw new AppAuthoringManifestError("app id is invalid");
  }

  await assertAppDoesNotExist(appsRoot, appId);
  validatePayloadCaps(files, "files");
  parseAndValidateManifestFromFiles(files, appId);

  const stagingDir = join(appsRoot, `.authoring-tmp-${randomBytes(8).toString("hex")}`);
  await mkdir(stagingDir, { recursive: true });

  try {
    const validatedEntries = resolveValidatedEntries(stagingDir, files);
    const filesWritten = await writeValidatedEntries(stagingDir, validatedEntries);

    const staged = await validateStagedAppRoot(stagingDir, appId);
    if (staged.status !== "ready") {
      throw new AppAuthoringManifestError(staged.manifestError ?? staged.status);
    }

    const targetDir = join(appsRoot, appId);
    await rename(stagingDir, targetDir);

    const { status, sourceHash, registration } = await refreshAfterMutation(appsRoot, appId, options);

    return {
      ok: true,
      appId,
      status,
      sourceHash,
      filesWritten,
      registration,
    };
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

export async function applyMiniAppSourceBatch(
  appsRoot: string,
  input: {
    appId: string;
    writes: MiniAppSourceWrite[];
    expectedSourceHash?: string;
  },
  options: MiniAppAuthoringStoreOptions = {},
): Promise<MiniAppAuthoringResult> {
  const { appId, writes } = input;

  if (!isSafeMiniAppId(appId)) {
    throw new AppAuthoringManifestError("app id is invalid");
  }

  const app = await findInstalledApp(appsRoot, appId);
  if (!app) {
    throw new AppNotFoundError(appId);
  }

  if (input.expectedSourceHash !== undefined) {
    const currentHash = app.sourceHash ?? (await computeAppSourceHash(app.root));
    if (currentHash !== input.expectedSourceHash) {
      throw new AppAuthoringSourceHashError(currentHash);
    }
  }

  validatePayloadCaps(writes, "writes");
  const validatedEntries = await preflightBatchWrites(app.root, writes);
  const filesWritten = await writeValidatedEntries(app.root, validatedEntries);

  const { status, sourceHash, registration } = await refreshAfterMutation(appsRoot, appId, options);

  return {
    ok: true,
    appId,
    status,
    sourceHash,
    filesWritten,
    registration,
  };
}

export async function validateMiniAppSource(
  appsRoot: string,
  appId: string,
  opts?: { buildRuntime?: boolean; buildAgentTools?: boolean },
  options: MiniAppAuthoringStoreOptions = {},
): Promise<MiniAppValidationResult> {
  if (!isSafeMiniAppId(appId)) {
    throw new AppAuthoringManifestError("app id is invalid");
  }

  const app = await findInstalledApp(appsRoot, appId);
  if (!app) {
    throw new AppNotFoundError(appId);
  }

  const result: MiniAppValidationResult = {
    ok: app.status === "ready",
    appId,
    status: app.status,
    sourceHash: app.sourceHash,
  };
  if (app.error) {
    result.manifestError = app.error;
  }

  if (opts?.buildRuntime) {
    result.runtimeBuild = await buildMiniApp(app, appsRoot);
    result.ok = result.ok && result.runtimeBuild.ok;
  }

  if (opts?.buildAgentTools) {
    const register = options.registerAppTools ?? registerAppToolsForApp;
    try {
      result.registration = await register(appsRoot, appId);
    } catch (err) {
      result.registration = {
        status: "warning",
        message: err instanceof Error ? err.message : String(err),
      };
      result.ok = false;
    }
  }

  return result;
}
