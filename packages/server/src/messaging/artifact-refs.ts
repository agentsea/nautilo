import type { ChatArtifactRef, ChatFocusedResourceRef, MessageArtifactOpenRef, ResolvedFocusedResource } from "@nautilo/types";
import { log } from "@nautilo/logger";
import {
  findArtifactByIdForNamespaces,
  findArtifactInternalIdsForCanonicalNamespace,
  hydrateMessageArtifacts,
  recordMessageArtifacts,
} from "@nautilo/db";

/**
 * D356 — server ingest for metadata-only "focus on these artifacts" references.
 *
 * Mirrors `attachments.ts` `parseChatAttachmentRefs` (shape/bounds at parse;
 * ownership/namespace enforced at resolve). Unlike attachments, NO bytes are
 * uploaded — these are pointers at artifacts that already live server-side.
 * The agent receives them as in-focus prompt context (a `## Referenced
 * artifacts` block); it reaches the bytes (if at all) via its `file` tool by
 * `path`/`artifactId`.
 *
 * Identity is the EXTERNAL `artifactId` (may contain `/`), never the internal
 * artifact row uuid.
 */

const MAX_ARTIFACT_REFS = 10;
const MAX_ARTIFACT_ID_LEN = 256;
const MAX_PATH_LEN = 1024;

/**
 * Parse the wire `artifactRefs` array. Shape + bounds only; existence and
 * namespace access are enforced later by `resolveChatArtifactRefs`.
 */
export function parseChatArtifactRefs(raw: unknown): ChatArtifactRef[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new Error("artifactRefs must be an array");
  }
  if (raw.length > MAX_ARTIFACT_REFS) {
    throw new Error(`artifactRefs exceeds maximum of ${MAX_ARTIFACT_REFS}`);
  }
  return raw.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`artifactRefs[${index}] must be an object`);
    }
    const candidate = item as Record<string, unknown>;
    const artifactId = candidate["artifactId"];
    if (typeof artifactId !== "string" || artifactId.trim().length === 0) {
      throw new Error(`artifactRefs[${index}].artifactId must be a non-empty string`);
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001F\u007F]/.test(artifactId)) {
      throw new Error(`artifactRefs[${index}].artifactId contains control characters`);
    }
    if (artifactId.length > MAX_ARTIFACT_ID_LEN) {
      throw new Error(`artifactRefs[${index}].artifactId exceeds maximum length`);
    }
    const pathRaw = candidate["path"];
    const path = typeof pathRaw === "string" ? pathRaw : "";
    if (path.length > MAX_PATH_LEN) {
      throw new Error(`artifactRefs[${index}].path exceeds maximum length`);
    }
    const mimeRaw = candidate["mimeType"];
    const mimeType = typeof mimeRaw === "string" && mimeRaw ? mimeRaw : "application/octet-stream";
    const sizeRaw = candidate["size"];
    const size =
      typeof sizeRaw === "number" && Number.isFinite(sizeRaw) && sizeRaw >= 0 ? sizeRaw : 0;
    return { artifactId, path, mimeType, size };
  });
}

/**
 * Resolve parsed refs against the caller's readable namespaces. Each external
 * `artifactId` must exist in a namespace the caller can read; refs that don't
 * resolve are DROPPED (advisory context, never a hard error — matches the
 * `currentFolder` D304 posture). Resolved entries use the AUTHORITATIVE DB
 * values (path/mime/size), so client-spoofed metadata can't reach the prompt.
 * De-dupes by `artifactId`.
 */
export async function resolveChatArtifactRefs(params: {
  refs: readonly ChatArtifactRef[];
  readableNamespaceIds: readonly string[];
}): Promise<ChatArtifactRef[]> {
  const { refs, readableNamespaceIds } = params;
  if (refs.length === 0 || readableNamespaceIds.length === 0) return [];
  const resolved: ChatArtifactRef[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref.artifactId)) continue;
    const row = await findArtifactByIdForNamespaces({
      artifactId: ref.artifactId,
      readableNamespaceIds: [...readableNamespaceIds],
    });
    if (!row) continue;
    seen.add(ref.artifactId);
    resolved.push({
      artifactId: row.artifactId,
      path: row.path,
      mimeType: row.mimeType ?? "application/octet-stream",
      size: typeof row.size === "number" ? row.size : Number(row.size ?? 0),
    });
  }
  return resolved;
}

/**
 * D423 Phase 4 — compatibility adapter: map already-resolved (DB-authoritative)
 * `artifactRefs` into the common `ResolvedFocusedResource` manifest as
 * `kind:"workspace-artifact"` entries. The legacy `artifactRefs` wire contract
 * is unchanged; this only mirrors resolved refs into the generic substrate so
 * the model sees ONE `## Focused resources` manifest instead of parallel prose.
 *
 * Capabilities are server-derived (readable namespace ⇒ `read`); the client
 * never asserts them. The `locator` carries the external `artifactId` as
 * private server-side run metadata; it never enters the prompt block.
 */
