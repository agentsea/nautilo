import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const tag = "0229_cloudy_phantom_reporter";
const migration = readFileSync(
  resolve(import.meta.dir, `../../src/migrations/${tag}.sql`),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  resolve(import.meta.dir, "../../src/migrations/meta/_journal.json"),
  "utf8",
)) as { entries: readonly { idx: number; tag: string }[] };

const retiredTables = [
  "namespace_key_envelope_acknowledgements",
  "namespace_key_generation_heads",
  "namespace_key_publication_operations",
  "namespace_key_recipient_authorization_operations",
  "namespace_key_recipient_envelopes",
  "namespace_key_recipient_sync_campaigns",
  "grant_domain_envelope_acknowledgements",
  "grant_domain_heads",
  "grant_domain_publication_operations",
  "grant_domain_recipient_authorization_operations",
  "grant_domain_recipient_envelopes",
  "grant_domain_recipient_sync_campaigns",
  "namespace_grant_domain_bindings",
  "namespace_grant_domain_heads",
] as const;

describe("0229 M306 legacy authority retirement migration", () => {
  test("is the generated journal entry", () => {
    expect(journal.entries.find((entry) => entry.tag === tag))
      .toMatchObject({ idx: 229, tag });
  });

  test("drops every M290 and M291 table", () => {
    for (const table of retiredTables) {
      expect(migration).toContain(`DROP TABLE "${table}" CASCADE`);
    }
  });

  test("narrows persisted turn authority to Domain Key V2", () => {
    expect(migration).toContain(
      'ALTER COLUMN "namespace_authority_scheme" SET DEFAULT \'domain_key_v2\'',
    );
    expect(migration).toContain(
      '"namespace_authority_scheme" = \'domain_key_v2\'',
    );
    for (const retiredScheme of [
      "domain_root_v1",
      "device_wrapped_v1",
      "grant_domain_v1",
    ]) {
      expect(migration).not.toContain(
        `"namespace_authority_scheme" = '${retiredScheme}'`,
      );
    }
  });

  test("preserves the live Domain Key V2 authority tables", () => {
    for (const table of [
      "domain_key_heads",
      "domain_key_recipient_envelopes",
      "namespace_domain_key_bindings",
      "namespace_domain_key_heads",
    ]) {
      expect(migration).not.toContain(`DROP TABLE "${table}"`);
    }
  });
});
