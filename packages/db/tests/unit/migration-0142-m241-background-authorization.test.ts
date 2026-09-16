import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  M241_BACKGROUND_AUTHORITY_MARKER,
  M241_JOURNAL_PUBLICATION_AUTHORITY_MARKER,
} from "../../scripts/finalize-m241-background-authorization";

const migrations = resolve(import.meta.dirname, "../../src/migrations");
const migrationTag = "0142_dark_dreadnoughts";
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
  readFileSync(resolve(migrations, "meta/0142_snapshot.json"), "utf8"),
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
    policies: Record<string, unknown>;
    isRLSEnabled: boolean;
  }>;
};

describe("M241 durable background authorization migration", () => {
  test("records one current, monotonic, generated additive migration", () => {
    const entry = journal.entries.find((item) => item.idx === 142);
    const previous = journal.entries.find((item) => item.idx === 141);

    expect(entry).toMatchObject({ idx: 142, tag: migrationTag });
    expect(entry!.when).toBeGreaterThan(previous!.when);
    expect(entry!.when).toBeLessThanOrEqual(Date.now());
    expect(migration).not.toMatch(
      /^\s*(?:DROP|DELETE|UPDATE|INSERT|TRUNCATE|RENAME)\b/im,
    );
    expect(migration).not.toMatch(/\bjsonb?\b/i);
  });

  test("creates strict lifecycle, append-only evidence, and product receipt tables", () => {
    for (const table of [
      "background_crypto_authorization_requests",
      "processor_crypto_signer_authorizations",
      "room_journal_crypto_publications",
    ]) {
      expect(migration).toContain(`CREATE TABLE "${table}"`);
      expect(snapshot.tables[`public.${table}`]).toBeDefined();
    }
    for (const forbidden of [
      "recipient_private_key",
      "signer_private_key",
      "domain_root",
      "plaintext",
      "prompt",
      "model_output",
    ]) {
      expect(migration).not.toContain(`"${forbidden}"`);
    }
    expect(migration).toContain(
      "background_crypto_authorization_requests_subject_coherent",
    );
    expect(migration).toContain(
      "background_crypto_authorization_requests_state_material_coherent",
    );
    expect(migration).toContain(
      "background_crypto_authorization_requests_response_coherent",
    );
    expect(migration).toContain(
      "background_crypto_authorization_requests_terminal_coherent",
    );
    expect(migration).toMatch(
      /background_crypto_authorization_requests_terminal_reason" CHECK[\s\S]*?'malformed_request',\s*'integrity_failure',[\s\S]*?background_crypto_authorization_requests_terminal_coherent/,
    );
    expect(migration).toContain(
      "processor_crypto_signer_authorizations_time_order",
    );
    expect(migration).toContain(
      "room_journal_crypto_publications_publication_coherent",
    );
    expect(migration).toContain(
      "\"output_object_count\" between 0\n        and 5",
    );
    expect(migration).not.toContain("'unknown'");
    expect(migration).toContain(
      "\"accepted_response_kind\" = 'processor'",
    );
    expect(migration).toContain("and 200704");
    expect(migration).toContain(
      "\"accepted_response_kind\" = 'agent'",
    );
    expect(migration).toContain("and 2101248");
    expect(migration).toContain(
      "background_crypto_authorization_requests_recipient_ttl",
    );
    expect(migration).toContain(
      "background_crypto_authorization_requests_authorization_ttl",
    );
  });

  test("forces least-privilege crypto RLS and denies the receipt to non-product roles", () => {
    expect(migration).toContain(M241_BACKGROUND_AUTHORITY_MARKER);
    expect(migration).toContain(
      M241_JOURNAL_PUBLICATION_AUTHORITY_MARKER,
    );
    for (const table of [
      "background_crypto_authorization_requests",
      "processor_crypto_signer_authorizations",
    ]) {
      expect(migration).toContain(
        `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`,
      );
      expect(migration).toMatch(
        new RegExp(
          `ALTER TABLE "${table}"\\s+FORCE ROW LEVEL SECURITY`,
        ),
      );
      expect(snapshot.tables[`public.${table}`]?.isRLSEnabled).toBe(true);
    }
    expect(migration).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE\s+"background_crypto_authorization_requests"\s+TO "nautilo_crypto"/,
    );
    expect(migration).toMatch(
      /GRANT SELECT, INSERT ON TABLE\s+"processor_crypto_signer_authorizations"\s+TO "nautilo_crypto"/,
    );
    expect(migration).toContain(
      'REVOKE ALL PRIVILEGES ON TABLE "room_journal_crypto_publications"\nFROM PUBLIC, "nautilo_agent", "nautilo_crypto"',
    );
    expect(migration).not.toMatch(
      /GRANT [A-Z, ]+ ON TABLE "room_journal_crypto_publications"/,
    );
  });

  test("adds unique no-cascade event and rollup crypto mappings", () => {
    for (const table of ["room_events", "room_event_rollups"]) {
      const tableSnapshot = snapshot.tables[`public.${table}`]!;
      expect(tableSnapshot.columns["crypto_object_id"]).toEqual({
        name: "crypto_object_id",
        type: "text",
        primaryKey: false,
        notNull: false,
      });
      const foreignKey = Object.values(tableSnapshot.foreignKeys).find(
        (value) => value.columnsFrom.includes("crypto_object_id"),
      );
      expect(foreignKey).toMatchObject({
        tableTo: "crypto_objects",
        columnsFrom: ["crypto_object_id"],
        columnsTo: ["object_id"],
        onDelete: "no action",
      });
      expect(
        Object.values(tableSnapshot.uniqueConstraints).some(
          (constraint) =>
            constraint.columns.length === 1
            && constraint.columns[0] === "crypto_object_id",
        ),
      ).toBe(true);
    }
  });

  test("keeps signer history independent of request pruning and binds receipt ownership", () => {
    expect(
      snapshot.tables["public.processor_crypto_signer_authorizations"]
        ?.foreignKeys,
    ).toEqual({});
    expect(
      snapshot.tables["public.room_journal_crypto_publications"]
        ?.foreignKeys[
          "room_journal_crypto_publications_room_namespace_fk"
        ],
    ).toMatchObject({
      tableTo: "rooms",
      columnsFrom: ["room_id", "namespace_id_at_allocation"],
      columnsTo: ["id", "namespace_id"],
      onDelete: "restrict",
    });
    expect(migration).toContain(
      'CONSTRAINT "uq_processor_crypto_signer_authorizations_request_generation" UNIQUE("request_id","recipient_generation")',
    );
    expect(migration).toContain(
      'CONSTRAINT "uq_room_journal_crypto_publications_work_identity" UNIQUE("work_identity_hash")',
    );
  });
});
