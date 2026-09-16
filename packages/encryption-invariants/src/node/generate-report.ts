import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BASELINE_REGISTRY } from "../../baseline/existing-debt";
import { formatCoverageReport, verifyCoverageReport } from "../report";
import {
  collectRepositoryInventory,
  repositoryReportInput,
  verifyRepositoryInventory,
} from "./repository-inventory";

const repositoryRoot = join(import.meta.dir, "../../../..");
const reportPath = join(import.meta.dir, "../../generated/encryption-coverage.md");
const check = process.argv.includes("--check");
const inventory = await collectRepositoryInventory(repositoryRoot);
const verification = verifyRepositoryInventory(inventory, BASELINE_REGISTRY);

if (!verification.ok) {
  for (const error of verification.errors) console.error(error);
  process.exitCode = 1;
} else {
  const input = repositoryReportInput(inventory, BASELINE_REGISTRY);
  const generated = formatCoverageReport(input);
  if (check) {
    const current = await readFile(reportPath, "utf8").catch(() => "");
    const result = verifyCoverageReport(current, input);
    if (!result.ok) {
      for (const error of result.errors) console.error(error);
      process.exitCode = 1;
    }
  } else {
    await mkdir(join(reportPath, ".."), { recursive: true });
    await writeFile(reportPath, generated, "utf8");
  }
}
