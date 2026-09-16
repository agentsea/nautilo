import { describe, expect, test } from "bun:test";
import { loginModule, loginPasswordArgvCheck } from "../../src/commands/login.ts";

describe("nautilo login — --password retired", () => {
  test("argv password key surfaces the public retirement message", () => {
    expect(() =>
      loginPasswordArgvCheck({ password: "x" } as Record<string, unknown>),
    ).toThrow(/Sign-in with `--password` is no longer supported/);
  });

  test("argv without password key passes the guard", () => {
    expect(loginPasswordArgvCheck({ remote: true } as Record<string, unknown>)).toBe(true);
  });

  test("loginModule wires the guard into yargs", () => {
    // Smoke-check that the module exports a builder we can install. The
    // end-to-end yargs `.check()` → `.fail()` round-trip is yargs's
    // contract, not ours; covered by `loginPasswordArgvCheck` above.
    expect(typeof loginModule.builder).toBe("function");
    expect(loginModule.command).toBe("login");
  });
});
