import { sql } from "drizzle-orm";
import { boolean, check, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * M219 — server-wide foreground Room context policy.
 *
 * One row per DB (`id='server'`). The recent conversation limit counts
 * deduplicated Human and non-empty Assistant boundaries; retained Tool rows
 * inside that range do not consume the limit.
 */
export const serverContextConfig = pgTable(
  "server_context_config",
  {
    id: text("id").primaryKey().default("server"),
    recentConversationLimit: integer("recent_conversation_limit")
      .notNull()
      .default(50),
    minimumFullTurns: integer("minimum_full_turns")
      .notNull()
      .default(1),
    maxRoomContextPercent: integer("max_room_context_percent")
      .notNull()
      .default(50),
    stenographerPriorConversationLimit: integer(
      "stenographer_prior_conversation_limit",
    )
      .notNull()
      .default(10),
    /**
     * M277 — optional foreground Record retrieval. Background Reflection/Sleep
     * and explicit recall_records remain active when this is disabled.
     */
    passiveRecallEnabled: boolean("passive_recall_enabled")
      .notNull()
      .default(true),
    /**
     * Background Reflection/Sleep control. New server configuration defaults
     * on after convergence qualification; an existing persisted off selection
     * remains authoritative.
     */
    reflectionSleepEnabled: boolean("reflection_sleep_enabled")
      .notNull()
      .default(true),
    /** Null preserves runtime reviewer enablement. */
    memoryReviewEnabled: boolean("memory_review_enabled"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "server_context_config_recent_conversation_limit_range",
      sql`${table.recentConversationLimit} BETWEEN 10 AND 100`,
    ),
    check(
      "server_context_config_minimum_full_turns_range",
      sql`${table.minimumFullTurns} BETWEEN 0 AND 10`,
    ),
    check(
      "server_context_config_max_room_context_percent_range",
      sql`${table.maxRoomContextPercent} BETWEEN 30 AND 80`,
    ),
    check(
      "server_context_config_stenographer_prior_conversation_limit_range",
      sql`${table.stenographerPriorConversationLimit} BETWEEN 0 AND 50`,
    ),
  ],
);

export type ServerContextConfigRow = typeof serverContextConfig.$inferSelect;
export type NewServerContextConfigRow = typeof serverContextConfig.$inferInsert;
