import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import {
  assertCompleteMutationCoverage,
  assertNoMutationSuppression,
  parseMutationManifest,
} from "./mutation-governance.ts";
import {
  aggregateAvailableHostedMutationEvidence,
  aggregateHostedMutationEvidence,
  collectHostedMutationArtifacts,
  createHostedMutationFailureEvidence,
} from "./mutation-hosted.ts";
import {
  mutationGateExitCode,
  type MutationEvidenceSummary,
} from "./mutation-runner.ts";
import {
  deriveMutationSourceInventory,
  derivePackageTypeScriptSourceInventory,
} from "./mutation-source-inventory.ts";

const packageRoot = new URL("..", import.meta.url);
const reportsDirectory = new URL("../reports/mutation/", import.meta.url);
const resolvePackagePath = (path: string): URL =>
  new URL(`../${path}`, import.meta.url);
const manifestValue: unknown = await Bun.file(
  new URL("mutation-scopes.json", import.meta.url),
).json();
const ledgerValue: unknown = await Bun.file(
  new URL("mutation-residuals.json", import.meta.url),
).json();
const manifest = parseMutationManifest(manifestValue, {
  fileExists: (path) => existsSync(resolvePackagePath(path)),
});
assertCompleteMutationCoverage(
  manifest,
  deriveMutationSourceInventory(packageRoot.pathname),
);
assertNoMutationSuppression(
  derivePackageTypeScriptSourceInventory(packageRoot.pathname).map((path) => ({
    path,
    source: readFileSync(resolvePackagePath(path), "utf8"),
  })),
);

async function readGitOutput(arguments_: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", ...arguments_], {
    cwd: packageRoot.pathname,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `git ${arguments_.join(" ")} failed: ${stderr.trim()}`,
    );
  }
  return stdout.trim();
}

const identity = {
  commit: await readGitOutput(["rev-parse", "HEAD"]),
  dirty: (await readGitOutput([
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ])).length > 0,
};
if (
  process.env["CI"] !== "true"
  || process.env["GITHUB_ACTIONS"] !== "true"
  || process.env["GITHUB_SHA"] !== identity.commit
) {
  throw new Error(
    "hosted mutation aggregation requires the exact GitHub Actions revision",
  );
}

async function readUnknownJson(url: URL): Promise<unknown> {
  return JSON.parse(await Bun.file(url).text()) as unknown;
}

const dependencies = {
  readSource: (path: string): string =>
    readFileSync(resolvePackagePath(path), "utf8"),
  fileExists: (path: string): boolean => existsSync(resolvePackagePath(path)),
};
const collected = await collectHostedMutationArtifacts(
  manifest,
  (fileName) => readUnknownJson(new URL(fileName, reportsDirectory)),
);
const artifacts = collected.artifacts;
let summary: MutationEvidenceSummary;
try {
  if (collected.failures.length > 0) {
    summary = aggregateAvailableHostedMutationEvidence({
      manifest,
      ledgerValue,
      identity,
      artifacts,
      failures: collected.failures,
    }, dependencies);
  } else {
    summary = aggregateHostedMutationEvidence({
      manifest,
      ledgerValue,
      identity,
      artifacts,
    }, dependencies);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  summary = createHostedMutationFailureEvidence({
    manifest,
    identity,
    completedScopes: artifacts.map((artifact) => artifact.scopeName),
    failure: `hosted mutation aggregation failed: ${message}`,
  }, dependencies);
}
await writeFile(
  new URL("summary.json", reportsDirectory),
  `${JSON.stringify(summary, null, 2)}\n`,
);

if (summary.policyPassed) {
  process.stdout.write(
    `Lattice mutation aggregate passed: ${summary.completedScopes.length} `
      + `scopes, ${summary.maximumHostedWorkers} maximum hosted workers.\n`,
  );
} else {
  process.stderr.write(
    `Lattice mutation aggregate failed:\n${
      summary.failures.map((failure) => `- ${failure}`).join("\n")
    }\n`,
  );
}
process.exitCode = mutationGateExitCode(summary);
