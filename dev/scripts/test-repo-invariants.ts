import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const testRoot = join(repositoryRoot, "dev/tests/repo-invariants");

// Bun 1.3.11 can crash during the combined Windows invariant run. Keep every
// assertion, but release each file's runtime state before loading the next one.
const suites = process.platform === "win32"
  ? [...new Bun.Glob("**/*{.test,_test,.spec,_spec}.{js,jsx,ts,tsx,mjs,mts,cjs,cts}")
    .scanSync({ cwd: testRoot, absolute: true, onlyFiles: true })].sort()
  : [testRoot];

if (suites.length === 0) throw new Error("No repository invariant test files found");

for (const suite of suites) {
  console.log(`[repo-invariants] ${relative(repositoryRoot, suite)}`);
  const result = spawnSync(process.execPath, ["test", ...process.argv.slice(2), suite], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
