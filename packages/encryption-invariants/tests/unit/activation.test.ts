import { describe, expect, test } from "bun:test";

import {
  DEFAULT_ENCRYPTION_ACTIVATION,
  parseWave0Activation,
} from "../../src/activation";

describe("Wave 0 activation", () => {
  test("has exactly one default and it is disabled", () => {
    expect(DEFAULT_ENCRYPTION_ACTIVATION).toEqual({ stage: "disabled" });
    expect(Object.keys(DEFAULT_ENCRYPTION_ACTIVATION)).toEqual(["stage"]);
  });

  test("accepts only the literal disabled stage", () => {
    expect(parseWave0Activation(undefined)).toEqual({ ok: true, value: { stage: "disabled" } });
    expect(parseWave0Activation({ stage: "disabled" })).toEqual({
      ok: true,
      value: { stage: "disabled" },
    });
  });

  test.each([
    "preparation",
    "shadow_writing",
    "live_migration",
    "ciphertext_reads",
    "ciphertext_only_finalized",
  ])("rejects non-disabled stage %s", (stage) => {
    expect(parseWave0Activation({ stage })).toEqual({
      ok: false,
      error: `Wave 0 cannot activate encryption stage: ${stage}`,
    });
  });

  test("rejects malformed and extra activation input", () => {
    expect(parseWave0Activation(null)).toEqual({
      ok: false,
      error: "Wave 0 activation input must be an object when provided",
    });
    expect(parseWave0Activation({ stage: "disabled", enabled: true })).toEqual({
      ok: false,
      error: "Wave 0 activation input contains unsupported fields: enabled",
    });
  });
});
