const requestedScopeName = process.env["LATTICE_MUTATION_SCOPE"];
const encodedTargets = process.env["LATTICE_MUTATION_TARGETS"];
const requestedTestCommand = process.env["LATTICE_MUTATION_COMMAND"];
const encodedConcurrency = process.env["LATTICE_MUTATION_CONCURRENCY"];
const hasMutationEnvironment = [
  requestedScopeName,
  encodedTargets,
  requestedTestCommand,
  encodedConcurrency,
].some((value) => value !== undefined);

if (
  hasMutationEnvironment
  && (!requestedScopeName || !/^[a-z0-9-]+$/.test(requestedScopeName))
) {
  throw new Error("LATTICE_MUTATION_SCOPE must be a portable scope name");
}
if (
  hasMutationEnvironment
  && (!encodedTargets || !requestedTestCommand || !encodedConcurrency)
) {
  throw new Error(
    "Lattice mutation targets, command, and concurrency are required",
  );
}
const requestedConcurrency = Number(encodedConcurrency);
if (
  hasMutationEnvironment
  && (!Number.isSafeInteger(requestedConcurrency) || requestedConcurrency < 1)
) {
  throw new Error("LATTICE_MUTATION_CONCURRENCY must be a positive integer");
}

const mutate = encodedTargets
  ? JSON.parse(encodedTargets)
  : ["__LATTICE_MUTATION_ENVIRONMENT_REQUIRED__"];
if (
  !Array.isArray(mutate)
  || mutate.length === 0
  || mutate.some((target) => typeof target !== "string" || target.length === 0)
) {
  throw new Error(
    "LATTICE_MUTATION_TARGETS must encode a non-empty string array",
  );
}

// Repository-wide tools such as Knip import every config file. Keep that
// inspection inert and fail-closed; the only supported mutation entry point
// supplies and validates the complete environment before invoking Stryker.
const scopeName = requestedScopeName ?? "mutation-environment-required";
const testCommand = requestedTestCommand ?? "exit 1";
const concurrency = hasMutationEnvironment ? requestedConcurrency : 1;

export default {
  mutate,
  testRunner: "command",
  commandRunner: {
    command: testCommand,
  },
  coverageAnalysis: "off",
  ignoreStatic: false,
  incremental: false,
  ignorers: [],
  mutator: {
    excludedMutations: [],
  },
  concurrency,
  timeoutMS: 30_000,
  timeoutFactor: 2,
  tempDirName: `.stryker-tmp/${scopeName}`,
  cleanTempDir: "always",
  reporters: ["clear-text", "json"],
  jsonReporter: {
    fileName: `reports/mutation/${scopeName}.json`,
  },
  thresholds: {
    high: 80,
    low: 80,
    break: null,
  },
};
