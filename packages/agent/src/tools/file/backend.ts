/**
 * M174 — `FileBackend` seam for the unified `file` tool.
 *
 * The `file` tool stays `executor:"cloud"`: all matching, scanning,
 * approval, and revision/artifact logic runs in the server process.
 * Only the raw byte I/O is abstracted behind this interface so that the
 * `current` and `absolute` zones can be served by a connected relay (the
 * user's machine) when the server lives elsewhere (M115 remote droplet),
 * while the `workspace` zone keeps running locally (it is DB/artifact-
 * backed and inherently server-side).
 *
 * Backend selection happens once per `file` call, keyed on the resolved
 * zone (see `selectFileBackend`):
 *   - workspace / home / scratch → `LocalFileBackend` (node:fs/promises)
 *   - current / absolute → M206 `executeLocalFileCommand` (typed `local-file`
 *     relay dispatch; never `RelayFileBackend` / `fs` primitives)
 */

import * as fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import type {
  RelayFsChangeEvent,
  RelayFsDirEntry,
  RelayFsRequest,
  RelayFsResult,
  RelayFsStat,
} from "@nautilo/relay";
import type { ToolRelayRegistry } from "../../nodes/tools";
import { writeAtomic } from "./atomic-write";

/** Minimal `Dirent`-shaped value the read handlers consume. */
export interface BackendDirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** Minimal `Stats`-shaped value the read/stat handlers consume. */
export interface BackendStat {
  sourceVersion?: string;
  size: number;
  mtime: Date;
  birthtime: Date;
  mode: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
}

export interface BackendWriteOptions {
  mode?: number;
  changeEvent?: RelayFsChangeEvent;
}

/**
 * Byte-I/O surface every `file` command handler uses instead of calling
 * `node:fs/promises` directly. Error semantics match Node: methods throw
 * `NodeJS.ErrnoException`-shaped errors with `.code` set (ENOENT/EACCES/
 * EISDIR/EXDEV/…) so existing `errCodeMatches`/`msg.includes("ENOENT")`
 * checks in the handlers keep working unchanged.
 */
