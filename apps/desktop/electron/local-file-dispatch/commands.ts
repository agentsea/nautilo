/**
 * M206 — local unified `file` command implementations (Electron relay).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createDiscoveryPage } from "@nautilo/relay/native-search";
import { diffLines } from "diff";
import {
  RELAY_FS_MAX_BYTES,
  readTextWindow,
  RELAY_MEDIA_CHUNK_BYTES,
  RELAY_MEDIA_MAX_BYTES,
} from "@nautilo/relay";
import type { RelayLocalFileZone } from "@nautilo/relay";
import type { GuardedFileAdapter } from "../local-file-history/file-adapter.ts";
import { sha256Hex, snapshotFromBytes } from "../local-file-history/hash.ts";
import { formatRevisionRef } from "../local-file-history/ids.ts";
import { readState, type LocalFileHistoryJournal } from "../local-file-history/journal.ts";
import type { FileStateSnapshot } from "../local-file-history/types.ts";
import {
  GuardedWriteError,
  assertExpectedSha256,
  parseOptionalClientMutationId,
  parseOptionalExpectedSha256,
  staleSha256Result,
} from "./guarded-write.ts";
import { findFragmentRange } from "./matching.ts";
import {
  resolveZonePath,
  resolveLocalMutationTransactionId,
  stripRouting,
  type LocalRoutingContext,
} from "./paths.ts";

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_LIMIT_NON_RECURSIVE = 1000;
const DEFAULT_LIMIT_RECURSIVE = 5000;
const DIFF_PREVIEW_MAX_BYTES = 2_000_000;

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "out",
  ".cache",
]);

export interface LocalFileCommandContext {
  adapter: GuardedFileAdapter;
  signal?: AbortSignal | undefined;
  journal: LocalFileHistoryJournal;
  relayId: string;
  allowedRoots: readonly string[];
  routing: LocalRoutingContext;
  mutationSemanticDigest: string;
  agentContentCommit?: ((input: {
    readonly targetPath: string;
    readonly authorizedRoots?: readonly string[] | undefined;
    readonly before: Uint8Array | null;
    readonly after: Uint8Array;
    readonly agentId: string;
    readonly turnId: string;
    readonly command: string;
    readonly mutationRequestId: string;
    readonly semanticDigest: string;
    readonly replayOnly?: boolean | undefined;
    readonly clientMutationId?: string | undefined;
  }) => Promise<
    | {
        readonly ok: true;
        readonly revisionId: string;
        readonly sha256: string;
        readonly before: Uint8Array | null;
        readonly after: Uint8Array;
      }
    | {
        readonly ok: false;
        readonly code:
          | "stale_sha256"
          | "human_edit_conflict"
          | "reapply_required"
          | "error";
        readonly message: string;
        readonly expectedSha256?: string;
        readonly actualSha256?: string;
      }
  >) | undefined;
  structuralCommit?: ((input: {
    readonly command: "delete" | "move" | "copy";
    readonly sourcePath: string;
    readonly destinationPath?: string | undefined;
    readonly authorizedRoots: readonly string[];
    readonly agentId: string;
    readonly turnId: string;
    readonly mutationRequestId: string;
    readonly semanticDigest: string;
    readonly replayOnly?: boolean | undefined;
  }) => Promise<
    | {
        readonly ok: true;
        readonly revisionId: string;
        readonly command: "delete" | "move" | "copy";
        readonly sourceCanonicalPath: string;
        readonly destinationCanonicalPath?: string;
        readonly sha256: string | null;
        readonly byteLength: number;
        readonly replayed: boolean;
      }
    | {
        readonly ok: false;
        readonly code:
          | "destination_exists"
          | "source_missing"
          | "binary_source"
          | "human_edit_conflict"
          | "reapply_required"
          | "error";
        readonly message: string;
      }
  >) | undefined;
  historyCommit?: ((input: {
    readonly action: "undo" | "redo" | "undo_turn";
    readonly targetPath?: string | undefined;
    readonly revisionId?: string | undefined;
    readonly targetTurnId?: string | undefined;
    readonly agentId: string;
    readonly turnId: string;
    readonly mutationRequestId: string;
    readonly semanticDigest: string;
    readonly authorizedRoots: readonly string[];
    readonly replayOnly?: boolean | undefined;
  }) => Promise<
    | {
        readonly ok: true;
        readonly operationId: string;
        readonly revisionGroupId: string;
        readonly revisions: readonly {
          readonly revisionId: string;
          readonly canonicalPath: string;
          readonly sha256: string | null;
        }[];
        readonly replayed: boolean;
      }
    | {
        readonly ok: false;
        readonly code:
          | "no_revisions"
          | "revision_not_found"
          | "no_revisions_for_turn"
          | "nothing_to_redo"
          | "human_edit_conflict"
          | "reapply_required"
          | "error";
        readonly message: string;
        readonly canonicalPath?: string;
      }
  >) | undefined;
}

export type LocalPathResolutionContext = Pick<
  LocalFileCommandContext,
  "adapter" | "allowedRoots" | "routing"
>;

async function assertContained(
  adapter: GuardedFileAdapter,
  resolved: string,
  allowedRoots: readonly string[],
): Promise<string | null> {
  try {
    const canonical = await adapter.canonicalize(resolved);
    for (const root of allowedRoots) {
      const rootCanon = await adapter.canonicalize(root);
      const rel = path.relative(rootCanon, canonical);
      if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
        return canonical;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function revalidatePath(
  adapter: GuardedFileAdapter,
  resolved: string,
  allowedRoots: readonly string[],
): Promise<
  | { ok: true; canonical: string; isSymlink: false }
  | { ok: false; text: string }
> {
  const canonical = await assertContained(adapter, resolved, allowedRoots);
  if (!canonical) {
    return { ok: false, text: `Error: path is outside allowed roots: ${resolved}` };
  }
  const st = await adapter.stat(canonical);
  if (st?.isSymbolicLink) {
    return { ok: false, text: `Error: refusing symlink path ${resolved}` };
  }
  return { ok: true, canonical, isSymlink: false };
}

function diffStats(oldBytes: Uint8Array, newBytes: Uint8Array, displayPath: string) {
  const oldText = Buffer.from(oldBytes).toString("utf-8");
  const newText = Buffer.from(newBytes).toString("utf-8");
  let additions = 0;
  let deletions = 0;
  for (const part of diffLines(oldText, newText)) {
    const lines = part.count ?? 0;
    if (part.added) additions += lines;
    if (part.removed) deletions += lines;
  }
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  let unifiedDiff =
    `--- ${displayPath}\n+++ ${displayPath}\n` +
    `@@ -1,${oldLines.length} +1,${newLines.length} @@\n`;
  const previewOld = oldText.slice(0, 4000);
  const previewNew = newText.slice(0, 4000);
  unifiedDiff += previewOld === oldText && previewNew === newText
    ? `(content changed: ${oldBytes.byteLength} → ${newBytes.byteLength} bytes)`
    : `(preview truncated)`;
  if (unifiedDiff.length > DIFF_PREVIEW_MAX_BYTES) {
    unifiedDiff =
      `Inline diff preview omitted — change is ${unifiedDiff.length} bytes over limit.`;
  }
  return { additions, deletions, unifiedDiff, summary: `Updated ${displayPath}` };
}

export async function executeCoordinatedContentMutation(
  ctx: LocalFileCommandContext,
  args: {
    readonly canonicalPath: string;
    readonly zone: RelayLocalFileZone;
    readonly command: string;
    readonly displayPath: string;
    readonly preState: FileStateSnapshot;
    readonly postState: FileStateSnapshot;
    readonly clientMutationId?: string | undefined;
    readonly includeSha256?: boolean | undefined;
  },
): Promise<string> {
  const transactionId = resolveLocalMutationTransactionId(ctx.routing);
  if (!transactionId) {
    return JSON.stringify({
      error: "missing_turn_id",
      hint: "turnId or appOperationId required for local mutations",
    });
  }
  if (!ctx.agentContentCommit) {
    return JSON.stringify({
      error: "runtime_unavailable",
      message: "Desktop document mutation runtime is unavailable",
    });
  }
  if (!ctx.routing.mutationRequestId) {
    return JSON.stringify({
      error: "missing_mutation_request_id",
      message: "trusted file-tool mutation request identity is unavailable",
    });
  }
  if (args.postState.kind !== "bytes") {
    return JSON.stringify({
      error: "mutation_failed",
      message: "local file content mutation requires a byte postimage",
    });
  }

  const committed = await ctx.agentContentCommit({
    targetPath: args.canonicalPath,
    before: args.preState.kind === "bytes" ? args.preState.bytes : null,
    after: args.postState.bytes,
    agentId: ctx.routing.agentId,
    turnId: transactionId,
    command: args.command,
    mutationRequestId: ctx.routing.mutationRequestId,
    semanticDigest: ctx.mutationSemanticDigest,
    ...(args.clientMutationId === undefined
      ? {}
      : { clientMutationId: args.clientMutationId }),
  });
  if (!committed.ok) {
    if (committed.code === "stale_sha256") {
      return staleSha256Result({
        expectedSha256: committed.expectedSha256 ??
          (args.preState.kind === "bytes"
            ? args.preState.sha256
            : sha256Hex(new Uint8Array())),
        actualSha256: committed.actualSha256,
      });
    }
    if (
      committed.code === "human_edit_conflict" ||
      committed.code === "reapply_required"
    ) {
      return JSON.stringify({
        error: committed.code,
        message: committed.message,
        retryable: false,
        hint: "Reread the current file and construct a new edit; do not blindly retry this mutation.",
      });
    }
    return JSON.stringify({
      error: "mutation_failed",
      message: committed.message,
    });
  }

  return formatCommittedContentMutation(committed, {
    relayId: ctx.relayId,
    displayPath: args.displayPath,
    zone: args.zone,
    command: args.command,
    includeSha256: args.includeSha256,
  });
}

export function formatCommittedContentMutation(
  committed: {
    readonly revisionId: string;
    readonly sha256: string;
    readonly before: Uint8Array | null;
    readonly after: Uint8Array;
  },
  args: {
    readonly relayId: string;
    readonly displayPath: string;
    readonly zone: RelayLocalFileZone;
    readonly command: string;
    readonly includeSha256?: boolean | undefined;
  },
): string {
  const preBytes = committed.before ?? new Uint8Array();
  const { additions, deletions, unifiedDiff, summary } = diffStats(
    preBytes,
    committed.after,
    args.displayPath,
  );
  return JSON.stringify({
    applied: true,
    revisionId: formatRevisionRef(args.relayId, committed.revisionId),
    ...(args.includeSha256 ? { sha256: committed.sha256 } : {}),
    path: args.displayPath,
    zone: args.zone,
    command: args.command,
    stats: { additions, deletions },
    summary,
    unifiedDiff,
  });
}

export async function executeLocalFileCommand(
  command: string,
  zone: RelayLocalFileZone,
  rawArgs: Record<string, unknown>,
  ctx: LocalFileCommandContext,
): Promise<unknown> {
  const args = stripRouting(rawArgs);

  switch (command) {
    case "list":
      return listCommand(zone, args, ctx);
    case "read":
      return readCommand(zone, args, ctx);
    case "media_read_chunk":
      return mediaReadChunkCommand(zone, args, ctx);
    case "grep":
    case "glob":
      return "Error: native search requires the typed kind=search operation";
    case "stat":
      return statCommand(zone, args, ctx);
    case "write":
      return writeCommand(zone, args, ctx);
    case "create":
      return writeCommand(zone, args, ctx, true);
    case "insert":
      return insertCommand(zone, args, ctx);
    case "str_replace":
      return strReplaceCommand(zone, args, ctx);
    case "move":
      return moveCommand(zone, args, ctx);
    case "copy":
      return copyCommand(zone, args, ctx);
    case "delete":
      return deleteCommand(zone, args, ctx);
    default:
      return `Error: unknown local file command ${command}`;
  }
}

/**
 * D417's v5-only read primitive. This is intentionally separate from `read`:
 * ordinary file and Office reads retain their 16 MiB cap. The final assembly
 * happens on the server and is bounded to RELAY_MEDIA_MAX_BYTES.
 */
