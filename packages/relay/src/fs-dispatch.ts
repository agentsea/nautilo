import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import * as fsp from "node:fs/promises";
import { RELAY_FS_MAX_BYTES } from "./constants";
import {
  RELAY_FS_READDIR_MAX_ENTRIES,
} from "./protocol";
import type {
  RelayDispatchRequest,
  RelayDispatchResult,
  RelayFsDirEntry,
  RelayFsErrResult,
  RelayFsRequest,
  RelayFsResult,
  RelayFsStat,
} from "./protocol";
import {
  createWorkspaceGuard,
  type WorkspaceGuard,
} from "./workspace-guard";

/**
 * D418 — validated local authority for a desktop-filesystem-grant dispatch.
 *
 * The `roots` here are the ONLY roots the fs jail may use for a dispatch that
 * carries a `desktopFilesystemGrantRequest`. They are produced by the Electron
 * relay's local resolver (live grant reload + `guardDesktopFilesystemOperation` +
 * identity revalidation + protected-path policy). The server-provided
 * `allowedRoots` / `requestedRoot` must never be unioned into this set.
 */
export interface FsDispatchDesktopFilesystemAuthority {
  readonly roots: readonly string[];
}

export interface FsDispatchOptions {
  /** Present only when a validated D418 authority replaces raw root widening. */
  readonly desktopFilesystemAuthority?: FsDispatchDesktopFilesystemAuthority | undefined;
}

function parseFsRequest(
  args: Record<string, unknown>,
): RelayFsRequest | null {
  if (typeof args["op"] !== "string" || typeof args["path"] !== "string") {
    return null;
  }
  const fsReq: RelayFsRequest = {
    op: args["op"] as RelayFsRequest["op"],
    path: args["path"],
    allowedRoots: Array.isArray(args["allowedRoots"])
      ? (args["allowedRoots"] as string[])
      : [],
  };
  if (typeof args["destPath"] === "string") {
    fsReq.destPath = args["destPath"];
  }
  if (typeof args["dataBase64"] === "string") {
    fsReq.dataBase64 = args["dataBase64"];
  }
  if (args["opts"] !== undefined && typeof args["opts"] === "object" && args["opts"] !== null) {
    fsReq.opts = args["opts"] as Record<string, unknown>;
  }
  return fsReq;
}

function toRelayFsStat(stat: Stats): RelayFsStat {
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    birthtimeMs: stat.birthtimeMs,
    mode: stat.mode,
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    isSymbolicLink: stat.isSymbolicLink(),
    isFIFO: stat.isFIFO(),
    isSocket: stat.isSocket(),
  };
}

function errnoResult(err: unknown): RelayFsErrResult {
  const e = err as NodeJS.ErrnoException;
  const message = err instanceof Error ? err.message : String(err);
  if (typeof e.code === "string") {
    return { ok: false, code: e.code, message };
  }
  return { ok: false, message };
}

function resolveReaddirPage(
  opts: Record<string, unknown> | undefined,
): {
  ok: true;
  maxEntries: number | null;
  afterName: string | null;
  includeHidden: boolean;
  nameQuery: string;
} | RelayFsErrResult {
  const requested = opts?.["maxEntries"];
  const afterName = opts?.["afterName"] ?? null;
  const includeHidden = opts?.["includeHidden"] ?? true;
  const nameQuery = opts?.["nameQuery"] ?? "";
  if (afterName !== null && (typeof afterName !== "string" || afterName.length === 0 || afterName.length > 1024)) {
    return {
      ok: false,
      code: "EINVAL",
      message: "readdir opts.afterName must be a non-empty bounded string",
    };
  }
  if (requested !== undefined && (
    typeof requested !== "number" ||
    !Number.isSafeInteger(requested) ||
    requested < 1
  )) {
    return {
      ok: false,
      code: "EINVAL",
      message: "readdir opts.maxEntries must be a positive safe integer",
    };
  }
  if (typeof includeHidden !== "boolean") {
    return { ok: false, code: "EINVAL", message: "readdir opts.includeHidden must be a boolean" };
  }
  if (typeof nameQuery !== "string" || nameQuery.length > 200 || nameQuery.includes("\0")) {
    return { ok: false, code: "EINVAL", message: "readdir opts.nameQuery must be a bounded string" };
  }
  return {
    ok: true,
    maxEntries: requested === undefined
      ? null
      : Math.min(requested, RELAY_FS_READDIR_MAX_ENTRIES),
    afterName,
    includeHidden,
    nameQuery: nameQuery.toLocaleLowerCase(),
  };
}

