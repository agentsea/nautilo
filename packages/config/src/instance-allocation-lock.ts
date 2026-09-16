import {
  chmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  lstatSync,
  unlinkSync,
  writeFileSync,
  closeSync,
  fsyncSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const LOCK_DIRECTORY = ".nautilo-instance-allocation.lock";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 25;
const SAFE_TOKEN = /^[a-zA-Z0-9-]{8,128}$/;

interface AllocationLockOwner {
  readonly pid: number;
  readonly token: string;
  readonly createdAt: string;
}

export interface InstanceAllocationLockOptions {
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly now?: () => number;
  readonly token?: () => string;
  /** Test notification after the unique claim exists and before the action. */
  readonly acquired?: () => void;
  /** Test notification after observing an existing valid lock. */
  readonly contended?: () => void;
}

export class InstanceAllocationBusyError extends Error {
  constructor(lockPath: string) {
    super(
      `Timed out waiting for Nautilo instance allocation lock at ${lockPath}; ` +
        "another worktree may still be creating an instance. Inspect the owner-only claim before removing a stale lock.",
    );
    this.name = "InstanceAllocationBusyError";
  }
}

export function instanceAllocationLockPath(userHomeDir: string): string {
  return join(userHomeDir, LOCK_DIRECTORY);
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === code;
}

function claimFile(lockPath: string, token: string): string {
  if (!SAFE_TOKEN.test(token)) throw new Error("Unsafe Nautilo instance allocation lock token");
  return join(lockPath, `${token}.json`);
}

function parseOwner(raw: string): AllocationLockOwner | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      typeof value !== "object" || value === null || Array.isArray(value) ||
      !Number.isSafeInteger((value as { pid?: unknown }).pid) ||
      (value as { pid: number }).pid <= 0 ||
      typeof (value as { token?: unknown }).token !== "string" ||
      !SAFE_TOKEN.test((value as { token: string }).token) ||
      typeof (value as { createdAt?: unknown }).createdAt !== "string"
    ) return null;
    return value as AllocationLockOwner;
  } catch {
    return null;
  }
}

function assertOwnerOnlyLockDirectory(lockPath: string): void {
  try {
    const details = lstatSync(lockPath);
    if (!details.isDirectory() || (details.mode & 0o077) !== 0) {
      throw new Error(`Nautilo instance allocation lock is not owner-only: ${lockPath}`);
    }
    const entries = readdirSync(lockPath);
    if (entries.length > 1) {
      throw new Error(`Nautilo instance allocation lock has multiple claims: ${lockPath}`);
    }
    if (entries.length === 1) {
      const name = entries[0] as string;
      const token = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!SAFE_TOKEN.test(token)) {
        throw new Error(`Nautilo instance allocation lock has an unsafe claim: ${lockPath}`);
      }
      const claim = join(lockPath, name);
      const claimDetails = lstatSync(claim);
      const owner = parseOwner(readFileSync(claim, "utf8"));
      if (!claimDetails.isFile() || (claimDetails.mode & 0o077) !== 0 || owner?.token !== token) {
        throw new Error(`Nautilo instance allocation lock claim is invalid: ${claim}`);
      }
    }
  } catch (error) {
    if (isCode(error, "ENOENT")) return;
    throw error;
  }
}

function tryAcquire(lockPath: string, owner: AllocationLockOwner): boolean {
  try {
    mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if (isCode(error, "EEXIST")) return false;
    throw error;
  }
  chmodSync(lockPath, 0o700);
  const path = claimFile(lockPath, owner.token);
  let fd: number | null = null;
  try {
    fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    return true;
  } catch (error) {
    if (fd !== null) closeSync(fd);
    try { unlinkSync(path); } catch { /* keep original acquisition error */ }
    try { rmdirSync(lockPath); } catch { /* keep original acquisition error */ }
    throw error;
  }
}

/**
 * Token-safe release: every owner has a unique claim pathname inside a lock
 * directory. Contenders never mutate an existing directory, so removing this
 * claim cannot remove a replacement owner's claim; `rmdir` succeeds only when
 * no unexpected entry exists.
 */
function release(lockPath: string, token: string): void {
  const path = claimFile(lockPath, token);
  let owner: AllocationLockOwner | null;
  try {
    owner = parseOwner(readFileSync(path, "utf8"));
  } catch (error) {
    if (isCode(error, "ENOENT")) return;
    throw error;
  }
  if (owner?.token !== token) return;
  unlinkSync(path);
  try {
    rmdirSync(lockPath);
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
}

function waitSynchronously(milliseconds: number): void {
  if (milliseconds > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  }
}

/** Serialize sibling scan plus instance.json publication across worktrees. */
export function withInstanceAllocationLockSync<T>(
  userHomeDir: string,
  action: () => T,
  options: InstanceAllocationLockOptions = {},
): T {
  const lockPath = instanceAllocationLockPath(userHomeDir);
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const token = (options.token ?? randomUUID)();
  if (!SAFE_TOKEN.test(token)) throw new Error("Unsafe Nautilo instance allocation lock token");
  const deadline = now() + timeoutMs;
  for (;;) {
    const owner = { pid: process.pid, token, createdAt: new Date(now()).toISOString() };
    if (tryAcquire(lockPath, owner)) {
      try {
        options.acquired?.();
        return action();
      } finally {
        release(lockPath, token);
      }
    }
    assertOwnerOnlyLockDirectory(lockPath);
    options.contended?.();
    if (now() >= deadline) throw new InstanceAllocationBusyError(lockPath);
    waitSynchronously(Math.min(pollMs, Math.max(0, deadline - now())));
  }
}