async function mediaReadChunkCommand(
  zone: RelayLocalFileZone,
  args: Record<string, unknown>,
  ctx: LocalFileCommandContext,
): Promise<string> {
  const offset = args["offset"];
  const index = args["index"];
  const chunkCount = args["chunkCount"];
  if (!Number.isSafeInteger(offset) || (offset as number) < 0 ||
      !Number.isSafeInteger(index) || (index as number) < 0 ||
      !Number.isSafeInteger(chunkCount) || (chunkCount as number) <= 0 ||
      (index as number) >= (chunkCount as number)) {
    return "Error: invalid media chunk coordinates";
  }
  const chunkOffset = offset as number;
  const chunkIndex = index as number;
  const totalChunks = chunkCount as number;
  const resolved = await resolvePathArg(zone, args, ctx);
  if (!resolved.ok) return resolved.text;
  const st = await ctx.adapter.stat(resolved.canonical);
  if (!st?.isFile || st.size > RELAY_MEDIA_MAX_BYTES) {
    return `Error: media file is not readable or exceeds ${RELAY_MEDIA_MAX_BYTES}-byte cap`;
  }
  const expectedCount = Math.ceil(st.size / RELAY_MEDIA_CHUNK_BYTES);
  if (totalChunks !== expectedCount || chunkOffset !== chunkIndex * RELAY_MEDIA_CHUNK_BYTES) {
    return "Error: invalid media chunk order or count";
  }
  if (!ctx.adapter.readRange) return "Error: relay does not support secure media range reads";
  // Each request reads only its bounded range; never load the complete media
  // file once per transport chunk.
  const chunk = Buffer.from(await ctx.adapter.readRange(
    resolved.canonical,
    chunkOffset,
    Math.min(RELAY_MEDIA_CHUNK_BYTES, st.size - chunkOffset),
  ));
  return JSON.stringify({
    sessionId: args["sessionId"],
    index: chunkIndex,
    chunkCount: totalChunks,
    totalBytes: st.size,
    data: chunk.toString("base64"),
  });
}

