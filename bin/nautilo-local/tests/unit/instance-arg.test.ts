/**
 * M071 Phase 2C — `nautilo-local` `--instance` argv handling.
 */
import { describe, expect, test } from "bun:test";
import { applyInstanceArgFromArgv } from "@nautilo/config";

describe("applyInstanceArgFromArgv", () => {
  test("sets NAUTILO_INSTANCE_ID from --instance (CLI wins)", () => {
    const env = { NAUTILO_INSTANCE_ID: "gamma" } as NodeJS.ProcessEnv;
    applyInstanceArgFromArgv(["--instance", "beta", "--with-logto"], env);
    expect(env["NAUTILO_INSTANCE_ID"]).toBe("beta");
  });

  test("no --instance leaves env unchanged", () => {
    const env = { NAUTILO_INSTANCE_ID: "gamma" } as NodeJS.ProcessEnv;
    applyInstanceArgFromArgv(["--with-logto"], env);
    expect(env["NAUTILO_INSTANCE_ID"]).toBe("gamma");
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
});
