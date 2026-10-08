import { resolve } from "node:path";
import { verifyGitHubCliDistribution } from "./github-cli-distribution";

if (import.meta.main) {
  const root = process.argv[2];
  if (!root || ![3, 5].includes(process.argv.length) || (process.argv.length === 5 && process.argv[3] !== "--signed")) throw new Error("usage: verify-github-cli.ts <runtime-directory> [--signed <Nautilo.app>]");
  verifyGitHubCliDistribution(resolve(root), process.argv[4] ? resolve(process.argv[4]) : undefined);
  console.log("[github-cli] verified pinned runtime, license and requested package provenance");
}
