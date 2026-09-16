/**
 * D429 Phase 7.4.2 — authenticated, verified-byte explainer media route.
 *
 * `GET /api/explainers/:id/media` resolves a catalog id from the ACTIVE signed
 * catalog (signed remote LKG or bundled seed), fetches the opaque asset key
 * from the fixed allowlisted public media origin, and serves MP4 bytes to the
 * browser ONLY after exact byteLength + SHA-256 verification.
 *
 * Security contract:
 *   - Authenticated only (bearer via the normal trust preHandler; never in
 *     PUBLIC_ROUTES / trust-bypass). Unauthenticated => 401.
 *   - The id is resolved from the active signed catalog only; an unknown id
 *     fails closed with 404 (no local spoof, no caller URL/path).
 *   - The playback URL is derived from the fixed allowlisted public origin
 *     (`resolveExplainerMediaOrigin`) + the catalog's contained, encoded key.
 *     No caller-supplied URL or path is ever accepted.
 *   - Public MP4 GET with `redirect: "error"`, a timeout covering the FULL
 *     body, exact `video/mp4` Content-Type, and a Content-Length precheck.
 *   - Hard cap no greater than the source schema cap (512 MiB) and the
 *     entry's declared `byteLength`; bytes are spooled to an owned temp file
 *     while hashing (never buffered in heap), and the response is streamed
 *     ONLY after the exact byteLength + SHA-256 match. Never stream
 *     unverified bytes.
 *   - Fail closed on altered/oversize/wrong-type/timeout/origin failure.
 *   - The cache key is the verified content digest (`contentSha256`), never
 *     the id or path. Every cache hit is streamed through exact size + SHA-256
 *     verification; a corrupt cache entry is evicted and re-fetched.
 *   - The browser sees only the local API response: no CDN/media URL, no
 *     provider identity, no AgentSea reader token, no raw origin leakage.
 *   - Temp files are always cleaned up on failure; the digest cache file is
 *     intentionally retained (keyed by verified digest).
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { EXPLAINER_MEDIA_MAX_BYTES, type ExplainerCatalogEntry } from "@nautilo/types";
import {
  findExplainerCatalogEntry,
  getRuntimeExplainerCatalog,
  resolveExplainerMediaOrigin,
} from "@nautilo/agent";

const DEFAULT_TIMEOUT_MS = 120_000;
/** Hard global cap: never above the source schema cap (512 MiB). */
const HARD_CAP_BYTES = EXPLAINER_MEDIA_MAX_BYTES;
const EXPLAINER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

export interface ExplainerMediaRouteDeps {
  /** Test seam for the upstream fetch. Defaults to globalThis.fetch. */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Digest cache directory. Defaults to ~/.nautilo/explainer-media-cache. */
  cacheDir?: string;
  /** Temp spool directory. Defaults to os.tmpdir(). */
  tmpDir?: string;
  /** Connect+read timeout covering the FULL body, in ms. */
  timeoutMs?: number;
  /** Hard byte cap (≤ 512 MiB). Defaults to the schema cap. */
  maxBytes?: number;
  /** Test seam for simulating an atomic-promotion race. Defaults to renameSync. */
  renameImpl?: (oldPath: string, newPath: string) => void;
}

export interface VerifiedExplainerMedia {
  /** Absolute path to the verified MP4 (the digest cache file). */
  readonly path: string;
  readonly byteLength: number;
  readonly contentSha256: string;
}

function defaultCacheDir(): string {
  return join(homedir(), ".nautilo", "explainer-media-cache");
}

function cachePathFor(cacheDir: string, contentSha256: string): string {
  return join(cacheDir, `${contentSha256}.mp4`);
}

/** Encode the contained catalog key into origin-relative path segments. */
function encodeAssetKey(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function isMp4ContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
  return mediaType === "video/mp4";
}

/**
 * Verify an existing cache file without buffering it in heap. The read is
 * bounded by both the exact catalog byteLength and the server hard cap.
 */
