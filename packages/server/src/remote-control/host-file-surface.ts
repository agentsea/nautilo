/**
 * D458 — bounded, read-only Computer Files surface.
 *
 * This is intentionally not the agent's multi-host chooser. A phone names a
 * durable controller binding, and the route resolves exactly that binding to
 * one live relay before this module receives the private root and dispatch
 * port. Absolute paths never cross the HTTP boundary.
 */
import * as path from "node:path";
import {
  type RelayFsDirEntry,
  type RelayFsResult,
  type RelayFsStat,
} from "@nautilo/relay";

export const HOST_FILE_ROOT_KINDS = ["workspace", "current_folder", "paired_filesystem"] as const;
export type HostFileRootKind = typeof HOST_FILE_ROOT_KINDS[number];

export const HOST_FILE_ERROR_CODES = [
  "offline",
  "revoked",
  "no_current_folder",
  "root_stale",
  "transport",
  "inaccessible",
  "unsupported",
  "too_large",
  "not_found",
] as const;
export type HostFileErrorCode = typeof HOST_FILE_ERROR_CODES[number];

export const HOST_FILE_MAX_PAGE_SIZE = 100;
export const HOST_FILE_DEFAULT_PAGE_SIZE = 50;
/** Preview bytes are purposefully lower than the generic Relay fs ceiling. */
export const HOST_FILE_MAX_PREVIEW_BYTES = 1024 * 1024;

export type HostFileMetadata = {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
};

export type HostFileDirectoryEntry = {
  readonly name: string;
  readonly path: string;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
};

export type HostFileSurfaceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: HostFileErrorCode };

export interface HostFileDispatchPort {
  fsDispatch(
    relayId: string,
    request: {
      op: "readFile" | "readdir" | "stat" | "lstat";
      path: string;
      opts?: Record<string, unknown>;
      allowedRoots: string[];
    },
    options: { mutating: false; timeoutMs?: number },
  ): Promise<RelayFsResult>;
}

function isContainedRelativePath(value: string): boolean {
  if (value.length > 1024 || value.includes("\0") || path.isAbsolute(value)) return false;
  const normalized = path.normalize(value || ".");
  return normalized === "." || (normalized !== ".." && !normalized.startsWith(`..${path.sep}`));
}

/** The public path is relative to the requested root, never machine-local. */
export function normalizeHostFileRelativePath(value: string): string | null {
  if (!isContainedRelativePath(value)) return null;
  const normalized = path.normalize(value || ".");
  return normalized === "." ? "" : normalized.split(path.sep).join("/");
}

export function decodeHostFileCursor(cursor: string | undefined): string | null | undefined {
  if (cursor === undefined) return undefined;
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) return null;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    return decoded.length > 0 && decoded.length <= 1024 && !decoded.includes("\0")
      ? decoded
      : null;
  } catch {
    return null;
  }
}

export function encodeHostFileCursor(afterName: string): string | null {
  if (afterName.length === 0 || afterName.length > 1024 || afterName.includes("\0")) return null;
  return Buffer.from(afterName, "utf8").toString("base64url");
}

function resultError(result: RelayFsResult): HostFileErrorCode {
  if (result.ok) return "transport";
  switch (result.code) {
    case "ENOENT":
    case "ENOTDIR":
      return "not_found";
    case "EACCES":
    case "EPERM":
    case "ELOOP":
      return "inaccessible";
    case "EFBIG":
      return "too_large";
    case "ENOTSUP":
    case "EOPNOTSUPP":
      return "unsupported";
    default:
      return "transport";
  }
}

function metadata(relativePath: string, stat: RelayFsStat): HostFileMetadata {
  return {
    path: relativePath,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    isFile: stat.isFile,
    isDirectory: stat.isDirectory,
    isSymbolicLink: stat.isSymbolicLink,
  };
}

function joinRoot(root: string, relativePath: string): string {
  // `relativePath` has already been validated by normalizeHostFileRelativePath.
  return relativePath === "" ? root : path.resolve(root, relativePath);
}

async function ensureLiveRoot(input: {
  dispatch: HostFileDispatchPort;
  relayId: string;
  root: string;
}): Promise<HostFileSurfaceResult<void>> {
  const stat = await input.dispatch.fsDispatch(
    input.relayId,
    { op: "stat", path: input.root, allowedRoots: [input.root] },
    { mutating: false, timeoutMs: 10_000 },
  );
  if (!stat.ok) {
    // The root itself disappeared. Keep that distinct from a missing child.
    if (stat.code === "ENOENT" || stat.code === "ENOTDIR") return { ok: false, error: "root_stale" };
    return { ok: false, error: resultError(stat) };
  }
  if (!stat.stat?.isDirectory) return { ok: false, error: "root_stale" };
  return { ok: true, value: undefined };
}

