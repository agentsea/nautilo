import {
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users";
import { rooms } from "./rooms";

/**
 * Costs dashboard substrate — one row per LLM API call whose token usage we
 * can observe.
 *
 * Nautilo never receives a dollar figure from most providers (Anthropic,
 * OpenAI, Google, Fireworks, xAI return token counts only), so
 * `estimated_cost_usd` is computed at write time from the maintained price
 * table (`@nautilo/agent` pricing) using the tokens on this row. It stays
 * correct historically because the dollar amount is frozen at insert.
 *
 * `actual_cost_usd` is the provider-reported dollar cost and is only populated
 * for providers that return it on the wire (OpenRouter, custom gateway). NULL
 * everywhere else — the UI shows estimated for those and labels it as such.
 *
 * `user_id` / `room_id` are nullable: background and system calls (memory
 * flush, capability probes, etc.) have no initiating human or room.
 */
export const llmUsageEvents = pgTable(
  "llm_usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Initiating human, when there is one. NULL for system/background calls. */
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Room the call happened in, when applicable. */
    roomId: uuid("room_id").references(() => rooms.id, {
      onDelete: "set null",
    }),
    /**
     * What kind of call this was:
     * `chat` | `subagent` | `conductor` | `room_stenographer` | `room_reflection`
     * | `room_event_compaction` | `embedding` | `image_gen`
     * | `memory_flush` | `memory_review` | `web_search` | `session_search`
     * | `title` | `capability_probe` | `soul` | `other`.
     */
    callType: text("call_type").notNull().default("chat"),
    /** Provider slug: `anthropic` | `openai` | `google` | `openrouter` | ... */
    provider: text("provider").notNull(),
    /** Full model id, e.g. `anthropic:claude-sonnet-4-6`. */
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** Reasoning/thinking tokens, when the provider reports them separately. */
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    /** Cache-read (cached prompt) tokens, when reported; billed at a lower rate. */
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    /** Our token×price estimate, frozen at insert. Always present. */
    estimatedCostUsd: numeric("estimated_cost_usd", {
      precision: 14,
      scale: 8,
    })
      .notNull()
      .default("0"),
    /** Provider-reported dollar cost (OpenRouter/gateway). NULL when unknown. */
    actualCostUsd: numeric("actual_cost_usd", { precision: 14, scale: 8 }),
    /** Version tag of the price table used, so we can audit/reprice later. */
    pricingVersion: text("pricing_version"),
    /**
     * Funding provenance is forward-only. NULL means a legacy/unclassified row;
     * it must never be interpreted as server-funded.
     */
    fundingKind: varchar("funding_kind", {
      length: 16,
      enum: ["personal", "server", "service"],
    }),
    /** Human whose credential paid for a personal call. Kept after credential deletion. */
    payerHumanId: uuid("payer_human_id"),
    /** Actual funded transport route, distinct from the catalogue model id. */
    providerRoute: text("provider_route"),
    /** Non-secret personal credential row identity, retained as historical provenance. */
    credentialId: uuid("credential_id"),
    /** Credential revision admitted for this exact attempt. */
    credentialRevision: integer("credential_revision"),
    /** Freeform: sessionId, threadId, agentId, imageCount, requestId, etc. */
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  },
  (table) => [
    index("idx_llm_usage_occurred_at").on(table.occurredAt),
    index("idx_llm_usage_user_id").on(table.userId),
    index("idx_llm_usage_model").on(table.model),
    index("idx_llm_usage_call_type").on(table.callType),
    index("idx_llm_usage_provider").on(table.provider),
    index("idx_llm_usage_funding_kind").on(table.fundingKind),
    index("idx_llm_usage_payer_human_id").on(table.payerHumanId),
    check(
      "llm_usage_events_funding_provenance_check",
      sql`(
        (${table.fundingKind} IS NULL AND ${table.payerHumanId} IS NULL AND ${table.providerRoute} IS NULL AND ${table.credentialId} IS NULL AND ${table.credentialRevision} IS NULL)
        OR
        (${table.fundingKind} IS NOT NULL AND (
          (${table.fundingKind} = 'personal' AND ${table.payerHumanId} IS NOT NULL AND ${table.providerRoute} IS NOT NULL AND length(${table.providerRoute}) > 0 AND ${table.credentialId} IS NOT NULL AND ${table.credentialRevision} IS NOT NULL AND ${table.credentialRevision} >= 1)
          OR
          (${table.fundingKind} IN ('server', 'service') AND ${table.payerHumanId} IS NULL AND ${table.providerRoute} IS NOT NULL AND length(${table.providerRoute}) > 0 AND ${table.credentialId} IS NULL AND ${table.credentialRevision} IS NULL)
        ))
      )`,
    ),
  ],
);

export type LlmUsageEvent = typeof llmUsageEvents.$inferSelect;
export type NewLlmUsageEvent = typeof llmUsageEvents.$inferInsert;
