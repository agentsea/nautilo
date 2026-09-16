import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  ApiError,
  type ArtifactDto,
  type NautiloApiClient,
} from "@nautilo/api-client/browser";
import type { ChatArtifactRef } from "@nautilo/types";
import {
  artifactCacheName,
  capForKind,
  classifyArtifactKind,
  type ArtifactBytesResult,
} from "@/lib/artifact-bytes";
import { downloadArtifactBytes, releaseArtifactFileUri } from "@/lib/artifact-byte-download";
import { ensureValidToken } from "@/lib/auth";
import { emitAuthDead } from "@/lib/auth-events";

const HINT_KEY_PREFIX = "nautilo.artifact-discussion-room.v1.";

/** Public response shape until the browser client re-exports its DTO type. */
export type DiscussionRoom = { id: string; label: string; kind: string };

/**
 * Canonical per-turn pointer used by the existing workspace-artifact focus
 * lane. "Discuss this file" supplies this transparently to the docked chat;
 * the server re-resolves the id and replaces the metadata with authoritative
 * DB values before the agent sees it.
 */
export function artifactDiscussionRef(artifact: ArtifactDto): ChatArtifactRef {
  return {
    artifactId: artifact.artifactId,
    path: artifact.path,
    mimeType: artifact.mimeType,
    size: artifact.size,
  };
}

export function isDiscussionCandidate(
  roomId: string | undefined,
  candidates: readonly DiscussionRoom[],
): roomId is string {
  return roomId !== undefined && candidates.some((candidate) => candidate.id === roomId);
}

export async function readDiscussionRoomHint(
  serverId: string,
  artifactId: string,
): Promise<string | undefined> {
  try {
    const value = await AsyncStorage.getItem(hintKey(serverId, artifactId));
    return value && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function writeDiscussionRoomHint(
  serverId: string,
  artifactId: string,
  roomId: string,
): Promise<void> {
  try {
    await AsyncStorage.setItem(hintKey(serverId, artifactId), roomId);
  } catch {
    // The hint is advisory. A storage failure must not block discussion.
  }
}

function hintKey(serverId: string, artifactId: string): string {
  return `${HINT_KEY_PREFIX}${serverId}.${artifactId}`;
}

/**
 * Loads artifact content through the aggregate, server-authorized read. This
 * deliberately has no roomId: browsing a file must not choose its discussion
 * destination. Room-scoped reads remain used only by the Files filter.
 */
export async function fetchAggregateArtifactBytes(args: {
  serverId: string;
  baseUrl: string;
  client: NautiloApiClient;
  artifactId: string;
  signal?: AbortSignal;
}): Promise<ArtifactBytesResult> {
  const { serverId, baseUrl, client, artifactId, signal } = args;
  try {
    const token = await ensureValidToken(serverId, baseUrl);
    if (!token) {
      emitAuthDead(serverId);
      return { kind: "auth_dead" };
    }
    client.setToken(token);
    const artifact = await client.getWorkspaceArtifact(artifactId);
    if (!artifact) return { kind: "not_found" };
    const viewerKind = classifyArtifactKind(artifact.path, artifact.mimeType);
    // Video owns a cancellable native original-file lease, rather than the
    // legacy capped preview cache. No media bytes are decoded through JS.
    if (viewerKind === "video") return { kind: "video", artifact };
    const maxBytes = capForKind(viewerKind);
    if (maxBytes === null) return { kind: "unsupported", ext: extensionOf(artifact.path), artifact };
    if (artifact.size > maxBytes) {
      return { kind: "too_large", sizeBytes: artifact.size, maxBytes, viewerKind, artifact };
    }
    if (signal?.aborted) return { kind: "cancelled" };

    const downloaded = await downloadArtifactBytes({
      url: client.getWorkspaceArtifactBytesUrl(artifactId),
      token,
      cacheName: artifactCacheName(
        artifact.artifactId,
        artifact.revision,
        extensionOf(artifact.path),
      ),
      text: viewerKind === "text" || viewerKind === "markdown" || viewerKind === "writer",
      signal,
    });
    if (signal?.aborted) {
      if (downloaded.kind === "file") releaseArtifactFileUri(downloaded.fileUri);
      return { kind: "cancelled" };
    }
    return downloaded.kind === "text"
      ? { kind: "text", content: downloaded.content, mimeType: artifact.mimeType, artifact }
      : { kind: "file", fileUri: downloaded.fileUri, mimeType: artifact.mimeType, artifact };
  } catch (caught) {
    if (signal?.aborted) return { kind: "cancelled" };
    if (caught instanceof ApiError) return mapApiError(caught);
    const message = caught instanceof Error ? caught.message : "Failed to load artifact.";
    const status = Number(message.match(/(?:http|status)[:\s]*(\d{3})/i)?.[1]);
    if (status === 401) {
      emitAuthDead(serverId);
      return { kind: "auth_dead" };
    }
    if (status === 403) return { kind: "forbidden", message };
    if (status === 404) return { kind: "not_found" };
    if (status === 501) return { kind: "not_implemented", message };
    return { kind: "network", message };
  }
}

function mapApiError(error: ApiError): ArtifactBytesResult {
  switch (error.status) {
    case 401: return { kind: "auth_dead" };
    case 403: return { kind: "forbidden", message: error.message };
    case 404: return { kind: "not_found" };
    case 501: return { kind: "not_implemented", message: error.message };
    default: return { kind: "server", status: error.status, message: error.message };
  }
}

function extensionOf(path: string): string | null {
  const name = path.split(/[/\\]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot).toLowerCase() : null;
}