export async function resolvePathArg(
  zone: RelayLocalFileZone,
  args: Record<string, unknown>,
  ctx: LocalPathResolutionContext,
): Promise<
  | { ok: true; resolved: string; canonical: string; displayPath: string }
  | { ok: false; text: string }
> {
  const rawPath = args["path"];
  if (typeof rawPath !== "string") {
    return { ok: false, text: "Error: path is required" };
  }
  const resolution = resolveZonePath(zone, rawPath, ctx.routing);
  if (!resolution.ok) return { ok: false, text: `Error: ${resolution.reason}` };

  try {
    const lst = await fs.lstat(resolution.resolved);
    if (lst.isSymbolicLink()) {
      return { ok: false, text: `Error: refusing symlink path ${resolution.resolved}` };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, text: `Error: ${msg}` };
    }
  }

  const canonical = await assertContained(ctx.adapter, resolution.resolved, ctx.allowedRoots);
  if (!canonical) {
    return { ok: false, text: `Error: path is outside allowed roots: ${resolution.resolved}` };
  }
  return {
    ok: true,
    resolved: resolution.resolved,
    canonical,
    displayPath: resolution.displayPath,
  };
}

async function listCommand(
  zone: RelayLocalFileZone,
  args: Record<string, unknown>,
  ctx: LocalFileCommandContext,
): Promise<string> {
  const resolved = await resolvePathArg(zone, args, ctx);
  if (!resolved.ok) return resolved.text;
  const recursive = args["recursive"] === true;
  const depth = typeof args["depth"] === "number" ? args["depth"] : undefined;
  const limit = typeof args["limit"] === "number" ? args["limit"] : recursive ? DEFAULT_LIMIT_RECURSIVE : DEFAULT_LIMIT_NON_RECURSIVE;
  const includeIgnored = args["includeIgnored"] === true;
  const glob = typeof args["glob"] === "string" ? args["glob"] : undefined;
  type Entry = { name: string; path: string; type: string; size?: number; descendants?: string };
  try {
    ctx.signal?.throwIfAborted();
    const page = createDiscoveryPage<Entry>({ command: "list", path: resolved.canonical, zone, recursive, depth: depth ?? null, includeIgnored, glob: glob ?? null }, limit, args["discoveryCursor"]);
    const omitted = { depth_limit: 0, excluded_directory: 0, symlink: 0, denied: 0, disappeared: 0 };
    async function walk(dir: string, level: number): Promise<void> {
      ctx.signal?.throwIfAborted();
      const names = await fs.readdir(dir, { withFileTypes: true });
      names.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const ent of names) {
        ctx.signal?.throwIfAborted();
        const full = path.join(dir, ent.name);
        // Do not resolve a symlink and accidentally enumerate its outside target.
        if (ent.isSymbolicLink()) {
          page.accept({ name: ent.name, path: full, type: "symlink", ...(recursive ? { descendants: "symlink" } : {}) });
          if (recursive) omitted.symlink += 1;
          continue;
        }
        const canon = await assertContained(ctx.adapter, full, ctx.allowedRoots);
        if (!canon) { omitted.denied += 1; page.accept({ name: ent.name, path: full, type: "unknown", descendants: "denied" }); continue; }
        const est = await ctx.adapter.stat(canon);
        if (!est) { omitted.disappeared += 1; page.accept({ name: ent.name, path: full, type: "unknown", descendants: "disappeared" }); continue; }
        const entry: Entry = { name: ent.name, path: full, type: est.isDirectory ? "directory" : est.isSymbolicLink ? "symlink" : "file", ...(!est.isDirectory && !est.isSymbolicLink ? { size: est.size } : {}) };
        if (recursive && est.isSymbolicLink) { entry.descendants = "symlink"; omitted.symlink += 1; }
        if (recursive && est.isDirectory) {
          if (ent.name === ".git" || (!includeIgnored && SKIP_DIRS.has(ent.name))) { entry.descendants = "excluded_directory"; omitted.excluded_directory += 1; }
          else if (depth !== undefined && level >= depth) { entry.descendants = "depth_limit"; omitted.depth_limit += 1; }
        }
        if (!glob || (!est.isDirectory && path.matchesGlob(ent.name, glob)) || entry.descendants) page.accept(entry);
        if (recursive && est.isDirectory && !entry.descendants) await walk(canon, level + 1);
      }
    }
    const st = await ctx.adapter.stat(resolved.canonical);
    if (!st) return `Error: path not found: ${resolved.resolved}`;
    if (st.isFile) page.accept({ name: path.basename(resolved.resolved), path: resolved.resolved, type: "file", size: st.size });
    else await walk(resolved.canonical, 0);
    const pagination = page.finish();
    const incompleteReasons = Object.entries(omitted).filter(([, count]) => count > 0).map(([reason, count]) => ({ reason, count }));
    return JSON.stringify({ ...pagination, complete: pagination.complete && incompleteReasons.length === 0, incompleteReasons,
      sourceVersionScope: "Ordered discovery entries, not an atomic file-content snapshot",
      ...(pagination.nextCursor ? { recovery: "Echo nextCursor as discoveryCursor with this same path and filters until null." } : {}),
      ...(incompleteReasons.length ? { exclusionsRecovery: "Entries with descendants identify unsearched paths. Inspect relevant depth-limited or excluded directories separately, or use includeIgnored:true for excluded build/dependency directories; .git internals and symlink traversal remain excluded." } : {}) });
  } catch (cause) {
    return `Error: directory discovery did not complete: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
}

async function readCommand(
  zone: RelayLocalFileZone,
  args: Record<string, unknown>,
  ctx: LocalFileCommandContext,
): Promise<unknown> {
  const resolved = await resolvePathArg(zone, args, ctx);
  if (!resolved.ok) return resolved.text;
  const st = await ctx.adapter.stat(resolved.canonical);
  if (!st?.isFile) {
    const requestedPath = args["path"];
    const discoveryPath = typeof requestedPath === "string"
      ? st?.isDirectory
        ? requestedPath
        : path.dirname(requestedPath)
      : null;
    if (zone === "current" && discoveryPath !== null) {
      const listing = await listCommand(zone, {
        path: discoveryPath,
        recursive: false,
      }, ctx);
      if (!listing.startsWith("Error:")) {
        let parsed: unknown;
        try { parsed = JSON.parse(listing) as unknown; } catch { parsed = null; }
        if (parsed !== null) {
          const entries = Array.isArray(parsed)
            ? parsed
            : typeof parsed === "object" && Array.isArray((parsed as { entries?: unknown }).entries)
              ? (parsed as { entries: unknown[] }).entries
              : [];
          return JSON.stringify({
            ok: true,
            command: "read",
            readStatus: st?.isDirectory ? "target_is_directory" : "target_not_found",
            requestedPath,
            recovery: "The exact read target is unavailable. Parent directory entries were returned; choose an exact file path and retry the read.",
            entries,
          });
        }
      }
    }
    return `Error: ${resolved.resolved} is not a readable file`;
  }

  if (args["encoding"] === "base64" || args["binary"] === true) {
    if (st.size > RELAY_FS_MAX_BYTES) return `Error: file exceeds ${RELAY_FS_MAX_BYTES}-byte read cap; use document/media chunk transport`;
    const bytes = await ctx.adapter.readFile(resolved.canonical);
    if (bytes.byteLength > RELAY_FS_MAX_BYTES) return `Error: file changed beyond binary payload limit`;
    return JSON.stringify({ content: Buffer.from(bytes).toString("base64"), binary: true,
      byteLength: bytes.byteLength, sha256: sha256Hex(bytes) });
  }
  if (!ctx.adapter.readRange || !st.sourceVersion) {
    return "Error: this file backend does not support versioned text ranges";
  }
  const rawRange = args["lineRange"];
  let range: { from: number; to: number } | undefined;
  if (rawRange !== undefined) {
    if (rawRange === null || typeof rawRange !== "object" || Array.isArray(rawRange)) return "Error: read lineRange requires positive integer from/to with from <= to";
    const candidate = rawRange as Record<string, unknown>;
    const from = candidate["from"];
    const to = candidate["to"];
    if (typeof from !== "number" || typeof to !== "number" || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) return "Error: read lineRange requires positive integer from/to with from <= to";
    range = { from, to };
  }
  const offset = args["offset"] ?? 1;
  const limit = args["limit"] ?? DEFAULT_MAX_LINES;
  if (!range && (typeof offset !== "number" || typeof limit !== "number" || !Number.isSafeInteger(offset) || !Number.isSafeInteger(limit) || offset < 0 || limit < 1)) return "Error: read requires integer offset and positive limit";
  const from = range?.from ?? Math.max(1, Number(offset));
  const to = range?.to ?? (from + Number(limit) - 1);
  const version = sha256Hex(Buffer.from(st.sourceVersion));
  try {
    const page = await readTextWindow({
      size: st.size,
      version,
      readRange: (offset, length) => ctx.adapter.readRange!(resolved.canonical, offset, length),
      currentVersion: async () => {
        const current = await ctx.adapter.stat(resolved.canonical);
        return current?.sourceVersion ? sha256Hex(Buffer.from(current.sourceVersion)) : "unavailable";
      },
    }, { from, to,
      ...(typeof args["readCursor"] === "string" ? { cursor: args["readCursor"] } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    return JSON.stringify(page);
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : "text range unavailable"}`;
  }
}

