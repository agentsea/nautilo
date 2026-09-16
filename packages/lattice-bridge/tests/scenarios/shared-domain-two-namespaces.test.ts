import { describe, expect, test } from "bun:test";
import {
  createFakeLatticeStorage,
  runSyntheticSharedDomainScenario,
} from "@nautilo/lattice-bridge/testing";

describe("synthetic shared Domain across stable Namespaces", () => {
  test("keeps two Namespace object histories separate under one Alice/Bob Domain", async () => {
    const fake = createFakeLatticeStorage();
    const report = await runSyntheticSharedDomainScenario(fake.storage);

    expect(report.domain.firstStatus).toBe("created");
    expect(report.domain.secondStatus).toBe("existing");
    expect(report.domain.firstId).toBe(report.domain.secondId);
    expect(report.domain.participants).toEqual([
      "00000000-0000-4000-8000-00000000000a",
      "00000000-0000-4000-8000-00000000000b",
    ]);
    expect(report.namespaces).toEqual([
      "10000000-0000-4000-8000-000000000001",
      "10000000-0000-4000-8000-000000000002",
    ]);
    expect(report.bindingStatuses).toEqual(["applied", "applied"]);
    expect(report.correctDecryptions).toEqual([
      "synthetic namespace one",
      "synthetic namespace two",
    ]);
    expect(report.crossNamespaceRejected).toBe(true);
    expect(report.persistedAccessNamespaces).toEqual([
      ["10000000-0000-4000-8000-000000000001"],
      ["10000000-0000-4000-8000-000000000002"],
    ]);
  });
});
