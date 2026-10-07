import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../..");

// Native Windows qualification for local Server and Desktop source builds.
// POSIX deployment/recovery qualification remains in the full Linux CI gate.
const packageChecks = [
  ["packages/api-client", "test:unit"],
  ["packages/db", "test:unit"],
  ["packages/trust", "test:unit"],
  ["packages/first-party-apps/writer", "test"],
  ["packages/first-party-apps/video", "test"],
] as const;

const sourceTests = [
  "apps/desktop/tests/unit/windows-package-contract.test.ts",
  "apps/desktop/tests/unit/bun-vendor-cache.test.ts",
  "apps/desktop/tests/unit/relay-binary-resolution.test.ts",
  "apps/desktop/tests/unit/desktop-license-payload.test.ts",
  "dev/tests/repo-invariants/test-first-party-app-production-install.test.ts",
  "packages/server/tests/unit/seed-first-party-apps.test.ts",
  "packages/server/tests/unit/runtime-dependency-snapshot.test.ts",
  "packages/db/tests/unit/moderation-migration-privileges.test.ts",
  "packages/document-mutations/tests/unit/coordinator.test.ts",
  "packages/runtime/tests/unit/conversation-composition.test.ts",
  "packages/lattice-crypto/tests/unit/mutation-governance.test.ts",
  "apps/cli/tests/unit/cloudflare-r2-oauth-probe.test.ts",
  "apps/workbench/src/modes/rooms/explorer/tests/explorer-grouping.test.ts",
  "apps/workbench/tests/unit-isolated/terminal-co-driving-consent.test.tsx",
  "apps/workbench/tests/unit-isolated/maintenance-applying-gate.test.tsx",
  "apps/workbench/tests/unit-isolated/maintenance-applying-boundary.test.tsx",
  "scripts/stack309-ios-simulator-input-helper.test.ts",
  "bin/nautilo-dev/tests/unit/agent-browser-preflight.test.ts",
  "bin/nautilo-dev/tests/unit/migrate-add-agent-role.test.ts",
  "bin/nautilo-dev/tests/unit/bootstrap-claim-invite.test.ts",
  "apps/desktop/tests/unit-isolated/relay-sidecar-client.test.ts",
  "packages/server/tests/unit/connected-web-account-direct-browser-harness.test.ts",
  "packages/server/tests/unit/agent-browser-server-vendor.test.ts",
  "packaging/openconnector/provenance.test.ts",
] as const;

function run(args: string[]): void {
  console.log(`[windows-unit] bun ${args.join(" ")}`);
  const result = spawnSync(process.execPath, args, {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

for (const [workspace, script] of packageChecks) {
  run(["run", "--cwd", workspace, script]);
}
// DOM/mock suites use separate processes, matching their package boundaries.
for (const path of sourceTests) {
  run(["test", "--timeout", "60000", path]);
}
