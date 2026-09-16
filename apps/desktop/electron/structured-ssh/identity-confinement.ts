import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";

import { isCanonicalSshHost, type SshHostTrustTarget } from "./contracts.ts";
import { validateSystemAgentPublicKey } from "./system-agent.ts";

const SCRATCH_DIRECTORY_PREFIX = "structured-ssh-run-";
const KNOWN_HOSTS_FILE_NAME = "known_hosts";
const MAX_PATH_BYTES = 4 * 1024;
const MAX_KNOWN_HOSTS_LINE_BYTES = 8 * 1024;
const MAX_DIRECTORY_ATTEMPTS = 3;

interface StructuredSshFileStat {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  readonly dev: number;
  readonly ino: number;
}

interface StructuredSshWritableFile {
  writeFile(data: string): Promise<void>;
  close(): Promise<void>;
}

/** Narrow Electron-local filesystem seam. It never reads or writes an identity. */
export interface StructuredSshHostTrustFileSystem {
  mkdir(path: string, options: { readonly recursive: boolean; readonly mode: number }): Promise<unknown>;
  lstat(path: string): Promise<StructuredSshFileStat>;
  realpath(path: string): Promise<string>;
  open(path: string, flags: "wx", mode: number): Promise<StructuredSshWritableFile>;
  chmod(path: string, mode: number): Promise<void>;
  rm(path: string, options: { readonly force: true; readonly recursive?: boolean }): Promise<void>;
}

export interface StructuredSshHostTrustConfinementDependencies {
  readonly fs?: StructuredSshHostTrustFileSystem;
  readonly randomHex?: () => string;
}

export interface CreateStructuredSshHostTrustBundleInput {
  /** App-owned directory, never a Human SSH directory. */
  readonly appDataDirectory: string;
  /** Target used to reconstruct the exact app-private known_hosts line. */
  readonly target: SshHostTrustTarget;
  /** Exact `canonical-host-token validated-public-key` observation output. */
  readonly knownHostsLine: string;
}

export interface StructuredSshHostTrustBundle {
  /** Fixed OpenSSH configuration fragments. No identity source is selected here. */
  readonly argv: readonly string[];
  /** Redacts app-private scratch/trust paths without exposing those values. */
  redactOutput(value: string): string;
  /** Rechecks app-private known_hosts confinement immediately before launch. */
  validateForLaunch(): Promise<void>;
  /** Removes only the exact known_hosts file and empty app-private directory. */
  cleanup(): Promise<void>;
}

interface FileIdentity { readonly dev: number; readonly ino: number; }
interface DirectorySnapshot extends FileIdentity { readonly path: string; }
interface FileSnapshot extends FileIdentity { readonly path: string; }

function isAbsoluteSafePath(value: string): boolean {
  return nodePath.isAbsolute(value) && Buffer.byteLength(value, "utf8") <= MAX_PATH_BYTES && !/[\0\r\n]/.test(value);
}

function isLiteralOpenSshPath(value: string): boolean {
  return !/[%$]/.test(value);
}

