import { describe, expect, test } from "bun:test";
import {
  cryptoDomainId,
  domainEpoch,
  authorizationRevision,
  humanId,
  participantDigest,
} from "@nautilo/lattice-crypto";
import {
  createFakeLatticeStorage,
  FakeLatticeCommitOutcomeUnknown,
} from "@nautilo/lattice-bridge/testing";

const domain = {
  id: cryptoDomainId("domain-fixture"),
  participants: ["human-alice"],
  participantDigest: participantDigest([humanId("human-alice")]),
  epoch: domainEpoch(0),
  authorizationRevision: authorizationRevision(0),
  rosterBytes: new Uint8Array([1, 2, 3]),
};

describe("fake lattice storage", () => {
  test("delegates the complete storage contract to the core reference store", async () => {
    const fake = createFakeLatticeStorage();
    expect(await fake.storage.createDomainIfAbsent(domain)).toEqual({
      status: "created",
      domain,
    });
    expect(
      await fake.storage.findDomain(
        domain.participantDigest,
        domain.participants,
      ),
    ).toEqual(domain);
    expect(await fake.storage.createDomainIfAbsent(domain)).toEqual({
      status: "existing",
      domain,
    });
  });

  test("bounds fault queues and consumes a conflict exactly once", async () => {
    const fake = createFakeLatticeStorage({ maximumPendingFaults: 1 });
    fake.faults.enqueue({
      operation: "createDomainIfAbsent",
      outcome: "conflict",
    });
    expect(() =>
      fake.faults.enqueue({
        operation: "createDomainIfAbsent",
        outcome: "conflict",
      })
    ).toThrow("fault queue is full");
    expect(fake.storage.createDomainIfAbsent(domain)).rejects.toThrow(
      "injected conflict",
    );
    expect(await fake.storage.createDomainIfAbsent(domain)).toEqual({
      status: "created",
      domain,
    });
  });

  test("can expose an unknown commit outcome without undoing committed state", async () => {
    const fake = createFakeLatticeStorage();
    fake.faults.enqueue({
      operation: "createDomainIfAbsent",
      outcome: "unknown-after-commit",
    });
    expect(fake.storage.createDomainIfAbsent(domain)).rejects.toBeInstanceOf(
      FakeLatticeCommitOutcomeUnknown,
    );
    expect(
      await fake.storage.findDomain(
        domain.participantDigest,
        domain.participants,
      ),
    ).toEqual(domain);
  });

  test("rejects status injection for operations without that status", () => {
    const fake = createFakeLatticeStorage();
    expect(() =>
      fake.faults.enqueue({
        operation: "getObject",
        outcome: "stale",
      })
    ).toThrow("does not support stale injection");
  });
});
