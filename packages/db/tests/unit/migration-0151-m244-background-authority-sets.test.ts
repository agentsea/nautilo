import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { M244_BACKGROUND_AUTHORITY_SETS_MARKER } from "../../scripts/finalize-m244-background-authority-sets";

const migrations = resolve(import.meta.dirname, "../../src/migrations");
const migrationTag = "0151_striped_terror";
const migration = readFileSync(
  resolve(migrations, `${migrationTag}.sql`),
  "utf8",
);
const journal = JSON.parse(
  readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
) as {
  entries: readonly { idx: number; when: number; tag: string }[];
};
const snapshot = JSON.parse(
  readFileSync(resolve(migrations, "meta/0151_snapshot.json"), "utf8"),
) as {
  tables: Record<string, {
    columns: Record<string, unknown>;
    foreignKeys: Record<string, {
      tableTo: string;
      columnsFrom: readonly string[];
      columnsTo: readonly string[];
      onDelete: string;
    }>;
    compositePrimaryKeys: Record<string, { columns: readonly string[] }>;
    uniqueConstraints: Record<string, { columns: readonly string[] }>;
    policies: Record<string, unknown>;
    checkConstraints: Record<string, { value: string }>;
    isRLSEnabled: boolean;
  }>;
};

const DOMAIN_TABLE =
  "background_crypto_authorization_domain_requirements";
const NAMESPACE_TABLE =
  "background_crypto_authorization_namespace_requirements";

describe("M244 generated background authority-set migration", () => {
  test("records one current monotonic additive migration", () => {
    const entry = journal.entries.find((item) => item.idx === 151);
    const previous = journal.entries.find((item) => item.idx === 150);

    expect(entry).toMatchObject({ idx: 151, tag: migrationTag });
    expect(entry!.when).toBeGreaterThan(previous!.when);
    expect(entry!.when).toBeLessThanOrEqual(Date.now());
    expect(migration).not.toMatch(/\b(?:DROP|TRUNCATE) TABLE\b/i);
    expect(migration).not.toMatch(/^\s*(?:DELETE|UPDATE|INSERT)\b/im);
    expect(migration).not.toMatch(/\bjsonb?\b/i);
  });

  test("adds exact bounded Domain and Namespace authority inventories", () => {
    for (const table of [DOMAIN_TABLE, NAMESPACE_TABLE]) {
      expect(migration).toContain(`CREATE TABLE "${table}"`);
      expect(snapshot.tables[`public.${table}`]).toBeDefined();
      expect(snapshot.tables[`public.${table}`]?.isRLSEnabled).toBe(true);
    }
    expect(
      Object.keys(snapshot.tables[`public.${DOMAIN_TABLE}`]!.columns),
    ).toEqual([
      "request_id",
      "domain_id",
      "ordinal",
      "expected_epoch",
      "expected_agent_authorization_revision",
    ]);
    expect(
      Object.keys(snapshot.tables[`public.${NAMESPACE_TABLE}`]!.columns),
    ).toEqual([
      "request_id",
      "namespace_id",
      "ordinal",
      "domain_id",
      "operation_mask",
      "expected_access_revision",
      "expected_policy_revision",
    ]);
    expect(migration).toContain(
      '"operation_mask" between 1 and 3',
    );
    expect(migration).toMatch(
      /"format_version" = 1 or \([\s\S]*?"format_version" = 2[\s\S]*?"credential_subject_kind" = 'agent'/,
    );
    for (const forbidden of [
      "domain_root",
      "private_key",
      "secret",
      "plaintext",
      "prompt",
      "provider_payload",
      "model_output",
    ]) {
      expect(migration).not.toContain(`"${forbidden}"`);
    }
  });

  test("binds canonical identity and deterministic ordering", () => {
    const domain = snapshot.tables[`public.${DOMAIN_TABLE}`]!;
    const namespace = snapshot.tables[`public.${NAMESPACE_TABLE}`]!;

    expect(
      Object.values(domain.compositePrimaryKeys)[0]?.columns,
    ).toEqual(["request_id", "domain_id"]);
    expect(
      domain.uniqueConstraints["uq_bg_crypto_auth_domain_req_ordinal"]
        ?.columns,
    ).toEqual(["request_id", "ordinal"]);
    expect(domain.foreignKeys).toEqual({});

    expect(
      Object.values(namespace.compositePrimaryKeys)[0]?.columns,
    ).toEqual(["request_id", "namespace_id"]);
    expect(
      namespace.uniqueConstraints["uq_bg_crypto_auth_ns_req_ordinal"]
        ?.columns,
    ).toEqual(["request_id", "ordinal"]);
    expect(namespace.foreignKeys).toEqual({});
  });

  test("forces RLS and grants append-plus-prune crypto-role access", () => {
    expect(migration).toContain(M244_BACKGROUND_AUTHORITY_SETS_MARKER);
    for (const table of [DOMAIN_TABLE, NAMESPACE_TABLE]) {
      expect(migration).toContain(
        `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`,
      );
      expect(migration).toMatch(
        new RegExp(`ALTER TABLE "${table}"\\s+FORCE ROW LEVEL SECURITY`),
      );
      const policyPrefix = table === DOMAIN_TABLE
        ? "bg_crypto_auth_domain_req"
        : "bg_crypto_auth_ns_req";
      expect(Object.keys(
        snapshot.tables[`public.${table}`]!.policies,
      )).toEqual([
        `${policyPrefix}_crypto_sel`,
        `${policyPrefix}_crypto_ins`,
        `${policyPrefix}_crypto_del`,
      ]);
    }
    expect(migration).toContain(
      'FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto"',
    );
    expect(migration).toMatch(
      /GRANT SELECT, INSERT, DELETE ON TABLE[\s\S]+TO "nautilo_crypto"/,
    );
    expect(migration).not.toMatch(/GRANT [^;]*UPDATE/);
  });
});
