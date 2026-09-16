import { describe, expect, test } from "bun:test";
import { reportStaleToken } from "../../../electron/auth/report-stale-token";

describe("reportStaleToken", () => {
  test("invokes clearTokens then broadcast signed-out", () => {
    let cleared = false;
    let out: string | null = null;
    reportStaleToken(
      (s) => {
        out = s;
      },
      () => {
        cleared = true;
      },
    );
    expect(cleared).toBe(true);
    expect(out).toBe("signed-out");
  });
});
