import { resolve } from "node:path";
import { parseArguments, runPublicInvariantCheck, type PublicCheckDependencies, type PublicCheckOptions } from "../../../limit-invariants/src/node/public-check";
import { discoverQueryInventory } from "./query-inventory";

export const QUERY_POLICY_STATUS_CONTEXT = "query-policy-reviewed";

export function runPublicQueryCheck(options: PublicCheckOptions, dependencies: PublicCheckDependencies = {}) {
  return runPublicInvariantCheck(options, {
    scan: async (root) => (await discoverQueryInventory(root)).observations,
    reviewContext: QUERY_POLICY_STATUS_CONTEXT,
  }, dependencies);
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await runPublicQueryCheck({
      ...parseArguments(process.argv.slice(2)),
      sourceRoot: resolve(import.meta.dir, "../../../.."),
      token: process.env["GITHUB_TOKEN"] ?? "",
    })));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Public query check failed.");
    process.exitCode = 1;
  }
}
