import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditQueryInventory,
  auditReviewedQueryDecisions,
  auditFullDrizzleSample,
  discoverQueryInventory,
  fullDrizzleSampleSummary,
  parseFullDrizzleSample,
  parseQueryInventory,
  parseReviewedQueryDecisions,
  queryInventorySummary,
  reviewedQuerySummary,
  serializeQueryInventory,
} from "./query-inventory";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryRoot = resolve(packageRoot, "../..");
const baselinePath = resolve(packageRoot, "baseline/query-inventory.jsonl");
const addendumPath = resolve(packageRoot, "baseline/query-inventory-addendum.jsonl");
const reviewsPath = resolve(packageRoot, "baseline/reviewed-query-decisions.jsonl");
const fullDrizzleSamplePath = resolve(packageRoot, "baseline/full-drizzle-sample.jsonl");
const mode = process.argv[2];

if (mode !== "--write" && mode !== "--write-addendum" && mode !== "--check") {
  throw new Error("usage: bun src/node/cli.ts --write|--write-addendum|--check");
}

const actual = await discoverQueryInventory(repositoryRoot);
const reviews = parseReviewedQueryDecisions(await readFile(reviewsPath, "utf8"));
const fullDrizzleSample = parseFullDrizzleSample(await readFile(fullDrizzleSamplePath, "utf8"));
if (mode === "--write") {
  await writeFile(baselinePath, serializeQueryInventory(actual), "utf8");
  console.log(`Wrote ${actual.observations.length} query observations to ${baselinePath}`);
  console.log(JSON.stringify(queryInventorySummary(actual), null, 2));
} else if (mode === "--write-addendum") {
  const baseline = parseQueryInventory(await readFile(baselinePath, "utf8"));
  const delta = auditQueryInventory(baseline, actual);
  if (delta.removed.length > 0 || delta.changed.length > 0) {
    throw new Error("Cannot generate an additive inventory while legacy observations changed or disappeared.");
  }
  const added = new Set(delta.added);
  const additions = actual.observations.filter((observation) => added.has(observation.locator));
  await writeFile(addendumPath, serializeQueryInventory({
    schemaVersion: actual.schemaVersion,
    purpose: "Additive query observations alongside the legacy baseline",
    observations: additions,
  }), "utf8");
  console.log(`Wrote ${additions.length} query observations to ${addendumPath}`);
} else {
  const baseline = parseQueryInventory(await readFile(baselinePath, "utf8"));
  const addendum = parseQueryInventory(await readFile(addendumPath, "utf8"));
  const expected = {
    ...baseline,
    observations: [...baseline.observations, ...addendum.observations],
  };
  const audit = auditQueryInventory(expected, actual);
  if (!audit.ok) {
    throw new Error(["Query inventory guard failed.", ...audit.errors].join("\n"));
  }
  console.log(`Query inventory guard passed (${actual.observations.length} observations).`);
  console.log(JSON.stringify(queryInventorySummary(actual), null, 2));
}
const reviewAudit = auditReviewedQueryDecisions({ inventory: actual, reviews });
if (!reviewAudit.ok) {
  throw new Error(["Reviewed query decisions are stale.", ...reviewAudit.errors].join("\n"));
}
console.log("Reviewed query decisions passed.");
const sampleAudit = auditFullDrizzleSample({ inventory: actual, sample: fullDrizzleSample });
if (!sampleAudit.ok) {
  throw new Error(["Full-Drizzle sample is stale.", ...sampleAudit.errors].join("\n"));
}
console.log("Full-Drizzle stratified sample passed.");
console.log(JSON.stringify(fullDrizzleSampleSummary(fullDrizzleSample), null, 2));
console.log("Combined reviewed classification:");
console.log(JSON.stringify(reviewedQuerySummary({
  inventory: actual,
  reviews,
  fullDrizzleSample,
}), null, 2));
