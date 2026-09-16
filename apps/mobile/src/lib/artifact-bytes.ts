// D424 Phase 3.1 — authenticated native byte-transport for workspace artifact
// viewers (text / markdown / image / PDF). Implements the Phase 1.4 contract:
// metadata-first size check (ArtifactDto.size), cap-before-download, native
// streamed download to a cache file with abort + partial-file cleanup, and
// typed error mapping (401 / 403 / 404 / 501). No Blob -> ArrayBuffer / base64
// for image / PDF — binary viewers stream through `expo-file-system`
// `File.downloadFileAsync`. The earlier Blob->ArrayBuffer prototype was
// deliberately discarded (Sol review 2026-07-14); do not recreate that path.
//
// Expo SDK 57 requires the native filesystem to be part of the stable app
// bundle. A dynamic import caused Metro to load a split bundle on first file
// open and restart React Native, dropping the viewer route. Tests mock this
// static native boundary before importing the module.
//
// `tokenNeedsRefresh` is co-located here (not in `auth.ts`) for the same
// reason: `auth.ts` transitively imports `expo-auth-session` / `expo-secure-store`
// at module load, which cannot be parsed by bun's test runtime. Keeping the
// pure freshness decision in this native-free module makes the force-refresh
// seam unit-testable; `auth.ts` imports it and `ensureValidToken` still owns
// the SecureStore-backed refresh.
import { ApiError, type ArtifactDto, type NautiloApiClient } from "@nautilo/api-client/browser";
import { Directory, File, Paths } from "expo-file-system";

import { emitAuthDead } from "@/lib/auth-events";
import { isVideoCandidate } from "@/features/artifacts/artifact-video-format";

/** Workspace artifact viewer kinds Wave 4 mobile supports. */
export type ArtifactKind = "text" | "markdown" | "writer" | "image" | "pdf" | "video" | "unsupported";

/**
 * D424 Phase 3.1 — pure freshness decision for the mobile access token.
 *
 * `forceRefresh` bypasses the 60s freshness guard so an artifact-byte transport
 * that just got a native `401` can force a Logto refresh even when the cached
 * access token still looks unexpired (the server rejected it, so it is no
 * longer trustworthy). Extracted as a pure function so the retry-on-401 seam is
 * unit-testable without the SecureStore / Logto harness; `auth.ts`'s
 * `ensureValidToken` consumes it and still owns the actual refresh.
 *
 * @returns `true` when the caller must refresh; `false` when the cached token
 *   is fresh enough to reuse.
 */
export function tokenNeedsRefresh(
  expiresAt: number,
  now: number,
  forceRefresh: boolean,
): boolean {
  if (forceRefresh) return true;
  return expiresAt - now <= 60_000;
}

/** Upper-bound desktop eligibility caps (Phase 1.4 §3) — not RN render limits. */
export const MAX_TEXT_BYTES = 50 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_PDF_BYTES = 25 * 1024 * 1024;

/**
 * Text / markdown preview extensions. Mirrors the workbench
 * `TEXT_PREVIEW_EXTENSIONS` subset (`apps/workbench/src/lib/file-preview.ts`)
 * plus `.md` / `.markdown`. Inlined here so the mobile app does not depend on
 * the workbench package.
 */
const TEXT_EXTENSIONS = new Set([
  ".txt", ".json", ".yaml", ".yml", ".toml", ".ini",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".rb", ".java", ".kt", ".swift",
  ".css", ".scss", ".xml", ".sh", ".bash",
  ".md", ".markdown",
]);

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]);

function extensionOf(path: string): string | null {
  const name = path.split(/[/\\]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot).toLowerCase();
}

/**
 * Lazy accessor for `auth.ts`'s `ensureValidToken`. `auth.ts` transitively
 * imports native Expo modules (`expo-auth-session` / `expo-secure-store`) that
 * cannot be parsed by bun's test runtime, so we defer the import to first use
 * — which only happens on-device inside `fetchArtifactBytes`, never in unit
 * tests of the pure helpers.
 */
type EnsureValidToken = (
  serverId: string,
  baseUrl: string,
  opts?: { forceRefresh?: boolean },
) => Promise<string | null>;
let ensureValidTokenFn: EnsureValidToken | undefined;
async function freshToken(
  serverId: string,
  baseUrl: string,
  forceRefresh: boolean,
): Promise<string | null> {
  if (!ensureValidTokenFn) {
    const mod = await import("@/lib/auth");
    ensureValidTokenFn = mod.ensureValidToken;
  }
  return ensureValidTokenFn(serverId, baseUrl, { forceRefresh });
}

