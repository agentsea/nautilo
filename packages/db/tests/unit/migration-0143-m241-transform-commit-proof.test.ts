import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migrations = resolve(import.meta.dirname, "../../src/migrations");
const migrationTag = "0143_illegal_sprite";
const migration = readFileSync(
  resolve(migrations, `${migrationTag}.sql`),
  "utf8",
);
const journal = JSON.parse(
  readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
) as {
  entries: readonly {
    idx: number;
    when: number;
    tag: string;
  }[];
};
const snapshot = JSON.parse(
  readFileSync(resolve(migrations, "meta/0143_snapshot.json"), "utf8"),
) as {
  tables: Record<string, {
    columns: Record<string, {
      name: string;
      type: string;
      primaryKey: boolean;
      notNull: boolean;
    }>;
  }>;
};

describe("M241 transform commit proof migration", () => {
  test("is a generated additive and monotonic migration", () => {
    const entry = journal.entries.find((item) => item.idx === 143);
    const previous = journal.entries.find((item) => item.idx === 142);

    expect(entry).toMatchObject({ idx: 143, tag: migrationTag });
    expect(entry!.when).toBeGreaterThan(previous!.when);
    expect(entry!.when).toBeLessThanOrEqual(Date.now());
    expect(migration).not.toMatch(
      /^\s*(?:DROP|DELETE|UPDATE|INSERT|TRUNCATE|RENAME)\b/im,
    );
    expect(migration).not.toMatch(/\bjsonb?\b/i);
  });

  test("adds only a bounded content-free commit proof to the authorization row", () => {
    const columns = snapshot.tables[
      "public.background_crypto_authorization_requests"
    ]!.columns;
    expect(Object.fromEntries(
      [
        "transform_commit_claim_id",
        "transform_commit_descriptor_hash",
        "transform_commit_recipient_generation",
        "transform_commit_output_count",
        "transform_committed_at",
      ].map((name) => [name, columns[name]]),
    )).toEqual({
      transform_commit_claim_id: {
        name: "transform_commit_claim_id",
        type: "text",
        primaryKey: false,
        notNull: false,
      },
      transform_commit_descriptor_hash: {
        name: "transform_commit_descriptor_hash",
        type: "bytea",
        primaryKey: false,
        notNull: false,
      },
      transform_commit_recipient_generation: {
        name: "transform_commit_recipient_generation",
        type: "bigint",
        primaryKey: false,
        notNull: false,
      },
      transform_commit_output_count: {
        name: "transform_commit_output_count",
        type: "smallint",
        primaryKey: false,
        notNull: false,
      },
      transform_committed_at: {
        name: "transform_committed_at",
        type: "timestamp with time zone",
        primaryKey: false,
        notNull: false,
      },
    });
    expect(migration).toContain(
      "background_crypto_authorization_requests_transform_commit_coherent",
    );
    expect(migration).toContain(
      '"transform_commit_output_count" between 0\n          and 256',
    );
    expect(migration).toContain(
      '"transform_commit_descriptor_hash" = "background_crypto_authorization_requests"."descriptor_hash"',
    );
    for (const forbidden of [
      "private_key",
      "domain_root",
      "plaintext",
      "prompt",
      "model_output",
      "ciphertext",
    ]) {
      expect(migration).not.toContain(forbidden);
    }
  });
});
