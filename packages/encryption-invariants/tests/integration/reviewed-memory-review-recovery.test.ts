import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import { BASELINE_REGISTRY } from "../../baseline/existing-debt";
import {
  REVIEWED_MEMORY_REVIEW_DTO_DECLARATIONS,
  REVIEWED_MEMORY_REVIEW_RECOVERY_COVERAGE,
} from "../../baseline/reviewed-memory-review-recovery";
import {
  auditDtoDeclarations,
  discoverHttpDtoInventory,
} from "../../src/node/dto-inventory";

const repositoryRoot = resolve(import.meta.dir, "../../../..");

describe("Memory review operator recovery inventory", () => {
  test("pins the exact recovery and Stenographer response contracts", async () => {
    const observations = await discoverHttpDtoInventory(repositoryRoot);
    const locators = new Set(
      REVIEWED_MEMORY_REVIEW_DTO_DECLARATIONS.map((entry) => entry.locator),
    );
    const declarations = DTO_BASELINE_DECLARATIONS.filter((entry) =>
      locators.has(entry.locator)
    );

    expect(declarations).toEqual([...REVIEWED_MEMORY_REVIEW_DTO_DECLARATIONS]);
    expect(auditDtoDeclarations({
      observations: observations.filter((entry) => locators.has(entry.locator)),
      declarations,
    })).toMatchObject({ ok: true });
  });

  test("classifies only content-free server recovery coordinates", () => {
    for (const entry of REVIEWED_MEMORY_REVIEW_RECOVERY_COVERAGE) {
      expect(BASELINE_REGISTRY.entries).toContainEqual(entry);
      expect(entry.classification).toBe("bounded_metadata");
    }

    const migration = readFileSync(
      resolve(
        repositoryRoot,
        "packages/db/src/migrations/0387_eminent_absorbing_man.sql",
      ),
      "utf8",
    );
    expect(migration).not.toContain("nautilo_agent");
  });
});
