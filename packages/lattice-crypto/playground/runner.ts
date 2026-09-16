/**
 * Playground runner — argument-driven.
 *
 *   bun run play                       # every scenario x every config
 *   bun run play mls+enumeration       # all scenarios, real-MLS config
 *   bun run play mls+enumeration multiuser
 *   bun run play all basic
 *   bun run play --help
 *
 * First arg = config (matrix row name) or "all". Second arg = scenario name or
 * "all". Not a test — a fast way to eyeball behavior while iterating.
 */
import { matrix } from "../src/testing/matrix.ts";
import { scenarios } from "./scenarios.ts";

function printUsage(): void {
  console.log("Usage: bun run play [config|all] [scenario|all]\n");
  console.log("Configs:");
  console.log("  all");
  for (const c of matrix) console.log(`  ${c.name}`);
  console.log("\nScenarios:");
  console.log("  all");
  for (const [name, s] of Object.entries(scenarios)) {
    console.log(`  ${name.padEnd(12)} ${s.description}`);
  }
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  printUsage();
  process.exit(0);
}

const configArg = args[0] ?? "all";
const scenarioArg = args[1] ?? "all";

const configs = configArg === "all" ? matrix : matrix.filter((c) => c.name === configArg);
if (configs.length === 0) {
  console.error(`Unknown config "${configArg}".\n`);
  printUsage();
  process.exit(1);
}

const scenarioNames = scenarioArg === "all" ? Object.keys(scenarios) : [scenarioArg];
for (const name of scenarioNames) {
  if (!scenarios[name]) {
    console.error(`Unknown scenario "${name}".\n`);
    printUsage();
    process.exit(1);
  }
}

for (const config of configs) {
  console.log(`\n######## config: ${config.name} ########`);
  for (const name of scenarioNames) {
    const scenario = scenarios[name]!;
    console.log(`\n=== ${name} — ${scenario.description} ===`);
    await scenario.run(config);
  }
}

console.log("\ndone.");
