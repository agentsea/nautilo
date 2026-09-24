import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  auditFullDrizzleSample,
  auditReviewedQueryDecisions,
  parseFullDrizzleSample,
  parseQueryInventory,
  parseReviewedQueryDecisions,
} from "../../src/node/query-inventory";

const packageRoot = resolve(import.meta.dir, "../..");
const baselinePath = resolve(packageRoot, "baseline/query-inventory.jsonl");
const addendumPath = resolve(packageRoot, "baseline/query-inventory-addendum.jsonl");
const reviewsPath = resolve(packageRoot, "baseline/reviewed-query-decisions.jsonl");
const fullDrizzleSamplePath = resolve(packageRoot, "baseline/full-drizzle-sample.jsonl");

describe("historical query review seed compatibility", () => {
  // Current-source drift is checked by strict local review and exact-head CI.
  // Public checkout tests cannot require unpublished current review evidence.
  test("retained seed files remain internally consistent for local bootstrapping", async () => {
    const baseline = parseQueryInventory(await readFile(baselinePath, "utf8"));
    const addendum = parseQueryInventory(await readFile(addendumPath, "utf8"));
    const expected = {
      ...baseline,
      observations: [...baseline.observations, ...addendum.observations],
    };
    const reviews = parseReviewedQueryDecisions(await readFile(reviewsPath, "utf8"));
    const reviewAudit = auditReviewedQueryDecisions({ inventory: expected, reviews });
    if (!reviewAudit.ok) {
      throw new Error([
        "Reviewed query decisions are stale.",
        ...reviewAudit.errors,
      ].join("\n"));
    }
    expect(reviewAudit).toMatchObject({ ok: true, added: [], removed: [], changed: [] });

    const sample = parseFullDrizzleSample(await readFile(fullDrizzleSamplePath, "utf8"));
    const sampleAudit = auditFullDrizzleSample({ inventory: expected, sample });
    if (!sampleAudit.ok) {
      throw new Error([
        "Full-Drizzle sample is stale.",
        ...sampleAudit.errors,
      ].join("\n"));
    }
    expect(sampleAudit).toMatchObject({ ok: true, added: [], removed: [], changed: [] });
  });
});
