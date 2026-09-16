/**
 * Regression: `buildSummary().hasLlm` must derive from the key registry,
 * NOT a hardcoded `ok("anthropic") || ok("openai") || ...` chain.
 *
 * This test iterates every key def in the LLM categories, sets only that
 * key's env var to a format-passing value, and asserts hasLlm becomes true.
 * If hasLlm regresses to a hardcoded list, the keys not in that list will
 * fail this test and pinpoint the regression.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { check, getAllKeyDefinitions } from "../../src/index";

// Minimum format-passing values per registered LLM key. Kept in sync with
// each `formatCheck` in `key-registry.ts`. If a check changes, update here.
const PASSING_VALUES: Record<string, string> = {
  anthropic: `sk-ant-api03-${"a".repeat(50)}`,
  openai: `sk-proj-${"a".repeat(40)}`,
  openrouter: `sk-or-v1-${"a".repeat(40)}`,
  gateway: "opaque-gateway-key-1234",
  google: `AIzaSy${"a".repeat(34)}`,
  fireworks: `fw_${"a".repeat(20)}`,
  venice: "a".repeat(48),
};

const ALL_LLM_ENV_VARS = getAllKeyDefinitions()
  .filter((d) => d.category === "llm" || d.category === "llm+embeddings")
  .map((d) => ({ id: d.id, envVar: d.envVar }));

describe("buildSummary().hasLlm derives from key-registry", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const { envVar } of ALL_LLM_ENV_VARS) {
      saved[envVar] = process.env[envVar];
      delete process.env[envVar];
    }
  });

  afterEach(() => {
    for (const { envVar } of ALL_LLM_ENV_VARS) {
      const prev = saved[envVar];
      if (prev === undefined) delete process.env[envVar];
      else process.env[envVar] = prev;
    }
  });

  test("hasLlm is false when no LLM env vars are set", async () => {
    const r = await check({ validate: false });
    expect(r.summary.hasLlm).toBe(false);
  });

  for (const { id, envVar } of ALL_LLM_ENV_VARS) {
    test(`hasLlm is true when only ${id} (${envVar}) is set with a passing value`, async () => {
      const v = PASSING_VALUES[id];
      if (!v) {
        throw new Error(
          `No PASSING_VALUES entry for registered LLM key "${id}". Update the test fixture.`,
        );
      }
      process.env[envVar] = v;
      const r = await check({ validate: false });
      const keyReport = r.keys.find((k) => k.id === id);
      expect(keyReport?.status === "verified" || keyReport?.status === "present").toBe(true);
      expect(r.summary.hasLlm).toBe(true);
    });
  }
});

describe("buildSummary().hasConversion derives from cloudconvert key", () => {
  const envVar = "CLOUDCONVERT_API_KEY";
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[envVar];
    delete process.env[envVar];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[envVar];
    else process.env[envVar] = saved;
  });

  test("hasConversion is false when CLOUDCONVERT_API_KEY is unset", async () => {
    const r = await check({ validate: false });
    expect(r.summary.hasConversion).toBe(false);
  });

  test("hasConversion is true when CLOUDCONVERT_API_KEY has a passing value", async () => {
    process.env[envVar] = [
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      "a".repeat(100),
      "b".repeat(100),
    ].join(".");
    const r = await check({ validate: false });
    const keyReport = r.keys.find((k) => k.id === "cloudconvert");
    expect(keyReport?.status === "verified" || keyReport?.status === "present").toBe(true);
    expect(r.summary.hasConversion).toBe(true);
  });
});

describe("buildSummary().hasEmbeddings accepts qualified runtime paths", () => {
  const envVars = ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "VENICE_API_KEY"] as const;
  const saved: Record<(typeof envVars)[number], string | undefined> = {
    OPENAI_API_KEY: undefined,
    OPENROUTER_API_KEY: undefined,
    VENICE_API_KEY: undefined,
  };

  beforeEach(() => {
    for (const envVar of envVars) {
      saved[envVar] = process.env[envVar];
      delete process.env[envVar];
    }
  });

  afterEach(() => {
    for (const envVar of envVars) {
      const previous = saved[envVar];
      if (previous === undefined) delete process.env[envVar];
      else process.env[envVar] = previous;
    }
  });

  test("is true for OpenRouter without OpenAI", async () => {
    process.env["OPENROUTER_API_KEY"] = `sk-or-v1-${"a".repeat(40)}`;
    const result = await check({ validate: false });
    expect(result.summary.hasEmbeddings).toBe(true);
  });

  test("is true for Venice without OpenAI or OpenRouter", async () => {
    process.env["VENICE_API_KEY"] = "a".repeat(48);
    const result = await check({ validate: false });
    expect(result.summary.hasEmbeddings).toBe(true);
  });

  test("is false when no embedding provider is configured", async () => {
    const result = await check({ validate: false });
    expect(result.summary.hasEmbeddings).toBe(false);
  });
});
