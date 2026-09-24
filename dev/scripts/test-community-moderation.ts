import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { resolveInstance, resolveNautiloStorageRoot } from "../../packages/config/src/index";
import { classifyProfileAuthority, readProfileInstanceAuthority } from "../../packages/instance-discovery/src/node";
import { buildServerDaemonEnv } from "../../bin/nautilo-dev/src/commands/server-start";
import { isProtectedDurableInstance } from "../../bin/nautilo-dev/src/lib/protected-durable-instance";

const { values } = parseArgs({ options: { integration: { type: "boolean" }, instance: { type: "string" } } });
const root = resolve(import.meta.dir, "../..");
let integrationEnv: NodeJS.ProcessEnv | undefined;
if (values.integration) {
  const instanceId = values.instance?.trim();
  if (!instanceId || ["default", "(default)"].includes(instanceId.toLowerCase())) {
    throw new Error("Integration tests require --instance with an explicitly disposable local test instance.");
  }
  const rootDir = resolveNautiloStorageRoot(homedir(), instanceId);
  const authority = classifyProfileAuthority(instanceId, readProfileInstanceAuthority(homedir()));
  if (!existsSync(resolve(rootDir, "instance.json")) || isProtectedDurableInstance(rootDir, authority)
    || (authority !== null && (authority.classification !== "local" || authority.retention !== "disposable"))) {
    throw new Error("Refusing an absent, protected, remote, or ambiguous integration instance. Provision a separate disposable scratch instance first.");
  }
  process.env["NAUTILO_INSTANCE_ID"] = instanceId;
  integrationEnv = buildServerDaemonEnv({ rootDir, instanceId, inst: resolveInstance() });
  integrationEnv["NAUTILO_TEST_DB_AUTOHEAL"] = "0";
} else if (values.instance) {
  throw new Error("--instance is only used with --integration.");
}

const unitFiles = [
  "packages/trust/tests/unit/moderation-policy.test.ts",
  "packages/trust/tests/unit/moderation-grants.test.ts",
  "packages/trust/tests/unit/action-capability-admission.test.ts",
  "packages/runtime/tests/unit/moderation-work-cancellation.test.ts",
  "packages/runtime/tests/unit/resume-task-approval-auth.test.ts",
  "packages/runtime/tests/unit-isolated/resume-task-research-progress.test.ts",
  "packages/server/tests/unit/moderation-audit.test.ts",
  "packages/server/tests/unit/moderation-event-producer.test.ts",
  "packages/server/tests/unit/moderation-recovery.test.ts",
  "packages/server/tests/unit-isolated/moderation-convergence.test.ts",
  "packages/server/tests/unit-isolated/moderation-routes.test.ts",
  "packages/server/tests/unit-isolated/enrollment-review-routes.test.ts",
  "packages/server/tests/unit-isolated/public-join-route.test.ts",
  "apps/workbench/tests/unit-isolated/enrollment-review-gate.test.tsx",
  "apps/workbench/tests/unit-isolated/moderation-controls.test.tsx",
];
const integrationFiles = [
  "packages/trust/tests/integration/enrollment-review.integration.test.ts",
  "packages/trust/tests/integration/moderation-enrollment-pause.integration.test.ts",
  "packages/trust/tests/integration/invocation-origin-access.integration.test.ts",
  "packages/trust/tests/integration/moderation.integration.test.ts",
  "packages/runtime/tests/integration/moderation-task-stop.integration.test.ts",
  "packages/lattice-bridge/tests/integration/moderation-recipient-authority.integration.test.ts",
  "packages/server/tests/integration/moderation-relay-admission.integration.test.ts",
  "packages/server/tests/integration/moderation-recovery.integration.test.ts",
  "packages/server/tests/integration/moderation-controls-journey.integration.test.ts",
  "packages/server/tests/integration/moderation-message-cleanup.integration.test.ts",
];

// Isolate module mocks and process-global app state, as the package runners do.
for (const [files, env, timeout] of [
  [unitFiles, process.env, "30000"],
  [integrationEnv ? integrationFiles : [], integrationEnv, "120000"],
] as const) {
  for (const file of files) {
    const child = Bun.spawn(["bun", "test", "--preload", "./packages/trust/tests/test-env-preload.ts", "--timeout", timeout, file],
      { cwd: root, env, stdout: "inherit", stderr: "inherit" });
    const status = await child.exited;
    if (status !== 0) process.exit(status);
  }
}
console.log(`Community moderation checks passed (${unitFiles.length} unit files${integrationEnv ? `, ${integrationFiles.length} integration files` : ""}).`);