async function statCommand(
  zone: RelayLocalFileZone,
  args: Record<string, unknown>,
  ctx: LocalFileCommandContext,
): Promise<string> {
  const resolved = await resolvePathArg(zone, args, ctx);
  if (!resolved.ok) return resolved.text;
  const st = await ctx.adapter.stat(resolved.canonical);
  if (!st) return `Error: ENOENT ${resolved.resolved}`;
  return JSON.stringify({
    path: resolved.resolved,
    size: st.size,
    mtimeMs: st.mtimeMs,
    isFile: st.isFile,
    isDirectory: st.isDirectory,
    isSymbolicLink: st.isSymbolicLink,
  });
}

async function writeCommand(
  zone: RelayLocalFileZone,
  args: Record<string, unknown>,
  ctx: LocalFileCommandContext,
  createOnly = false,
): Promise<string> {
  if (createOnly && (args["mode"] !== undefined || args["expectedSha256"] !== undefined)) {
    return JSON.stringify({ error: "invalid_create_options", message: "create requires a missing destination and accepts no write mode or existing hash" });
  }
  const content = args["content"];
  if (typeof content !== "string") return "Error: write requires content";
  // Explicit absence is a create-only guard. Older relays reject null as an
  // invalid SHA, so they cannot silently downgrade this into an overwrite.
  const expectAbsent = args["expectedSha256"] === null;
  const expectedParsed = expectAbsent
    ? { ok: true as const, value: undefined }
    : parseOptionalExpectedSha256(args);
  if (!expectedParsed.ok) return expectedParsed.text;
  const expectedSha256 = expectedParsed.value;
  const clientMutationId = parseOptionalClientMutationId(args);

  const resolved = await resolvePathArg(zone, args, ctx);
  if (!resolved.ok) return resolved.text;

  const transactionId = resolveLocalMutationTransactionId(ctx.routing);
  if (!transactionId) {
    return JSON.stringify({ error: "missing_turn_id", hint: "turnId or appOperationId required for local mutations" });
  }

  const mode = args["mode"] ?? "overwrite";
  if ((expectedSha256 || expectAbsent) && mode !== "overwrite") {
    return JSON.stringify({
      error: "invalid_write_mode",
      message: "expectedSha256 requires mode overwrite",
    });
  }

  const isBase64 = args["encoding"] === "base64";
  const contentBytes = isBase64 ? Buffer.from(content, "base64") : Buffer.from(content, "utf-8");

  if (expectedSha256 && contentBytes.byteLength > RELAY_FS_MAX_BYTES) {
    return JSON.stringify({
      error: "document_transport_required",
      message: `guarded writes above ${RELAY_FS_MAX_BYTES} bytes must use kind:"document" chunk transport`,
    });
  }

  const lockedPath = await revalidatePath(ctx.adapter, resolved.resolved, ctx.allowedRoots);
  if (!lockedPath.ok) return lockedPath.text;
  if (lockedPath.canonical !== resolved.canonical) {
    return "Error: canonical path changed during write mutation";
  }
    const preSnap = await readState(ctx.adapter, resolved.canonical);
    if (expectAbsent && preSnap.kind !== "missing") {
      return JSON.stringify({ error: "destination_exists", message: "The destination already exists; choose another name or explicitly overwrite it." });
    }
    if (createOnly && preSnap.kind !== "missing") {
      return JSON.stringify({ error: "EXISTS", message: "A file already exists at the destination." });
    }
    const preBytes = preSnap.kind === "bytes" ? preSnap.bytes : new Uint8Array();
    let post: Uint8Array;
    if (mode === "append") {
      post = Buffer.concat([Buffer.from(preBytes), contentBytes]);
    } else if (mode === "prepend") {
      post = Buffer.concat([contentBytes, Buffer.from(preBytes)]);
    } else {
      post = contentBytes;
    }
    if (expectedSha256) {
      try {
        await assertExpectedSha256(ctx.adapter, resolved.canonical, expectedSha256);
      } catch (err) {
        if (err instanceof GuardedWriteError && err.code === "stale_sha256") {
          return staleSha256Result(err.details);
        }
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: "read_failed", message: msg });
      }
    }

    const postSnap = snapshotFromBytes(post);
  return executeCoordinatedContentMutation(ctx, {
    canonicalPath: resolved.canonical,
    zone,
    command: createOnly ? "create" : "write",
    displayPath: resolved.displayPath,
    preState: preSnap,
    postState: postSnap,
    ...(clientMutationId ? { clientMutationId } : {}),
    ...((expectedSha256 || expectAbsent || createOnly || isBase64) ? { includeSha256: true } : {}),
  });
}

