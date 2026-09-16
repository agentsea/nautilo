/**
 * M059 — `nautilo-dev verify-config-env` runner.
 *
 * Runs the validator with injected env snapshots so each branch is
 * deterministic (no filesystem, no `process.env` mutation).
 *
 * Asserts (post-M072 — Logto is the only auth mode):
 *   - All 11 LOGTO_* keys present is valid (exit 0).
 *   - Any missing LOGTO_* key is INVALID (exit 1) AND the missing key
 *     surfaces in the output.
 *   - The output table covers ALL 11 LOGTO_* keys, including
 *     LOGTO_DESKTOP_APP_ID (the M055 addition the original spec
 *     missed).
 *   - LOGTO_M2M_APP_SECRET is masked, never plaintext.
 */
import { describe, expect, test } from "bun:test";
import { runVerifyConfigEnv } from "../../src/commands/verify-config-env";

function captureLog() {
  const lines: string[] = [];
  return {
    log: (msg: string) => {
      lines.push(msg);
    },
    output: () => lines.join("\n"),
  };
}

const ALL_LOGTO_KEYS = {
  LOGTO_ENDPOINT: "https://auth.example.com",
  LOGTO_ISSUER: "https://auth.example.com/oidc",
  LOGTO_JWKS_URI: "https://auth.example.com/oidc/jwks",
  LOGTO_RESOURCE: "https://api.example.com",
  LOGTO_WORKBENCH_APP_ID: "wbId",
  LOGTO_TUI_APP_ID: "tuiId",
  LOGTO_TUI_LOOPBACK_APP_ID: "tuiLoopId",
  LOGTO_DESKTOP_APP_ID: "deskId",
  LOGTO_MOBILE_APP_ID: "mobileId",
  LOGTO_M2M_APP_ID: "m2mId",
  LOGTO_M2M_APP_SECRET: "this-is-the-real-secret",
};

describe("runVerifyConfigEnv — happy paths", () => {
  test("all 11 LOGTO_* keys present is valid", () => {
    const cap = captureLog();
    const code = runVerifyConfigEnv(
      {},
      {
        loadEnv: () => ALL_LOGTO_KEYS,
        log: cap.log,
      },
    );
    expect(code).toBe(0);
    expect(cap.output()).toContain("Logto configuration is valid");
  });
});

describe("runVerifyConfigEnv — invalid", () => {
  test("empty env is INVALID and lists every missing LOGTO_* key", () => {
    const cap = captureLog();
    const code = runVerifyConfigEnv(
      {},
      {
        loadEnv: () => ({}),
        log: cap.log,
      },
    );
    expect(code).toBe(1);
    const out = cap.output();
    expect(out).toContain("Config is INVALID");
    // Every required LOGTO_* key must show as missing in the row table.
    for (const key of [
      "LOGTO_ENDPOINT",
      "LOGTO_ISSUER",
      "LOGTO_JWKS_URI",
      "LOGTO_RESOURCE",
      "LOGTO_WORKBENCH_APP_ID",
      "LOGTO_TUI_APP_ID",
      "LOGTO_TUI_LOOPBACK_APP_ID",
      "LOGTO_DESKTOP_APP_ID",
      "LOGTO_MOBILE_APP_ID",
      "LOGTO_M2M_APP_ID",
      "LOGTO_M2M_APP_SECRET",
    ]) {
      expect(out).toContain(`✗ ${key} — missing`);
    }
    // The cross-key invariant aggregate also calls out the missing keys.
    expect(out).toContain("Logto configuration requires every LOGTO_* key");
  });

  test("missing only LOGTO_DESKTOP_APP_ID (M055 regression guard) is INVALID", () => {
    const cap = captureLog();
    const env = { ...ALL_LOGTO_KEYS } as Record<string, string | undefined>;
    delete env["LOGTO_DESKTOP_APP_ID"];
    const code = runVerifyConfigEnv(
      {},
      {
        loadEnv: () => env,
        log: cap.log,
      },
    );
    expect(code).toBe(1);
    const out = cap.output();
    expect(out).toContain("✗ LOGTO_DESKTOP_APP_ID — missing");
    expect(out).toContain("LOGTO_DESKTOP_APP_ID");
  });

  test("missing only LOGTO_MOBILE_APP_ID (M199 regression guard) is INVALID", () => {
    const cap = captureLog();
    const env = { ...ALL_LOGTO_KEYS } as Record<string, string | undefined>;
    delete env["LOGTO_MOBILE_APP_ID"];
    const code = runVerifyConfigEnv(
      {},
      {
        loadEnv: () => env,
        log: cap.log,
      },
    );
    expect(code).toBe(1);
    const out = cap.output();
    expect(out).toContain("✗ LOGTO_MOBILE_APP_ID — missing");
    expect(out).toContain("LOGTO_MOBILE_APP_ID");
  });
});

describe("runVerifyConfigEnv — secret redaction", () => {
  test("LOGTO_M2M_APP_SECRET is NEVER printed in plaintext", () => {
    const cap = captureLog();
    runVerifyConfigEnv(
      {},
      {
        loadEnv: () => ALL_LOGTO_KEYS,
        log: cap.log,
      },
    );
    const out = cap.output();
    expect(out).not.toContain(ALL_LOGTO_KEYS.LOGTO_M2M_APP_SECRET);
    // The row label is still present; the value is masked.
    expect(out).toContain("LOGTO_M2M_APP_SECRET");
    expect(out).toContain("(redacted)");
  });
});
