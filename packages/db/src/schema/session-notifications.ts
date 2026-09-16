import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents";

/**
 * D090 — per-thread, per-agent notifications buffer.
 *
 * Backs the silent direct-dispatch Accept / Reject flow: when a user
 * clicks Reject on a DiffView card, the server WS handler writes a
 * row here instead of sending a synthetic user message through the
 * chat pipeline. At the start of the next user-driven turn, the
 * pre-model node drains the buffer for `(threadId, agentId)`, injects
 * a one-shot `## Since your last turn` block into the system prompt,
 * and marks the drained rows with `drained_at`.
 *
 * Accept clicks do NOT write a row — the filesystem is the
 * source-of-truth; the Agent learns about applies via normal reads +
 * the stage-time sha256 guard. Only rejections need an explicit
 * signal because they carry new-information the agent can't deduce
 * from disk state alone.
 *
 * The scope key is `thread_id` — the LangGraph thread identifier,
 * same value that `sessions.thread_id` stores (one session = one
 * thread today; future cross-session continuity would reuse the
 * same thread). Using the thread id rather than a `sessions.id` FK
 * means (a) `state.langgraphThreadId` is already plumbed end-to-end
 * so pre-model can drain without new state annotations, and
 * (b) notifications survive a session-row cleanup if we ever GC
 * old `sessions` rows but keep the thread around. Tradeoff: no FK
 * cascade from sessions — a daily sweep (§1.9 follow-up) handles
 * orphan cleanup based on `drained_at` age.
 *
 * `drained_at` as a soft-delete rather than a hard DELETE so that:
 *   - A daily sweep can GC rows older than N days for auditability.
 *   - Diagnostic queries like "did this agent ever see that reject?"
 *     work after the next-turn injection fires.
 *
 * `kind` is reserved for future notification types:
 *   - `'reject'` — the only kind written in D090 Phase 1.
 *   - `'apply'` / `'error'` — reserved if we later decide some
 *     apply outcomes warrant a notification too (not planned).
 */
export const sessionNotifications = pgTable(
  "session_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    threadId: text("thread_id").notNull(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),

    /**
     * Valid values: `'reject'` (D090 Phase 1). `'apply'` / `'error'`
     * reserved for future. Validated at the append call site; no DB
     * CHECK constraint to match the convention used across the rest
     * of this schema.
     */
    kind: text("kind").notNull(),

    /**
     * The staged-patch id whose dispatch triggered this notification.
     * Stored verbatim so the next-turn system-prompt block can quote
     * it back ("patch id: 9fbe7e65:067b238f") for observability /
     * debuggability — same format the agent sees in file_revisions.
     */
    patchId: text("patch_id").notNull(),

    /**
     * The absolute filesystem path the patch would have modified.
     * Captured from `StagedPatch.path` before the stage was removed
     * (reject drains the stage, losing the path otherwise). Used to
     * render a backticked path in the next-turn block so the Agent
     * knows which file the rejection applies to.
     *
     * PII / M2 note: same shape as `file_revisions.absolute_path`.
     * If M2's per-field encryption ever applies to filesystem paths,
     * both columns get the same treatment; no D090-specific policy.
     */
    absolutePath: text("absolute_path").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** NULL = pending; non-NULL = drained into a pre-model prompt
     *  at the given timestamp. Drain updates the row rather than
     *  deletes so audit queries still work. */
    drainedAt: timestamp("drained_at", { withTimezone: true }),
  },
  (table) => [
    // Drives the turn-start "give me everything pending for this
    // (thread, agent)" query. WHERE drained_at IS NULL fast-filters
    // via the partial-index characteristic of btrees — most rows
    // will be drained at any given time so the scan is cheap.
    index("idx_session_notifications_pending").on(
      table.threadId,
      table.agentId,
      table.drainedAt,
    ),
  ],
);

export type SessionNotification = typeof sessionNotifications.$inferSelect;
export type NewSessionNotification = typeof sessionNotifications.$inferInsert;

/**
 * Discriminator values for `session_notifications.kind`. Exported so
 * the application layer references the same string constants without
 * re-declaring the literal — mirrors `FILE_REVISION_KIND` /
 * `FILE_REVISION_OPERATION` from `file-revisions.ts`.
 */
export const SESSION_NOTIFICATION_KIND = {
  REJECT: "reject",
  // Reserved — not written by D090 Phase 1.
  APPLY: "apply",
  ERROR: "error",
} as const;
export type SessionNotificationKind =
  (typeof SESSION_NOTIFICATION_KIND)[keyof typeof SESSION_NOTIFICATION_KIND];
