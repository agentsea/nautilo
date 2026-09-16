import { describe, expect, test } from "bun:test";
import {
  isKnownFixtureAgentHandle,
  isZeroFootprintFixtureOrphanAgent,
  type OrphanAgentFootprint,
} from "../../src/commands/cleanup-test-cruft";

const ZERO: OrphanAgentFootprint = {
  actorCount: 0,
  sessionCount: 0,
  profileCount: 0,
  roomMembershipCount: 0,
};

describe("cleanup-test-cruft post-M128 orphan agent predicate", () => {
  test("recognizes known fixture agent handle prefixes", () => {
    expect(isKnownFixtureAgentHandle("undo-turn-e2e-abc")).toBe(true);
    expect(isKnownFixtureAgentHandle("fk-invariant-123")).toBe(true);
    expect(isKnownFixtureAgentHandle("backup-e2e-xyz")).toBe(true);
    expect(isKnownFixtureAgentHandle("find-agent-smoke")).toBe(true);
    expect(isKnownFixtureAgentHandle("jeannie-test-local")).toBe(true);
    expect(isKnownFixtureAgentHandle("m088c-fam-ag-one")).toBe(true);
  });

  test("does not treat real or unknown no-mirror agents as cleanup candidates", () => {
    expect(isKnownFixtureAgentHandle("jeannie")).toBe(false);
    expect(isZeroFootprintFixtureOrphanAgent("jeannie", ZERO)).toBe(false);
    expect(isZeroFootprintFixtureOrphanAgent("genie_user_a", ZERO)).toBe(false);
    expect(isZeroFootprintFixtureOrphanAgent(null, ZERO)).toBe(false);
  });

  test("deletes only known fixture orphan agents with zero footprint", () => {
    expect(isZeroFootprintFixtureOrphanAgent("fk-invariant-123", ZERO)).toBe(true);
    expect(isZeroFootprintFixtureOrphanAgent("undo-turn-e2e-abc", ZERO)).toBe(true);
  });

  test("preserves known fixture agents with any footprint", () => {
    expect(
      isZeroFootprintFixtureOrphanAgent("fk-invariant-123", {
        ...ZERO,
        sessionCount: 1,
      }),
    ).toBe(false);
    expect(
      isZeroFootprintFixtureOrphanAgent("fk-invariant-123", {
        ...ZERO,
        profileCount: 1,
      }),
    ).toBe(false);
    expect(
      isZeroFootprintFixtureOrphanAgent("fk-invariant-123", {
        ...ZERO,
        actorCount: 1,
      }),
    ).toBe(false);
    expect(
      isZeroFootprintFixtureOrphanAgent("fk-invariant-123", {
        ...ZERO,
        roomMembershipCount: 1,
      }),
    ).toBe(false);
  });
});