/** Classify the viewer kind from `path` + `mimeType` (workbench rules). */
export function classifyArtifactKind(path: string, mimeType: string): ArtifactKind {
  const ext = extensionOf(path);
  const mime = mimeType.split(";", 1)[0].trim().toLowerCase();
  if (mime === "application/pdf" || ext === ".pdf") return "pdf";
  if (mime.startsWith("image/") || (ext !== null && IMAGE_EXTENSIONS.has(ext))) return "image";
  if (isVideoCandidate(path, mime)) return "video";
  if (mime === "text/markdown" || ext === ".md" || ext === ".markdown") return "markdown";
  // The document reader distinguishes canonical Writer from ordinary HTML
  // after fetching the authorized source. Neither is displayed as raw text.
  if (mime === "text/html" || ext === ".html" || ext === ".htm") return "writer";
  if (mime.startsWith("text/") || (ext !== null && TEXT_EXTENSIONS.has(ext))) return "text";
  // Some servers default unknown artifacts to octet-stream; let the extension
  // have the final say for known text/image kinds before declaring unsupported.
  if (ext !== null && TEXT_EXTENSIONS.has(ext)) return "text";
  return "unsupported";
}

/** Max bytes a kind may download before the transport refuses (null = never download). */
export function capForKind(kind: ArtifactKind): number | null {
  switch (kind) {
    case "text":
    case "markdown":
    case "writer":
      return MAX_TEXT_BYTES;
    case "image":
      return MAX_IMAGE_BYTES;
    case "pdf":
      return MAX_PDF_BYTES;
    default:
      return null;
  }
}

/**
 * Revision-safe cache file name for a downloaded artifact. Encoded so a new
 * `revision` never collides with a prior download (the prior file is left for
 * the viewer to replace; partials of THIS generation are cleaned on abort).
 */
export function artifactCacheName(artifactId: string, revision: number, ext: string | null): string {
  const safeId = artifactId.replace(/[^A-Za-z0-9._-]/g, "_");
  return `nautilo-artifact-${safeId}-rev${revision}${ext ?? ""}`;
}

/**
 * Normalize an `expo-file-system` native download rejection into an HTTP status
 * + abort flag. Expo throws an `UnableToDownload` Error whose message embeds the
 * status on non-2xx (`HTTP <code>` on Android, `response has status <code>` /
 * `server returned HTTP <code>` on iOS), and an `AbortError` (name ===
 * "AbortError") when an `AbortSignal` cancels the download. The status is
 * `null` when the failure is a network/IO error with no HTTP response.
 */
export function normalizeDownloadError(err: unknown): { status: number | null; aborted: boolean } {
  if (
    err !== null &&
    typeof err === "object" &&
    "name" in err &&
    (err as { name: unknown }).name === "AbortError"
  ) {
    return { status: null, aborted: true };
  }
  const msg = err instanceof Error ? err.message : String(err);
  const match = msg.match(/(?:http|status)[:\s]*(\d{3})/i);
  return { status: match ? Number(match[1]) : null, aborted: false };
}

/** Discriminated result of {@link fetchArtifactBytes}. */
export type ArtifactBytesResult =
  | { kind: "video"; artifact: ArtifactDto }
  | { kind: "text"; content: string; mimeType: string; artifact: ArtifactDto }
  | { kind: "file"; fileUri: string; mimeType: string; artifact: ArtifactDto }
  | { kind: "too_large"; sizeBytes: number; maxBytes: number; viewerKind: ArtifactKind; artifact: ArtifactDto }
  | { kind: "unsupported"; ext: string | null; artifact: ArtifactDto }
  | { kind: "missing_room" }
  | { kind: "not_found" }
  | { kind: "forbidden"; message: string }
  | { kind: "not_implemented"; message: string }
  | { kind: "auth_dead" }
  | { kind: "cancelled" }
  | { kind: "network"; message: string }
  | { kind: "server"; status: number; message: string };

/** Server mutation DTOs replace metadata only; already-downloaded bytes stay intact. */
export function replaceArtifactBytesMetadata(result: ArtifactBytesResult, artifact: ArtifactDto): ArtifactBytesResult {
  return "artifact" in result ? { ...result, artifact } : result;
}