async function verifyCachedFile(
  path: string,
  expectedByteLength: number,
  expectedSha256: string,
  maxBytes: number,
): Promise<boolean> {
  if (expectedByteLength > maxBytes) return false;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size !== expectedByteLength || stat.size > maxBytes) {
      return false;
    }

    const hash = createHash("sha256");
    let bytes = 0;
    const stream = createReadStream(path);
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > expectedByteLength || bytes > maxBytes) {
        stream.destroy();
        return false;
      }
      hash.update(buffer);
    }
    return bytes === expectedByteLength && hash.digest("hex") === expectedSha256;
  } catch {
    return false;
  }
}

function evictCacheFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* best-effort eviction */
  }
}

interface ByteChunkReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  releaseLock(): void;
  cancel(): Promise<void>;
}

/**
 * Fetch the asset from the allowlisted public origin, spool to an owned temp
 * file while hashing, and verify exact byteLength + SHA-256 BEFORE the file is
 * promoted to the digest cache. Throws a non-secret reason on any mismatch;
 * the temp file is always cleaned up on failure.
 */
async function fetchAndVerify(
  entry: ExplainerCatalogEntry,
  deps: ExplainerMediaRouteDeps,
): Promise<VerifiedExplainerMedia> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const maxBytes = Math.min(deps.maxBytes ?? HARD_CAP_BYTES, HARD_CAP_BYTES);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheDir = deps.cacheDir ?? defaultCacheDir();
  const tmpDir = deps.tmpDir ?? defaultTmpDir();
  const renameImpl = deps.renameImpl ?? renameSync;
  const declaredByteLength = entry.asset.byteLength;
  const declaredSha = entry.asset.contentSha256;
  if (declaredByteLength > maxBytes) {
    throw new Error("declared byteLength exceeds server cap");
  }

  const origin = resolveExplainerMediaOrigin();
  const url = new URL(encodeAssetKey(entry.asset.key), origin).toString();

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tmpPath: string | null = null;
  let fd: number | null = null;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`upstream media fetch timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    const work = async (): Promise<VerifiedExplainerMedia> => {
      const res = await fetchImpl(url, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: { accept: "video/mp4" },
      });
      if (res.status !== 200) {
        throw new Error(`upstream media fetch failed status=${res.status}`);
      }
      if (!isMp4ContentType(res.headers.get("content-type"))) {
        throw new Error("upstream media response is not video/mp4");
      }
      const contentLengthHeader = res.headers.get("content-length");
      if (contentLengthHeader !== null) {
        if (!/^\d+$/.test(contentLengthHeader)) {
          throw new Error("upstream media has invalid Content-Length");
        }
        const declared = Number(contentLengthHeader);
        if (!Number.isSafeInteger(declared) || declared > maxBytes) {
          throw new Error("upstream media Content-Length exceeds server cap");
        }
        if (declared !== declaredByteLength) {
          throw new Error("upstream media Content-Length does not match catalog byteLength");
        }
      }
      if (!res.body) {
        throw new Error("upstream media response body is missing");
      }

      mkdirSync(cacheDir, { recursive: true });
      mkdirSync(tmpDir, { recursive: true });
      tmpPath = join(tmpDir, `nautilo-explainer-${randomUUID()}.mp4`);
      fd = openSync(tmpPath, "w", 0o600);
      const hash = createHash("sha256");
      let bytes = 0;
      const reader = res.body.getReader() as ByteChunkReader;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) break;
          bytes += value.byteLength;
          if (bytes > declaredByteLength || bytes > maxBytes) {
            throw new Error("upstream media exceeded declared byteLength/cap");
          }
          hash.update(value);
          writeSyncAll(fd, Buffer.from(value));
        }
      } finally {
        // Release the body lock; the AbortController cancels the upstream on timeout.
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      closeSync(fd);
      fd = null;
      if (bytes !== declaredByteLength) {
        throw new Error("upstream media byteLength mismatch");
      }
      const sha = hash.digest("hex");
      if (sha !== declaredSha) {
        throw new Error("upstream media contentSha256 mismatch");
      }
      // Promote the verified temp file to the digest cache (atomic rename).
      const finalPath = cachePathFor(cacheDir, sha);
      try {
        renameImpl(tmpPath, finalPath);
        tmpPath = null;
      } catch {
        // Another process may have won the promotion race. Never trust the
        // winner by filename or size: hash its full bounded contents before
        // returning it. The losing verified temp remains owned and is cleaned
        // in the outer finally block.
        if (
          !existsSync(finalPath) ||
          !(await verifyCachedFile(finalPath, declaredByteLength, declaredSha, maxBytes))
        ) {
          evictCacheFile(finalPath);
          throw new Error("failed to promote verified media to digest cache");
        }
      }
      return { path: finalPath, byteLength: bytes, contentSha256: sha };
    };
    const workPromise = work();
    workPromise.catch(() => {});
    return await Promise.race([workPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    if (tmpPath !== null) {
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

function defaultTmpDir(): string {
  return tmpdir();
}

/** Write the full buffer to fd, retrying around partial writes. */
function writeSyncAll(fd: number, buf: Buffer): void {
  let offset = 0;
  while (offset < buf.length) {
    const written = writeSync(fd, buf, offset);
    if (written <= 0) throw new Error("failed to spool media bytes to temp file");
    offset += written;
  }
}

/** Per-process, per-digest in-flight dedupe so concurrent requests share one fetch. */
const inflight = new Map<string, Promise<VerifiedExplainerMedia>>();

/**
 * Resolve the verified MP4 for a catalog entry. Returns the digest cache
 * path; fetches + verifies on miss. The cache key is the verified
 * `contentSha256`, never the id or path.
 */
async function resolveVerifiedExplainerMedia(
  entry: ExplainerCatalogEntry,
  deps: ExplainerMediaRouteDeps = {},
): Promise<VerifiedExplainerMedia> {
  const cacheDir = deps.cacheDir ?? defaultCacheDir();
  const maxBytes = Math.min(deps.maxBytes ?? HARD_CAP_BYTES, HARD_CAP_BYTES);
  const sha = entry.asset.contentSha256;
  const cached = cachePathFor(cacheDir, sha);
  if (existsSync(cached)) {
    if (
      await verifyCachedFile(
        cached,
        entry.asset.byteLength,
        sha,
        maxBytes,
      )
    ) {
      return { path: cached, byteLength: entry.asset.byteLength, contentSha256: sha };
    }
    // Wrong-size or wrong-hash cache entry: evict and re-fetch.
    evictCacheFile(cached);
  }
  const key = `${cacheDir}:${sha}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = fetchAndVerify(entry, deps).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

