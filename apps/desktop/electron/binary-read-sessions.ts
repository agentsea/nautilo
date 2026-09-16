import * as fsp from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";

/** D431's launch envelope. Consumers may impose a stricter format-specific cap. */
const BINARY_READ_SESSION_MAX_FILE_BYTES = 100 * 1024 * 1024;
const BINARY_READ_SESSION_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const BINARY_READ_SESSION_CHUNK_BYTES = 1024 * 1024;
const BINARY_READ_SESSION_MAX_SESSIONS = 8;
const BINARY_READ_SESSION_MAX_SESSIONS_PER_SENDER = 2;
export const BINARY_READ_SESSION_TTL_MS = 30_000;

export type BinaryReadSessionErrorCode =
  | "invalid_request"
  | "not_file"
  | "not_found"
  | "size_limit"
  | "session_limit"
  | "session_not_found"
  | "sender_mismatch"
  | "out_of_order"
  | "read_in_progress"
  | "expired"
  | "mutated"
  | "unavailable";

/** Public errors intentionally contain no path, filename, hash, or file bytes. */
export class BinaryReadSessionError extends Error {
  constructor(
    readonly code: BinaryReadSessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BinaryReadSessionError";
  }
}

export type BinaryReadSessionOpenResult = {
  id: string;
  size: number;
  chunkSize: number;
};

export type BinaryReadSessionChunk = {
  /** Structured-cloned binary data; never a base64 transport. */
  bytes: Uint8Array;
  position: number;
  done: boolean;
};

export type BinaryReadSessionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: BinaryReadSessionErrorCode } };

/**
 * Electron's structured clone does not preserve custom Error fields. Convert
 * the internal error at the IPC boundary so renderers never parse messages.
 */
export async function asBinaryReadSessionResult<T>(
  operation: () => Promise<T>,
): Promise<BinaryReadSessionResult<T>> {
  try {
    return { ok: true, data: await operation() };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error instanceof BinaryReadSessionError ? error.code : "unavailable",
      },
    };
  }
}

type FileVersion = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

type Session = {
  id: string;
  senderId: number;
  canonicalPath: string;
  file: FileHandle;
  version: FileVersion;
  position: number;
  lastActivityMs: number;
  reading: boolean;
  closed: boolean;
};

export type BinaryReadSessionManagerOptions = {
  /** Re-applied to the canonical path after realpath resolution. */
  assertPathInAllowedRoot: (canonicalPath: string) => void;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  chunkBytes?: number;
  maxSessions?: number;
  maxSessionsPerSender?: number;
  inactivityTtlMs?: number;
  now?: () => number;
};

function versionFromStat(stat: Awaited<ReturnType<FileHandle["stat"]>>): FileVersion {
  return {
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    ctimeMs: Number(stat.ctimeMs),
  };
}

function sameVersion(left: FileVersion, right: FileVersion): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Main-process owner for short-lived local-file reads. It deliberately owns
 * FileHandles, canonical paths, and file versions; callers only receive an
 * opaque id and fixed-size binary chunks.
 */
