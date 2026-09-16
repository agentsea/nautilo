import { v2ProviderMatrix } from "../src/testing/v2-matrix.ts";
import { requiredV2Scenarios } from "./v2-scenarios.ts";

function usage(): void {
  console.log("Usage: bun run playground/v2-runner.ts [provider|all] [scenario-id|all]");
  console.log("Providers: all, dummy, ts-mls, openmls");
  console.log("Scenarios:");
  for (const scenario of requiredV2Scenarios) {
    console.log(`  ${String(scenario.id).padStart(2, "0")}  ${scenario.name}`);
  }
}

const [providerArg = "all", scenarioArg = "all"] = process.argv.slice(2);
if (providerArg === "--help" || providerArg === "-h") {
  usage();
  process.exit(0);
}

const providers = providerArg === "all"
  ? v2ProviderMatrix
  : v2ProviderMatrix.filter((row) => row.id === providerArg);
const scenarios = scenarioArg === "all"
  ? requiredV2Scenarios
  : requiredV2Scenarios.filter(
      (scenario) => scenario.id === Number(scenarioArg),
    );

if (providers.length === 0 || scenarios.length === 0) {
  usage();
  process.exit(1);
}

let assertions = 0;
let transitions = 0;
for (const provider of providers) {
  for (const scenario of scenarios) {
    const result = await scenario.run(provider);
    assertions += result.assertions;
    transitions += result.providerTransitions;
    console.log(
      `PASS ${provider.id.padEnd(7)} #${String(scenario.id).padStart(2, "0")} ${scenario.name}`
      + ` (${result.assertions} checks, ${result.providerTransitions} provider transition)`,
    );
  }
}
console.log(
  `PASS ${providers.length * scenarios.length} rows; ${assertions} checks; ${transitions} provider transitions`,
);
