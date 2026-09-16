import { describe, expect, test } from "bun:test";
import * as nautiloSchema from "@nautilo/db/schema";
import {
  pgSchema,
  pgTable,
  pgView,
  primaryKey,
  text,
  uuid,
} from "drizzle-orm/pg-core";

import { inventoryDrizzleSchema } from "../../src/node/schema-inventory";

describe("Drizzle schema inventory", () => {
  test("enumerates the actual Nautilo tables, columns, and existing view without a DB", () => {
    const inventory = inventoryDrizzleSchema(nautiloSchema);

    expect(inventory.objects.filter((object) => object.kind === "table")).toHaveLength(205);
    expect(inventory.objects.filter((object) => object.kind === "view")).toEqual([
      {
        id: "db.public.users_public",
        surface: "db",
        locator: "public.users_public",
        kind: "view",
        schema: "public",
        name: "users_public",
        exportNames: ["usersPublic"],
        isExisting: true,
      },
    ]);
    expect(inventory.columns.filter((column) => column.kind === "table")).toHaveLength(2758);
    expect(inventory.columns.filter((column) => column.kind === "view")).toHaveLength(6);
    expect(inventory.constraints).toHaveLength(775);

    expect(inventory.columns).toContainEqual({
      id: "db.public.session_messages.content",
      surface: "db",
      locator: "public.session_messages.content",
      kind: "table",
      schema: "public",
      objectName: "session_messages",
      columnName: "content",
      sqlType: "text",
      notNull: false,
      generated: false,
      defaultSql: null,
      primaryKey: false,
    });
    expect(inventory.columns.filter((column) =>
      [
        "public.room_journal_state.rebuild_generation",
        "public.room_journal_state.rebuild_requested_at",
        "public.room_journal_state.rebuild_target_message_id",
        "public.session_messages.edit_revision",
        "public.session_messages.edited_at",
      ].includes(column.locator)
    ).map((column) => column.locator)).toEqual([
      "public.room_journal_state.rebuild_generation",
      "public.room_journal_state.rebuild_requested_at",
      "public.room_journal_state.rebuild_target_message_id",
      "public.session_messages.edit_revision",
      "public.session_messages.edited_at",
    ]);
    expect(inventory.columns.find(
      (column) => column.locator === "public.memories.creation_key",
    )).toMatchObject({
      sqlType: "text",
      notNull: false,
      generated: false,
    });
    expect(inventory.columns.find(
      (column) => column.locator === "public.memories.crypto_object_id",
    )).toMatchObject({
      sqlType: "text",
      notNull: false,
      generated: false,
    });
    expect(inventory.columns.find(
      (column) =>
        column.locator === "public.memory_crypto_revisions.memory_id",
    )).toMatchObject({
      sqlType: "uuid",
      notNull: true,
      generated: false,
    });
    expect(inventory.columns.find(
      (column) =>
        column.locator === "public.memory_crypto_operations.operation_id",
    )).toMatchObject({
      sqlType: "text",
      notNull: true,
      generated: false,
    });
    expect(inventory.columns.find(
      (column) => column.locator === "public.relay_tokens.device_group_id",
    )).toMatchObject({
      sqlType: "uuid",
      notNull: false,
      generated: false,
    });
    expect(inventory.columns.find(
      (column) => column.locator ===
        "public.relay_tokens.device_management_id",
    )).toMatchObject({
      sqlType: "text",
      notNull: false,
      generated: false,
    });
    expect(inventory.columns.find(
      (column) => column.locator === "public.rooms.normalized_label",
    )).toMatchObject({
      sqlType: "text",
      notNull: false,
      generated: true,
    });
    expect(inventory.constraints).toContainEqual({
      locator: "public.actors#foreign_key:actors_owner_id_users_id_fk",
      tableLocator: "public.actors",
      kind: "foreign_key",
      name: "actors_owner_id_users_id_fk",
      columns: ["owner_id"],
      referencedTable: "public.users",
      referencedColumns: ["id"],
      onDelete: "cascade",
      onUpdate: "no action",
    });
    expect(inventory.columns).toContainEqual({
      id: "db.public.session_messages.content_search",
      surface: "db",
      locator: "public.session_messages.content_search",
      kind: "table",
      schema: "public",
      objectName: "session_messages",
      columnName: "content_search",
      sqlType: "tsvector",
      notNull: false,
      generated: true,
      defaultSql: null,
      primaryKey: false,
    });
    expect(inventory.columns).toContainEqual({
      id: "db.public.users_public.name",
      surface: "db",
      locator: "public.users_public.name",
      kind: "view",
      schema: "public",
      objectName: "users_public",
      columnName: "name",
      sqlType: "varchar(255)",
      notNull: true,
      generated: false,
      defaultSql: null,
      primaryKey: false,
    });
  });

  test("uses fully-qualified deterministic locators and deduplicates export aliases", () => {
    const privateSchema = pgSchema("private");
    const privateNotes = privateSchema.table("notes", {
      body: text("body").notNull(),
      id: uuid("id").notNull(),
    });
    const publicNotes = pgTable("notes", {
      body: text("body"),
    });
    const publicView = pgView("notes_public", {
      body: text("body").notNull(),
    }).existing();

    const first = inventoryDrizzleSchema({
      zAlias: privateNotes,
      publicView,
      publicNotes,
      aAlias: privateNotes,
    });
    const second = inventoryDrizzleSchema({
      publicNotes,
      aAlias: privateNotes,
      zAlias: privateNotes,
      publicView,
    });

    expect(first).toEqual(second);
    expect(first.objects).toEqual([
      {
        id: "db.private.notes",
        surface: "db",
        locator: "private.notes",
        kind: "table",
        schema: "private",
        name: "notes",
        exportNames: ["aAlias", "zAlias"],
        isExisting: false,
      },
      {
        id: "db.public.notes",
        surface: "db",
        locator: "public.notes",
        kind: "table",
        schema: "public",
        name: "notes",
        exportNames: ["publicNotes"],
        isExisting: false,
      },
      {
        id: "db.public.notes_public",
        surface: "db",
        locator: "public.notes_public",
        kind: "view",
        schema: "public",
        name: "notes_public",
        exportNames: ["publicView"],
        isExisting: true,
      },
    ]);
    expect(first.columns.map((column) => column.locator)).toEqual([
      "private.notes.body",
      "private.notes.id",
      "public.notes.body",
      "public.notes_public.body",
    ]);
  });

  test("rejects incompatible objects that collide on one physical locator", () => {
    const first = pgTable("collision", { body: text("body") });
    const incompatible = pgTable("collision", {
      body: text("body").notNull(),
    });

    expect(() => inventoryDrizzleSchema({ first, incompatible })).toThrow(
      "Conflicting Drizzle schema object: table public.collision",
    );
  });

  test("rejects ambiguous duplicate constraint locators", () => {
    const duplicate = pgTable("duplicate", {
      id: uuid("id").primaryKey(),
    }, (table) => [
      primaryKey({ name: "duplicate_id_pk", columns: [table.id] }),
    ]);

    expect(() => inventoryDrizzleSchema({ duplicate })).toThrow(
      "Duplicate Drizzle constraint locators: public.duplicate#primary_key",
    );
  });
});
