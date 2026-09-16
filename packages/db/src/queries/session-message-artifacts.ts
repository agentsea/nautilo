/**
 * D424 — ArtifactOpenCard persistence + hydration helpers.
 *
 * The durable relation (`session_message_artifacts`) is keyed by INTERNAL
 * `artifacts.id` and stores only the relation + send-time ordering. These
 * helpers:
 *   - resolve the canonical room namespace id for a room,
 *   - resolve external artifact ids → internal ids that are CURRENTLY attached
 *     to that canonical namespace (write-time gate: only artifacts attached to
 *     the canonical room namespace become cards),
 *   - record the relation for an authorized persisted message (idempotent, ordered),
 *   - hydrate safe `MessageArtifactOpenRef[]` per message at read/event time,
 *     re-validating canonical-namespace attachment + not-deleted so detached /
 *     deleted / private refs are omitted.
 *
 * No external id, path, storage URI, namespace id, capability, or private
 * locator is ever snapshotted or projected. The hydrate projects only
 * `artifactInternalId`, the server-validated `roomId`, a safe basename
 * derived from the logical path, `mimeType`, and `sizeBytes`.
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db, type Database } from "../config/database";
import { type DirectDatabase } from "../config/direct-database";
import { artifacts } from "../schema/artifacts";
import { artifactNamespaces } from "../schema/artifact-namespaces";
import { rooms } from "../schema/rooms";
import { sessionMessageArtifacts } from "../schema/session-message-artifacts";
import type { MessageArtifactOpenRef } from "@nautilo/types";

type Db = Database;
/** Hydrate accepts either the Neon HTTP db (production) or the postgres-js direct db (integration tests). */
type HydrateDb = Database | DirectDatabase;

/**
 * Resolve the canonical room namespace id (`rooms.namespace_id`) for a room.
 * The canonical namespace is the attachment target an artifact must still be
 * joined to at hydrate for its card to surface. Returns `null` when the room
 * row is gone (e.g. a since-deleted room) — callers omit cards in that case.
 */
export async function getRoomNamespaceId(
  roomId: string,
  conn: Db = db,
): Promise<string | null> {
  if (!roomId) return null;
  const rows = await conn
    .select({ namespaceId: rooms.namespaceId })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1);
  return rows[0]?.namespaceId ?? null;
}

/**
 * Resolve a set of EXTERNAL artifact ids to INTERNAL `artifacts.id`s that are
 * CURRENTLY attached to the canonical room namespace and not soft-deleted.
 *
 * This is the write-time gate: only artifacts attached to the canonical room
 * namespace become cards. An artifact that is readable via some OTHER room's
 * namespace (but not the canonical one) is intentionally NOT returned — it
 * must not become a card for this room's message. Returns a Map keyed by
 * external `artifactId`; refs not attached to the canonical namespace are
 * absent (dropped, never throw).
 */
export async function findArtifactInternalIdsForCanonicalNamespace(args: {
  externalArtifactIds: readonly string[];
  canonicalRoomNamespaceId: string;
  conn?: Db;
}): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (args.externalArtifactIds.length === 0 || !args.canonicalRoomNamespaceId) {
    return out;
  }
  const conn = args.conn ?? db;
  const rows = await conn
    .select({
      artifactId: artifacts.artifactId,
      internalId: artifacts.id,
    })
    .from(artifacts)
    .innerJoin(
      artifactNamespaces,
      eq(artifactNamespaces.artifactId, artifacts.id),
    )
    .where(
      and(
        inArray(artifacts.artifactId, [...args.externalArtifactIds]),
        eq(artifactNamespaces.namespaceId, args.canonicalRoomNamespaceId),
        isNull(artifacts.deletedAt),
      ),
    );
  for (const r of rows) {
    if (!out.has(r.artifactId)) out.set(r.artifactId, r.internalId);
  }
  return out;
}