async function insertCommand(
  zone: RelayLocalFileZone,
  args: Record<string, unknown>,
  ctx: LocalFileCommandContext,
): Promise<string> {
  const content = args["content"];
  const lineNumber = args["lineNumber"];
  if (typeof content !== "string") return "Error: insert requires content";
  if (typeof lineNumber !== "number") return "Error: insert requires lineNumber";
  const resolved = await resolvePathArg(zone, args, ctx);
  if (!resolved.ok) return resolved.text;

  const transactionId = resolveLocalMutationTransactionId(ctx.routing);
  if (!transactionId) {
    return JSON.stringify({ error: "missing_turn_id", hint: "turnId or appOperationId required for local mutations" });
  }

  const lockedPath = await revalidatePath(ctx.adapter, resolved.resolved, ctx.allowedRoots);
  if (!lockedPath.ok) return lockedPath.text;
  if (lockedPath.canonical !== resolved.canonical) {
    return "Error: canonical path changed during insert mutation";
  }
    const preSnap = await readState(ctx.adapter, resolved.canonical);
    const preBytes = preSnap.kind === "bytes" ? preSnap.bytes : new Uint8Array();
    const lines = Buffer.from(preBytes).toString("utf-8").split("\n");
    const idx = Math.max(0, Math.min(lines.length, lineNumber - 1));
    lines.splice(idx, 0, content);
    const post = Buffer.from(lines.join("\n"), "utf-8");
    const postSnap = snapshotFromBytes(post);

  return executeCoordinatedContentMutation(ctx, {
    canonicalPath: resolved.canonical,
    zone,
    command: "insert",
    displayPath: resolved.displayPath,
    preState: preSnap,
    postState: postSnap,
  });
}