export class BinaryReadSessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private readonly chunkBytes: number;
  private readonly maxSessions: number;
  private readonly maxSessionsPerSender: number;
  private readonly inactivityTtlMs: number;
  private readonly now: () => number;
  private reservedBytes = 0;

  constructor(private readonly options: BinaryReadSessionManagerOptions) {
    this.maxFileBytes = options.maxFileBytes ?? BINARY_READ_SESSION_MAX_FILE_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? BINARY_READ_SESSION_MAX_TOTAL_BYTES;
    this.chunkBytes = options.chunkBytes ?? BINARY_READ_SESSION_CHUNK_BYTES;
    this.maxSessions = options.maxSessions ?? BINARY_READ_SESSION_MAX_SESSIONS;
    this.maxSessionsPerSender = options.maxSessionsPerSender ?? BINARY_READ_SESSION_MAX_SESSIONS_PER_SENDER;
    this.inactivityTtlMs = options.inactivityTtlMs ?? BINARY_READ_SESSION_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async open(senderId: number, requestedPath: unknown): Promise<BinaryReadSessionOpenResult> {
    await this.cleanupExpired();
    if (!Number.isSafeInteger(senderId) || senderId < 0 || typeof requestedPath !== "string") {
      throw new BinaryReadSessionError("invalid_request", "Invalid binary read request.");
    }
    if (this.sessions.size >= this.maxSessions || this.sessionsForSender(senderId) >= this.maxSessionsPerSender) {
      throw new BinaryReadSessionError("session_limit", "Too many active binary reads.");
    }

    let file: FileHandle | null = null;
    try {
      const canonicalPath = await fsp.realpath(requestedPath);
      this.options.assertPathInAllowedRoot(canonicalPath);
      file = await fsp.open(canonicalPath, "r");
      const stat = await file.stat();
      if (!stat.isFile()) {
        throw new BinaryReadSessionError("not_file", "The selected item is not a file.");
      }
      const version = versionFromStat(stat);
      if (!isSafeNonNegativeInteger(version.size) || version.size > this.maxFileBytes) {
        throw new BinaryReadSessionError("size_limit", "The selected file is too large to preview.");
      }
      // Recheck after async canonicalization/open/stat work: concurrent IPC
      // opens can otherwise all pass the inexpensive check at method entry.
      if (this.sessions.size >= this.maxSessions ||
        this.sessionsForSender(senderId) >= this.maxSessionsPerSender ||
        this.reservedBytes + version.size > this.maxTotalBytes) {
        throw new BinaryReadSessionError("session_limit", "Too many active binary reads.");
      }

      const id = randomUUID();
      this.sessions.set(id, {
        id,
        senderId,
        canonicalPath,
        file,
        version,
        position: 0,
        lastActivityMs: this.now(),
        reading: false,
        closed: false,
      });
      this.reservedBytes += version.size;
      file = null;
      return { id, size: version.size, chunkSize: this.chunkBytes };
    } catch (error) {
      if (file) await file.close().catch(() => undefined);
      if (error instanceof BinaryReadSessionError) throw error;
      const code = (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
        ? "not_found"
        : "unavailable";
      throw new BinaryReadSessionError(code, "The selected file is unavailable.");
    }
  }

  async read(senderId: number, id: unknown, position: unknown): Promise<BinaryReadSessionChunk> {
    if (!isSafeNonNegativeInteger(position) || typeof id !== "string") {
      throw new BinaryReadSessionError("invalid_request", "Invalid binary read request.");
    }
    const requestedSession = this.sessions.get(id);
    await this.cleanupExpired();
    if (requestedSession && !this.sessions.has(id)) {
      throw new BinaryReadSessionError("expired", "Binary read session has expired.");
    }
    const session = this.requireOwnedSession(senderId, id);
    if (session.position !== position) {
      throw new BinaryReadSessionError("out_of_order", "Binary chunks must be read in order.");
    }
    if (session.reading) {
      throw new BinaryReadSessionError("read_in_progress", "A binary chunk read is already in progress.");
    }

    session.reading = true;
    session.lastActivityMs = this.now();
    try {
      await this.assertUnchanged(session);
      const remaining = session.version.size - session.position;
      const byteLength = Math.min(this.chunkBytes, remaining);
      const buffer = Buffer.allocUnsafe(byteLength);
      const { bytesRead } = await session.file.read(buffer, 0, byteLength, session.position);
      if (bytesRead !== byteLength) {
        throw new BinaryReadSessionError("mutated", "The selected file changed while it was being read.");
      }
      await this.assertUnchanged(session);
      session.position += bytesRead;
      session.lastActivityMs = this.now();
      const done = session.position === session.version.size;
      // Copy only this bounded chunk out of Node's Buffer before IPC cloning.
      const bytes = Uint8Array.from(buffer.subarray(0, bytesRead));
      const result = { bytes, position: session.position, done };
      if (done) await this.closeSession(session);
      return result;
    } catch (error) {
      await this.closeSession(session);
      if (error instanceof BinaryReadSessionError) throw error;
      throw new BinaryReadSessionError("unavailable", "The selected file is unavailable.");
    } finally {
      session.reading = false;
    }
  }

  /** Close/cancel is deliberately idempotent for a sender-owned session. */
  async close(senderId: number, id: unknown): Promise<void> {
    await this.cleanupExpired();
    if (typeof id !== "string") {
      throw new BinaryReadSessionError("invalid_request", "Invalid binary read request.");
    }
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.senderId !== senderId) {
      throw new BinaryReadSessionError("sender_mismatch", "Binary read session ownership does not match.");
    }
    await this.closeSession(session);
  }

  async closeForSender(senderId: number): Promise<void> {
    await Promise.all(
      [...this.sessions.values()]
        .filter((session) => session.senderId === senderId)
        .map((session) => this.closeSession(session)),
    );
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => this.closeSession(session)));
  }

  async cleanupExpired(now = this.now()): Promise<void> {
    await Promise.all(
      [...this.sessions.values()]
        .filter((session) => !session.reading && now - session.lastActivityMs >= this.inactivityTtlMs)
        .map((session) => this.closeSession(session)),
    );
  }

  get activeSessionCount(): number {
    return this.sessions.size;
  }

  hasSessionsForSender(senderId: number): boolean {
    return this.sessionsForSender(senderId) > 0;
  }

  private sessionsForSender(senderId: number): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.senderId === senderId) count += 1;
    }
    return count;
  }

  private requireOwnedSession(senderId: number, id: string): Session {
    const session = this.sessions.get(id);
    if (!session || session.closed) {
      throw new BinaryReadSessionError("session_not_found", "Binary read session is no longer active.");
    }
    if (session.senderId !== senderId) {
      throw new BinaryReadSessionError("sender_mismatch", "Binary read session ownership does not match.");
    }
    return session;
  }

  private async assertUnchanged(session: Session): Promise<void> {
    const [handleStat, pathStat] = await Promise.all([
      session.file.stat(),
      fsp.stat(session.canonicalPath),
    ]);
    if (!handleStat.isFile() || !pathStat.isFile() ||
      !sameVersion(session.version, versionFromStat(handleStat)) ||
      !sameVersion(session.version, versionFromStat(pathStat))) {
      throw new BinaryReadSessionError("mutated", "The selected file changed while it was being read.");
    }
  }

  private async closeSession(session: Session): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    this.sessions.delete(session.id);
    this.reservedBytes -= session.version.size;
    await session.file.close().catch(() => undefined);
  }
}
