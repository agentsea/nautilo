import { copyFile } from "node:fs/promises";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  sha256File,
  verifyFullBackupDirectory,
  type VerifiedFullBackup,
} from "./full-dev-backup";
import {
  parseCloneSeedOperationRecord,
  writeCloneSeedOperationRecord,
  writeOwnerOnlyJsonAtomically,
  type CloneSeedOperationRecord,
} from "./d489-operation-records";

const STORE_FORMAT_VERSION = 1 as const;
const GENERATION_RE = /^[a-z0-9][a-z0-9-]{7,127}$/;
const BACKUP_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export interface CloneSeedPaths {
  readonly root: string;
  readonly generations: string;
  readonly currentPointer: string;
  readonly previousPointer: string;
  readonly failureRecord: string;
  readonly lock: string;
}

export interface CloneSeedPointer {
  readonly formatVersion: typeof STORE_FORMAT_VERSION;
  readonly generation: string;
}

export interface CloneSeedHandle {
  readonly generation: string;
  readonly directory: string;
  readonly backup: VerifiedFullBackup;
  readonly operation: CloneSeedOperationRecord;
}

export interface CloneSeedProvenance {
  readonly checkoutCommitSha: string;
  readonly lineage: {
    readonly appliedMigrationCount: number;
    readonly lastAppliedIndex: number;
    readonly sha256: string;
  };
}

export interface RefreshCloneSeedInput {
  readonly root: string;
  /** Capture must return a full backup that has already been quiesced. */
  readonly capture: () => Promise<VerifiedFullBackup>;
  /**
   * Kept injectable because Task 2.2 expands M234 eligibility to the canonical
   * empty-ID source. The production default remains the M234 verifier.
   */
  readonly verify?: (directory: string) => Promise<VerifiedFullBackup>;
  readonly provenance: CloneSeedProvenance;
  readonly now?: () => Date;
  readonly generation?: () => string;
  readonly copy?: (source: string, destination: string) => Promise<void>;
  readonly diskSpace?: (path: string) => Promise<{ readonly bavail: number; readonly bsize: number }>;
  /**
   * Removes capture-owned temporary state while this refresh still owns the
   * cross-worktree lock. A caller that loses lock acquisition must never run
   * this cleanup against the winning refresh.
   */
  readonly cleanupCapture?: () => Promise<void>;
  /** Test-only boundary after the staged backup is fully verified and before publication. */
  readonly beforePublish?: () => Promise<void>;
  /** Test-only notification after the current pointer becomes authoritative. */
  readonly afterPublish?: () => Promise<void>;
}

export class CloneSeedBusyError extends Error {
  constructor() {
    super("A clone-seed refresh is already in progress; reuse the current seed or retry shortly");
    this.name = "CloneSeedBusyError";
  }
}

export class CloneSeedFreshnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloneSeedFreshnessError";
  }
}

/** Deliberately not under an instance's `dev-snapshots` recovery directory. */
export function defaultCloneSeedRoot(userHome: string): string {
  return join(resolve(userHome), ".nautilo-clone-seeds");
}

export function cloneSeedPaths(root: string): CloneSeedPaths {
  const absoluteRoot = resolve(root);
  return {
    root: absoluteRoot,
    generations: join(absoluteRoot, "generations"),
    currentPointer: join(absoluteRoot, "current.json"),
    previousPointer: join(absoluteRoot, "previous.json"),
    failureRecord: join(absoluteRoot, "last-failed.json"),
    lock: join(absoluteRoot, "refresh.lock"),
  };
}

function safeGeneration(value: string): string {
  if (!GENERATION_RE.test(value)) throw new Error("Clone seed generation is unsafe");
  return value;
}

function seedGenerationDirectory(paths: CloneSeedPaths, generation: string): string {
  const directory = resolve(paths.generations, safeGeneration(generation));
  if (!directory.startsWith(`${paths.generations}/`)) throw new Error("Clone seed generation escapes its store");
  return directory;
}