export interface FetchArtifactBytesArgs {
  /** Active server id (SecureStore token key). */
  serverId: string;
  /** Server base URL (`http(s)://host`, no trailing slash). */
  baseUrl: string;
  /** Api client bound to `baseUrl`; the transport latches fresh tokens via `setToken`. */
  client: NautiloApiClient;
  /** Internal artifact row id (the `:id` used by `/api/workspace/artifacts/:id` routes). */
  artifactId: string;
  /**
   * C1-validated, nonempty selected conversation room id. The caller MUST have
   * already confirmed dual membership (user + personal agent) per Phase 1.3
   * before invoking; an empty `roomId` returns `missing_room` without a call.
   */
  roomId: string;
  /** Optional abort signal — cancels the native download and cleans the partial file. */
  signal?: AbortSignal;
}

/**
 * Map an `ApiError` thrown by an api-client JSON/Blob call into a typed
 * transport result. `401` is handled by the caller (retry path) and is not
 * mapped here — it returns `null` so the caller can distinguish it.
 */
function apiErrorToResult(err: ApiError): ArtifactBytesResult | null {
  switch (err.status) {
    case 401:
      return null;
    case 403:
      return { kind: "forbidden", message: err.message };
    case 404:
      return { kind: "not_found" };
    case 501:
      return { kind: "not_implemented", message: err.message };
    default:
      return { kind: "server", status: err.status, message: err.message };
  }
}

/**
 * Fetch a workspace artifact's bytes for an in-app viewer, metadata-first.
 *
 * Flow: validate `roomId` -> `getWorkspaceArtifact` (size/mime/path) ->
 * classify + cap check (return too_large / unsupported before any bytes) ->
 * native `File.downloadFileAsync` streaming to a cache file. Text/Markdown
 * are decoded from that cache file; image/PDF use its URI directly. On a
 * native `401`, force-refresh the token once and retry
 * exactly once; a second `401` (or a dead refresh) emits auth-dead. Partial
 * cache files are deleted on abort or any failure.
 *
 * React Native's fetch/Blob bridge can reject otherwise-valid streamed
 * responses with `unexpected end of stream` on Android, so no viewer kind
 * uses Blob/ArrayBuffer/base64.
 */
export async function fetchArtifactBytes(
  args: FetchArtifactBytesArgs,
): Promise<ArtifactBytesResult> {
  const { serverId, baseUrl, client, artifactId, roomId, signal } = args;
  if (!roomId || roomId.length === 0) return { kind: "missing_room" };

  // --- metadata-first, with one 401 retry via forced refresh ---
  let metadata: ArtifactDto | null;
  try {
    metadata = await fetchMetadataWithRetry({ serverId, baseUrl, client, artifactId, roomId });
  } catch (err) {
    if (err instanceof ApiError) {
      const mapped = apiErrorToResult(err);
      if (mapped) return mapped;
      // 401 that already exhausted its retry inside fetchMetadataWithRetry.
      emitAuthDead(serverId);
      return { kind: "auth_dead" };
    }
    return {
      kind: "network",
      message: err instanceof Error ? err.message : "Failed to load artifact metadata.",
    };
  }
  if (metadata === null) return { kind: "not_found" };
  if (signal?.aborted) return { kind: "cancelled" };

  // --- classify + cap before any bytes ---
  const viewerKind = classifyArtifactKind(metadata.path, metadata.mimeType);
  if (viewerKind === "video") return { kind: "video", artifact: metadata };
  if (viewerKind === "unsupported") {
    return { kind: "unsupported", ext: extensionOf(metadata.path), artifact: metadata };
  }
  const cap = capForKind(viewerKind);
  if (cap !== null && metadata.size > cap) {
    return { kind: "too_large", sizeBytes: metadata.size, maxBytes: cap, viewerKind, artifact: metadata };
  }

  if (viewerKind === "text" || viewerKind === "markdown" || viewerKind === "writer") {
    return fetchTextBytes({ serverId, baseUrl, client, artifactId, roomId, metadata, signal });
  }
  return fetchBinaryBytes({ serverId, baseUrl, client, artifactId, roomId, metadata, signal });
}

