import { describe, expect, test } from "bun:test";
import { resetTestCruft, TEST_CRUFT_INSTANCE_ID } from "../../src/commands/reset-test-cruft";

describe("reset-test-cruft", () => {
  test("refuses without --yes before touching instance state", async () => {
    let deleted = false;
    let started = false;

    const code = await resetTestCruft(
      { yes: false },
      {
        deleteInstanceImpl: async () => {
          deleted = true;
          return 0;
        },
        infraStartImpl: async () => {
          started = true;
          return 0;
        },
      },
    );

    expect(code).toBe(1);
    expect(deleted).toBe(false);
    expect(started).toBe(false);
  });

  test("deletes test-cruft then recreates it with scoped NAUTILO_INSTANCE_ID", async () => {
    const env = { HOME: "/synthetic-home", NAUTILO_INSTANCE_ID: "caller-instance" } as NodeJS.ProcessEnv;
    const calls: string[] = [];

    const code = await resetTestCruft(
      { yes: true },
      {
        env,
        log: (msg) => calls.push(msg),
        deleteInstanceImpl: async (opts) => {
          expect(opts).toEqual({ id: TEST_CRUFT_INSTANCE_ID, yes: true });
          calls.push("delete");
          expect(env["NAUTILO_INSTANCE_ID"]).toBe("caller-instance");
          return 0;
        },
        infraStartImpl: async () => {
          calls.push("infra-start");
          expect(env["NAUTILO_INSTANCE_ID"]).toBe(TEST_CRUFT_INSTANCE_ID);
          return 0;
        },
        persistDisposableRetention: (home, id, retention) => {
          expect({ home, id, retention }).toEqual({ home: "/synthetic-home", id: TEST_CRUFT_INSTANCE_ID, retention: "disposable" });
          calls.push("retention");
        },
      },
    );

    expect(code).toBe(0);
    expect(calls).toContain("delete");
    expect(calls).toContain("infra-start");
    expect(calls).toContain("retention");
    expect(env["NAUTILO_INSTANCE_ID"]).toBe("caller-instance");
  });

  test("aborts recreate when delete-instance fails", async () => {
    let started = false;

    const code = await resetTestCruft(
      { yes: true },
      {
        deleteInstanceImpl: async () => 7,
        infraStartImpl: async () => {
          started = true;
          return 0;
        },
      },
    );

    expect(code).toBe(7);
    expect(started).toBe(false);
  });
});
