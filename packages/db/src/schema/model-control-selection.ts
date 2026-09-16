import { index, jsonb, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import type { ModelControlSelection } from "@nautilo/types";
import { agents } from "./agents";
import { rooms } from "./rooms";

/**
 * D462's persisted user preference shape. It intentionally contains only
 * provider-neutral catalog IDs: adapter selectors and provider request fields
 * never cross this persistence boundary.
 */
export type { ModelControlSelection } from "@nautilo/types";

/**
 * Durable quick-picker override, keyed by the canonical Room + Agent lane.
 * A composite primary key prevents one Agent's override colliding with another
 * Agent in the same Room (or the same Agent in another Room).
 */
export const roomAgentModelControlSelections = pgTable(
  "room_agent_model_control_selections",
  {
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    selection: jsonb("selection").$type<ModelControlSelection>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.roomId, table.agentId] }),
    index("idx_room_agent_model_control_selections_agent").on(table.agentId),
  ],
);

export type RoomAgentModelControlSelection = typeof roomAgentModelControlSelections.$inferSelect;
export type NewRoomAgentModelControlSelection = typeof roomAgentModelControlSelections.$inferInsert;
