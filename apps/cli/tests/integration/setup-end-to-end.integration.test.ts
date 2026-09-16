/**
 * Full stack: requires compose + Logto + running server (same class as
 * NAUTILO_LOGTO_PASSWORD_LOGIN_IT-gated tests). Enable with NAUTILO_CLI_E2E=1.
 */
import { describe, test, expect } from "bun:test";

const RUN = process.env["NAUTILO_CLI_E2E"] === "1";

describe.skipIf(!RUN)("nautilo setup end-to-end (infra)", () => {
  test("placeholder — extend with d112-smoke fixture + gen-setup-template + setup + config.env assertions", () => {
    expect(true).toBe(true);
  });
});
