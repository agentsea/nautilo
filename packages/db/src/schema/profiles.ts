import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { AvatarRef, ProfileVoices } from "@nautilo/types";
import { users } from "./users";
import { agents } from "./agents";
import type { ModelControlSelection } from "./model-control-selection";

export const profiles = pgTable(
  "profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    // M132 — the Profile is 1:1 with the Agent it describes. agent_id is
    // the canonical identity key; user_id is retained for the (current)
    // user-keyed read path and is no longer unique (a Human may own more
    // than one Agent → more than one Profile).
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    name: varchar("name", { length: 100 }).notNull().default("Nautilo"),
    soulFile: text("soul_file"),
    language: varchar("language", { length: 5 }).notNull().default("en"),
    privacySpectrum: integer("privacy_spectrum"),
    workLifeMode: varchar("work_life_mode", { length: 20 }),
    voiceName: varchar("voice_name", { length: 100 }),
    voiceId: varchar("voice_id", { length: 100 }),
    /**
     * D261 — per-language voice map. `Record<"default"|BCP-47, {voiceId,voiceName}>`.
     * `"default"` is the primary/fallback voice (untagged text + unmapped languages);
     * other keys are per-language voices the agent switches to on `<voice lang>` spans.
     * Backfilled from `voice_id/voice_name`; those legacy columns are dropped once all
     * callers read `voices` (see ISSUE-D261 Phase 1).
     */
    voices: jsonb("voices").$type<ProfileVoices>().notNull().default({}),
    personalityPrompt: text("personality_prompt"),
    motherAnswer: text("mother_answer"),
    avatarRef: jsonb("avatar_ref").$type<AvatarRef | null>(),
    /**
     * D487 — monotonic CAS token for the one canonical Agent-photo pointer
     * above. This is deliberately not another pointer or historical value.
     */
    avatarSelectionRevision: bigint("avatar_selection_revision", { mode: "number" })
      .notNull()
      .default(0),
    /**
     * D487 — monotonic invalidation token for the owned-photo library. It is
     * independent of selection so list pagination can fence stale pages.
     */
    avatarLibraryRevision: bigint("avatar_library_revision", { mode: "number" })
      .notNull()
      .default(0),
    publicProfile: boolean("public_profile").notNull().default(false),
    personalityTone: varchar("personality_tone", { length: 50 }),
    defaultModel: varchar("default_model", { length: 100 }),
    /**
     * D462 — optional full control bundle for this Agent's default model.
     * `default_model` remains in place for model-only clients and historical
     * rows; readers use this bundle only when it is present and valid.
     */
    defaultModelControlSelection: jsonb("default_model_control_selection")
      .$type<ModelControlSelection>(),
    onboardingCompleted: boolean("onboarding_completed").notNull().default(false),
    welcomeMessageSent: boolean("welcome_message_sent").notNull().default(false),
    /**
     * D141 P2 / LD-1 — per-user default for opt-in model fallback. Owned
     * by D141; surfaced to the user via the chain-editor in workbench
     * Settings → Providers. Default `false` per LD-4; existing instances
     * cold-flip to `false` per LD-5 (no migration banner).
     */
    fallbackEnabled: boolean("fallback_enabled").notNull().default(false),
    /**
     * D141 P2 / LD-1 — ordered list of catalog model IDs (per
     * `assistant-models.ts`) the user has authored. `[]` by default.
     * `resolveFallbackPolicy(userId, agentId)` reads this when no
     * per-agent override is present in `agents.customization.fallback`.
     */
    fallbackChain: jsonb("fallback_chain").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // M132: user_id index is now NON-unique (was uniqueIndex) — a Human may
    // own more than one Agent, hence more than one Profile.
    index("idx_profiles_user_id").on(table.userId),
    // M132: the Profile's identity is its Agent.
    uniqueIndex("uq_profiles_agent_id").on(table.agentId),
    check(
      "profiles_avatar_photo_revisions_nonnegative",
      sql`${table.avatarSelectionRevision} BETWEEN 0 AND 9007199254740991
        AND ${table.avatarLibraryRevision} BETWEEN 0 AND 9007199254740991`,
    ),
  ],
);

export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;
