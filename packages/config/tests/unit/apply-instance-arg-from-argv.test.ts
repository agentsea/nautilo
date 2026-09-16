/**
 * M071 — shared `--instance` argv parsing for all entrypoints.
 */
import { describe, expect, test } from "bun:test";
import {
  applyInstanceArgFromArgv,
  stripInstancePairFromArgv,
} from "../../src/apply-instance-arg-from-argv";

describe("applyInstanceArgFromArgv", () => {
  test("sets NAUTILO_INSTANCE_ID (CLI wins)", () => {
    const env = { NAUTILO_INSTANCE_ID: "gamma" } as NodeJS.ProcessEnv;
    applyInstanceArgFromArgv(["--instance", "beta", "x"], env);
    expect(env["NAUTILO_INSTANCE_ID"]).toBe("beta");
  });

  test("no --instance leaves env unchanged", () => {
    const env = { NAUTILO_INSTANCE_ID: "gamma" } as NodeJS.ProcessEnv;
    applyInstanceArgFromArgv(["--with-logto"], env);
    expect(env["NAUTILO_INSTANCE_ID"]).toBe("gamma");
  });

  test("finds --instance anywhere in argv", () => {
    const env = {} as NodeJS.ProcessEnv;
    applyInstanceArgFromArgv(["bun", "script.ts", "infra-start", "--instance", "beta"], env);
    expect(env["NAUTILO_INSTANCE_ID"]).toBe("beta");
  });

  test("rejects invalid id", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(() => applyInstanceArgFromArgv(["--instance", "BAD"], env)).toThrow(
      /invalid --instance/,
    );
  });

  test("rejects missing value", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(() => applyInstanceArgFromArgv(["--instance"], env)).toThrow(
      /requires a non-empty id/,
    );
  });

  test("normalizes 'default' alias to empty string", () => {
    const env = { NAUTILO_INSTANCE_ID: "gamma" } as NodeJS.ProcessEnv;
    applyInstanceArgFromArgv(["--instance", "default"], env);
    expect(env["NAUTILO_INSTANCE_ID"]).toBe("");
  });

  test("normalizes '(default)' alias to empty string", () => {
    const env = {} as NodeJS.ProcessEnv;
    applyInstanceArgFromArgv(["--instance", "(default)"], env);
    expect(env["NAUTILO_INSTANCE_ID"]).toBe("");
  });

  test("normalizes 'Default' (case-insensitive) to empty string", () => {
    const env = {} as NodeJS.ProcessEnv;
    applyInstanceArgFromArgv(["--instance", "Default"], env);
    expect(env["NAUTILO_INSTANCE_ID"]).toBe("");
  });

  test("does not normalize unrelated ids", () => {
    const env = {} as NodeJS.ProcessEnv;
    applyInstanceArgFromArgv(["--instance", "test-cruft"], env);
    expect(env["NAUTILO_INSTANCE_ID"]).toBe("test-cruft");
  });

  test("rejects path-like ids (validation still runs for non-aliases)", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(() => applyInstanceArgFromArgv(["--instance", "../bad"], env)).toThrow(
      /invalid --instance/,
    );
  });

  test("rejects duplicate --instance flags", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(() =>
      applyInstanceArgFromArgv(["--instance", "beta", "--instance", "gamma"], env),
    ).toThrow(/may only be provided once/);
  });
});

describe("stripInstancePairFromArgv", () => {
  test("removes first --instance pair", () => {
    expect(stripInstancePairFromArgv(["infra-start", "--instance", "beta"])).toEqual([
      "infra-start",
    ]);
  });

  test("leaves argv without instance unchanged", () => {
    expect(stripInstancePairFromArgv(["infra-start", "--fix"])).toEqual([
      "infra-start",
      "--fix",
    ]);
  });
});
