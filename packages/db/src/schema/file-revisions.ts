import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  bigint,
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { rooms } from "./rooms";
import { users } from "./users";

/**
 * Backup substrate: revision records support document recovery.
 *
 * Every accepted `file.apply_patch` call records a revision here. The row
 * carries enough information to reconstruct the pre-accept bytes of the
 * target file, either by applying the stored reverse unified-diff against
 * the current on-disk bytes (hot lane, `kind='diff'`), or by reading a
 * pre-bytes blob from `StorageProvider` (cold lane, `kind='blob'`, or
 * `kind='tombstone'` for deletes where the target no longer exists).
 *
 * The hot / cold split is invisible above the storage layer — one
 * `recordRevision()` function, one restore API. Routing happens inside the
 * backup module based on file shape (binary vs text, pre-bytes size,
 * resulting diff size, operation kind).
 *
 * Payload invariant (enforced in the application layer by `recordRevision`,
 * not by a CHECK constraint — matching the convention used elsewhere in
 * this schema):
 *   - `kind='diff'`      → `diffText` populated, `blobRef` / `blobSize` null.
 *   - `kind='blob'`      → `blobRef` + `blobSize` populated, `diffText` null.
 *   - `kind='tombstone'` → `blobRef` + `blobSize` populated (pre-bytes of the
 *                          deleted file), `diffText` null.
 */
export const fileRevisions = pgTable(
  "file_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    roomId: uuid("room_id").references(() => rooms.id, { onDelete: "set null" }),

    /**
     * Turn that produced this revision. Not an FK because turn records
     * are not their own table yet (they live inside the turn-log log
     * stream); revisions must survive turn-log cleanup so we can still
     * undo months-old accepts.
     */
    turnId: text("turn_id").notNull(),

    /**
     * The canonical identity of the target file. Restore and queries
     * both key off `absolutePath`. `workspacePath` is display-only.
     */
    absolutePath: text("absolute_path").notNull(),
    workspacePath: text("workspace_path"),

    /**
     * D448 — Workspace-backed revision provenance. `absolutePath` remains
     * the physical storage path used by the existing restore machinery;
     * these nullable fields describe the logical artifact mutation without
     * changing ordinary local-file revision behavior.
     *
     * A move records both logical paths against the same artifact UUID.
     * `workspaceOperationId` identifies one logical/native operation group:
     * an overwrite-move may therefore create two linked revision rows with
     * the same id. Ordering across groups remains intentionally unspecified
     * until Workspace undo has a truthful transaction model.
     */
    workspaceArtifactId: uuid("workspace_artifact_id"),
    workspacePathBefore: text("workspace_path_before"),
    workspacePathAfter: text("workspace_path_after"),
    workspaceOperationId: uuid("workspace_operation_id"),

    /**
     * sha256 hex of the pre-accept bytes. Used for (a) blob-dedup in the
     * cold lane, (b) restore-time sanity checking that the chain from
     * current-on-disk back through the revision is internally consistent.
     */
    preSha256: text("pre_sha256").notNull(),
    /**
     * Pre-accept byte count. `bigint` (not `integer`) because binary
     * workspace files can trivially exceed `integer`'s 2.14 GB ceiling
     * (videos, datasets, large images). `mode: "number"` surfaces JS
     * `number` rather than `BigInt` since file sizes below 2^53 bytes
     * (~9 PB) are the only realistic range.
     */
    preSize: bigint("pre_size", { mode: "number" }).notNull(),

    /**
     * Lane discriminator. Valid values: 'diff' | 'blob' | 'tombstone'.
     * Enforced at the recordRevision() call site.
     */
    kind: text("kind").notNull(),
    diffText: text("diff_text"),
    blobRef: text("blob_ref"),
    /** Same rationale as `preSize` — `bigint` with `mode: "number"`. */
    blobSize: bigint("blob_size", { mode: "number" }),

    /**
     * The destructive `file` command that produced this revision.
     * Valid values: 'write' | 'str_replace' | 'insert' | 'delete'
     * | 'move' | 'copy'. Surfaced in the rollback UI as part of the
     * "what did the Agent do" summary.
     */
    operation: text("operation").notNull(),

    /**
     * Retention knobs. `pinned` rows are exempt from GC; `accessedAt`
     * is bumped on restore reads so LRU eviction prefers stale rows.
     */
    pinned: boolean("pinned").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    accessedAt: timestamp("accessed_at", { withTimezone: true }),

    /**
     * D087 Phase 3 — redo traversal pointer.
     *
     * When the user accepts an `undo` staged patch, the apply-patch
     * handler records a NEW revision of the pre-undo state. That new
     * row carries `restoreFromRevisionId` pointing to the revision
     * the undo was restoring FROM — i.e. the "forward" state. Redo
     * is simply "find my most recent revision where this column is
     * non-null, then stage its pre-state as a restore."
     *
     * NULL for revisions that weren't produced by an undo (the
     * vast majority). Self-referential FK to `file_revisions(id)`,
     * `ON DELETE SET NULL` so GC of older rows doesn't cascade into
     * newer ones (the newer row just loses its redo pointer — still
     * a valid revision, just no longer redo-eligible).
     */
    restoreFromRevisionId: uuid("restore_from_revision_id").references(
      (): AnyPgColumn => fileRevisions.id,
      { onDelete: "set null" },
    ),

    /**
     * M180 — who authored this revision. Agent accepts default to
     * `'agent'`; human workbench checkpoints pass `'user'` plus
     * `userId`. Distinct from `ownerId` (namespace owner) — a human
     * editor's checkpoint is owned by the agent namespace but
     * attributed to the editing user.
     */
    authoredBy: text("authored_by").notNull().default("agent"),
    /**
     * M180 — the human user who authored this revision when
     * `authoredBy='user'`. NULL for agent-authored rows. FK to
     * `users.id` with `ON DELETE SET NULL` so account deletion
     * doesn't cascade-delete revision history.
     */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  },
  (table) => [
    // "Revisions for this file, newest first" — the restore-time lookup.
    index("idx_file_revisions_path_newest").on(
      table.agentId,
      table.absolutePath,
      table.createdAt.desc(),
    ),
    // "Revisions from this turn" — the /undo default = last-turn undo.
    index("idx_file_revisions_turn").on(table.agentId, table.turnId),
    // D448 — all revisions linked to one Workspace logical/native operation.
    index("idx_file_revisions_workspace_operation").on(
      table.agentId,
      table.workspaceOperationId,
    ),
    // LRU eviction sweep.
    index("idx_file_revisions_gc").on(
      table.pinned,
      table.accessedAt,
      table.createdAt,
    ),
    // Blob dedup / ref-count lookup before unlinking a cold-lane blob.
    index("idx_file_revisions_blob_ref").on(table.blobRef),
    // "Redo-eligible revisions for this file, newest first" — the
    // §3.3 selection heuristic. Partial-index effect: rows where
    // restore_from_revision_id IS NULL (the majority) sort cheaply
    // at the end of the btree, so redo lookups stay fast even as
    // the table grows.
    index("idx_file_revisions_redo").on(
      table.agentId,
      table.absolutePath,
      table.restoreFromRevisionId,
      table.createdAt.desc(),
    ),
  ],
);

