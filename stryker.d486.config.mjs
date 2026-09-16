/** Targeted D486 mutation gate for the Electron-owned authority boundary. */
export default {
  mutate: [
    "apps/desktop/electron/workstation-shell-consent-store.ts:83-142",
    "apps/desktop/electron/workstation-shell-consent-store.ts:184-244",
    "apps/desktop/electron/workstation-shell-consent-store.ts:269-335",
    "apps/desktop/electron/workstation-shell-host.ts:66-145",
    "apps/desktop/electron/workstation-shell-host.ts:147-229",
    "apps/desktop/electron/workstation-shell-host.ts:300-357",
    "packages/trust/src/workstation-admission.ts:227-243",
    "packages/server/src/workstation-execution-class.ts",
    "apps/desktop/electron/relay.ts:1415-1424",
    "packages/security/src/content-scanner.ts:38-42",
  ],
  ignorePatterns: [
    "apps/desktop/release/**",
    "apps/desktop/dist-electron/**",
    "apps/workbench/dist/**",
  ],
  testRunner: "command",
  commandRunner: {
    command:
      "bun test --timeout 10000 apps/desktop/tests/unit/workstation-shell-consent-store.test.ts apps/desktop/tests/unit/workstation-shell-host.test.ts packages/trust/tests/unit/workstation-admission.test.ts packages/server/tests/unit/workstation-execution-class.test.ts apps/desktop/tests/unit-isolated/relay-workstation-shell-binding.test.ts packages/security/tests/unit/content-scanner.test.ts",
  },
  coverageAnalysis: "off",
  // This gate proves authority predicates and lifecycle branches. User-facing
  // copy is asserted directly in component/skill tests and is not a security
  // mutation target.
  mutator: {
    excludedMutations: ["StringLiteral"],
  },
  concurrency: 2,
  timeoutMS: 15_000,
  reporters: ["clear-text", "progress"],
  thresholds: {
    high: 90,
    low: 80,
    break: 80,
  },
  tempDirName: ".stryker-tmp",
};
