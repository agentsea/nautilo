import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";

beforeAll(() => {
  bootstrapTestDbInstance();
});

const entrypoint = readFileSync(resolve(import.meta.dir, "../../src/index.ts"), "utf8");

test("Computer Use catalogue hydration settles before tool registration", () => {
  const startAt = entrypoint.indexOf("async function start()");
  const hydrateAt = entrypoint.indexOf("await hydrateRuntimeComputerUseContractCatalogue()", startAt);
  const registerAt = entrypoint.indexOf("registerAllTools(catalog)", startAt);
  expect(startAt).toBeGreaterThan(-1);
  expect(hydrateAt).toBeGreaterThan(startAt);
  expect(registerAt).toBeGreaterThan(hydrateAt);
});

test("boot provenance names exact source, version, digest, and staleness", () => {
  expect(entrypoint).toContain("source=${computerUseCatalogue.source}");
  expect(entrypoint).toContain("version=${computerUseCatalogue.catalogueVersion}");
  expect(entrypoint).toContain("sha256=${computerUseCatalogue.artifactSha256}");
  expect(entrypoint).toContain("stale=${computerUseCatalogue.stale}");
});

test("signed catalogue refreshes reconcile the generic tool surface after boot", () => {
  const startAt = entrypoint.indexOf("async function start()");
  const initializeAt = entrypoint.indexOf("initToolCatalog(catalog)", startAt);
  const refreshLoopAt = entrypoint.indexOf(
    "startRuntimeComputerUseContractCatalogueRefreshLoop",
    initializeAt,
  );
  const reconcileAt = entrypoint.indexOf("reconcileComputerUseHostTools(catalog)", refreshLoopAt);
  expect(refreshLoopAt).toBeGreaterThan(initializeAt);
  expect(reconcileAt).toBeGreaterThan(refreshLoopAt);
  expect(entrypoint).toContain("contractsChanged=${contractsChanged}");
});

test("every server shutdown path stops Computer Use catalogue refreshes", () => {
  const signalHandlerAt = entrypoint.indexOf("function setupSignalHandlers");
  const signalStopAt = entrypoint.indexOf(
    "stopRuntimeComputerUseContractCatalogueRefreshLoop()",
    signalHandlerAt,
  );
  const failedBootAt = entrypoint.indexOf("start().catch");
  const failedBootStopAt = entrypoint.indexOf(
    "stopRuntimeComputerUseContractCatalogueRefreshLoop()",
    failedBootAt,
  );
  expect(signalStopAt).toBeGreaterThan(signalHandlerAt);
  expect(failedBootStopAt).toBeGreaterThan(failedBootAt);
});