export interface FileBackend {
  readFile(p: string): Promise<Buffer>;
  readRange?(p: string, offset: number, length: number): Promise<Buffer>;
  writeFileAtomic(p: string, data: Buffer, opts?: BackendWriteOptions): Promise<void>;
  readdir(p: string, opts?: { withFileTypes?: boolean }): Promise<BackendDirent[]>;
  stat(p: string): Promise<BackendStat>;
  lstat(p: string): Promise<BackendStat>;
  mkdir(p: string, opts?: { recursive?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(p: string): Promise<void>;
  rm(p: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
  cp(from: string, to: string, opts?: { recursive?: boolean; errorOnExist?: boolean }): Promise<void>;
  /** Resolves symlinks; throws an ENOENT-shaped error when the target is absent. */
  realpath(p: string): Promise<string>;
}

/**
 * Default backend — thin pass-through to `node:fs/promises`. Byte-for-
 * byte identical to the pre-M174 behavior. Used for the `workspace` zone
 * always, and for `current`/`absolute` when the server IS the user's
 * machine but no relay is connected (… which returns the decision-#2
 * error instead; in practice Local only serves workspace + tests).
 */
export class LocalFileBackend implements FileBackend {
  readFile(p: string): Promise<Buffer> {
    return fsp.readFile(p);
  }
  async readRange(p: string, offset: number, length: number): Promise<Buffer> {
    const handle = await fsp.open(p, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    } finally { await handle.close(); }
  }
  async writeFileAtomic(p: string, data: Buffer, opts?: BackendWriteOptions): Promise<void> {
    await writeAtomic(p, data, opts?.mode !== undefined ? { mode: opts.mode } : {});
  }
  readdir(_p: string, _opts?: { withFileTypes?: boolean }): Promise<BackendDirent[]> {
    return fsp.readdir(_p, { withFileTypes: true });
  }
  async stat(p: string): Promise<BackendStat> {
    const stat = await fsp.stat(p);
    return Object.assign(stat, { sourceVersion: createHash("sha256")
      .update(`${p}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`).digest("hex") });
  }
  lstat(p: string): Promise<BackendStat> {
    return fsp.lstat(p);
  }
  async mkdir(p: string, opts?: { recursive?: boolean }): Promise<void> {
    await fsp.mkdir(p, { recursive: opts?.recursive === true });
  }
  rename(from: string, to: string): Promise<void> {
    return fsp.rename(from, to);
  }
  unlink(p: string): Promise<void> {
    return fsp.unlink(p);
  }
  async rm(p: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void> {
    await fsp.rm(p, { recursive: opts?.recursive === true, force: opts?.force === true });
  }
  async cp(from: string, to: string, opts?: { recursive?: boolean; errorOnExist?: boolean }): Promise<void> {
    await fsp.cp(from, to, {
      recursive: opts?.recursive === true,
      errorOnExist: opts?.errorOnExist === true,
    });
  }
  realpath(p: string): Promise<string> {
    return fsp.realpath(p);
  }
}

/** Subset of the relay registry the relay backend needs. */
export type FsRelayRegistry = Pick<ToolRelayRegistry, "fsDispatch">;

function fsError(result: RelayFsResult & { ok: false }, op: string, p: string): Error {
  const code = result.code;
  // Embed the code token in the message too: several handlers branch on
  // `msg.includes("ENOENT")` rather than `.code`. Set both so either
  // detection style fires.
  const err = new Error(
    `relay fs ${op} failed for ${p}: ${code ? `${code} ` : ""}${result.message}`,
  ) as NodeJS.ErrnoException;
  if (code) err.code = code;
  return err;
}

function direntFromWire(e: RelayFsDirEntry): BackendDirent {
  return {
    name: e.name,
    isFile: () => e.file,
    isDirectory: () => e.dir,
    isSymbolicLink: () => e.symlink,
  };
}

function statFromWire(s: RelayFsStat): BackendStat {
  return {
    size: s.size,
    mtime: new Date(s.mtimeMs),
    birthtime: new Date(s.birthtimeMs),
    mode: s.mode,
    isFile: () => s.isFile,
    isDirectory: () => s.isDirectory,
    isSymbolicLink: () => s.isSymbolicLink,
    isFIFO: () => s.isFIFO,
    isSocket: () => s.isSocket,
  };
}

/**
 * Relay-backed byte I/O — every primitive is one `fsDispatch` round-trip
 * over the `fs` execution class. All `file`-tool logic stays on the
 * server; only bytes cross the wire (base64). `allowedRoots` is the set
 * the relay must jail each op within (server passes the relay's own
 * reported roots, same gate `run_shell` uses).
 */
export class RelayFileBackend implements FileBackend {
  constructor(
    private readonly registry: FsRelayRegistry,
    private readonly relayId: string,
    private readonly allowedRoots: string[],
  ) {}

  private async dispatch(
    req: Omit<RelayFsRequest, "allowedRoots">,
    mutating: boolean,
  ): Promise<RelayFsResult> {
    if (!this.registry.fsDispatch) {
      return { ok: false, message: "relay registry does not support fs dispatch" };
    }
    return this.registry.fsDispatch(
      this.relayId,
      { ...req, allowedRoots: this.allowedRoots },
      { mutating },
    );
  }

  async readFile(p: string): Promise<Buffer> {
    const r = await this.dispatch({ op: "readFile", path: p }, false);
    if (!r.ok) throw fsError(r, "readFile", p);
    return Buffer.from(r.dataBase64 ?? "", "base64");
  }

  async writeFileAtomic(p: string, data: Buffer, opts?: BackendWriteOptions): Promise<void> {
    const r = await this.dispatch(
      {
        op: "writeFileAtomic",
        path: p,
        dataBase64: data.toString("base64"),
        ...(opts?.mode !== undefined || opts?.changeEvent
          ? {
              opts: {
                ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
                ...(opts.changeEvent ? { changeEvent: opts.changeEvent } : {}),
              },
            }
          : {}),
      },
      true,
    );
    if (!r.ok) throw fsError(r, "writeFileAtomic", p);
  }

  async readdir(p: string, opts?: { withFileTypes?: boolean }): Promise<BackendDirent[]> {
    const r = await this.dispatch(
      { op: "readdir", path: p, opts: { withFileTypes: opts?.withFileTypes !== false } },
      false,
    );
    if (!r.ok) throw fsError(r, "readdir", p);
    return (r.entries ?? []).map(direntFromWire);
  }

  async stat(p: string): Promise<BackendStat> {
    const r = await this.dispatch({ op: "stat", path: p }, false);
    if (!r.ok) throw fsError(r, "stat", p);
    if (!r.stat) throw fsError({ ok: false, message: "missing stat payload" }, "stat", p);
    return statFromWire(r.stat);
  }

  async lstat(p: string): Promise<BackendStat> {
    const r = await this.dispatch({ op: "lstat", path: p }, false);
    if (!r.ok) throw fsError(r, "lstat", p);
    if (!r.stat) throw fsError({ ok: false, message: "missing stat payload" }, "lstat", p);
    return statFromWire(r.stat);
  }

  async mkdir(p: string, opts?: { recursive?: boolean }): Promise<void> {
    const r = await this.dispatch(
      { op: "mkdir", path: p, opts: { recursive: opts?.recursive === true } },
      true,
    );
    if (!r.ok) throw fsError(r, "mkdir", p);
  }

  async rename(from: string, to: string): Promise<void> {
    const r = await this.dispatch({ op: "rename", path: from, destPath: to }, true);
    if (!r.ok) throw fsError(r, "rename", from);
  }

  async unlink(p: string): Promise<void> {
    const r = await this.dispatch({ op: "unlink", path: p }, true);
    if (!r.ok) throw fsError(r, "unlink", p);
  }

  async rm(p: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const r = await this.dispatch(
      {
        op: "rm",
        path: p,
        opts: { recursive: opts?.recursive === true, force: opts?.force === true },
      },
      true,
    );
    if (!r.ok) throw fsError(r, "rm", p);
  }

  async cp(
    from: string,
    to: string,
    opts?: { recursive?: boolean; errorOnExist?: boolean },
  ): Promise<void> {
    const r = await this.dispatch(
      {
        op: "cp",
        path: from,
        destPath: to,
        opts: {
          recursive: opts?.recursive === true,
          errorOnExist: opts?.errorOnExist === true,
        },
      },
      true,
    );
    if (!r.ok) throw fsError(r, "cp", from);
  }

  async realpath(p: string): Promise<string> {
    const r = await this.dispatch({ op: "realpath", path: p }, false);
    if (!r.ok) throw fsError(r, "realpath", p);
    if (r.realpath === null || r.realpath === undefined) {
      // Mirror node's ENOENT throw so callers' `realpathOrNull` catch fires.
      const err = new Error(`relay fs realpath failed for ${p}: ENOENT`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    return r.realpath;
  }
}

export type FsZoneName = "workspace" | "current" | "absolute" | "home" | "scratch";

export type BackendSelection =
  | { ok: true; backend: FileBackend }
  | { ok: false; error: string };

/**
 * Choose the byte-I/O backend for a `file` call.
 *
 * - `workspace`/`home`/`scratch` → `LocalFileBackend` (DB/artifact-backed,
 *   always server-side — even when a relay is connected).
 * - `current`/`absolute` → not selected here; `createFileTool` routes those
 *   zones through M206 `executeLocalFileCommand` before handlers run.
 *
 * `registry` is accepted for API compatibility but ignored for local zones.
 */
export function selectFileBackend(args: {
  zone: FsZoneName;
  command: string;
  ownerId: string;
  registry: ToolRelayRegistry | null;
}): BackendSelection {
  const { zone } = args;

  if (zone === "workspace" || zone === "home" || zone === "scratch") {
    return { ok: true, backend: new LocalFileBackend() };
  }

  // M206 — local zones never use server/RelayFileBackend byte I/O.
  return {
    ok: false,
    error:
      "file operations on local zones must use typed local-file relay dispatch; " +
      "selectFileBackend must not be called for current/absolute.",
  };
}
