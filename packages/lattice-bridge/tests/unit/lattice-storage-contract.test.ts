import { describe, expect, test } from "bun:test";
import {
  createFakeLatticeStorage,
  LATTICE_STORAGE_METHODS,
  runLatticeStorageContract,
} from "@nautilo/lattice-bridge/testing";

describe("shared LatticeStorage contract", () => {
  test("exercises all 23 methods against the fake reference adapter", async () => {
    const fake = createFakeLatticeStorage();
    const report = await runLatticeStorageContract(fake.storage);

    expect(report.calledMethods).toEqual(LATTICE_STORAGE_METHODS);
    expect(report.calledMethods).toHaveLength(23);
    expect(report.statuses).toEqual({
      domainCreate: "created",
      domainReplay: "existing",
      providerCreate: "inserted",
      providerReplay: "existing",
      providerAdvance: "applied",
      providerDuplicate: "duplicate",
      providerStale: "stale",
      namespaceDuplicate: "duplicate",
      namespaceStale: "stale",
      objectDuplicate: "duplicate",
      objectStale: "stale",
      runtimeCreate: "inserted",
      runtimeReplay: "existing",
      challengeReserve: "applied",
      challengeDuplicate: "duplicate",
      challengeStale: "stale",
      runtimeRotate: "applied",
      runtimeRotateDuplicate: "duplicate",
      runtimeRotateStale: "stale",
      runtimeAuthorizationTransition: "applied",
      runtimeAuthorizationTransitionDuplicate: "duplicate",
      runtimeAuthorizationTransitionStale: "stale",
      recoveryCreate: "applied",
      recoveryReplay: "duplicate",
    });
    expect(report.grant).toEqual({
      beforeConsume: false,
      firstConsume: true,
      secondConsumeMissing: true,
    });
  });
});