export type FileRevision = typeof fileRevisions.$inferSelect;
export type NewFileRevision = typeof fileRevisions.$inferInsert;

/**
 * Discriminator values for `file_revisions.kind`. Exported so the
 * application-layer router, tests, and GC code can reference the
 * same union without reimplementing it.
 */
export const FILE_REVISION_KIND = {
  DIFF: "diff",
  BLOB: "blob",
  TOMBSTONE: "tombstone",
} as const;
export type FileRevisionKind =
  (typeof FILE_REVISION_KIND)[keyof typeof FILE_REVISION_KIND];

/**
 * Valid values for `file_revisions.operation`. Mirrors the `file` tool's
 * destructive-command set (Phase 1 `FileCommandName` minus the read-only
 * members). Exported for type-safe recordRevision call sites.
 */
export const FILE_REVISION_OPERATION = {
  CREATE: "create",
  WRITE: "write",
  STR_REPLACE: "str_replace",
  INSERT: "insert",
  DELETE: "delete",
  MOVE: "move",
  COPY: "copy",
  CONVERT: "convert",
  WRITE_XLSX: "write_xlsx",
  WRITE_PPTX: "write_pptx",
} as const;
export type FileRevisionOperation =
  (typeof FILE_REVISION_OPERATION)[keyof typeof FILE_REVISION_OPERATION];

/**
 * Valid values for `file_revisions.authored_by`. Agent file-tool
 * accepts default to `agent`; human workbench checkpoints use `user`.
 */
export const FILE_REVISION_AUTHOR = {
  AGENT: "agent",
  USER: "user",
} as const;
export type FileRevisionAuthor =
  (typeof FILE_REVISION_AUTHOR)[keyof typeof FILE_REVISION_AUTHOR];
