import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
  resolve(
    import.meta.dirname,
    "../../src/migrations/0126_conscious_ricochet.sql",
  ),
  "utf8",
);

describe("M232 device delivery sequence migration", () => {
  test("creates final queue counters and constraints additively", () => {
    expect(migration).not.toMatch(/\b(?:DROP|TRUNCATE)\b/i);
    expect(migration).toContain(
      '"recipient_sequence" bigint NOT NULL',
    );
    expect(migration).toContain(
      '"delivery_sequence_high_watermark" bigint DEFAULT 0 NOT NULL',
    );
    expect(migration).toContain(
      '"delivery_acknowledged_sequence" bigint DEFAULT 0 NOT NULL',
    );
  });

  test("needs no transitional backfill because the queue tables are new", () => {
    expect(migration).not.toMatch(
      /(?:PARTITION BY|SET "recipient_sequence"|UPDATE "crypto_delivery_)/,
    );
  });

  test("enforces unique positive sequences and coherent durable cursors", () => {
    expect(migration).toContain(
      '"uq_crypto_delivery_messages_recipient_sequence"',
    );
    expect(migration).toContain(
      '"crypto_delivery_messages_recipient_sequence_positive"',
    );
    expect(migration).toContain(
      '"human_crypto_devices_delivery_cursor_coherent"',
    );
  });
});