export function adaptResolvedArtifactRefs(
  refs: readonly ChatArtifactRef[],
): ResolvedFocusedResource[] {
  const out: ResolvedFocusedResource[] = [];
  for (const ref of refs) {
    const path = typeof ref.path === "string" ? ref.path : "";
    const displayName = basenameOrFallback(path, ref.artifactId);
    if (!displayName) continue;
    const mimeType = ref.mimeType || undefined;
    const size = Number.isFinite(ref.size) && ref.size >= 0 ? ref.size : undefined;
    const resource: ResolvedFocusedResource = {
      kind: "workspace-artifact",
      displayName,
      location: "server",
      lifetime: "workspace",
      capabilities: ["read"],
      locator: { artifactId: ref.artifactId },
      ...(mimeType ? { mimeType } : {}),
      ...(size !== undefined ? { size } : {}),
      ...(path ? { toolTarget: { tool: "file", zone: "workspace", path } } : {}),
    };
    out.push(resource);
  }
  return out;
}

function basenameOrFallback(path: string, fallback: string): string {
  if (path) {
    const trimmed = path.trim();
    if (trimmed) {
      const parts = trimmed.split(/[\\/]+/).filter(Boolean);
      const tail = parts[parts.length - 1];
      if (tail) return tail;
    }
  }
  return typeof fallback === "string" ? fallback.trim() : "";
}

/**
 * D424 — collect the EXTERNAL workspace-artifact ids that may become
 * ArtifactOpenCards for a user send. Draws from BOTH focus lanes:
 *   - legacy `artifactRefs` (every entry is a workspace-artifact focus ref), and
 *   - `focusedResources` entries with `kind === "workspace-artifact"`.
 *
 * `local-file` and `message-attachment` focus refs are NEVER collected — they
 * cannot become cards. Dedupes by external `artifactId` preserving send order
 * (legacy lane first, then generic lane), so a ref arriving via both lanes
 * collapses to one card. Pure (no DB); the canonical-namespace + internal-id
 * resolution happens in {@link persistMessageArtifactOpenRefs}.
 */
export function collectWorkspaceArtifactExternalIds(args: {
  artifactRefs: readonly ChatArtifactRef[];
  focusedResources: readonly ChatFocusedResourceRef[];
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const ref of args.artifactRefs) {
    const id = ref.artifactId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  for (const ref of args.focusedResources) {
    if (ref.kind !== "workspace-artifact") continue;
    const id = ref.artifactId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * D424 — persist the ArtifactOpenCard relation for a just-persisted user
 * message. Resolves each external workspace-artifact id to its INTERNAL
 * `artifacts.id` CURRENTLY attached to the canonical room namespace
 * (write-time gate: only canonical-namespace artifacts become cards), then
 * records the durable, pointer-only `session_message_artifacts` rows.
 *
 * Best-effort, never throws: a failure is logged and the turn proceeds (the
 * message already went out; a missing link just means the card won't render,
 * not a send failure — mirrors the D391 retained-attachment stamp posture).
 * No-ops when `externalArtifactIds` is empty or the canonical namespace id is
 * missing.
 */
export async function persistMessageArtifactOpenRefs(args: {
  messageId: number;
  externalArtifactIds: readonly string[];
  canonicalRoomNamespaceId: string | null | undefined;
}): Promise<void> {
  if (
    args.externalArtifactIds.length === 0 ||
    !args.canonicalRoomNamespaceId
  ) {
    return;
  }
  try {
    const internalIds = await findArtifactInternalIdsForCanonicalNamespace({
      externalArtifactIds: args.externalArtifactIds,
      canonicalRoomNamespaceId: args.canonicalRoomNamespaceId,
    });
    if (internalIds.size === 0) return;
    const ordered: string[] = [];
    for (const externalId of args.externalArtifactIds) {
      const internalId = internalIds.get(externalId);
      if (internalId && !ordered.includes(internalId)) ordered.push(internalId);
    }
    if (ordered.length === 0) return;
    await recordMessageArtifacts({
      messageId: args.messageId,
      artifactInternalIds: ordered,
    });
  } catch (err) {
    log(
      `[d424] message artifact card persist failed for messageId=${args.messageId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * D424 — hydrate the safe `MessageArtifactOpenRef[]` for a single message,
 * for the `message.new` realtime event. Re-validates canonical-namespace
 * attachment + not-deleted at hydrate; detached/deleted/private refs are
 * omitted. Returns `[]` on any failure (the event still emits without cards
 * rather than blocking the turn).
 */
export async function hydrateMessageArtifactOpenRefs(args: {
  messageId: number;
  canonicalRoomNamespaceId: string | null | undefined;
  roomId: string;
}): Promise<MessageArtifactOpenRef[]> {
  if (!args.canonicalRoomNamespaceId || !args.roomId) return [];
  try {
    const map = await hydrateMessageArtifacts({
      messageIds: [args.messageId],
      canonicalRoomNamespaceId: args.canonicalRoomNamespaceId,
      roomId: args.roomId,
    });
    return map.get(args.messageId) ?? [];
  } catch (err) {
    log(
      `[d424] message artifact card hydrate failed for messageId=${args.messageId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
}
