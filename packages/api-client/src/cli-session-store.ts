import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { resolveNautiloRootDir } from "@nautilo/config";
import { CliSessionV1, type CliSessionV1Payload } from "./schemas/cli-session";

const FILE_NAME = "cli-session.json";
const SESSIONS_SUBDIR = "sessions";
const BAK_SUFFIX = ".bak";
const MODE_0600 = 0o600;
const MODE_0700 = 0o700;
const LOCK_WAIT_MS = 1_000;
const LOCK_POLL_MS = 10;

const inProcessWriteQueues = new Map<string, Promise<void>>();

export class CliSessionMissingError extends Error {
  constructor(message = "No CLI session") {
    super(message);
    this.name = "CliSessionMissingError";
  }
}

export class CliSessionExpiredError extends Error {
  constructor(message = "CLI session expired") {
    super(message);
    this.name = "CliSessionExpiredError";
  }
}

export class CliSessionFileModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliSessionFileModeError";
  }
}

/** Filesystem, ownership, symlink, or lock safety validation failed. */
export class CliSessionSecurityError extends Error {
  constructor(message = "CLI session storage failed a security check") {
    super(message);
    this.name = "CliSessionSecurityError";
  }
}

/** A second writer did not finish before the bounded lock wait elapsed. */
export class CliSessionWriteConflictError extends Error {
  constructor(message = "CLI session is being updated by another process") {
    super(message);
    this.name = "CliSessionWriteConflictError";
  }
}

export interface CliSessionPathOpts {
  /** Profile name. When omitted, uses the legacy single-file path. */
  profile?: string;
}

export type CliSessionListRow = {
  profileName: string;
  payload: CliSessionV1Payload;
};

type LockRecord = { pid: number; nonce: string; createdAt: number };

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function cliSessionDir(): string {
  const override = process.env["NAUTILO_HOME_OVERRIDE"];
  return override
    ? resolveNautiloRootDir({ userHomeDir: override })
    : resolveNautiloRootDir();
}

/** Profile filenames are identifiers, never paths. */
export function validateCliSessionProfileName(profile: string): string {
  if (
    profile.length === 0 ||
    Buffer.byteLength(profile, "utf8") > 200 ||
    profile === "." ||
    profile === ".." ||
    profile === ".active" ||
    profile.includes("/") ||
    profile.includes("\\") ||
    Array.from(profile).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new CliSessionSecurityError("Invalid CLI session profile name");
  }
  return profile;
}

function sessionFileName(opts?: CliSessionPathOpts): string {
  return opts?.profile ? `${validateCliSessionProfileName(opts.profile)}.json` : FILE_NAME;
}

function sessionFileDir(opts?: CliSessionPathOpts): string {
  const dir = cliSessionDir();
  return opts?.profile ? join(dir, SESSIONS_SUBDIR) : dir;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Filesystem enumeration must not inherit locale-sensitive sort semantics. */
export function compareCliSessionProfileNames(left: string, right: string): number {
  const byteOrder = Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
  if (byteOrder !== 0) return byteOrder;
  // UTF-8 equality implies string equality, but retain an explicit stable
  // code-unit tie-break rather than relying on a locale comparator returning 0.
  return left < right ? -1 : left > right ? 1 : 0;
}

async function assertOwnedRegularFile(path: string): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new CliSessionSecurityError();
  }
  if ((entry.mode & 0o777) !== MODE_0600) throw new CliSessionFileModeError("CLI session file must be mode 0600");
  const uid = currentUid();
  if (uid !== undefined && entry.uid !== uid) throw new CliSessionSecurityError();
}

async function assertOwnedRemovableRegularFile(path: string): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new CliSessionSecurityError();
  const uid = currentUid();
  if (uid !== undefined && entry.uid !== uid) throw new CliSessionSecurityError();
}

async function ensureOwnedSessionDir(path: string, requireMode0700: boolean): Promise<void> {
  await mkdir(path, { recursive: true, mode: MODE_0700 });
  let entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new CliSessionSecurityError();
  const uid = currentUid();
  if (uid !== undefined && entry.uid !== uid) throw new CliSessionSecurityError();
  if (requireMode0700 && (entry.mode & 0o777) !== MODE_0700) {
    // Historical sessions/ directories inherited the process umask. Harden
    // only after ownership/non-symlink validation, then verify again.
    await chmod(path, MODE_0700);
    entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o777) !== MODE_0700) {
      throw new CliSessionSecurityError();
    }
  }
}

async function assertOwnedExistingDir(path: string): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new CliSessionSecurityError();
  const uid = currentUid();
  if (uid !== undefined && entry.uid !== uid) throw new CliSessionSecurityError();
}

