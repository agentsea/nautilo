import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyReply, FastifyRequest } from "fastify";
import sharp from "sharp";
import { error as logError } from "@nautilo/logger";
import { getProfileAvatarsRoot } from "@nautilo/config";
import { PRESET_AVATAR_ID_REGEX, type AvatarRef } from "@nautilo/types";

/**
 * D243 — shared avatar response helpers for `/api/profile/avatar` and
 * `/api/users/:id/avatar`. Both routes have their own privacy gate
 * (`resolveVisibleAvatar` / `resolveVisibleAvatarFor`) that decides
 * WHICH `AvatarRef` a given viewer is allowed to see; everything from
 * variant selection to lazy thumbnail backfill to HTTP cache headers
 * lives here so the two routes stay byte-identical at the response
 * layer.
 *
 * Pre-Stack-42 these helpers were duplicated across the two route
 * files with a TODO to hoist after D207 (upload) landed. D243 (Stack
 * 42) ships the hoist alongside the variant selector and lazy backfill
 * so the duplication doesn't grow further.
 *
 * Public surface (this is the entire intentional API):
 *  - `sendAvatar(request, reply, avatar)` — full serve given an
 *    already-privacy-resolved `AvatarRef`.
 *  - `getAvatarBlobDir(kind)` — composed write path used by upload
 *    and generate-avatar persisters.
 *  - `setMediaCacheHeaders(reply, { visibility, etag })` — single
 *    cache-policy source (D243 Phase 2); shared with `server-icon.ts`
 *    so private avatars and the public server icon stop drifting apart.
 *  - `isSafeBlobId(blobId)` — shared path-traversal jail for blob ids.
 *  - `MediaVisibility` — `"public" | "private"`.
 *
 * Everything else (`sendShell`, `pickAvatarBlobFile`, `requestWantsFull`,
 * `setPrivateAvatarHeaders`, `sendPresetAvatar`, `sendBlobAvatar`) is
 * internal to this module on purpose; the public `sendAvatar` is the
 * one-call serve contract.
 */