function parsePointer(value: unknown): CloneSeedPointer {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    (value as Record<string, unknown>)["formatVersion"] !== STORE_FORMAT_VERSION ||
    typeof (value as Record<string, unknown>)["generation"] !== "string"
  ) throw new Error("Invalid clone-seed pointer");
  const generation = (value as Record<string, unknown>)["generation"];
  if (typeof generation !== "string") throw new Error("Invalid clone-seed pointer");
  return { formatVersion: STORE_FORMAT_VERSION, generation: safeGeneration(generation) };
}

async function readPointer(path: string): Promise<CloneSeedPointer | null> {
  try {
    return parsePointer(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

async function ownerOnlyDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function ensureStore(paths: CloneSeedPaths): Promise<void> {
  await ownerOnlyDirectory(paths.root);
  await ownerOnlyDirectory(paths.generations);
}

async function assertOwnerOnlyDirectory(path: string): Promise<void> {
  const details = await stat(path);
  if (!details.isDirectory() || (details.mode & 0o077) !== 0) {
    throw new Error("Clone seed directory is not owner-only");
  }
}

function artifactBytes(backup: VerifiedFullBackup): number {
  return Object.values(backup.manifest.artifacts).reduce((total, artifact) => total + artifact.bytes, 0);
}

function strictTimestamp(now: Date): string {
  return now.toISOString();
}

function createPublishedOperation(input: {
  readonly provenance: CloneSeedProvenance;
  readonly backup: VerifiedFullBackup;
  readonly manifestSha256: string;
  readonly startedAt: Date;
  readonly updatedAt: Date;
}): CloneSeedOperationRecord {
  const startedAt = strictTimestamp(input.startedAt);
  const updatedAt = strictTimestamp(input.updatedAt);
  return parseCloneSeedOperationRecord({
    formatVersion: 1,
    kind: "clone-seed",
    status: "published",
    startedAt,
    updatedAt,
    source: {
      authority: "canonical-default",
      deploymentMode: "local-self-host",
      checkoutCommitSha: input.provenance.checkoutCommitSha,
      lineage: input.provenance.lineage,
    },
    capture: {
      capturedAt: input.backup.manifest.createdAt,
      freshness: "fresh",
      manifestSha256: input.manifestSha256,
      artifactCount: Object.keys(input.backup.manifest.artifacts).length,
      artifactBytes: artifactBytes(input.backup),
    },
    completedStages: ["captured", "verified", "published"],
    artifactPolicy: "current-plus-one-previous-or-failed",
    failure: null,
    recovery: { retryState: "not-needed", guidance: "none" },
  });
}

function createFailureOperation(input: {
  readonly provenance: CloneSeedProvenance;
  readonly backup: VerifiedFullBackup | null;
  readonly startedAt: Date;
  readonly updatedAt: Date;
  readonly code: "seed-capture-failed" | "seed-verification-failed" | "seed-publication-failed" | "seed-interrupted";
}): CloneSeedOperationRecord {
  const startedAt = strictTimestamp(input.startedAt);
  const updatedAt = strictTimestamp(input.updatedAt);
  const manifestSha256 = "0".repeat(64);
  const stageCount = input.code === "seed-capture-failed" ? 0 : input.code === "seed-verification-failed" ? 1 : 2;
  return parseCloneSeedOperationRecord({
    formatVersion: 1,
    kind: "clone-seed",
    status: "failed",
    startedAt,
    updatedAt,
    source: {
      authority: "canonical-default",
      deploymentMode: "local-self-host",
      checkoutCommitSha: input.provenance.checkoutCommitSha,
      lineage: input.provenance.lineage,
    },
    capture: {
      capturedAt: input.backup?.manifest.createdAt ?? startedAt,
      freshness: "fresh",
      manifestSha256,
      artifactCount: input.backup === null ? 0 : Object.keys(input.backup.manifest.artifacts).length,
      artifactBytes: input.backup === null ? 0 : artifactBytes(input.backup),
    },
    completedStages: ["captured", "verified", "published"].slice(0, stageCount),
    artifactPolicy: "current-plus-one-previous-or-failed",
    failure: { code: input.code, guidance: input.code === "seed-publication-failed" ? "reuse-current-artifact" : "retry-capture" },
    recovery: { retryState: "safe-to-retry", guidance: input.code === "seed-publication-failed" ? "reuse-current-artifact" : "retry-capture" },
  });
}

async function writeFailureEvidence(
  paths: CloneSeedPaths,
  input: Parameters<typeof createFailureOperation>[0],
): Promise<void> {
  const record = createFailureOperation(input);
  await writeCloneSeedOperationRecord(paths.failureRecord, record);
}

async function copyVerifiedBackup(input: {
  readonly source: VerifiedFullBackup;
  readonly destination: string;
  readonly copy: (source: string, destination: string) => Promise<void>;
}): Promise<void> {
  const sourceName = basename(input.source.dir);
  if (!BACKUP_NAME_RE.test(sourceName) || input.source.manifest.name !== sourceName) {
    throw new Error("Clone seed source backup has an unsafe published name");
  }
  await ownerOnlyDirectory(input.destination);
  const sourceRoot = resolve(input.source.dir);
  const destinationRoot = resolve(input.destination);
  const files = ["manifest.json", ...Object.values(input.source.manifest.artifacts).map((artifact) => artifact.file)];
  for (const file of files) {
    const source = resolve(sourceRoot, file);
    const destination = resolve(destinationRoot, file);
    if (!source.startsWith(`${sourceRoot}/`) || !destination.startsWith(`${destinationRoot}/`)) {
      throw new Error("Clone seed artifact escapes its directory");
    }
    await input.copy(source, destination);
    await chmod(destination, 0o600);
  }
}

async function readSeedAtGeneration(input: {
  readonly paths: CloneSeedPaths;
  readonly generation: string;
  readonly verify: (directory: string) => Promise<VerifiedFullBackup>;
  readonly now?: Date;
  readonly maxAgeMs?: number;
  readonly expectedLineage?: CloneSeedProvenance["lineage"];
}): Promise<CloneSeedHandle> {
  const directory = seedGenerationDirectory(input.paths, input.generation);
  await assertOwnerOnlyDirectory(directory);
  const entries = await readdir(directory);
  if (!entries.includes("backup") || !entries.includes("operation.json")) {
    throw new Error("Published clone seed is incomplete");
  }
  const backupContainer = join(directory, "backup");
  await assertOwnerOnlyDirectory(backupContainer);
  const backupNames = await readdir(backupContainer);
  if (backupNames.length !== 1 || !BACKUP_NAME_RE.test(backupNames[0] ?? "")) {
    throw new Error("Published clone seed backup layout is invalid");
  }
  const backupDirectory = join(backupContainer, backupNames[0] as string);
  const backup = await input.verify(backupDirectory);
  const operationOptions = {
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.maxAgeMs === undefined ? {} : { maxAgeMs: input.maxAgeMs }),
  };
  const operation = parseCloneSeedOperationRecord(
    JSON.parse(await readFile(join(directory, "operation.json"), "utf8")) as unknown,
    operationOptions,
  );
  if (operation.status !== "published") throw new Error("Clone seed is not published");
  if (input.expectedLineage !== undefined && (
    operation.source.lineage.appliedMigrationCount !== input.expectedLineage.appliedMigrationCount ||
    operation.source.lineage.lastAppliedIndex !== input.expectedLineage.lastAppliedIndex ||
    operation.source.lineage.sha256 !== input.expectedLineage.sha256
  )) throw new CloneSeedFreshnessError("Clone seed lineage differs from the requested source lineage");
  const manifestSha256 = await sha256File(join(backupDirectory, "manifest.json"));
  if (
    operation.capture.manifestSha256 !== manifestSha256 ||
    operation.capture.artifactCount !== Object.keys(backup.manifest.artifacts).length ||
    operation.capture.artifactBytes !== artifactBytes(backup)
  ) throw new Error("Clone seed operation evidence does not match verified artifacts");
  return { generation: input.generation, directory, backup, operation };
}

export async function readCurrentCloneSeed(input: {
  readonly root: string;
  readonly verify?: (directory: string) => Promise<VerifiedFullBackup>;
  readonly now?: Date;
  readonly maxAgeMs?: number;
  readonly expectedLineage?: CloneSeedProvenance["lineage"];
}): Promise<CloneSeedHandle | null> {
  const paths = cloneSeedPaths(input.root);
  const pointer = await readPointer(paths.currentPointer);
  if (pointer === null) return null;
  return readSeedAtGeneration({
    paths,
    generation: pointer.generation,
    verify: input.verify ?? verifyFullBackupDirectory,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.maxAgeMs === undefined ? {} : { maxAgeMs: input.maxAgeMs }),
    ...(input.expectedLineage === undefined ? {} : { expectedLineage: input.expectedLineage }),
  });
}

async function removeGeneration(paths: CloneSeedPaths, generation: string | null): Promise<void> {
  if (generation !== null) await rm(seedGenerationDirectory(paths, generation), { recursive: true, force: true });
}

/**
 * A hard-killed refresh can leave a staging directory or a final generation
 * that was renamed before the current pointer commit. Reconcile only names we
 * own while holding the refresh lock; anything else is an operator-visible
 * safety stop rather than a broad cleanup.
 */
async function reconcileUnreferencedGenerations(paths: CloneSeedPaths): Promise<void> {
  const current = await readPointer(paths.currentPointer);
  const previous = await readPointer(paths.previousPointer);
  if (current === null && previous !== null) {
    throw new Error("Clone seed previous pointer exists without an authoritative current pointer");
  }
  const referenced = new Set([current?.generation, previous?.generation].filter((value): value is string => value !== undefined));
  // Validate references before removing anything. A corrupted pointer must be
  // a zero-mutation safety stop, including for otherwise recognizable orphans.
  for (const generation of referenced) {
    const details = await stat(seedGenerationDirectory(paths, generation)).catch((error: unknown) => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (details === null || !details.isDirectory()) {
      throw new Error("Clone seed pointer references a missing or invalid generation");
    }
  }
  const entries = await readdir(paths.generations);
  for (const entry of entries) {
    const path = join(paths.generations, entry);
    const details = await stat(path);
    if (!details.isDirectory()) throw new Error("Clone seed generations contains an unexpected non-directory entry");
    if (entry.startsWith(".staging-")) {
      const generation = entry.slice(".staging-".length);
      if (!GENERATION_RE.test(generation)) throw new Error("Clone seed generations contains an unsafe staging entry");
      await rm(path, { recursive: true, force: true });
      continue;
    }
    if (!GENERATION_RE.test(entry)) throw new Error("Clone seed generations contains an unknown unsafe entry");
    if (!referenced.has(entry)) await rm(path, { recursive: true, force: true });
  }
}

/** Runs a refresh under an immediate owner-only lock. It never waits on another worktree. */
export async function withCloneSeedRefreshLock<T>(
  root: string,
  action: () => Promise<T>,
  cleanup?: () => Promise<void>,
): Promise<T> {
  const paths = cloneSeedPaths(root);
  await ensureStore(paths);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  for (let attempt = 0; attempt < 2 && handle === null; attempt += 1) {
    let candidate: Awaited<ReturnType<typeof open>>;
    try {
      candidate = await open(paths.lock, "wx", 0o600);
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST")) throw error;
      let lock: unknown;
      try {
        lock = JSON.parse(await readFile(paths.lock, "utf8")) as unknown;
      } catch {
        throw new Error("Clone seed refresh lock cannot be proved stale; inspect or remove it after confirming no refresh is active");
      }
      const pid = typeof lock === "object" && lock !== null && !Array.isArray(lock) ? (lock as Record<string, unknown>)["pid"] : undefined;
      if (!Number.isSafeInteger(pid) || (pid as number) < 1) {
        throw new Error("Clone seed refresh lock cannot be proved stale; inspect or remove it after confirming no refresh is active");
      }
      try {
        process.kill(pid as number, 0);
        throw new CloneSeedBusyError();
      } catch (livenessError) {
        if (typeof livenessError === "object" && livenessError !== null && "code" in livenessError && (livenessError as { code?: unknown }).code === "ESRCH") {
          await rm(paths.lock, { force: true });
          continue;
        }
        throw livenessError;
      }
    }
    try {
      await candidate.chmod(0o600);
      await candidate.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, "utf8");
      handle = candidate;
    } catch (error) {
      await candidate.close().catch(() => undefined);
      await rm(paths.lock, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  if (handle === null) throw new CloneSeedBusyError();
  try {
    return await action();
  } finally {
    try {
      await cleanup?.();
    } finally {
      await handle.close();
      await rm(paths.lock, { force: true });
    }
  }
}

export async function refreshCloneSeed(input: RefreshCloneSeedInput): Promise<CloneSeedHandle> {
  const paths = cloneSeedPaths(input.root);
  const verify = input.verify ?? verifyFullBackupDirectory;
  const now = input.now ?? (() => new Date());
  const copy = input.copy ?? copyFile;
  const diskSpace = input.diskSpace ?? (async (path) => {
    const fs = await statfs(path);
    return { bavail: Number(fs.bavail), bsize: Number(fs.bsize) };
  });
  return withCloneSeedRefreshLock(paths.root, async () => {
    await reconcileUnreferencedGenerations(paths);
    const startedAt = now();
    let source: VerifiedFullBackup | null = null;
    let staging: string | null = null;
    let publishedGeneration: string | null = null;
    let stage: "capture" | "verification" | "publication" = "capture";
    try {
      source = await input.capture();
      // A capture callback must not be trusted merely because it claims this type.
      stage = "verification";
      source = await verify(source.dir);
      const free = await diskSpace(paths.root);
      if (!Number.isFinite(free.bavail) || !Number.isFinite(free.bsize) || free.bavail < 0 || free.bsize < 1 || free.bavail * free.bsize < artifactBytes(source)) {
        throw new Error("Insufficient free disk space for clone seed staging");
      }
      const generation = safeGeneration(input.generation?.() ?? `seed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
      staging = join(paths.generations, `.staging-${generation}`);
      const backupContainer = join(staging, "backup");
      await ownerOnlyDirectory(backupContainer);
      const stagedBackup = join(backupContainer, basename(source.dir));
      await ownerOnlyDirectory(staging);
      await copyVerifiedBackup({ source, destination: stagedBackup, copy });
      const verifiedStaging = await verify(stagedBackup);
      const manifestSha256 = await sha256File(join(stagedBackup, "manifest.json"));
      const operation = createPublishedOperation({
        provenance: input.provenance,
        backup: verifiedStaging,
        manifestSha256,
        startedAt,
        updatedAt: now(),
      });
      await writeCloneSeedOperationRecord(join(staging, "operation.json"), operation);
      stage = "publication";
      await input.beforePublish?.();
      const finalDirectory = seedGenerationDirectory(paths, generation);
      await rename(staging, finalDirectory);
      staging = null;
      publishedGeneration = generation;
      // The final path is verified before it can become authoritative. Do not
      // add a fallible read after current.json is atomically replaced.
      const published = await readSeedAtGeneration({ paths, generation, verify });

      const oldCurrent = await readPointer(paths.currentPointer);
      const oldPrevious = await readPointer(paths.previousPointer);
      // Delete the superseded fallback before pointer publication. A failed
      // publication therefore leaves the old current authoritative and bounded.
      if (oldPrevious !== null && oldPrevious.generation !== oldCurrent?.generation) {
        await removeGeneration(paths, oldPrevious.generation);
      }
      if (oldCurrent === null) {
        await rm(paths.previousPointer, { force: true });
      } else {
        await writeOwnerOnlyJsonAtomically(paths.previousPointer, oldCurrent);
      }
      await writeOwnerOnlyJsonAtomically(paths.currentPointer, { formatVersion: STORE_FORMAT_VERSION, generation });
      // The pointer replacement is the commit point. Observers cannot turn a
      // committed, readable seed into a failed refresh.
      await input.afterPublish?.().catch(() => undefined);
      return published;
    } catch (error) {
      if (staging !== null) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      if (publishedGeneration !== null) {
        const current = await readPointer(paths.currentPointer).catch(() => null);
        if (current?.generation !== publishedGeneration) {
          await removeGeneration(paths, publishedGeneration).catch(() => undefined);
        }
      }
      const code = source === null
        ? "seed-capture-failed"
        : stage === "verification"
          ? "seed-verification-failed"
          : "seed-publication-failed";
      await writeFailureEvidence(paths, {
        provenance: input.provenance,
        backup: source,
        startedAt,
        updatedAt: now(),
        code,
      }).catch(() => undefined);
      throw error;
    }
  }, input.cleanupCapture);
}
