import {
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * D374 — database self-identity marker.
 *
 * This is intentionally stored in the connected DB, not inferred from env.
 * Destructive guards use it to detect "env says scratch, connection points
 * at default" split-brain before touching schemas/tables.
 */
export const nautiloInstanceIdentity = pgTable("nautilo_instance_identity", {
  id: text("id").primaryKey().default("self"),
  /**
   * Canonical instance id: empty string means protected `(default)`;
   * named instances use their NAUTILO_INSTANCE_ID value.
   */
  instanceId: text("instance_id").notNull(),
  /**
   * D458 — immutable UUID used to bind remote-controller ceremonies to this
   * particular Server. Unlike `instanceId`, this is not a deployment label
   * and must never be regenerated after the identity row is created.
   */
  serverInstanceId: uuid("server_instance_id").notNull().defaultRandom(),
  /**
   * Monotonic binding epoch. Remote binding consumers include this in their
   * authorization tuple so a future server-wide invalidation can advance one
   * durable generation rather than trusting a client-held value.
   */
  serverBindingGeneration: integer("server_binding_generation")
    .notNull()
    .default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("uq_nautilo_instance_identity_server_instance").on(
    table.serverInstanceId,
  ),
]);
