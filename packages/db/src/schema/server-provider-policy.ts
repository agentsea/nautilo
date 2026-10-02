import { sql } from "drizzle-orm";
import { boolean, check, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export type ServerProviderFundingPreference = "personal_first" | "server_first";

/** One durable provider-funding policy per server database. */
export const serverProviderPolicy = pgTable(
  "server_provider_policy",
  {
    id: text("id").primaryKey().default("server"),
    allowPersonalProviderKeys: boolean("allow_personal_provider_keys")
      .notNull()
      .default(false),
    fundingPreference: text("funding_preference")
      .$type<ServerProviderFundingPreference>()
      .notNull()
      .default("personal_first"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("server_provider_policy_singleton", sql`${table.id} = 'server'`),
    check(
      "server_provider_policy_funding_preference",
      sql`${table.fundingPreference} in ('personal_first', 'server_first')`,
    ),
  ],
);

export type ServerProviderPolicyRow = typeof serverProviderPolicy.$inferSelect;