async function ensureSessionFileDir(opts?: CliSessionPathOpts): Promise<void> {
  // The Nautilo root predates the session store and may legitimately hold
  // non-secret installation data. Only the dedicated sessions directory is
  // required to be 0700.
  await ensureOwnedSessionDir(cliSessionDir(), false);
  if (opts?.profile) await ensureOwnedSessionDir(sessionFileDir(opts), true);
}

function lockPath(opts?: CliSessionPathOpts): string {
  return `${cliSessionPath(opts)}.lock`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function withFilesystemSessionWriteLock<T>(
  opts: CliSessionPathOpts | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  await ensureSessionFileDir(opts);
  const path = lockPath(opts);
  const deadline = Date.now() + LOCK_WAIT_MS;
  let acquired = false;
  let nonce: string | undefined;
  while (!acquired) {
    const candidateNonce = randomUUID();
    const candidate = `${path}.owner.${candidateNonce}`;
    try {
      // Build a complete ownership record before atomically linking it into
      // the lock name. A crash can leave only an unreferenced candidate, never
      // a lock whose owner is unknowable.
      await writeFile(candidate, JSON.stringify({ pid: process.pid, nonce: candidateNonce, createdAt: Date.now() }), { mode: MODE_0600 });
      await chmod(candidate, MODE_0600);
      await link(candidate, path);
      nonce = candidateNonce;
      acquired = true;
    } catch (error) {
      if (!isMissing(error) && (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Never reclaim a lock automatically. Without an OS compare-and-delete
      // primitive, PID/mtime-based stale recovery can unlink a replacement
      // owner's live lock. A crash therefore fails closed with a bounded
      // conflict until the owned lock file is inspected and removed.
      if (Date.now() >= deadline) throw new CliSessionWriteConflictError();
      await sleep(LOCK_POLL_MS);
    } finally {
      await unlink(candidate).catch(() => undefined);
    }
  }
  try {
    return await operation();
  } finally {
    // Only remove our own lock. A malformed/replaced lock is left for the
    // next bounded acquisition rather than risking deletion of a live owner.
    try {
      const raw = await readFile(path, "utf8");
      if ((JSON.parse(raw) as Partial<LockRecord>).nonce === nonce) await unlink(path);
    } catch {
      /* already removed or unsafe to remove */
    }
  }
}

/**
 * Serialize writers in this process before taking the cross-process lock.
 * Without this queue a burst of local callers can consume the entire bounded
 * filesystem-lock window while competing with siblings from the same process.
 */
async function withSessionWriteLock<T>(
  opts: CliSessionPathOpts | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const path = lockPath(opts);
  const previous = inProcessWriteQueues.get(path) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => turn);
  inProcessWriteQueues.set(path, tail);

  await previous.catch(() => undefined);
  try {
    return await withFilesystemSessionWriteLock(opts, operation);
  } finally {
    release();
    if (inProcessWriteQueues.get(path) === tail) inProcessWriteQueues.delete(path);
  }
}

export function cliSessionPath(opts?: CliSessionPathOpts): string {
  return join(sessionFileDir(opts), sessionFileName(opts));
}

export async function loadCliSession(
  opts?: CliSessionPathOpts,
): Promise<CliSessionV1Payload | null> {
  // Validate the supplied profile even when its file does not exist.
  if (opts?.profile) validateCliSessionProfileName(opts.profile);
  const path = cliSessionPath(opts);
  try {
    await assertOwnedExistingDir(cliSessionDir());
    if (opts?.profile) await assertOwnedExistingDir(sessionFileDir(opts));
    await assertOwnedRegularFile(path);
    const raw = await readFile(path, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    const result = CliSessionV1.safeParse(parsed);
    if (!result.success) {
      throw new CliSessionSecurityError("CLI session payload failed validation");
    }
    return result.data;
  } catch (error) {
    if (isMissing(error)) return null;
    if (error instanceof CliSessionSecurityError || error instanceof CliSessionFileModeError) throw error;
    throw new CliSessionSecurityError("CLI session could not be read or parsed");
  }
}

async function saveCliSessionUnlocked(
  s: CliSessionV1Payload,
  opts?: CliSessionPathOpts,
): Promise<void> {
  const finalPath = cliSessionPath(opts);
  try {
    await assertOwnedRegularFile(finalPath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const tmp = join(
    sessionFileDir(opts),
    `.${sessionFileName(opts)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const payload = { ...s, revision: randomUUID() };
  try {
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: MODE_0600 });
    await chmod(tmp, MODE_0600);
    await rename(tmp, finalPath);
    await chmod(finalPath, MODE_0600);
    await assertOwnedRegularFile(finalPath);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

export async function saveCliSession(
  s: CliSessionV1Payload,
  opts?: CliSessionPathOpts,
): Promise<void> {
  if (!CliSessionV1.safeParse(s).success) {
    throw new CliSessionSecurityError("Invalid CLI session payload");
  }
  // Preserve the precise legacy mode error when a caller attempts to
  // overwrite an already-existing file; directory validation follows before
  // any write is possible.
  try {
    await assertOwnedRegularFile(cliSessionPath(opts));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await withSessionWriteLock(opts, () => saveCliSessionUnlocked(s, opts));
}

/** Opaque revision CAS: a token value cannot satisfy this after an ABA write. */
export async function saveCliSessionIfRevisionMatches(
  expectedRevision: string | undefined,
  replacement: CliSessionV1Payload,
  opts?: CliSessionPathOpts,
): Promise<boolean> {
  if (!expectedRevision) return false;
  if (!CliSessionV1.safeParse(replacement).success) {
    throw new CliSessionSecurityError("Invalid CLI session replacement");
  }
  return withSessionWriteLock(opts, async () => {
    const current = await loadCliSession(opts);
    if (!current || current.revision !== expectedRevision) return false;
    await saveCliSessionUnlocked(replacement, opts);
    return true;
  });
}

export async function clearCliSession(opts?: CliSessionPathOpts): Promise<void> {
  await withSessionWriteLock(opts, async () => {
    const path = cliSessionPath(opts);
    try {
      await assertOwnedRemovableRegularFile(path);
      await unlink(path);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
  });
}

/**
 * List profile-scoped cached sessions through the same ownership, mode, and
 * schema checks as a normal session load.  Callers must never enumerate the
 * filesystem themselves: this preserves NAUTILO_HOME_OVERRIDE semantics and
 * prevents an unsafe file from being rendered as identity data.
 */
export async function listCliSessions(): Promise<CliSessionListRow[]> {
  const root = cliSessionDir();
  const sessions = join(root, SESSIONS_SUBDIR);
  try {
    await assertOwnedExistingDir(root);
  } catch (error) {
    if (isMissing(error)) {
      const legacy = await loadCliSession();
      return legacy ? [{ profileName: "(default)", payload: legacy }] : [];
    }
    throw error;
  }
  let names: string[];
  try {
    await assertOwnedExistingDir(sessions);
    names = await readdir(sessions);
  } catch (error) {
    // No profile directory is a normal legacy state.  Continue through the
    // common empty-row fallback below so an owned legacy session is visible.
    if (isMissing(error)) names = [];
    else throw error;
  }
  const profileNames = names
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .map((name) => name.slice(0, -".json".length))
    .sort(compareCliSessionProfileNames);
  const rows: CliSessionListRow[] = [];
  for (const profileName of profileNames) {
    // A malformed filename must not become a path component.
    validateCliSessionProfileName(profileName);
    const payload = await loadCliSession({ profile: profileName });
    if (payload) rows.push({ profileName, payload });
  }
  if (rows.length === 0) {
    const legacy = await loadCliSession();
    if (legacy) rows.push({ profileName: "(default)", payload: legacy });
  }
  return rows;
}

export async function requireSession(
  opts?: CliSessionPathOpts,
): Promise<CliSessionV1Payload> {
  const s = await loadCliSession(opts);
  if (!s) throw new CliSessionMissingError();
  if (s.expiresAt <= Date.now()) throw new CliSessionExpiredError();
  return s;
}

export async function touchCliSessionObtainedAt(opts?: CliSessionPathOpts): Promise<void> {
  const s = await loadCliSession(opts);
  if (s) await saveCliSession({ ...s, obtainedAt: Date.now() }, opts);
}

/** One-shot, locked migration of the old single-file session into a profile. */
export async function migrateLegacySessionFile(profile: string): Promise<boolean> {
  validateCliSessionProfileName(profile);
  const opts = { profile };
  // Always take the legacy lock before the target lock. A simultaneous legacy
  // save and migration therefore cannot race the backup rename.
  return withSessionWriteLock(undefined, async () => withSessionWriteLock(opts, async () => {
    const target = cliSessionPath(opts);
    try {
      await lstat(target);
      return false;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const targetDir = sessionFileDir(opts);
    const files = await readdir(targetDir).catch((error: unknown) => {
      if (isMissing(error)) return [] as string[];
      throw error;
    });
    if (files.some((file) => file.endsWith(".json"))) return false;

    const legacy = cliSessionPath();
    try {
      await assertOwnedRegularFile(legacy);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    const backup = `${legacy}${BAK_SUFFIX}`;
    try {
      await lstat(backup);
      throw new CliSessionSecurityError("Legacy CLI session backup already exists");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const raw = await readFile(legacy, "utf8");
    let parsed: ReturnType<typeof CliSessionV1.safeParse>;
    try {
      parsed = CliSessionV1.safeParse(JSON.parse(raw));
    } catch {
      return false;
    }
    if (!parsed.success) return false;
    await saveCliSessionUnlocked(parsed.data, opts);
    await rename(legacy, backup);
    return true;
  }));
}