export async function listHostFiles(input: {
  dispatch: HostFileDispatchPort;
  relayId: string;
  root: string;
  relativePath: string;
  afterName: string | undefined;
  limit: number;
  includeHidden: boolean;
  query: string;
}): Promise<HostFileSurfaceResult<{ entries: HostFileDirectoryEntry[]; nextCursor: string | null }>> {
  const liveRoot = await ensureLiveRoot(input);
  if (!liveRoot.ok) return liveRoot;
  const target = joinRoot(input.root, input.relativePath);
  const listed = await input.dispatch.fsDispatch(
    input.relayId,
    {
      op: "readdir",
      path: target,
      opts: {
        withFileTypes: true,
        maxEntries: input.limit,
        includeHidden: input.includeHidden,
        nameQuery: input.query,
        ...(input.afterName !== undefined ? { afterName: input.afterName } : {}),
      },
      allowedRoots: [input.root],
    },
    { mutating: false, timeoutMs: 10_000 },
  );
  if (!listed.ok) return { ok: false, error: resultError(listed) };
  // Relay applies the cursor and page bound before serializing. A directory
  // may be arbitrarily large; only each request/response is bounded.
  const safeEntries = (listed.entries ?? [])
    .filter((entry) => entry.name !== "." && entry.name !== ".." && !entry.name.includes("/") && !entry.name.includes("\\"));
  const entries = safeEntries
    .map((entry: RelayFsDirEntry) => ({
      name: entry.name,
      path: input.relativePath ? `${input.relativePath}/${entry.name}` : entry.name,
      isDirectory: entry.dir,
      isFile: entry.file,
      isSymbolicLink: entry.symlink,
    }));
  const finalRawName = (listed.entries ?? []).at(-1)?.name;
  return {
    ok: true,
    value: {
      entries,
      nextCursor: listed.truncated === true && finalRawName !== undefined
        ? encodeHostFileCursor(finalRawName)
        : null,
    },
  };
}

export async function statHostFile(input: {
  dispatch: HostFileDispatchPort;
  relayId: string;
  root: string;
  relativePath: string;
}): Promise<HostFileSurfaceResult<HostFileMetadata>> {
  const liveRoot = await ensureLiveRoot(input);
  if (!liveRoot.ok) return liveRoot;
  const target = joinRoot(input.root, input.relativePath);
  // lstat keeps symlink presentation honest. The relay's root guard remains
  // the final execution authority for every actual filesystem operation.
  const stat = await input.dispatch.fsDispatch(
    input.relayId,
    { op: "lstat", path: target, allowedRoots: [input.root] },
    { mutating: false, timeoutMs: 10_000 },
  );
  if (!stat.ok) return { ok: false, error: resultError(stat) };
  if (!stat.stat) return { ok: false, error: "transport" };
  return { ok: true, value: metadata(input.relativePath, stat.stat) };
}

export async function readHostFilePreview(input: {
  dispatch: HostFileDispatchPort;
  relayId: string;
  root: string;
  relativePath: string;
}): Promise<HostFileSurfaceResult<{ metadata: HostFileMetadata; dataBase64: string }>> {
  const inspected = await statHostFile(input);
  if (!inspected.ok) return inspected;
  if (!inspected.value.isFile || inspected.value.isSymbolicLink) return { ok: false, error: "unsupported" };
  if (inspected.value.size > HOST_FILE_MAX_PREVIEW_BYTES) return { ok: false, error: "too_large" };
  const target = joinRoot(input.root, input.relativePath);
  const read = await input.dispatch.fsDispatch(
    input.relayId,
    { op: "readFile", path: target, allowedRoots: [input.root] },
    { mutating: false, timeoutMs: 15_000 },
  );
  if (!read.ok) return { ok: false, error: resultError(read) };
  if (typeof read.dataBase64 !== "string") return { ok: false, error: "transport" };
  // Protect the HTTP response even if the file changes between stat and read.
  if (Buffer.byteLength(read.dataBase64, "base64") > HOST_FILE_MAX_PREVIEW_BYTES) {
    return { ok: false, error: "too_large" };
  }
  return { ok: true, value: { metadata: inspected.value, dataBase64: read.dataBase64 } };
}
