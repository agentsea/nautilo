import { describe, expect, test } from "bun:test";
import {
  MISSING_MIGRATION_CONNECTION_MESSAGE,
  OFFLINE_DRIZZLE_CONNECTION_URL,
  resolveMigrationConnectionUrl,
} from "../../src/config/migration-connection";

describe("resolveMigrationConnectionUrl", () => {
  test("prefers nonblank DB_DIRECT_CONNECTION over runtime DB_CONNECTION_STRING", () => {
    const url = resolveMigrationConnectionUrl({
      DB_DIRECT_CONNECTION: "postgresql://admin:secret@localhost:5432/nautilo",
      DB_CONNECTION_STRING: "postgres://nautilo:runtime@db.localtest.me:4445/nautilo",
    });
    expect(url).toBe("postgresql://admin:secret@localhost:5432/nautilo");
  });

  test("falls back to legacy DB_CONNECTION_STRING when DB_DIRECT_CONNECTION is unset", () => {
    const legacy = "postgres://nautilo:legacy@db.localtest.me:4445/nautilo";
    const url = resolveMigrationConnectionUrl({
      DB_CONNECTION_STRING: legacy,
    });
    expect(url).toBe(legacy);
  });

  test("falls back to legacy DB_CONNECTION_STRING when DB_DIRECT_CONNECTION is blank", () => {
    const legacy = "postgres://nautilo:legacy@db.localtest.me:4445/nautilo";
    const url = resolveMigrationConnectionUrl({
      DB_DIRECT_CONNECTION: "   ",
      DB_CONNECTION_STRING: legacy,
    });
    expect(url).toBe(legacy);
  });

  test("fails closed when connecting commands omit an explicit target", () => {
    expect(() => resolveMigrationConnectionUrl({})).toThrow(
      MISSING_MIGRATION_CONNECTION_MESSAGE,
    );
    expect(
      () => resolveMigrationConnectionUrl({
        DB_DIRECT_CONNECTION: "",
        DB_CONNECTION_STRING: "  ",
      }),
    ).toThrow(MISSING_MIGRATION_CONNECTION_MESSAGE);
  });

  test("NAUTILO_INSTANCE_ID alone cannot silently select a database", () => {
    expect(() =>
      resolveMigrationConnectionUrl({ NAUTILO_INSTANCE_ID: "test-cruft" }),
    ).toThrow(MISSING_MIGRATION_CONNECTION_MESSAGE);
  });

  test("schema-only commands use a non-routable offline placeholder", () => {
    expect(
      resolveMigrationConnectionUrl({ NAUTILO_DRIZZLE_OFFLINE: "1" }),
    ).toBe(OFFLINE_DRIZZLE_CONNECTION_URL);
  });
});
