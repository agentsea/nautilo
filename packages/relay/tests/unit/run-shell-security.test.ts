import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";

import {
  RUN_SHELL_DEFAULT_TIMEOUT_MS,
  RUN_SHELL_MAX_TIMEOUT_MS,
  RUN_SHELL_MIN_TIMEOUT_MS,
  admitRunShellTimeoutMs,
  knownRunShellSecretValues,
  redactRunShellOutputBuffer,
  redactRunShellOutputText,
} from "../../src/run-shell-security";

describe("run_shell shared security floor", () => {
  test("clamps every consumer to the same timeout range", () => {
    expect(admitRunShellTimeoutMs(undefined)).toBe(RUN_SHELL_DEFAULT_TIMEOUT_MS);
    expect(admitRunShellTimeoutMs(0)).toBe(RUN_SHELL_MIN_TIMEOUT_MS);
    expect(admitRunShellTimeoutMs(5_000)).toBe(5_000);
    expect(admitRunShellTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(
      RUN_SHELL_MAX_TIMEOUT_MS,
    );
  });

  test("redacts known local secrets without changing byte offsets", () => {
    const secret = "environment-secret-value";
    const known = knownRunShellSecretValues({ NAUTILO_TEST_TOKEN: secret });
    const raw = Buffer.from(`before ${secret} after`, "utf8");
    const redacted = redactRunShellOutputBuffer(raw, known);

    expect(redacted.length).toBe(raw.length);
    expect(redacted.toString("utf8")).toContain("[REDACTED]");
    expect(redacted.toString("utf8")).not.toContain(secret);
  });

  test("redacts credential-shaped output even when it was not in the environment", () => {
    const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
    const output = redactRunShellOutputText(
      `authorization: Bearer opaque-value\ntoken=${token}`,
      [],
    );

    expect(output).toContain("authorization: Bearer [REDACTED]");
    expect(output).not.toContain("opaque-value");
    expect(output).not.toContain(token);
    expect(redactRunShellOutputText(output, [])).toBe(output);
  });
});
