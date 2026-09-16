import { describe, expect, test } from "bun:test";
import * as nautiloSchema from "@nautilo/db/schema";

import {
  REVIEWED_WAVE_11_COVERAGE_ENTRIES,
} from "../../baseline/reviewed-wave-11";
import {
  inventoryDrizzleSchema,
} from "../../src/node/schema-inventory";

const TABLES = new Set([
  "background_crypto_authorization_domain_requirements",
  "background_crypto_authorization_namespace_requirements",
]);

describe("Wave 11 reviewed coverage registry", () => {
  test("classifies both exact authority tables, every column, and all four writers", () => {
    const inventory = inventoryDrizzleSchema(nautiloSchema);
    const observed = [
      ...inventory.objects
        .filter((item) => item.kind === "table" && TABLES.has(item.name))
        .map((item) => item.locator),
      ...inventory.columns
        .filter((item) => TABLES.has(item.objectName))
        .map((item) => item.locator),
    ].sort();
    const declared = REVIEWED_WAVE_11_COVERAGE_ENTRIES
      .filter((entry) => !entry.locator.includes(":raw_sql:"))
      .map((entry) => entry.locator)
      .sort();
    const writers = REVIEWED_WAVE_11_COVERAGE_ENTRIES
      .filter((entry) => entry.locator.includes(":raw_sql:"));

    expect(declared).toEqual(observed);
    expect(declared).toHaveLength(14);
    expect(writers).toHaveLength(4);
    expect(writers.map((entry) => entry.locator)).toEqual([
      "packages/runtime/src/protected-execution/background-authorization/postgres-repository.ts##insertAuthoritySet:raw_sql:insert:public.background_crypto_authorization_domain_requirements:1",
      "packages/runtime/src/protected-execution/background-authorization/postgres-repository.ts#pruneTerminal:raw_sql:delete:public.background_crypto_authorization_domain_requirements:1",
      "packages/runtime/src/protected-execution/background-authorization/postgres-repository.ts##insertAuthoritySet:raw_sql:insert:public.background_crypto_authorization_namespace_requirements:1",
      "packages/runtime/src/protected-execution/background-authorization/postgres-repository.ts#pruneTerminal:raw_sql:delete:public.background_crypto_authorization_namespace_requirements:1",
    ]);
    expect(REVIEWED_WAVE_11_COVERAGE_ENTRIES).toHaveLength(18);
    expect(REVIEWED_WAVE_11_COVERAGE_ENTRIES.every(
      (entry) => entry.classification === "bounded_metadata",
    )).toBeTrue();
    expect(JSON.stringify(REVIEWED_WAVE_11_COVERAGE_ENTRIES)).not.toMatch(
      /aiRoot|private|secret|plaintext_bytes/u,
    );
  });
});