function strictDescendant(parent: string, child: string): boolean {
  const relative = nodePath.relative(parent, child);
  return relative.length > 0 && !relative.startsWith(`..${nodePath.sep}`) && relative !== ".." && !nodePath.isAbsolute(relative);
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function literalRedactor(values: readonly string[]): (value: string) => string {
  const sensitive = [...new Set(values.filter((value) => value.length > 1))]
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  return (value) => sensitive.reduce((redacted, secret) => redacted.split(secret).join("[local-path-redacted]"), value);
}

function fileIdentity(stat: StructuredSshFileStat, label: string): FileIdentity {
  if (!Number.isSafeInteger(stat.dev) || !Number.isSafeInteger(stat.ino) || stat.dev < 0 || stat.ino < 0) {
    throw new Error(`structured SSH ${label} identity is invalid`);
  }
  return { dev: stat.dev, ino: stat.ino };
}

function validTarget(value: unknown): value is SshHostTrustTarget {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2
    && Object.prototype.hasOwnProperty.call(record, "host")
    && Object.prototype.hasOwnProperty.call(record, "port")
    && isCanonicalSshHost(record["host"])
    && typeof record["port"] === "number"
    && Number.isSafeInteger(record["port"])
    && record["port"] >= 1
    && record["port"] <= 65_535;
}

function hostToken(target: SshHostTrustTarget): string {
  return target.port === 22 ? target.host : `[${target.host}]:${target.port}`;
}

function canonicalKnownHostsLine(target: SshHostTrustTarget, line: string): string | null {
  if (Buffer.byteLength(line, "utf8") > MAX_KNOWN_HOSTS_LINE_BYTES || /[\0\r\n]/.test(line)) return null;
  const fields = line.split(" ");
  if (fields.length !== 3 || fields.some((field) => field.length === 0)) return null;
  const validated = validateSystemAgentPublicKey(`${fields[1]!} ${fields[2]!}`);
  if (validated === null) return null;
  const expected = `${hostToken(target)} ${validated.canonical}`;
  return line === expected ? expected : null;
}

async function canonicalDirectory(fs: StructuredSshHostTrustFileSystem, path: string, label: string): Promise<DirectorySnapshot> {
  const stat = await fs.lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`structured SSH ${label} is invalid`);
  const canonical = await fs.realpath(path);
  if (canonical !== path) throw new Error(`structured SSH ${label} must be canonical`);
  return { path: canonical, ...fileIdentity(stat, label) };
}

async function captureScratchFile(fs: StructuredSshHostTrustFileSystem, directory: DirectorySnapshot, path: string): Promise<FileSnapshot> {
  const stat = await fs.lstat(path);
  const canonical = await fs.realpath(path);
  if (!stat.isFile() || stat.isSymbolicLink() || canonical !== path || !strictDescendant(directory.path, canonical)) {
    throw new Error("structured SSH known-hosts file was replaced");
  }
  return { path, ...fileIdentity(stat, "known-hosts file") };
}

async function writeScratchFile(fs: StructuredSshHostTrustFileSystem, directory: DirectorySnapshot, path: string, bytes: string): Promise<FileSnapshot> {
  let file: StructuredSshWritableFile | undefined;
  try {
    file = await fs.open(path, "wx", 0o600);
    await file.writeFile(bytes);
    await file.close();
    file = undefined;
    await fs.chmod(path, 0o600);
    return await captureScratchFile(fs, directory, path);
  } catch (error) {
    try { await file?.close(); } catch { /* Best effort only. */ }
    throw error;
  }
}

function quoteOpenSshConfigPath(path: string): string {
  if (/[\0\r\n]/.test(path)) throw new Error("structured SSH OpenSSH path is invalid");
  return /^[A-Za-z0-9_./-]+$/.test(path) ? path : `"${path.replace(/[\\"]/g, "\\$&")}"`;
}

/**
 * The broker supplies `-F /dev/null`, so no Human config (including Match
 * exec) is parsed at launch. These remaining options pin host trust even with
 * that empty config and prevent later host-key mutation.
 */
function createArgv(knownHostsPath: string): readonly string[] {
  return Object.freeze([
    "-o", `UserKnownHostsFile=${quoteOpenSshConfigPath(knownHostsPath)}`,
    "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "UpdateHostKeys=no",
    "-o", "BatchMode=yes",
    "-o", "ClearAllForwardings=yes",
  ]);
}

/**
 * Materialize only the independently observed, app-local host-key pin. The
 * launch remains free to use ordinary configured/default identities; this
 * module never writes a public or private identity file and never touches
 * Human ~/.ssh configuration or known_hosts files.
 */
