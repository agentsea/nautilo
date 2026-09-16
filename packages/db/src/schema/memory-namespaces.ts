import {
  index,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { memories } from "./memories";
import { namespaces } from "./trust";

export const memoryNamespaces = pgTable(
  "memory_namespaces",
  {
    memoryId: uuid("memory_id")
      .notNull()
      .references(() => memories.id, { onDelete: "cascade" }),
    namespaceId: uuid("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "restrict" }),
    attachedAt: timestamp("attached_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.memoryId, table.namespaceId] }),
    index("idx_memory_namespaces_namespace").on(table.namespaceId),
    index("idx_memory_namespaces_memory").on(table.memoryId),
  ],
);

export type MemoryNamespace = typeof memoryNamespaces.$inferSelect;
export type NewMemoryNamespace = typeof memoryNamespaces.$inferInsert;
