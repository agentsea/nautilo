import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import {
  assertCompleteMutationCoverage,
  assertNoMutationSuppression,
  parseMutationManifest,
  selectMutationScopes,
} from "./mutation-governance.ts";
import { selectHostedMutationScope } from "./mutation-hosted.ts";
import {
  mutationGateExitCode,
  runMutationScopes,
  type MutationRevisionIdentity,
  type ScopeExecution,
} from "./mutation-runner.ts";
import {
  deriveMutationSourceInventory,
  derivePackageTypeScriptSourceInventory,
} from
  "./mutation-source-inventory.ts";

const packageRoot = new URL("..", import.meta.url);
const reportsDirectory = new URL("../reports/mutation/", import.meta.url);
const mutationTempDirectory = new URL("../.stryker-tmp/", import.meta.url);
const manifestValue: unknown = await Bun.file(
  new URL("mutation-scopes.json", import.meta.url),
).json();
const ledgerValue: unknown = await Bun.file(
  new URL("mutation-residuals.json", import.meta.url),
).json();
const resolvePackagePath = (path: string): URL =>
  new URL(`../${path}`, import.meta.url);
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

const identity: MutationRevisionIdentity = {
  commit: await readGitOutput(["rev-parse", "HEAD"]),
  dirty: (await readGitOutput([
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ])).length > 0,
};
const requestedScope = process.env["LATTICE_MUTATION_SCOPE_ONLY"];
const hostedScope = process.env["LATTICE_MUTATION_HOSTED_SCOPE"];
if (requestedScope !== undefined && hostedScope !== undefined) {
  throw new Error(
    "local and hosted mutation scope selectors cannot be combined",
  );
}
const selectedScopes = hostedScope === undefined
  ? selectMutationScopes(manifest, {
    requestedScope,
    ci: process.env["CI"],
  })
  : [selectHostedMutationScope(manifest, {
    requestedScope: hostedScope,
    ci: process.env["CI"],
    githubActions: process.env["GITHUB_ACTIONS"],
    githubSha: process.env["GITHUB_SHA"],
    identity,
  })];
const partial = requestedScope !== undefined || hostedScope !== undefined;

async function readRevisionIdentity(): Promise<MutationRevisionIdentity> {
  return {
    commit: await readGitOutput(["rev-parse", "HEAD"]),
    dirty: (await readGitOutput([
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ])).length > 0,
  };
}

await rm(reportsDirectory, { force: true, recursive: true });
await rm(mutationTempDirectory, { force: true, recursive: true });
await mkdir(reportsDirectory, { recursive: true });

const summary = await runMutationScopes({
  manifest,
  selectedScopes,
  ledgerValue,
  identity,
  partial,
}, {
  executeScope: async (execution: ScopeExecution): Promise<number> => {
    process.stdout.write(
      `\n==> Lattice mutation scope: ${execution.scope.name} `
        + `(${execution.scope.mutate.length} targets)\n`,
    );
    const child = Bun.spawn(
      ["bunx", "stryker", "run", "stryker.config.mjs"],
      {
        cwd: packageRoot.pathname,
        env: {
          ...process.env,
          LATTICE_MUTATION_SCOPE: execution.scope.name,
          LATTICE_MUTATION_TARGETS: JSON.stringify(execution.scope.mutate),
          LATTICE_MUTATION_COMMAND: execution.scope.command,
          LATTICE_MUTATION_CONCURRENCY: String(execution.workerBudget),
        },
        stderr: "inherit",
        stdout: "inherit",
      },
    );
    return child.exited;
  },
  readReport: async (scope): Promise<unknown> =>
    Bun.file(
      new URL(`${scope.name}.json`, reportsDirectory),
    ).json(),
  readSource: (path): string =>
    readFileSync(resolvePackagePath(path), "utf8"),
  fileExists: (path): boolean => existsSync(resolvePackagePath(path)),
  readRevisionIdentity,
});

await writeFile(
  new URL(
    hostedScope === undefined
      ? "summary.json"
      : `${hostedScope}.evidence.json`,
    reportsDirectory,
  ),
  `${JSON.stringify(summary, null, 2)}\n`,
);
if (summary.status === "partial") {
  process.stdout.write(
    `\nLattice mutation scope completed: ${summary.completedScopes.length} `
      + "scope; this is partial development evidence, not the full gate.\n",
  );
} else if (summary.policyPassed) {
  process.stdout.write(
    `\nLattice mutation gate passed: ${summary.completedScopes.length} scopes `
      + `at or above ${summary.minimumKilledPercentage}% with complete `
      + "accountability.\n",
  );
}
if (!summary.policyPassed) {
  process.stderr.write(
    `\nLattice mutation gate failed:\n${
      summary.failures.map((failure) => `- ${failure}`).join("\n")
    }\n`,
  );
}
process.exitCode = mutationGateExitCode(summary);
