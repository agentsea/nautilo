import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import { BASELINE_REGISTRY } from "../../baseline/existing-debt";
import { REVIEWED_MANUAL_RECOVERY_DTO_DECLARATIONS } from "../../baseline/reviewed-manual-memory-recovery";
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
  test("each recovery route has one reviewed contract matching the discovered wire shape", async () => {
    const observations = await discoverHttpDtoInventory(repositoryRoot);
    const reviewed = [...REVIEWED_MEMORY_REVIEW_DTO_DECLARATIONS, ...REVIEWED_MANUAL_RECOVERY_DTO_DECLARATIONS];
    const locators = new Set(reviewed.map(entry => entry.locator));
    expect(locators.size).toBe(reviewed.length);
    const declarations = DTO_BASELINE_DECLARATIONS.filter((entry) =>
      locators.has(entry.locator)
    );

    expect(declarations).toHaveLength(reviewed.length);
    for (const contract of reviewed) expect(declarations).toContainEqual(contract);
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