const helperSrcDir = dirname(fileURLToPath(import.meta.url));
// `_helpers/` sits next to other route files under `routes/`; presets ship
// under `src/onboarding/images/avatars/` two levels up.
const presetAvatarDir = join(helperSrcDir, "..", "..", "onboarding", "images", "avatars");
/** Inline SVG fallback shown for guests, missing blobs, and resolution misses. */
const SHELL_SVG = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="Genie shell avatar"><rect width="128" height="128" rx="24" fill="#101820"/><text x="64" y="79" text-anchor="middle" font-size="58" font-family="Apple Color Emoji, Segoe UI Emoji, sans-serif">🐚</text></svg>`,
  "utf8",
);

/** Composed write path for a blob avatar kind. Used by persisters. */
export function getAvatarBlobDir(kind: "uploaded" | "generated"): string {
  return join(getProfileAvatarsRoot(), kind);
}

/**
 * Visibility class for media cache headers. `private` = per-viewer, auth-gated
 * (agent/human avatar); `public` = shareable (server icon, brand presets).
 */
export type MediaVisibility = "public" | "private";

/**
 * D243 Phase 2/3 — single source of cache-control policy across every
 * avatar/icon serve route.
 *
 * - `versioned` (D243 Phase 3): the request carried a content-addressed
 *   `?v=<blobId>` token, so the URL itself is unique per avatar version.
 *   That makes the bytes safe to cache **forever** (`immutable`): when the
 *   avatar changes, the `blobId` changes → a different URL → a fresh fetch,
 *   with no stale-window and no per-render revalidation. Applies to both
 *   public (server icon) and private (avatar) — `private` stays per-viewer
 *   via `Vary: Authorization`, but no longer revalidates each load.
 * - Unversioned (stable URL): private revalidates every time
 *   (`private, no-cache`); public is short-cacheable (`public, max-age`).
 */
export function setMediaCacheHeaders(
  reply: FastifyReply,
  opts: { visibility: MediaVisibility; etag?: string; versioned?: boolean },
): void {
  if (opts.etag) reply.header("ETag", `"${opts.etag}"`);
  if (opts.visibility === "private") reply.header("Vary", "Authorization");
  if (opts.versioned) {
    reply.header("Cache-Control", `${opts.visibility}, max-age=31536000, immutable`);
    return;
  }
  if (opts.visibility === "public") {
    reply.header("Cache-Control", "public, max-age=86400");
    return;
  }
  reply.header("Cache-Control", "private, no-cache");
}

/**
 * D243 Phase 3 — true when the request carries a non-empty content-addressed
 * `?v=` token. Callers pass the result to `setMediaCacheHeaders({ versioned })`
 * to opt the response into immutable caching. The server ignores the token's
 * value for resolution (it always serves the current resolved ref); `?v=` is
 * purely a client-supplied cache key derived from the ref's `blobId`.
 */
export function requestIsVersioned(request: FastifyRequest): boolean {
  const q = request.query as { v?: unknown } | undefined;
  return typeof q?.v === "string" && q.v.length > 0;
}

/** Path-traversal jail for blob ids (shared by avatar + server-icon serve). */
export function isSafeBlobId(blobId: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(blobId);
}

/**
 * Serve any privacy-resolved `AvatarRef`. The variant selector and
 * lazy-backfill logic apply automatically for blob kinds; presets and
 * SHELL take their respective fast paths. Always sets
 * `Cache-Control: private, no-cache` and `Vary: Authorization`.
 */
export async function sendAvatar(
  request: FastifyRequest,
  reply: FastifyReply,
  avatar: AvatarRef,
): Promise<FastifyReply> {
  // D243 Phase 3 — a content-addressed `?v=<blobId>` request opts into
  // immutable caching; the stable-URL path keeps revalidating (`no-cache`).
  setMediaCacheHeaders(reply, {
    visibility: "private",
    versioned: requestIsVersioned(request),
  });
  if (avatar.kind === "preset") return sendPresetAvatar(reply, avatar);
  return sendBlobAvatar(request, reply, avatar);
}

function sendShell(reply: FastifyReply): FastifyReply {
  setPrivateAvatarHeaders(reply);
  reply.type("image/svg+xml; charset=utf-8");
  return reply.send(SHELL_SVG);
}

/**
 * Materialize a built-in preset as portable PNG bytes. A backup carries the
 * selected image itself rather than depending on the destination having the
 * same preset catalogue. `shell` is included as pixels too, so every visible
 * avatar has an honest media representation.
 */
export async function readPresetAvatarPng(
  avatar: Extract<AvatarRef, { kind: "preset" }>,
): Promise<Buffer | null> {
  if (!PRESET_AVATAR_ID_REGEX.test(avatar.id)) return null;
  if (avatar.id === "shell") {
    return sharp(SHELL_SVG).png({ compressionLevel: 9 }).toBuffer();
  }
  const filePath = join(presetAvatarDir, `${avatar.id}.webp`);
  if (!existsSync(filePath)) return null;
  return sharp(filePath).png({ compressionLevel: 9 }).toBuffer();
}

/**
 * D243 Phase 5 — derivative thumbnail format. WebP at q82 is ~25-35% smaller
 * than the equivalent PNG for the illustrated/photographic avatars we serve,
 * is universally supported (Electron + every evergreen browser; the bundled
 * presets already ship as `.webp`), and encodes fast enough for lazy backfill.
 * The 1024² original stays PNG (lossless, cherished source); only the
 * icon-sized derivative is re-encoded. AVIF is deferred because it would need
 * `Accept` negotiation.
 */
const THUMB_EXT = "thumb.webp";
async function encodeThumb(input: Buffer | string): Promise<Buffer> {
  return sharp(input)
    .resize(256, 256, { fit: "cover", position: "center" })
    .webp({ quality: 82 })
    .toBuffer();
}

// --- Internal helpers below this line --------------------------------------

function setPrivateAvatarHeaders(reply: FastifyReply): void {
  // D243 — `no-cache` means "you may cache, but always revalidate before
  // using" — paired with the variant-keyed ETag (`<blobId>.thumb` vs
  // `<blobId>.full`) this gives:
  //   - warm reload / WS reconnect: conditional GET → 304 + empty body
  //   - in-session avatar change: new `blobId` → new ETag → 200 + fresh
  //     bytes the very next refresh (no staleness window)
  // `max-age=N` would serve stale bytes for N seconds after a Settings
  // avatar change because the browser would skip revalidation entirely
  // during the freshness window. Policy now lives in `setMediaCacheHeaders`
  // (D243 Phase 2) so avatar + server-icon routes share one source.
  setMediaCacheHeaders(reply, { visibility: "private" });
}

function sendPresetAvatar(
  reply: FastifyReply,
  avatar: Extract<AvatarRef, { kind: "preset" }>,
): FastifyReply {
  if (!PRESET_AVATAR_ID_REGEX.test(avatar.id)) {
    return reply.code(404).send({ error: "Not found" });
  }
  if (avatar.id === "shell") return sendShell(reply);

  const filePath = join(presetAvatarDir, `${avatar.id}.webp`);
  if (!existsSync(filePath)) return sendShell(reply);
  reply.type("image/webp");
  return reply.send(readFileSync(filePath));
}

async function sendBlobAvatar(
  request: FastifyRequest,
  reply: FastifyReply,
  avatar: Extract<AvatarRef, { kind: "uploaded" | "generated" }>,
): Promise<FastifyReply> {
  if (!isSafeBlobId(avatar.blobId)) {
    return reply.code(404).send({ error: "Not found" });
  }
  const picked = await pickAvatarBlobFile(avatar.kind, avatar.blobId, requestWantsFull(request));
  if (!picked) return sendShell(reply);

  reply.header("ETag", `"${picked.etag}"`);
  reply.type(picked.contentType);
  return reply.send(readFileSync(picked.filePath));
}

/**
 * Pick which on-disk variant of an avatar blob to serve.
 *
 * Default returns the 256² WebP thumbnail for `generated` avatars; `wantsFull`
 * (set by `?size=full`) returns the cherished 1024² PNG original. `uploaded`
 * avatars are already 256² at write time (see `persistUploadedServerImage`),
 * so the variant selector collapses to the single stored PNG and `?size=full`
 * is a no-op for them.
 *
 * Lazy thumbnail-on-read backfill: `generated` avatars with no `.thumb.webp`
 * on disk (legacy blobs that pre-date Stack 42, or pre-Phase-5 `.thumb.png`
 * siblings) derive the WebP thumb in-process from the original on first read,
 * write it to disk, then serve it. One-time ~30–60 ms cost amortized per blob.
 *
 * If the backfill itself throws, we degrade to serving the original this
 * request (so the user-visible avatar is at least correct) with the
 * `.full` ETag. The next request retries the backfill — eventually self-heals.
 *
 * Returns null when no acceptable file exists (caller falls back to SHELL).
 */
async function pickAvatarBlobFile(
  kind: "uploaded" | "generated",
  blobId: string,
  wantsFull: boolean,
): Promise<{ filePath: string; etag: string; contentType: string } | null> {
  const originalPath = join(getAvatarBlobDir(kind), `${blobId}.png`);

  if (wantsFull || kind === "uploaded") {
    if (!existsSync(originalPath)) return null;
    return { filePath: originalPath, etag: `${blobId}.full`, contentType: "image/png" };
  }

  const thumbPath = join(getAvatarBlobDir(kind), `${blobId}.${THUMB_EXT}`);
  if (existsSync(thumbPath)) {
    return { filePath: thumbPath, etag: `${blobId}.thumb`, contentType: "image/webp" };
  }

  if (!existsSync(originalPath)) return null;

  try {
    const buf = await encodeThumb(originalPath);
    writeFileSync(thumbPath, buf);
    return { filePath: thumbPath, etag: `${blobId}.thumb`, contentType: "image/webp" };
  } catch (err) {
    logError(
      "[avatar] lazy thumbnail backfill failed, serving original this request:",
      err instanceof Error ? err.message : String(err),
    );
    return { filePath: originalPath, etag: `${blobId}.full`, contentType: "image/png" };
  }
}

function requestWantsFull(request: FastifyRequest): boolean {
  const q = request.query as { size?: unknown } | undefined;
  // Strict equality: arrays, unknown keywords, etc. all fall back to the
  // safe default (thumb). `?size=full` is the only opt-in to the original.
  return typeof q?.size === "string" && q.size === "full";
}
