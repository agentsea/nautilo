import { listPackage } from "@electron/asar";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { inspectPackageInventory } from "./package-inventory-policy";

function fail(message: string): never {
  console.error(`[package-inventory] ${message}`);
  process.exit(1);
}

const input = process.argv[2];
if (input === undefined) {
  fail("usage: bun run verify:package-inventory -- <path-to-app.asar>");
}

const archivePath = resolve(input);
if (!existsSync(archivePath)) {
  fail(`archive does not exist: ${archivePath}`);
}

const report = inspectPackageInventory(listPackage(archivePath, { isPack: false }));
const rootSummary = [...report.rootCounts]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([root, count]) => `${root}=${count}`)
  .join(", ");

console.log(`[package-inventory] checked ${report.entries.length} archive entries (${rootSummary})`);

if (report.violations.length > 0) {
  const preview = report.violations
    .slice(0, 50)
    .map(({ path, reason }) => `  - ${path}: ${reason}`)
    .join("\n");
  const omitted = report.violations.length > 50
    ? `\n  ... ${report.violations.length - 50} more violation(s)`
    : "";
  fail(`${report.violations.length} disallowed or missing path(s):\n${preview}${omitted}`);
}

console.log("[package-inventory] PASS: archive matches the production package policy");
