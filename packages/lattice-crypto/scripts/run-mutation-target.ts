import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import {
  assertCompleteMutationCoverage,
  assertNoMutationSuppression,
  parseMutationManifest,
  selectMutationTarget,
} from "./mutation-governance.ts";
import {
  deriveMutationSourceInventory,
  derivePackageTypeScriptSourceInventory,
} from "./mutation-source-inventory.ts";

const packageRoot = new URL("..", import.meta.url);
const resolvePackagePath = (path: string): URL =>
  new URL(`../${path}`, import.meta.url);
const manifestValue: unknown = await Bun.file(
  new URL("mutation-scopes.json", import.meta.url),
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

const selection = selectMutationTarget(manifest, {
  requestedTarget: process.env["LATTICE_MUTATION_TARGET_ONLY"],
  requestedRange: process.env["LATTICE_MUTATION_RANGE_ONLY"],
  ci: process.env["CI"],
});
const developmentScope = `dev-${selection.scope.name}`;

await rm(new URL("../.stryker-tmp/", import.meta.url), {
  force: true,
  recursive: true,
});
process.stdout.write(
  `\n==> Lattice mutation development target: ${selection.mutatePattern}\n`
    + `    Owning scope tests: ${selection.scope.name}\n`,
);
const child = Bun.spawn(
  ["bunx", "stryker", "run", "stryker.config.mjs"],
  {
    cwd: packageRoot.pathname,
    env: {
      ...process.env,
      LATTICE_MUTATION_SCOPE: developmentScope,
      LATTICE_MUTATION_TARGETS: JSON.stringify([selection.mutatePattern]),
      LATTICE_MUTATION_COMMAND: selection.scope.command,
      LATTICE_MUTATION_CONCURRENCY: String(manifest.perScopeWorkerBudget),
    },
    stderr: "inherit",
    stdout: "inherit",
  },
);
const exitCode = await child.exited;
process.stdout.write(
  "\nThis file/range run is partial development feedback. It cannot satisfy "
    + "the complete mutation assurance gate.\n",
);
process.exitCode = exitCode;
