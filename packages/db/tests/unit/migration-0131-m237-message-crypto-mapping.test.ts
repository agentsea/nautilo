import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { cryptoObjects } from "../../src/schema/crypto-storage.ts";
import { sessionMessages } from "../../src/schema/sessions.ts";

const migrations = resolve(import.meta.dirname, "../../src/migrations");
const migrationTag = "0131_tiny_lily_hollister";
const migration = readFileSync(
  resolve(migrations, `${migrationTag}.sql`),
  "utf8",
);
const journal = JSON.parse(
  readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
) as {
  entries: readonly { idx: number; tag: string }[];
};
const snapshot = JSON.parse(
  readFileSync(resolve(migrations, "meta/0131_snapshot.json"), "utf8"),
) as {
  tables: Record<string, {
    columns: Record<string, {
      name: string;
      type: string;
      primaryKey: boolean;
      notNull: boolean;
    }>;
    foreignKeys: Record<string, {
      tableTo: string;
      columnsFrom: readonly string[];
      columnsTo: readonly string[];
      onDelete: string;
    }>;
    uniqueConstraints: Record<string, {
      name: string;
      columns: readonly string[];
      nullsNotDistinct: boolean;
    }>;
  }>;
};

describe("M237 session message crypto mapping schema", () => {
  test("adds exactly one nullable unique product-to-crypto mapping", () => {
    const config = getTableConfig(sessionMessages);
    const cryptoColumn = config.columns.find(
      (column) => column.name === "crypto_object_id",
    );

    expect(cryptoColumn).toBeDefined();
    expect(cryptoColumn?.notNull).toBe(false);
    expect(
      config.columns.filter((column) =>
        /(?:crypto|cipher|envelope|wrapped|namespace)/.test(column.name)
      ).map((column) => column.name),
    ).toEqual(["crypto_object_id"]);

    const uniqueMapping = config.uniqueConstraints.find((constraint) =>
      constraint.columns.some((column) => column.name === "crypto_object_id")
    );
    expect(uniqueMapping?.columns.map((column) => column.name)).toEqual([
      "crypto_object_id",
    ]);
  });

  test("references the canonical append-only crypto object without cascading delete", () => {
    const config = getTableConfig(sessionMessages);
    const mappingForeignKey = config.foreignKeys.find((foreignKey) =>
      foreignKey.reference().columns.some(
        (column) => column.name === "crypto_object_id",
      )
    );
    const reference = mappingForeignKey?.reference();

    expect(reference).toBeDefined();
    expect(reference?.columns.map((column) => column.name)).toEqual([
      "crypto_object_id",
    ]);
    expect(reference && getTableName(reference.foreignTable)).toBe(
      getTableName(cryptoObjects),
    );
    expect(reference?.foreignColumns.map((column) => column.name)).toEqual([
      "object_id",
    ]);
    expect(mappingForeignKey?.onDelete).not.toBe("cascade");
  });

  test("records one generated additive migration in the ledger and snapshot", () => {
    expect(journal.entries.find((entry) => entry.idx === 131)).toMatchObject({
      idx: 131,
      tag: migrationTag,
    });
    expect(migration).toContain(
      'ALTER TABLE "session_messages" ADD COLUMN "crypto_object_id" text',
    );
    expect(migration).toContain(
      'FOREIGN KEY ("crypto_object_id") REFERENCES "public"."crypto_objects"("object_id") ON DELETE no action',
    );
    expect(migration).toContain(
      'CONSTRAINT "uq_session_messages_crypto_object_id" UNIQUE("crypto_object_id")',
    );
    expect(migration.match(/^ALTER TABLE/gm)).toHaveLength(3);
    expect(migration).not.toMatch(
      /^\s*(?:DROP|DELETE|UPDATE|INSERT|TRUNCATE|RENAME)\b/im,
    );
    expect(migration).not.toMatch(
      /(?:namespace_id|ciphertext|wrapped_dek|envelope|payload_bytes)/,
    );

    const table = snapshot.tables["public.session_messages"];
    expect(table?.columns["crypto_object_id"]).toEqual({
      name: "crypto_object_id",
      type: "text",
      primaryKey: false,
      notNull: false,
    });
    expect(
      table?.foreignKeys[
        "session_messages_crypto_object_id_crypto_objects_object_id_fk"
      ],
    ).toMatchObject({
      tableTo: "crypto_objects",
      columnsFrom: ["crypto_object_id"],
      columnsTo: ["object_id"],
      onDelete: "no action",
    });
    expect(
      table?.uniqueConstraints["uq_session_messages_crypto_object_id"],
    ).toEqual({
      name: "uq_session_messages_crypto_object_id",
      nullsNotDistinct: false,
      columns: ["crypto_object_id"],
    });
  });
});