/**
 * Record the artifact-card relation for an authorized persisted message. Human
 * focus sends and the server-stamped ask_peer Artifact handoff are the current
 * authoring paths; callers must never infer cards from assistant prose.
 * `internalIds`
 * MUST be internal `artifacts.id` values already gated on canonical-namespace
 * attachment (see {@link findArtifactInternalIdsForCanonicalNamespace}); this
 * helper only dedupes + assigns a stable send-time `position` and inserts.
 *
 * Idempotent: re-recording the same (messageId, artifactId) set is a no-op
 * (`ON CONFLICT DO NOTHING` on the primary key). Positions are assigned in
 * input order starting at 0; a duplicate internal id collapses to one row.
 */
export async function recordMessageArtifacts(args: {
  messageId: number;
  artifactInternalIds: readonly string[];
  conn?: Db;
}): Promise<void> {
  if (args.artifactInternalIds.length === 0) return;
  const conn = args.conn ?? db;
  const seen = new Set<string>();
  const rows: Array<{ messageId: number; artifactId: string; position: number }> = [];
  let position = 0;
  for (const internalId of args.artifactInternalIds) {
    if (!internalId || seen.has(internalId)) continue;
    seen.add(internalId);
    rows.push({ messageId: args.messageId, artifactId: internalId, position });
    position += 1;
  }
  if (rows.length === 0) return;
  await conn
    .insert(sessionMessageArtifacts)
    .values(rows)
    .onConflictDoNothing();
}

/**
 * Hydrate safe `MessageArtifactOpenRef[]` for a set of messages, keyed by
 * message id. Re-validates at read time that each artifact is STILL attached
 * to the canonical room namespace and not soft-deleted; detached, deleted, or
 * private refs are omitted (the inner joins + `deleted_at IS NULL` filter
 * them). Orders each message's refs by the preserved send-time `position`.
 *
 * `roomId` is the server-validated canonical room id stamped onto every ref
 * for this page (the caller already verified room membership; this helper does
 * not re-check membership, only artifact attachment + non-deletion).
 */
export async function hydrateMessageArtifacts(args: {
  messageIds: readonly number[];
  canonicalRoomNamespaceId: string;
  roomId: string;
  conn?: HydrateDb;
}): Promise<Map<number, MessageArtifactOpenRef[]>> {
  const out = new Map<number, MessageArtifactOpenRef[]>();
  if (
    args.messageIds.length === 0 ||
    !args.canonicalRoomNamespaceId ||
    !args.roomId
  ) {
    return out;
  }
  const conn = args.conn ?? db;
  const rows = await conn
    .select({
      messageId: sessionMessageArtifacts.messageId,
      position: sessionMessageArtifacts.position,
      internalId: artifacts.id,
      path: artifacts.path,
      mimeType: artifacts.mimeType,
      size: artifacts.size,
    })
    .from(sessionMessageArtifacts)
    .innerJoin(artifacts, eq(artifacts.id, sessionMessageArtifacts.artifactId))
    .innerJoin(
      artifactNamespaces,
      eq(artifactNamespaces.artifactId, artifacts.id),
    )
    .where(
      and(
        inArray(sessionMessageArtifacts.messageId, [...args.messageIds]),
        eq(artifactNamespaces.namespaceId, args.canonicalRoomNamespaceId),
        isNull(artifacts.deletedAt),
      ),
    )
    .orderBy(
      asc(sessionMessageArtifacts.messageId),
      asc(sessionMessageArtifacts.position),
    );
  for (const r of rows) {
    const ref: MessageArtifactOpenRef = {
      artifactInternalId: r.internalId,
      roomId: args.roomId,
      basename: basenameFromPath(r.path),
      mimeType: r.mimeType ?? "application/octet-stream",
      sizeBytes: typeof r.size === "number" ? r.size : Number(r.size ?? 0),
    };
    const list = out.get(r.messageId);
    if (list) list.push(ref);
    else out.set(r.messageId, [ref]);
  }
  return out;
}

/**
 * Derive a safe basename from a logical artifact path. Strips any directory
 * component so no storage/path structure leaks into the card; falls back to an
 * empty string when the path is empty (the caller may still render the
 * internal id). Never throws.
 */
export function basenameFromPath(path: string | null | undefined): string {
  if (typeof path !== "string" || path.length === 0) return "";
  const trimmed = path.trim();
  if (!trimmed) return "";
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  const tail = parts[parts.length - 1];
  return tail ?? "";
}
