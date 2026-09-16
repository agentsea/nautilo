/**
 * M216 — bounded Writer document transport for Current Folder live review.
 *
 * Typed `kind:"document"` operations only. Generic `file.read` keeps the 16 MiB
 * cap; this path serves canonical reads and guarded writes up to 50 MiB via
 * ordered chunks without a single oversized WebSocket payload.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  RELAY_FS_MAX_BYTES,
  RELAY_LOCAL_DOCUMENT_CHUNK_BYTES,
  RELAY_LOCAL_DOCUMENT_MAX_BYTES,
  RELAY_LOCAL_DOCUMENT_TRANSFER_TTL_MS,
  type RelayLocalDocumentCommand,
  type RelayLocalFileZone,
} from "@nautilo/relay";

import { sha256Hex, snapshotFromBytes } from "../local-file-history/hash.ts";
import { readState } from "../local-file-history/journal.ts";
import {
  GuardedWriteError,
  assertExpectedSha256,
  parseOptionalClientMutationId,
  parseOptionalExpectedSha256,
  staleSha256Result,
} from "./guarded-write.ts";
import type { LocalFileCommandContext } from "./commands.ts";
import { executeCoordinatedContentMutation } from "./commands.ts";
import { resolveZonePath, stripRouting } from "./paths.ts";

const SESSION_ID_RE = /^[0-9a-f-]{36}$/i;
const MAX_DOCUMENT_SESSIONS = 4;
const STAGING_DIR = path.join(os.tmpdir(), "nautilo-document-staging");

type ReadSession = {
  canonical: string;
  totalBytes: number;
  chunkCount: number;
  sha256: string;
  expectedIndex: number;
  chunkInFlight: boolean;
  createdAt: number;
};

type WriteSession = {
  canonical: string;
  resolved: string;
  displayPath: string;
  zone: RelayLocalFileZone;
  totalBytes: number;
  chunkCount: number;
  expectedSha256: string;
  clientMutationId?: string | undefined;
  stagingPath: string;
  expectedIndex: number;
  receivedBytes: number;
  createdAt: number;
};

const readSessions = new Map<string, ReadSession>();
const writeSessions = new Map<string, WriteSession>();

function documentError(code: string, message: string): string {
  return JSON.stringify({ error: code, message });
}

function parseSessionId(value: unknown): string | null {
  if (typeof value !== "string" || !SESSION_ID_RE.test(value)) return null;
  return value;
}

function decodeDocumentChunk(value: unknown): Buffer | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    value.length > Math.ceil(RELAY_LOCAL_DOCUMENT_CHUNK_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return null;
  }
  const bytes = Buffer.from(value, "base64");
  return bytes.byteLength <= RELAY_LOCAL_DOCUMENT_CHUNK_BYTES && bytes.toString("base64") === value
    ? bytes
    : null;
}

function expectedChunkCount(totalBytes: number): number {
  return Math.ceil(totalBytes / RELAY_LOCAL_DOCUMENT_CHUNK_BYTES);
}

function documentSizeBand(size: number): "too_small" | "ok" | "too_large" {
  if (size <= RELAY_FS_MAX_BYTES) return "too_small";
  if (size > RELAY_LOCAL_DOCUMENT_MAX_BYTES) return "too_large";
  return "ok";
}

async function expireDocumentSessions(): Promise<void> {
  const now = Date.now();
  for (const [id, session] of readSessions) {
    if (now - session.createdAt > RELAY_LOCAL_DOCUMENT_TRANSFER_TTL_MS) {
      readSessions.delete(id);
    }
  }
  for (const [id, session] of writeSessions) {
    if (now - session.createdAt > RELAY_LOCAL_DOCUMENT_TRANSFER_TTL_MS) {
      await cleanupWriteSession(id, session);
    }
  }
}

async function cleanupWriteSession(sessionId: string, session: WriteSession): Promise<void> {
  writeSessions.delete(sessionId);
  await fs.rm(session.stagingPath, { force: true }).catch(() => undefined);
}

async function assertContainedPath(
  ctx: LocalFileCommandContext,
  zone: RelayLocalFileZone,
  rawPath: string,
): Promise<
  | { ok: true; resolved: string; canonical: string; displayPath: string }
  | { ok: false; text: string }
> {
  const resolution = resolveZonePath(zone, rawPath, ctx.routing);
  if (!resolution.ok) return { ok: false, text: documentError("path_forbidden", resolution.reason) };

  try {
    const lst = await fs.lstat(resolution.resolved);
    if (lst.isSymbolicLink()) {
      return { ok: false, text: documentError("path_forbidden", `refusing symlink path ${resolution.resolved}`) };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, text: documentError("path_forbidden", msg) };
    }
  }

  try {
    const canonical = await ctx.adapter.canonicalize(resolution.resolved);
    for (const root of ctx.allowedRoots) {
      const rootCanon = await ctx.adapter.canonicalize(root);
      const rel = path.relative(rootCanon, canonical);
      if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
        return {
          ok: true,
          resolved: resolution.resolved,
          canonical,
          displayPath: resolution.displayPath,
        };
      }
    }
    return { ok: false, text: documentError("path_forbidden", `path outside allowed roots: ${resolution.resolved}`) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, text: documentError("path_forbidden", msg) };
  }
}

async function readMetaCommand(
  zone: RelayLocalFileZone,
  args: Record<string, unknown>,
  ctx: LocalFileCommandContext,
): Promise<string> {
  await expireDocumentSessions();
  const sessionId = parseSessionId(args["sessionId"]);
  if (!sessionId) return documentError("invalid_session", "sessionId must be a UUID");
  if (readSessions.has(sessionId) || readSessions.size >= MAX_DOCUMENT_SESSIONS) {
    return documentError("invalid_session", "document read session unavailable");
  }

  const rawPath = args["path"];
  if (typeof rawPath !== "string") return documentError("invalid_request", "path is required");

  const resolved = await assertContainedPath(ctx, zone, rawPath);
  if (!resolved.ok) return resolved.text;

  const st = await ctx.adapter.stat(resolved.canonical);
  if (!st?.isFile) return documentError("not_a_file", `${resolved.resolved} is not a readable file`);

  const band = documentSizeBand(st.size);
  if (band === "too_small") {
    return documentError(
      "document_transport_not_required",
      `files at or below ${RELAY_FS_MAX_BYTES} bytes must use generic file.read`,
    );
  }
  if (band === "too_large") {
    return documentError(
      "document_too_large",
      `document exceeds ${RELAY_LOCAL_DOCUMENT_MAX_BYTES}-byte Writer cap`,
    );
  }

  const bytes = await ctx.adapter.readFile(resolved.canonical);
  const sha256 = sha256Hex(bytes);
  const chunkCount = expectedChunkCount(st.size);
  readSessions.set(sessionId, {
    canonical: resolved.canonical,
    totalBytes: st.size,
    chunkCount,
    sha256,
    expectedIndex: 0,
    chunkInFlight: false,
    createdAt: Date.now(),
  });

  return JSON.stringify({
    sessionId,
    totalBytes: st.size,
    chunkCount,
    sha256,
  });
}

async function readChunkCommand(
  zone: RelayLocalFileZone,
  args: Record<string, unknown>,
  ctx: LocalFileCommandContext,
): Promise<string> {
  await expireDocumentSessions();
  const sessionId = parseSessionId(args["sessionId"]);
  if (!sessionId) return documentError("invalid_session", "sessionId must be a UUID");

  const session = readSessions.get(sessionId);
  if (!session) return documentError("invalid_session", "unknown or expired document read session");

  const rawPath = args["path"];
  if (typeof rawPath !== "string") return documentError("invalid_request", "path is required");

  const resolved = await assertContainedPath(ctx, zone, rawPath);
  if (!resolved.ok) return resolved.text;
  if (resolved.canonical !== session.canonical) {
    return documentError("session_path_mismatch", "sessionId does not match canonical path");
  }

  const offset = args["offset"];
  const index = args["index"];
  const chunkCount = args["chunkCount"];
  if (
    !Number.isSafeInteger(offset) ||
    (offset as number) < 0 ||
    !Number.isSafeInteger(index) ||
    (index as number) < 0 ||
    !Number.isSafeInteger(chunkCount) ||
    (chunkCount as number) <= 0 ||
    (index as number) >= (chunkCount as number)
  ) {
    return documentError("invalid_chunk", "invalid document chunk coordinates");
  }

  const chunkIndex = index as number;
  const totalChunks = chunkCount as number;
  const chunkOffset = offset as number;

  if (session.chunkInFlight || chunkIndex !== session.expectedIndex) {
    return documentError("invalid_chunk", "out-of-order or duplicate document read chunk");
  }
  session.chunkInFlight = true;
  try {
    if (
      totalChunks !== session.chunkCount ||
      session.totalBytes !== (await ctx.adapter.stat(resolved.canonical))?.size
    ) {
      return documentError("invalid_chunk", "chunk count or total bytes mismatch");
    }
    if (chunkOffset !== chunkIndex * RELAY_LOCAL_DOCUMENT_CHUNK_BYTES) {
      return documentError("invalid_chunk", "invalid document chunk offset");
    }
    if (totalChunks !== expectedChunkCount(session.totalBytes)) {
      return documentError("invalid_chunk", "invalid document chunk count");
    }

    if (!ctx.adapter.readRange) {
      return documentError("unsupported", "relay does not support secure document range reads");
    }

    const expectedBytes = Math.min(
      RELAY_LOCAL_DOCUMENT_CHUNK_BYTES,
      session.totalBytes - chunkOffset,
    );
    const chunk = Buffer.from(
      await ctx.adapter.readRange(
        resolved.canonical,
        chunkOffset,
        expectedBytes,
      ),
    );
    if (chunk.byteLength !== expectedBytes) {
      return documentError("invalid_chunk", "document read chunk length mismatch");
    }

    const result = JSON.stringify({
      sessionId,
      index: chunkIndex,
      chunkCount: totalChunks,
      totalBytes: session.totalBytes,
      data: chunk.toString("base64"),
    });
    session.expectedIndex += 1;
    if (session.expectedIndex === session.chunkCount) {
      readSessions.delete(sessionId);
    }
    return result;
  } finally {
    session.chunkInFlight = false;
  }
}

async function stagingPathFor(sessionId: string): Promise<string> {
  await fs.mkdir(STAGING_DIR, { recursive: true, mode: 0o700 });
  return path.join(STAGING_DIR, `${sessionId}.part`);
}

async function writeBeginCommand(
  zone: RelayLocalFileZone,
  args: Record<string, unknown>,
  ctx: LocalFileCommandContext,
): Promise<string> {
  await expireDocumentSessions();
  const sessionId = parseSessionId(args["sessionId"]);
  if (!sessionId) return documentError("invalid_session", "sessionId must be a UUID");
  if (writeSessions.has(sessionId) || writeSessions.size >= MAX_DOCUMENT_SESSIONS) {
    return documentError("invalid_session", "document write session unavailable");
  }

  const expectedParsed = parseOptionalExpectedSha256(args);
  if (!expectedParsed.ok) return expectedParsed.text;
  const expectedSha256 = expectedParsed.value;
  if (!expectedSha256) {
    return documentError("invalid_request", "expectedSha256 is required for document write transport");
  }

  const totalBytes = args["totalBytes"];
  const chunkCount = args["chunkCount"];
  if (
    typeof totalBytes !== "number" ||
    !Number.isSafeInteger(totalBytes) ||
    typeof chunkCount !== "number" ||
    !Number.isSafeInteger(chunkCount) ||
    totalBytes <= RELAY_FS_MAX_BYTES ||
    totalBytes > RELAY_LOCAL_DOCUMENT_MAX_BYTES ||
    chunkCount !== expectedChunkCount(totalBytes)
  ) {
    return documentError("invalid_request", "invalid document write size or chunk count");
  }

  const rawPath = args["path"];
  if (typeof rawPath !== "string") return documentError("invalid_request", "path is required");

  const resolved = await assertContainedPath(ctx, zone, rawPath);
  if (!resolved.ok) return resolved.text;

  const stagingPath = await stagingPathFor(sessionId);
  await fs.writeFile(stagingPath, new Uint8Array(), { mode: 0o600 });

  writeSessions.set(sessionId, {
    canonical: resolved.canonical,
    resolved: resolved.resolved,
    displayPath: resolved.displayPath,
    zone,
    totalBytes,
    chunkCount,
    expectedSha256,
    clientMutationId: parseOptionalClientMutationId(args),
    stagingPath,
    expectedIndex: 0,
    receivedBytes: 0,
    createdAt: Date.now(),
  });

  return JSON.stringify({ sessionId, totalBytes, chunkCount });
}

async function writeChunkCommand(
  zone: RelayLocalFileZone,
  args: Record<string, unknown>,
  ctx: LocalFileCommandContext,
): Promise<string> {
  await expireDocumentSessions();
  const sessionId = parseSessionId(args["sessionId"]);
  if (!sessionId) return documentError("invalid_session", "sessionId must be a UUID");

  const session = writeSessions.get(sessionId);
  if (!session) return documentError("invalid_session", "unknown or expired document write session");

  const rawPath = args["path"];
  if (typeof rawPath !== "string") {
    await cleanupWriteSession(sessionId, session);
    return documentError("invalid_request", "path is required");
  }

  const resolved = await assertContainedPath(ctx, zone, rawPath);
  if (!resolved.ok) {
    await cleanupWriteSession(sessionId, session);
    return resolved.text;
  }
  if (resolved.canonical !== session.canonical || zone !== session.zone) {
    await cleanupWriteSession(sessionId, session);
    return documentError("session_path_mismatch", "sessionId does not match canonical path");
  }

  const index = args["index"];
  const chunkCount = args["chunkCount"];
  const offset = args["offset"];
  if (
    !Number.isSafeInteger(index) ||
    index !== session.expectedIndex ||
    chunkCount !== session.chunkCount ||
    offset !== index * RELAY_LOCAL_DOCUMENT_CHUNK_BYTES
  ) {
    await cleanupWriteSession(sessionId, session);
    return documentError("out_of_order_chunk", "out-of-order or mismatched document write chunk");
  }

  const chunk = decodeDocumentChunk(args["data"]);
  const remaining = session.totalBytes - session.receivedBytes;
  if (
    !chunk ||
    chunk.byteLength <= 0 ||
    chunk.byteLength > remaining ||
    (index < session.chunkCount - 1 && chunk.byteLength !== RELAY_LOCAL_DOCUMENT_CHUNK_BYTES)
  ) {
    await cleanupWriteSession(sessionId, session);
    return documentError("malformed_chunk", "malformed or oversized document write chunk");
  }

  try {
    await fs.appendFile(session.stagingPath, chunk);
  } catch (err) {
    await cleanupWriteSession(sessionId, session);
    throw err;
  }
  session.receivedBytes += chunk.byteLength;
  session.expectedIndex += 1;

  return JSON.stringify({
    sessionId,
    index,
    receivedBytes: session.receivedBytes,
  });
}

async function writeAbortCommand(
  zone: RelayLocalFileZone,
  args: Record<string, unknown>,
  ctx: LocalFileCommandContext,
): Promise<string> {
  await expireDocumentSessions();
  const sessionId = parseSessionId(args["sessionId"]);
  if (!sessionId) return documentError("invalid_session", "sessionId must be a UUID");

  const session = writeSessions.get(sessionId);
  if (!session) return JSON.stringify({ aborted: true, sessionId });

  const rawPath = args["path"];
  if (typeof rawPath === "string") {
    const resolved = await assertContainedPath(ctx, zone, rawPath);
    if (resolved.ok && resolved.canonical !== session.canonical) {
      await cleanupWriteSession(sessionId, session);
      return documentError("session_path_mismatch", "sessionId does not match canonical path");
    }
  }

  await cleanupWriteSession(sessionId, session);
  return JSON.stringify({ aborted: true, sessionId });
}

async function writeCommitCommand(
  zone: RelayLocalFileZone,
  args: Record<string, unknown>,
  ctx: LocalFileCommandContext,
): Promise<string> {
  await expireDocumentSessions();
  const sessionId = parseSessionId(args["sessionId"]);
  if (!sessionId) return documentError("invalid_session", "sessionId must be a UUID");

  const session = writeSessions.get(sessionId);
  if (!session) return documentError("invalid_session", "unknown or expired document write session");

  try {
    const rawPath = args["path"];
    if (typeof rawPath !== "string") return documentError("invalid_request", "path is required");

    const resolved = await assertContainedPath(ctx, zone, rawPath);
    if (!resolved.ok) return resolved.text;
    if (resolved.canonical !== session.canonical || zone !== session.zone) {
      return documentError("session_path_mismatch", "sessionId does not match canonical path");
    }

    const totalBytes = args["totalBytes"];
    const chunkCount = args["chunkCount"];
    const contentShaParsed = parseOptionalExpectedSha256({ expectedSha256: args["sha256"] });
    if (!contentShaParsed.ok) return contentShaParsed.text;
    const contentSha256 = contentShaParsed.value;
    const expectedParsed = parseOptionalExpectedSha256(args);
    if (!expectedParsed.ok) return expectedParsed.text;

    if (
      typeof totalBytes !== "number" ||
      totalBytes !== session.totalBytes ||
      chunkCount !== session.chunkCount ||
      !contentSha256 ||
      expectedParsed.value !== session.expectedSha256
    ) {
      return documentError("invalid_commit", "document write commit metadata mismatch");
    }

    if (session.expectedIndex !== session.chunkCount || session.receivedBytes !== session.totalBytes) {
      return documentError("incomplete_transfer", "document write transfer incomplete");
    }

    let staged: Buffer;
    try {
      staged = await fs.readFile(session.stagingPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return documentError("staging_read_failed", msg);
    }

    const actualContentSha = sha256Hex(staged);
    if (actualContentSha !== contentSha256) {
      return documentError("sha256_mismatch", "staged document sha256 does not match commit sha256");
    }

    const clientMutationId = parseOptionalClientMutationId(args) ?? session.clientMutationId;
    const postBytes = new Uint8Array(staged.buffer, staged.byteOffset, staged.byteLength);
    const postSnap = snapshotFromBytes(postBytes);

    const lockedPath = await assertContainedPath(ctx, zone, rawPath);
    if (!lockedPath.ok) return lockedPath.text;
    if (lockedPath.canonical !== session.canonical) {
      return documentError("path_forbidden", "canonical path changed during document write commit");
    }
      const preSnap = await readState(ctx.adapter, session.canonical);
      try {
        await assertExpectedSha256(ctx.adapter, session.canonical, session.expectedSha256);
      } catch (err) {
        if (err instanceof GuardedWriteError && err.code === "stale_sha256") {
          return staleSha256Result(err.details);
        }
        const msg = err instanceof Error ? err.message : String(err);
        return documentError("read_failed", msg);
      }

    const result = await executeCoordinatedContentMutation(ctx, {
      canonicalPath: session.canonical,
      zone: session.zone,
      command: "document_write_commit",
      displayPath: session.displayPath,
      preState: preSnap,
      postState: postSnap,
      ...(clientMutationId ? { clientMutationId } : {}),
      includeSha256: true,
    });
    return result;
  } finally {
    await cleanupWriteSession(sessionId, session);
  }
}

export function isMutatingDocumentCommand(command: RelayLocalDocumentCommand): boolean {
  return (
    command === "write_begin" ||
    command === "write_chunk" ||
    command === "write_commit" ||
    command === "write_abort"
  );
}

export async function executeLocalDocumentCommand(
  command: RelayLocalDocumentCommand,
  zone: RelayLocalFileZone,
  rawArgs: Record<string, unknown>,
  ctx: LocalFileCommandContext,
): Promise<unknown> {
  const args = stripRouting(rawArgs);
  switch (command) {
    case "read_meta":
      return readMetaCommand(zone, args, ctx);
    case "read_chunk":
      return readChunkCommand(zone, args, ctx);
    case "write_begin":
      return writeBeginCommand(zone, args, ctx);
    case "write_chunk":
      return writeChunkCommand(zone, args, ctx);
    case "write_commit":
      return writeCommitCommand(zone, args, ctx);
    case "write_abort":
      return writeAbortCommand(zone, args, ctx);
    default:
      return documentError("unknown_command", `unknown document command ${String(command)}`);
  }
}

/** Test hook — reset in-memory document transfer sessions. */
export function resetDocumentTransferSessionsForTests(): void {
  readSessions.clear();
  for (const session of writeSessions.values()) {
    void fs.rm(session.stagingPath, { force: true }).catch(() => undefined);
  }
  writeSessions.clear();
}
