export default {
  mutate: [
    "src/activation.ts",
    "src/model.ts",
    "src/registry.ts",
    "src/report-verification.ts",
    "src/node/activation-inventory-decisions.ts",
    "src/node/dto-declaration-audit.ts",
    "src/node/source-alarm-review.ts",
  ],
  testRunner: "command",
  commandRunner: {
    command: "bun test --timeout 30000 tests/unit tests/property tests/integration/dto-inventory-declarations.test.ts tests/integration/source-alarm-review.test.ts",
  },
  coverageAnalysis: "off",
  concurrency: 4,
  reporters: ["clear-text", "json"],
  jsonReporter: {
    fileName: "reports/mutation/mutation.json",
  },
  thresholds: {
    high: 100,
    low: 100,
    break: 100,
  },
};
