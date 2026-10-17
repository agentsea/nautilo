import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  resolveConductorModelId,
  resolveReflectionModelId,
  resolveMemoryReviewModelId,
  resolveStenographerModelId,
} from "../../src";

const SURPLUS_ONLY_MODEL = "openrouter:openai/gpt-5.6-sol";
const SURPLUS_ROUTE = {
  catalogModelId: SURPLUS_ONLY_MODEL,
  surplusModelId: "gpt-5.6-sol",
  providerPin: "openrouter" as const,
  supportsTools: true,
  supportsVision: false,
  supportsReasoning: true,
  maxContextTokens: 1_050_000,
  maxOutputTokens: 128_000,
};
const serverSurplus = { policyEnabled: true, keyConfigured: true, routes: [SURPLUS_ROUTE] };

const previousKeys: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY"]) {
    previousKeys[key] = process.env[key];
    process.env[key] = `test-${key.toLowerCase()}`;
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(previousKeys)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("resolveStenographerModelId", () => {
  test("uses a signed Surplus-only server model", () => {
    expect(resolveStenographerModelId({
      serverConfiguredModelId: SURPLUS_ONLY_MODEL,
      serverConfiguredConductorModelId: null,
      runtimeConfiguredConductorModelId: "google:gemini-2.5-pro",
      serverSurplus,
    })).toBe(SURPLUS_ONLY_MODEL);
  });
  test("uses an explicit Stenographer model", () => {
    expect(resolveStenographerModelId({
      serverConfiguredModelId: " openai:gpt-5.5-2026-04-23 ",
      serverConfiguredConductorModelId: "anthropic:claude-sonnet-4-6",
      runtimeConfiguredConductorModelId: "google:gemini-2.5-pro",
    })).toBe("openai:gpt-5.5-2026-04-23");
  });

  test("inherits the server Conductor model when blank", () => {
    expect(resolveStenographerModelId({
      serverConfiguredModelId: "",
      serverConfiguredConductorModelId: " anthropic:claude-sonnet-4-6 ",
      runtimeConfiguredConductorModelId: "google:gemini-2.5-pro",
    })).toBe("anthropic:claude-sonnet-4-6");
  });

  test("falls back to the runtime Conductor model when both server fields are blank", () => {
    expect(resolveStenographerModelId({
      serverConfiguredModelId: null,
      serverConfiguredConductorModelId: null,
      runtimeConfiguredConductorModelId: "google:gemini-2.5-pro",
    })).toBe("google:gemini-2.5-pro");
  });
});

describe("resolveReflectionModelId", () => {
  test("uses a signed Surplus-only server model", () => {
    expect(resolveReflectionModelId({
      serverConfiguredModelId: SURPLUS_ONLY_MODEL,
      resolvedStenographerModelId: "anthropic:claude-sonnet-4-6",
      serverSurplus,
    })).toBe(SURPLUS_ONLY_MODEL);
  });
  test("uses an explicit Reflection model", () => {
    expect(resolveReflectionModelId({
      serverConfiguredModelId: " openai:gpt-5.5-2026-04-23 ",
      resolvedStenographerModelId: "anthropic:claude-sonnet-4-6",
    })).toBe("openai:gpt-5.5-2026-04-23");
  });

  test("inherits the resolved Stenographer model when blank", () => {
    expect(resolveReflectionModelId({
      serverConfiguredModelId: null,
      resolvedStenographerModelId: "anthropic:claude-sonnet-4-6",
    })).toBe("anthropic:claude-sonnet-4-6");
  });
});

describe("resolveMemoryReviewModelId", () => {
  const conductor = {
    serverConfiguredConductorModelId: "anthropic:claude-sonnet-4-6",
    runtimeConfiguredConductorModelId: "openai:gpt-5.5-2026-04-23",
  };
  test("uses a tool-capable signed Surplus-only server model", () => {
    expect(resolveMemoryReviewModelId({
      ...conductor,
      serverConfiguredModelId: SURPLUS_ONLY_MODEL,
      serverSurplus,
    })).toBe(SURPLUS_ONLY_MODEL);
  });
  test("uses its own model when selected", () => {
    expect(resolveMemoryReviewModelId({ ...conductor, serverConfiguredModelId: " openai:gpt-5.5-2026-04-23 " }))
      .toBe("openai:gpt-5.5-2026-04-23");
  });
  test("inherits server Conductor when cleared", () => {
    expect(resolveMemoryReviewModelId({ ...conductor, serverConfiguredModelId: " " }))
      .toBe("anthropic:claude-sonnet-4-6");
  });
  test("inherits runtime Conductor when server Conductor is unset", () => {
    expect(resolveMemoryReviewModelId({ ...conductor, serverConfiguredModelId: null, serverConfiguredConductorModelId: null }))
      .toBe("openai:gpt-5.5-2026-04-23");
  });
  test("does not replace an unavailable own or inherited model", () => {
    expect(() => resolveMemoryReviewModelId({ ...conductor, serverConfiguredModelId: "missing:model" })).toThrow();
    expect(() => resolveMemoryReviewModelId({ ...conductor, serverConfiguredModelId: null, serverConfiguredConductorModelId: "missing:model" })).toThrow();
  });
});

describe("resolveConductorModelId", () => {
  test("uses a signed Surplus-only server model", () => {
    expect(resolveConductorModelId(SURPLUS_ONLY_MODEL, serverSurplus)).toBe(SURPLUS_ONLY_MODEL);
  });
});