export async function createStructuredSshHostTrustBundle(
  input: CreateStructuredSshHostTrustBundleInput,
  dependencies: StructuredSshHostTrustConfinementDependencies = {},
): Promise<StructuredSshHostTrustBundle> {
  if (!validTarget(input.target) || typeof input.knownHostsLine !== "string" || canonicalKnownHostsLine(input.target, input.knownHostsLine) === null || !isAbsoluteSafePath(input.appDataDirectory) || !isLiteralOpenSshPath(input.appDataDirectory)) {
    throw new Error("structured SSH host-trust confinement input is invalid");
  }
  const knownHostsLine = canonicalKnownHostsLine(input.target, input.knownHostsLine)!;
  const fs = dependencies.fs ?? nodeFs;
  const appData = await canonicalDirectory(fs, nodePath.resolve(input.appDataDirectory), "app-data directory");
  const randomHex = dependencies.randomHex ?? (() => randomBytes(16).toString("hex"));
  let runDirectory: DirectorySnapshot | undefined;
  for (let attempt = 0; attempt < MAX_DIRECTORY_ATTEMPTS; attempt += 1) {
    const suffix = randomHex();
    if (!/^[a-f0-9]{16,128}$/.test(suffix)) throw new Error("structured SSH scratch identifier is invalid");
    const candidate = nodePath.join(appData.path, `${SCRATCH_DIRECTORY_PREFIX}${suffix}`);
    try {
      await fs.mkdir(candidate, { recursive: false, mode: 0o700 });
      await fs.chmod(candidate, 0o700);
      const captured = await canonicalDirectory(fs, candidate, "scratch directory");
      if (!strictDescendant(appData.path, captured.path)) throw new Error("structured SSH scratch path was replaced");
      runDirectory = captured;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt === MAX_DIRECTORY_ATTEMPTS - 1) throw error;
    }
  }
  if (runDirectory === undefined) throw new Error("structured SSH scratch directory is unavailable");
  const knownHostsPath = nodePath.join(runDirectory.path, KNOWN_HOSTS_FILE_NAME);
  let knownHostsFile: FileSnapshot;
  try {
    knownHostsFile = await writeScratchFile(fs, runDirectory, knownHostsPath, `${knownHostsLine}\n`);
  } catch (error) {
    try {
      const current = await canonicalDirectory(fs, runDirectory.path, "scratch directory");
      if (sameIdentity(runDirectory, current)) await fs.rm(runDirectory.path, { force: true });
    } catch { /* Replacement races deliberately leave state behind. */ }
    throw error;
  }

  async function validateForLaunch(): Promise<void> {
    const currentAppData = await canonicalDirectory(fs, appData.path, "app-data directory");
    if (!sameIdentity(appData, currentAppData)) throw new Error("structured SSH app-data directory changed before launch");
    const currentRunDirectory = await canonicalDirectory(fs, runDirectory!.path, "scratch directory");
    if (!strictDescendant(currentAppData.path, currentRunDirectory.path) || !sameIdentity(runDirectory!, currentRunDirectory)) throw new Error("structured SSH scratch directory changed before launch");
    const currentKnownHosts = await captureScratchFile(fs, currentRunDirectory, knownHostsFile.path);
    if (!sameIdentity(knownHostsFile, currentKnownHosts)) throw new Error("structured SSH known-hosts file changed before launch");
  }

  let cleanup: Promise<void> | undefined;
  const redactOutput = literalRedactor([knownHostsPath, runDirectory.path, appData.path]);
  return {
    argv: createArgv(knownHostsPath),
    redactOutput,
    validateForLaunch,
    cleanup: () => {
      cleanup ??= (async () => {
        try {
          await validateForLaunch();
          await fs.rm(knownHostsFile.path, { force: true });
          const currentRunDirectory = await canonicalDirectory(fs, runDirectory.path, "scratch directory");
          if (sameIdentity(runDirectory, currentRunDirectory)) await fs.rm(runDirectory.path, { force: true });
        } catch { /* Replacement or cleanup races deliberately leave state behind. */ }
      })();
      return cleanup;
    },
  };
}