/** Metadata fetch with proactive refresh + one 401 retry via forced refresh. */
async function fetchMetadataWithRetry(
  args: {
    serverId: string;
    baseUrl: string;
    client: NautiloApiClient;
    artifactId: string;
    roomId: string;
  },
): Promise<ArtifactDto | null> {
  const { serverId, baseUrl, client, artifactId, roomId } = args;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await freshToken(serverId, baseUrl, attempt === 1);
    if (!token) {
      emitAuthDead(serverId);
      // Throw a sentinel ApiError so the caller maps to auth_dead without
      // conflating with a server 401.
      throw new ApiError(401, "Authentication required");
    }
    client.setToken(token);
    try {
      return await client.getWorkspaceArtifact(artifactId, { roomId });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && attempt === 0) continue;
      throw err;
    }
  }
  // Unreachable: the loop either returns or throws. Defensive auth-dead.
  emitAuthDead(serverId);
  throw new ApiError(401, "Authentication required");
}

/** Text/markdown/Writer path: native streamed cache file -> UTF-8 string. */
async function fetchTextBytes(
  args: {
    serverId: string;
    baseUrl: string;
    client: NautiloApiClient;
    artifactId: string;
    roomId: string;
    metadata: ArtifactDto;
    signal?: AbortSignal;
  },
): Promise<ArtifactBytesResult> {
  const downloaded = await fetchBinaryBytes(args);
  if (downloaded.kind !== "file") return downloaded;
  if (args.signal?.aborted) return { kind: "cancelled" };
  try {
    const content = await new File(downloaded.fileUri).text();
    if (args.signal?.aborted) return { kind: "cancelled" };
    return {
      kind: "text",
      content,
      mimeType: downloaded.mimeType,
      artifact: downloaded.artifact,
    };
  } catch (err) {
    return {
      kind: "network",
      message: err instanceof Error ? err.message : "Failed to read cached artifact text.",
    };
  }
}

/** Native streamed download to a cache file (no Blob/base64). */
async function fetchBinaryBytes(
  args: {
    serverId: string;
    baseUrl: string;
    client: NautiloApiClient;
    artifactId: string;
    roomId: string;
    metadata: ArtifactDto;
    signal?: AbortSignal;
  },
): Promise<ArtifactBytesResult> {
  const { serverId, baseUrl, client, artifactId, roomId, metadata, signal } = args;
  const bytesUrl = client.getWorkspaceArtifactBytesUrl(artifactId, { roomId });
  const cacheName = artifactCacheName(metadata.artifactId, metadata.revision, extensionOf(metadata.path));
  const cacheDir = new Directory(Paths.cache, "nautilo-artifacts");
  try {
    cacheDir.create({ intermediates: true, idempotent: true });
  } catch {
    // Best-effort; the download itself will surface a real IO error if the
    // cache directory is genuinely unusable.
  }
  const destination = new File(cacheDir, cacheName);

  const cleanupPartial = () => {
    try {
      if (destination.exists) destination.delete();
    } catch {
      // Best-effort partial cleanup; never mask the original error.
    }
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await freshToken(serverId, baseUrl, attempt === 1);
    if (!token) {
      cleanupPartial();
      emitAuthDead(serverId);
      return { kind: "auth_dead" };
    }
    if (signal?.aborted) {
      cleanupPartial();
      return { kind: "cancelled" };
    }
    try {
      await File.downloadFileAsync(bytesUrl, destination, {
        headers: { Authorization: `Bearer ${token}` },
        idempotent: true,
        signal,
      });
      return { kind: "file", fileUri: destination.uri, mimeType: metadata.mimeType, artifact: metadata };
    } catch (err) {
      const { status, aborted } = normalizeDownloadError(err);
      if (aborted || signal?.aborted) {
        cleanupPartial();
        return { kind: "cancelled" };
      }
      if (status === 401 && attempt === 0) {
        // Force-refresh and retry exactly once.
        continue;
      }
      cleanupPartial();
      if (status === 401) {
        emitAuthDead(serverId);
        return { kind: "auth_dead" };
      }
      const mapped = statusToResult(status, err);
      return mapped;
    }
  }
  cleanupPartial();
  emitAuthDead(serverId);
  return { kind: "auth_dead" };
}

/** Map a native download HTTP status to a typed user-presentable result. */
function statusToResult(status: number | null, err: unknown): ArtifactBytesResult {
  const message = err instanceof Error ? err.message : "Failed to download artifact bytes.";
  switch (status) {
    case 403:
      return { kind: "forbidden", message };
    case 404:
      return { kind: "not_found" };
    case 501:
      return { kind: "not_implemented", message };
    case null:
      return { kind: "network", message };
    default:
      return { kind: "server", status: status ?? 0, message };
  }
}
