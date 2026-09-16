import { describe, expect, test } from "bun:test";
import {
  compileOfflineDirectQuery,
  createOfflineDirectDb,
} from "../../src/config/direct-database";
import { memories, memoryNamespaces } from "../../src/schema";
import { sql } from "drizzle-orm";

describe("offline Drizzle result labels", () => {
  const db = createOfflineDirectDb();

  test("accepts a selection key matching the PostgreSQL column name", () => {
    const compiled = compileOfflineDirectQuery(
      db.select({ content_revision: memories.contentRevision }).from(memories),
    );

    expect(compiled.sql).toContain('"content_revision"');
  });

  test("accepts an explicit alias for a renamed result field", () => {
    const compiled = compileOfflineDirectQuery(
      db.select({
        memory_id: sql`${memories.id}`.as("memory_id"),
      }).from(memories),
    );

    expect(compiled.sql).toContain('"id" as "memory_id"');
  });

  test("preserves the PostgreSQL label when Drizzle would rename it", () => {
    const compiled = compileOfflineDirectQuery(
      db.select({ memory_id: memories.id }).from(memories),
    );

    expect(compiled.sql).toContain('"id"');
  });

  test("rejects unaliased SQL expressions", () => {
    expect(() => compileOfflineDirectQuery(
      db.select({ message_count: sql<number>`count(*)` }).from(memories),
    )).toThrow();
  });

  test("rejects an explicit alias that differs from its selection key", () => {
    expect(() => compileOfflineDirectQuery(
      db.select({ memory_id: sql`${memories.id}`.as("id") }).from(memories),
    )).toThrow('aliased result field "memory_id"');
  });

  test.each([
    [
      "insert",
      db.insert(memories)
        .values({ content: "test" })
        .returning({
          memory_id: sql`${memories.id}`.as("memory_id"),
        }),
    ],
    [
      "update",
      db.update(memories)
        .set({ content: "updated" })
        .returning({
          memory_id: sql`${memories.id}`.as("memory_id"),
        }),
    ],
    [
      "delete",
      db.delete(memories)
        .returning({
          memory_id: sql`${memories.id}`.as("memory_id"),
        }),
    ],
  ] as const)("accepts matching %s returning aliases", (_operation, query) => {
    const compiled = compileOfflineDirectQuery(query);

    expect(compiled.sql).toContain('"id" as "memory_id"');
  });

  test.each([
    [
      "insert",
      db.insert(memories)
        .values({ content: "test" })
        .returning({ memory_id: memories.id }),
    ],
    [
      "update",
      db.update(memories)
        .set({ content: "updated" })
        .returning({ memory_id: memories.id }),
    ],
    [
      "delete",
      db.delete(memories)
        .returning({ memory_id: memories.id }),
    ],
  ] as const)("preserves mismatched %s returning labels", (_operation, query) => {
    const compiled = compileOfflineDirectQuery(query);

    expect(compiled.sql).toContain('"id"');
  });

  test("rejects duplicate PostgreSQL labels", () => {
    expect(() => compileOfflineDirectQuery(
      db.select({ first: memories.id, second: memories.id }).from(memories),
    )).toThrow('result field label "id" must be unique');
  });

  test("builds insert-selects with every table field in definition order", () => {
    const query = db.insert(memoryNamespaces).select(db.select({
      memoryId: memories.id,
      namespaceId: sql<string>`'00000000-0000-0000-0000-000000000001'::uuid`
        .as("namespace_id"),
      attachedAt: sql<Date>`now()`.as("attached_at"),
    }).from(memories));

    expect(query.toSQL().sql).toContain(
      'insert into "memory_namespaces" ("memory_id", "namespace_id", "attached_at")',
    );
  });
});
