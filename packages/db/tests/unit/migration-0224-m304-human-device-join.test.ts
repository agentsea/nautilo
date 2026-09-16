import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const migration = await readFile(
  new URL("../../src/migrations/0224_kind_meggan.sql", import.meta.url),
  "utf8",
);

describe("M304 generated Human-device join-request migration", () => {
  test("persists only the target public join request and exact head binding", () => {
    expect(migration).toContain(
      'CREATE TABLE "human_crypto_device_group_join_requests"',
    );
    expect(migration).toContain('"expected_head_digest" "bytea" NOT NULL');
    expect(migration).toContain('"request_bytes" "bytea" NOT NULL');
    expect(migration).toContain(
      'FOREIGN KEY ("target_device_id","target_device_generation")',
    );
    expect(migration).not.toMatch(/private_key|exporter_secret|content_key/u);
  });

  test("keeps the request lifecycle crypto-role-only", () => {
    expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE",
    );
    expect(migration).toContain('TO "nautilo_crypto";');
    expect(migration).not.toMatch(/TO "nautilo_agent"/u);
  });
});
