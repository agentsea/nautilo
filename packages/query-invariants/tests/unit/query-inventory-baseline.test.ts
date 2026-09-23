import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  auditFullDrizzleSample,
  auditQueryInventory,
  auditReviewedQueryDecisions,
  discoverQueryInventory,
  parseFullDrizzleSample,
  parseQueryInventory,
  parseReviewedQueryDecisions,
} from "../../src/node/query-inventory";

const packageRoot = resolve(import.meta.dir, "../..");
const repositoryRoot = resolve(packageRoot, "../..");
const baselinePath = resolve(packageRoot, "baseline/query-inventory.jsonl");
const addendumPath = resolve(packageRoot, "baseline/query-inventory-addendum.jsonl");
const reviewsPath = resolve(packageRoot, "baseline/reviewed-query-decisions.jsonl");
const fullDrizzleSamplePath = resolve(packageRoot, "baseline/full-drizzle-sample.jsonl");

describe("query inventory baseline", () => {
  test("every discovered direct query has an exact current classification", async () => {
    const baseline = parseQueryInventory(await readFile(baselinePath, "utf8"));
    const addendum = parseQueryInventory(await readFile(addendumPath, "utf8"));
    const expected = {
      ...baseline,
      observations: [...baseline.observations, ...addendum.observations],
    };
    const actual = await discoverQueryInventory(repositoryRoot);
    const audit = auditQueryInventory(expected, actual);

    if (!audit.ok) {
      throw new Error([
        "Query inventory baseline is stale.",
        ...audit.errors,
        "",
        "Review each changed query before regenerating its inventory file.",
      ].join("\n"));
    }
    expect(audit).toMatchObject({ ok: true, added: [], removed: [], changed: [] });

    const reviews = parseReviewedQueryDecisions(await readFile(reviewsPath, "utf8"));
    const reviewAudit = auditReviewedQueryDecisions({ inventory: actual, reviews });
    if (!reviewAudit.ok) {
      throw new Error([
        "Reviewed query decisions are stale.",
        ...reviewAudit.errors,
      ].join("\n"));
    }
    expect(reviewAudit).toMatchObject({ ok: true, added: [], removed: [], changed: [] });

    const sample = parseFullDrizzleSample(await readFile(fullDrizzleSamplePath, "utf8"));
    const sampleAudit = auditFullDrizzleSample({ inventory: actual, sample });
    if (!sampleAudit.ok) {
      throw new Error([
        "Full-Drizzle sample is stale.",
        ...sampleAudit.errors,
      ].join("\n"));
    }
    expect(sampleAudit).toMatchObject({ ok: true, added: [], removed: [], changed: [] });
  // This intentionally scans the complete repository. On CI it runs beside
  // every affected package unit suite, so the same deterministic scan can be
  // CPU-starved well beyond its typical local runtime without being hung.
  }, 180_000);
});