function computeLineRangeWindow(
  original: string,
  lineRange: { from: number; to: number },
):
  | { ok: true; windowStart: number; windowEnd: number }
  | { ok: false; error: string } {
  const lines = original.split("\n");
  if (lineRange.from < 1 || lineRange.from > lines.length) {
    return {
      ok: false,
      error: `lineRange.from ${lineRange.from} is outside file bounds (file has ${lines.length} lines)`,
    };
  }
  if (lineRange.to < lineRange.from) {
    return {
      ok: false,
      error: `lineRange.to (${lineRange.to}) must be >= lineRange.from (${lineRange.from})`,
    };
  }
  if (lineRange.to > lines.length) {
    return {
      ok: false,
      error: `lineRange.to ${lineRange.to} is outside file bounds (file has ${lines.length} lines)`,
    };
  }

  let windowStart = 0;
  for (let i = 0; i < lineRange.from - 1; i++) {
    windowStart += (lines[i] ?? "").length + 1;
  }
  let windowEnd = windowStart;
  for (let i = lineRange.from - 1; i < lineRange.to; i++) {
    windowEnd += (lines[i] ?? "").length + 1;
  }
  return { ok: true, windowStart, windowEnd: Math.min(windowEnd, original.length) };
}

async function strReplaceCommand(
  zone: RelayLocalFileZone,
  args: Record<string, unknown>,
  ctx: LocalFileCommandContext,
): Promise<string> {
  const newString = args["newString"];
  if (typeof newString !== "string") return "Error: str_replace requires newString";
  const resolved = await resolvePathArg(zone, args, ctx);
  if (!resolved.ok) return resolved.text;

  const transactionId = resolveLocalMutationTransactionId(ctx.routing);
  if (!transactionId) {
    return JSON.stringify({ error: "missing_turn_id", hint: "turnId or appOperationId required for local mutations" });
  }

  const oldString = args["oldString"];
  const startFragment = args["startFragment"];
  const endFragment = args["endFragment"];
  const lineRange = args["lineRange"] as { from?: number; to?: number } | undefined;
  const replaceAll = args["replaceAll"] === true;

  const hasOldString = typeof oldString === "string" && oldString.length > 0;
  const hasBookend = typeof startFragment === "string" && typeof endFragment === "string";
  const hasOnlyLineRange = lineRange != null && !hasOldString && !hasBookend;
  const hasPartialBookend =
    (typeof startFragment === "string") !== (typeof endFragment === "string");

  if (replaceAll && !hasOldString) {
    return "Error: replaceAll requires a non-empty oldString";
  }
  if (hasPartialBookend) {
    return "Error: Bookend mode requires BOTH startFragment and endFragment (you provided only one)";
  }
  const modes = [hasOldString, hasOnlyLineRange, hasBookend].filter(Boolean).length;
  if (modes === 0) {
    return "Error: No disambiguator provided. Specify oldString, lineRange alone, or startFragment+endFragment.";
  }
  if (modes > 1) {
    return "Error: Ambiguous — multiple disambiguators provided (pick exactly one of oldString / lineRange-alone / startFragment+endFragment)";
  }

  const lockedPath = await revalidatePath(ctx.adapter, resolved.resolved, ctx.allowedRoots);
  if (!lockedPath.ok) return lockedPath.text;
  if (lockedPath.canonical !== resolved.canonical) {
    return "Error: canonical path changed during str_replace mutation";
  }
  const preSnap = await readState(ctx.adapter, resolved.canonical);
  const preBytes = preSnap.kind === "bytes" ? preSnap.bytes : new Uint8Array();
  const original = Buffer.from(preBytes).toString("utf-8");

  let windowStart = 0;
  let windowEnd = original.length;
  if (lineRange && typeof lineRange.from === "number" && typeof lineRange.to === "number") {
    const window = computeLineRangeWindow(original, {
      from: lineRange.from,
      to: lineRange.to,
    });
    if (!window.ok) return `Error: ${window.error}`;
    windowStart = window.windowStart;
    windowEnd = window.windowEnd;
  }

  let text: string;
  if (hasOldString) {
    const count = original.split(oldString).length - 1;
    if (count === 0) return `Error: oldString not found in ${resolved.displayPath}`;
    if (count > 1 && !replaceAll) {
      return `Error: oldString is ambiguous (${count} matches)`;
    }
    text = replaceAll
      ? original.split(oldString).join(newString)
      : original.replace(oldString, newString);
  } else if (hasBookend) {
    const result = findFragmentRange({
      haystack: original,
      startFragment,
      endFragment,
      startFrom: windowStart,
      normalize: "safe",
      requireUnique: true,
    });
    if (!result.ok) return `Error: ${result.reason}`;
    if (result.endIndex > windowEnd) {
      return "Error: bookend match extends past the specified lineRange. Widen the lineRange or narrow the fragments.";
    }
    text =
      original.slice(0, result.startIndex) + newString + original.slice(result.endIndex);
  } else if (lineRange && typeof lineRange.from === "number" && typeof lineRange.to === "number") {
    const lines = original.split("\n");
    const from = Math.max(1, lineRange.from) - 1;
    const to = Math.min(lines.length, lineRange.to);
    lines.splice(from, to - from, newString);
    text = lines.join("\n");
  } else {
    return "Error: No disambiguator provided. Specify oldString, lineRange alone, or startFragment+endFragment.";
  }

  const post = Buffer.from(text, "utf-8");
  const postSnap = snapshotFromBytes(post);

  return executeCoordinatedContentMutation(ctx, {
    canonicalPath: resolved.canonical,
    zone,
    command: "str_replace",
    displayPath: resolved.displayPath,
    preState: preSnap,
    postState: postSnap,
  });
}

