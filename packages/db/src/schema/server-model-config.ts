import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { ModelCatalogReasoningEffort } from "@nautilo/types";

export interface ServerReasoningPolicy {
  readonly defaultEffort: ModelCatalogReasoningEffort | null;
  readonly overrides: Record<string, ModelCatalogReasoningEffort>;
}

/**
 * D281 — server-wide model config singleton (default chat model, Conductor /
 * floor-manager model, fallback chain). One row per DB (`id='server'`), mirror
 * of `server_profile` (D280). DB-backed (not `.env`) so admin writes take
 * effect via a live read per request — no restart, no second `.env` writer.
 *
 * Null columns mean "unset → fall back to config/env defaults" (see
 * `resolveServerModelConfig`). `fallbackChain` is an ordered list of catalog
 * model ids (D141).
 */
export const serverModelConfig = pgTable("server_model_config", {
  id: text("id").primaryKey().default("server"),
  defaultChatModel: text("default_chat_model"),
  conductorModel: text("conductor_model"),
  /** M219 — null inherits the resolved Conductor model. */
  stenographerModel: text("stenographer_model"),
  /** M271 — null inherits the resolved Stenographer model. */
  reflectionModel: text("reflection_model"),
  /** Null preserves runtime Memory configuration and role selection. */
  memoryReviewModel: text("memory_review_model"),
  /** Null inherits operator config; empty selects automatic credential priority. */
  embeddingModel: text("embedding_model"),
  /** Null inherits operator config; empty selects the automatic catalogue default. */
  imageModel: text("image_model"),
  /** Null inherits operator config; empty selects the automatic catalogue default. */
  musicModel: text("music_model"),
  /** Null inherits operator config; empty selects the automatic catalogue default. */
  videoModel: text("video_model"),
  fallbackChain: jsonb("fallback_chain").$type<string[]>(),
  /**
   * D331 — per-model operator override for reasoning OUTPUT (Anthropic
   * extended thinking, etc). Keyed by catalog model id → enabled?. Absent key
   * (or null column) means "default": ON for `capabilities.reasoning` models.
   * An explicit `false` is the operator opt-OUT.
   */
  reasoningOutput: jsonb("reasoning_output").$type<Record<string, boolean>>(),
  /** D537 — compact server-wide reasoning intensity policy. */
  reasoningPolicy: jsonb("reasoning_policy").$type<ServerReasoningPolicy>(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ServerModelConfigRow = typeof serverModelConfig.$inferSelect;
export type NewServerModelConfigRow = typeof serverModelConfig.$inferInsert;