export async function handleFsDispatch(
  req: RelayDispatchRequest,
  baseGuard: WorkspaceGuard,
  options: FsDispatchOptions = {},
): Promise<RelayDispatchResult> {
  const fsReq = parseFsRequest(req.args);
  if (fsReq === null) {
    return {
      status: "ok",
      result: {
        ok: false,
        code: "EINVAL",
        message: "malformed fs request",
      } satisfies RelayFsResult,
    };
  }

  // D418 — a dispatch carrying a desktop-filesystem-grant request must be jailed to
  // the locally validated authority ONLY. Raw server-provided roots
  // (`fsReq.allowedRoots`) are an untrusted mirror and must never widen the
  // jail. If no validated authority reached this handler (e.g. the headless
  // relay, or a missing local resolver), fail closed — the server's roots
  // alone can never create filesystem authority.
  const isDesktopFilesystemGrantDispatch = req.desktopFilesystemGrantRequest !== undefined;
  let guard: WorkspaceGuard;
  try {
    if (isDesktopFilesystemGrantDispatch) {
      if (options.desktopFilesystemAuthority === undefined) {
        return {
          status: "ok",
          result: {
            ok: false,
            code: "EACCES",
            message:
              "Desktop Filesystem Grant request requires locally validated authority; " +
              "server-provided roots cannot widen this dispatch",
          } satisfies RelayFsResult,
        };
      }
      guard = createWorkspaceGuard({
        allowedRoots: [...options.desktopFilesystemAuthority.roots],
      });
    } else {
      guard = createWorkspaceGuard({
        allowedRoots: [...baseGuard.roots, ...(fsReq.allowedRoots ?? [])],
      });
    }
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  function jail(p: string): { ok: true; path: string } | RelayFsErrResult {
    const guardResult = guard.check(p);
    if (!guardResult.ok) {
      return { ok: false, code: "EACCES", message: guardResult.error };
    }
    return { ok: true, path: p };
  }

  const pathJail = jail(fsReq.path);
  if (!pathJail.ok) {
    return { status: "ok", result: pathJail };
  }

  const needsDest =
    fsReq.op === "rename" || fsReq.op === "cp";
  if (needsDest && fsReq.destPath !== undefined) {
    const destJail = jail(fsReq.destPath);
    if (!destJail.ok) {
      return { status: "ok", result: destJail };
    }
  }

  const path = pathJail.path;
  const opts = fsReq.opts;

  try {
    const result = await executeFsOp(fsReq, path, opts);
    return { status: "ok", result };
  } catch (err) {
    return { status: "ok", result: errnoResult(err) };
  }
}

async function executeFsOp(
  fsReq: RelayFsRequest,
  path: string,
  opts: Record<string, unknown> | undefined,
): Promise<RelayFsResult> {
  switch (fsReq.op) {
    case "readFile": {
      const st = await fsp.stat(path);
      if (st.size > RELAY_FS_MAX_BYTES) {
        return {
          ok: false,
          code: "EFBIG",
          message: `file size ${st.size} exceeds ${RELAY_FS_MAX_BYTES} byte limit`,
        };
      }
      const buf = await fsp.readFile(path);
      return { ok: true, dataBase64: buf.toString("base64") };
    }

    case "writeFileAtomic": {
      const data = Buffer.from(fsReq.dataBase64 ?? "", "base64");
      if (data.byteLength > RELAY_FS_MAX_BYTES) {
        return {
          ok: false,
          code: "EFBIG",
          message: `payload size ${data.byteLength} exceeds ${RELAY_FS_MAX_BYTES} byte limit`,
        };
      }
      const mode = typeof opts?.["mode"] === "number" ? opts["mode"] : 0o644;
      const tmp = `${path}.${randomUUID()}.tmp`;
      try {
        await fsp.writeFile(tmp, data);
        await fsp.chmod(tmp, mode);
        await fsp.rename(tmp, path);
      } catch (err) {
        try {
          await fsp.unlink(tmp);
        } catch {
          // best-effort cleanup
        }
        throw err;
      }
      return { ok: true };
    }

    case "readdir": {
      const withFileTypes = opts?.["withFileTypes"] === true;
      const page = resolveReaddirPage(opts);
      if (!page.ok) return page;
      if (page.maxEntries === null) {
        const dirents = await fsp.readdir(path, { withFileTypes: true });
        const entries = dirents
          .filter((dirent) => page.includeHidden || !dirent.name.startsWith("."))
          .filter((dirent) => page.nameQuery === "" || dirent.name.toLocaleLowerCase().includes(page.nameQuery))
          .map((dirent) => ({
          name: dirent.name,
          dir: withFileTypes ? dirent.isDirectory() : false,
          file: withFileTypes ? dirent.isFile() : false,
          symlink: withFileTypes ? dirent.isSymbolicLink() : false,
          }));
        entries.sort((left, right) => left.name.localeCompare(right.name));
        return { ok: true, entries };
      }
      const entries: RelayFsDirEntry[] = [];
      // Scan the directory but retain only the lexicographically next bounded
      // page. This avoids allocating or transporting the full directory while
      // keeping stateless cursors stable across separate requests.
      const dir = await fsp.opendir(path);
      let truncated = false;
      try {
        while (true) {
          const dirent = await dir.read();
          if (dirent === null) break;
          if (!page.includeHidden && dirent.name.startsWith(".")) continue;
          if (page.nameQuery !== "" && !dirent.name.toLocaleLowerCase().includes(page.nameQuery)) continue;
          if (page.afterName !== null && dirent.name <= page.afterName) continue;
          entries.push({
            name: dirent.name,
            dir: withFileTypes ? dirent.isDirectory() : false,
            file: withFileTypes ? dirent.isFile() : false,
            symlink: withFileTypes ? dirent.isSymbolicLink() : false,
          });
          entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
          if (entries.length > page.maxEntries) {
            entries.pop();
            truncated = true;
          }
        }
      } finally {
        await dir.close();
      }
      // The bounded result is the globally next lexicographic page. Directory
      // scanning is linear, while retained memory and transport stay bounded.
      return {
        ok: true,
        entries,
        ...(truncated ? { truncated: true } : {}),
      };
    }

    case "stat": {
      const st = await fsp.stat(path);
      return { ok: true, stat: toRelayFsStat(st) };
    }

    case "lstat": {
      const st = await fsp.lstat(path);
      return { ok: true, stat: toRelayFsStat(st) };
    }

    case "mkdir": {
      await fsp.mkdir(path, { recursive: opts?.["recursive"] === true });
      return { ok: true };
    }

    case "rename": {
      if (fsReq.destPath === undefined) {
        return { ok: false, code: "EINVAL", message: "destPath required for rename" };
      }
      await fsp.rename(path, fsReq.destPath);
      return { ok: true };
    }

    case "unlink": {
      await fsp.unlink(path);
      return { ok: true };
    }

    case "rm": {
      await fsp.rm(path, {
        recursive: opts?.["recursive"] === true,
        force: opts?.["force"] === true,
      });
      return { ok: true };
    }

    case "cp": {
      if (fsReq.destPath === undefined) {
        return { ok: false, code: "EINVAL", message: "destPath required for cp" };
      }
      await fsp.cp(path, fsReq.destPath, {
        recursive: opts?.["recursive"] === true,
        errorOnExist: opts?.["errorOnExist"] === true,
      });
      return { ok: true };
    }

    case "realpath": {
      try {
        const resolved = await fsp.realpath(path);
        return { ok: true, realpath: resolved };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          return { ok: true, realpath: null };
        }
        throw err;
      }
    }

    default:
      return { ok: false, code: "EINVAL", message: "unknown fs op" };
  }
}
