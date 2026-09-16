import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";

beforeAll(() => {
  bootstrapTestDbInstance();
});

const entrypoint = readFileSync(resolve(import.meta.dir, "../../src/index.ts"), "utf8");

test("media generation runtime is installed before live-gated tools are registered", () => {
  const startAt = entrypoint.indexOf("async function start()");
  const installAt = entrypoint.indexOf("installProductionMediaGenerationRuntime()", startAt);
  const registerAt = entrypoint.indexOf("registerAllTools(catalog)", startAt);
  const initializeAt = entrypoint.indexOf("initToolCatalog(catalog)", startAt);

  expect(startAt).toBeGreaterThan(-1);
  expect(installAt).toBeGreaterThan(startAt);
  expect(registerAt).toBeGreaterThan(installAt);
  expect(initializeAt).toBeGreaterThan(registerAt);
});

test("environment refresh is subscribed after both media clients install", () => {
  const startAt = entrypoint.indexOf("async function start()");
  const runtimeInstallAt = entrypoint.indexOf("installProductionMediaGenerationRuntime()", startAt);
  const workerInstallAt = entrypoint.indexOf("installProductionMediaGenerationWorker()", startAt);
  const subscribeAt = entrypoint.indexOf("subscribeEnvReload(", startAt);

  expect(runtimeInstallAt).toBeGreaterThan(startAt);
  expect(workerInstallAt).toBeGreaterThan(runtimeInstallAt);
  expect(subscribeAt).toBeGreaterThan(workerInstallAt);
});

test("shutdown and failed boot remove the paid admission runtime", () => {
  const signalHandlerAt = entrypoint.indexOf("function setupSignalHandlers");
  const signalUnsubscribeAt = entrypoint.indexOf("stopMediaEnvSubscription?.()", signalHandlerAt);
  const signalResetAt = entrypoint.indexOf("resetProductionMediaGenerationRuntime()", signalHandlerAt);
  const signalDrainAt = entrypoint.indexOf("app.close()", signalHandlerAt);
  const failedBootAt = entrypoint.indexOf("start().catch");
  const failedBootUnsubscribeAt = entrypoint.indexOf("stopMediaEnvSubscription?.()", failedBootAt);
  const failedBootResetAt = entrypoint.indexOf(
    "resetProductionMediaGenerationRuntime()",
    failedBootAt,
  );
  const failedBootExitAt = entrypoint.indexOf("process.exit(1)", failedBootAt);

  expect(signalHandlerAt).toBeGreaterThan(-1);
  expect(signalUnsubscribeAt).toBeGreaterThan(signalHandlerAt);
  expect(signalResetAt).toBeGreaterThan(signalUnsubscribeAt);
  expect(signalDrainAt).toBeGreaterThan(signalResetAt);
  expect(failedBootAt).toBeGreaterThan(signalHandlerAt);
  expect(failedBootUnsubscribeAt).toBeGreaterThan(failedBootAt);
  expect(failedBootResetAt).toBeGreaterThan(failedBootUnsubscribeAt);
  expect(failedBootExitAt).toBeGreaterThan(failedBootResetAt);
});

test("media reconciliation starts only after DB-backed HTTP boot and stops on every shutdown path", () => {
  const startAt = entrypoint.indexOf("async function start()");
  const databaseAt = entrypoint.indexOf("await ensureDatabase", startAt);
  const listenAt = entrypoint.indexOf("await app.listen", startAt);
  const workerInstallAt = entrypoint.indexOf("installProductionMediaGenerationWorker()", startAt);
  const signalHandlerAt = entrypoint.indexOf("function setupSignalHandlers");
  const signalStopAt = entrypoint.indexOf("stopProductionMediaGenerationWorker()", signalHandlerAt);
  const signalDrainAt = entrypoint.indexOf("app.close()", signalHandlerAt);
  const failedBootAt = entrypoint.indexOf("start().catch");
  const failedBootStopAt = entrypoint.indexOf("stopProductionMediaGenerationWorker()", failedBootAt);
  const failedBootExitAt = entrypoint.indexOf("process.exit(1)", failedBootAt);

  expect(databaseAt).toBeGreaterThan(startAt);
  expect(listenAt).toBeGreaterThan(databaseAt);
  expect(workerInstallAt).toBeGreaterThan(listenAt);
  expect(signalStopAt).toBeGreaterThan(signalHandlerAt);
  expect(signalDrainAt).toBeGreaterThan(signalStopAt);
  expect(failedBootStopAt).toBeGreaterThan(failedBootAt);
  expect(failedBootExitAt).toBeGreaterThan(failedBootStopAt);
});