async function executeCoordinatedStructuralMutation(
  ctx: LocalFileCommandContext,
  args: {
    readonly command: "delete" | "move" | "copy";
    readonly sourcePath: string;
    readonly destinationPath?: string;
    readonly displayPath: string;
    readonly zone: RelayLocalFileZone;
  },
): Promise<string> {
  const turnId = resolveLocalMutationTransactionId(ctx.routing);
  if (!turnId) {
    return JSON.stringify({
      error: "missing_turn_id",
      hint: "turnId or appOperationId required for local mutations",
    });
  }
  if (!ctx.routing.mutationRequestId) {
    return JSON.stringify({
      error: "missing_mutation_request_id",
      message: "trusted file-tool mutation request identity is unavailable",
    });
  }
  if (!ctx.structuralCommit) {
    return JSON.stringify({
      error: "runtime_unavailable",
      message: "Desktop document mutation runtime is unavailable",
    });
  }
  const committed = await ctx.structuralCommit({
    command: args.command,
    sourcePath: args.sourcePath,
    ...(args.destinationPath === undefined
      ? {}
      : { destinationPath: args.destinationPath }),
    authorizedRoots: ctx.allowedRoots,
    agentId: ctx.routing.agentId,
    turnId,
    mutationRequestId: ctx.routing.mutationRequestId,
    semanticDigest: ctx.mutationSemanticDigest,
    ...(ctx.routing.mutationRetry === true ? { replayOnly: true } : {}),
  });
  if (!committed.ok) {
    return JSON.stringify({
      error: committed.code,
      message: committed.message,
      retryable: false,
      ...(committed.code === "human_edit_conflict" ||
          committed.code === "reapply_required"
        ? {
            hint:
              "Reread current filesystem state and issue a new edit; do not blindly retry this mutation.",
          }
        : {}),
    });
  }
  return JSON.stringify({
    applied: true,
    revisionId: formatRevisionRef(ctx.relayId, committed.revisionId),
    path: args.displayPath,
    zone: args.zone,
    command: args.command,
    ...(committed.sha256 === null ? {} : { sha256: committed.sha256 }),
    replayed: committed.replayed,
    summary: args.command === "delete"
      ? `Deleted ${args.displayPath}`
      : `${args.command === "move" ? "Moved" : "Copied"} to ${args.displayPath}`,
  });
}