export function explainerMediaRoutes(app: FastifyInstance, deps: ExplainerMediaRouteDeps = {}): void {
  app.get("/api/explainers/:id/media", async (request: FastifyRequest, reply) => {
    const userId = request.sessionUserId;
    if (!userId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const id = (request.params as { id?: string } | undefined)?.id ?? "";
    if (!EXPLAINER_ID_PATTERN.test(id)) {
      return reply.code(404).send({ error: "Unknown explainer" });
    }

    let catalog;
    try {
      catalog = (await getRuntimeExplainerCatalog()).catalog;
    } catch {
      return reply.code(503).send({ error: "Explainer catalog unavailable" });
    }
    const entry = findExplainerCatalogEntry(catalog, id);
    if (
      entry === undefined ||
      entry.asset.provider !== "bunny-storage" ||
      entry.asset.format !== "mp4"
    ) {
      return reply.code(404).send({ error: "Unknown explainer" });
    }

    let media: VerifiedExplainerMedia;
    try {
      media = await resolveVerifiedExplainerMedia(entry, deps);
    } catch {
      // Fail closed: never stream unverified bytes. Non-secret reason only.
      return reply.code(502).send({ error: "Explainer media verification failed" });
    }

    reply.header("Content-Type", "video/mp4");
    reply.header("Content-Length", String(media.byteLength));
    reply.header("Cache-Control", "private, max-age=3600");
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.send(createReadStream(media.path));
  });
}
