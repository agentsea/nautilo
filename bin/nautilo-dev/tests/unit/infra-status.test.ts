/**
 * M051: pure-format contract for `nautilo-dev infra-status`. The status
 * table's labels are how operators answer "is everything I need running?"
 * at a glance — they should NOT silently drift.
 */
import { describe, expect, test } from "bun:test";
import {
  describeState,
  formatRow,
  type ContainerStatus,
} from "../../src/commands/infra-status";

const base: Omit<ContainerStatus, "state" | "health" | "name"> = {
  role: "test container",
};

describe("describeState", () => {
  test("running + healthy → OK", () => {
    expect(
      describeState({
        ...base,
        name: "nautilo-postgres-1",
        state: "running",
        health: "healthy",
      }),
    ).toBe("OK");
  });

  test("running + n/a (no healthcheck declared) → OK", () => {
    expect(
      describeState({
        ...base,
        name: "nautilo-logto-1",
        state: "running",
        health: "n/a",
      }),
    ).toBe("OK");
  });

  test("exited + seeder name → OK (seeded)", () => {
    expect(
      describeState({
        ...base,
        name: "nautilo-logto-seed-1",
        state: "exited",
        health: "n/a",
      }),
    ).toBe("OK (seeded)");
  });

  test("exited + non-seeder name → exited/<health>", () => {
    expect(
      describeState({
        ...base,
        name: "nautilo-logto-1",
        state: "exited",
        health: "n/a",
      }),
    ).toBe("exited/n/a");
  });

  test("missing → —", () => {
    expect(
      describeState({
        ...base,
        name: "nautilo-postgres-1",
        state: "missing",
        health: "—",
      }),
    ).toBe("—");
  });

  test("running + unhealthy → running/unhealthy (operator diagnostic)", () => {
    expect(
      describeState({
        ...base,
        name: "nautilo-postgres",
        state: "running",
        health: "unhealthy",
      }),
    ).toBe("running/unhealthy");
  });
});

describe("formatRow", () => {
  test("includes name, state-label, and role", () => {
    const row = formatRow({
      ...base,
      name: "nautilo-postgres",
      role: "legacy DB",
      state: "running",
      health: "healthy",
    });
    expect(row).toContain("nautilo-postgres");
    expect(row).toContain("OK");
    expect(row).toContain("legacy DB");
  });
});