async function moveCommand(
  zone: RelayLocalFileZone,
  args: Record<string, unknown>,
  ctx: LocalFileCommandContext,
): Promise<string> {
  const destPath = args["destinationPath"];
  if (typeof destPath !== "string") return "Error: move requires destinationPath";
  const destZone = (args["destinationZone"] ?? zone) as RelayLocalFileZone;
  const rawPath = args["path"];
  if (typeof rawPath !== "string") return "Error: path is required";
  const src = resolveZonePath(zone, rawPath, ctx.routing);
  if (!src.ok) return `Error: ${src.reason}`;
  const dest = resolveZonePath(destZone, destPath, ctx.routing);
  if (!dest.ok) return `Error (destination): ${dest.reason}`;
  return executeCoordinatedStructuralMutation(ctx, {
    command: "move",
    sourcePath: src.resolved,
    destinationPath: dest.resolved,
    displayPath: dest.displayPath,
    zone: destZone,
  });
}

async function copyCommand(
  zone: RelayLocalFileZone,
  args: Record<string, unknown>,
  ctx: LocalFileCommandContext,
): Promise<string> {
  const destPath = args["destinationPath"];
  if (typeof destPath !== "string") return "Error: copy requires destinationPath";
  const destZone = (args["destinationZone"] ?? zone) as RelayLocalFileZone;
  const rawPath = args["path"];
  if (typeof rawPath !== "string") return "Error: path is required";
  const src = resolveZonePath(zone, rawPath, ctx.routing);
  if (!src.ok) return `Error: ${src.reason}`;
  const dest = resolveZonePath(destZone, destPath, ctx.routing);
  if (!dest.ok) return `Error (destination): ${dest.reason}`;
  return executeCoordinatedStructuralMutation(ctx, {
    command: "copy",
    sourcePath: src.resolved,
    destinationPath: dest.resolved,
    displayPath: dest.displayPath,
    zone: destZone,
  });
}

async function deleteCommand(
  zone: RelayLocalFileZone,
  args: Record<string, unknown>,
  ctx: LocalFileCommandContext,
): Promise<string> {
  if (args["recursive"] === true) {
    return JSON.stringify({
      error: "recursive_delete_unsupported",
      message: "recursive local-file delete is not supported",
    });
  }
  const rawPath = args["path"];
  if (typeof rawPath !== "string") return "Error: path is required";
  const resolved = resolveZonePath(zone, rawPath, ctx.routing);
  if (!resolved.ok) return `Error: ${resolved.reason}`;
  return executeCoordinatedStructuralMutation(ctx, {
    command: "delete",
    sourcePath: resolved.resolved,
    displayPath: resolved.displayPath,
    zone,
  });
}
