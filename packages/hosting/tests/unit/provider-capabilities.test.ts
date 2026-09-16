import { describe, expect, test } from "bun:test";

import {
  HOSTING_CAPABILITIES,
  HOSTING_PROVIDERS,
  resolveProviderCapabilities,
  type HostingCapability,
  type ProviderCredentialReference,
} from "../../src";

const validReferences: readonly ProviderCredentialReference[] = [
  { provider: "openrouter", source: "environment", state: "configured" },
  { provider: "groq", source: "documented-config", state: "configured" },
  { provider: "tavily", source: "environment", state: "configured" },
];

function resolve(overrides: Partial<Parameters<typeof resolveProviderCapabilities>[0]> = {}) {
  return resolveProviderCapabilities({
    references: validReferences,
    allProviders: false,
    includeProviders: [],
    excludeProviders: [],
    qualifiedBaselineCapabilities: [],
    infrastructure: "planned",
    coreDegradedConsent: false,
    ...overrides,
  });
}

function capability(result: ReturnType<typeof resolve>, name: HostingCapability) {
  const status = result.capabilities.find((candidate) => candidate.capability === name);
  if (status === undefined) throw new Error(`missing ${name}`);
  return status;
}

describe("resolveProviderCapabilities", () => {
  test("keeps the recognized provider order aligned with the current key registry", () => {
    expect(HOSTING_PROVIDERS).toEqual([
      "anthropic",
      "openai",
      "openrouter",
      "gateway",
      "google",
      "fireworks",
      "venice",
      "elevenlabs",
      "groq",
      "tavily",
      "browser-use",
      "cloudconvert",
    ]);
  });

  test("Browser Use is selectable without claiming dedicated web-search coverage", () => {
    const result = resolve({ allProviders: true, references: [{ provider: "browser-use", state: "configured", source: "environment" }] });
    expect(result.issues).toEqual([]);
    expect(result.providers.find((provider) => provider.provider === "browser-use")?.selected).toBe(true);
    expect(capability(result, "search").experience).toBe("unavailable");
  });

  test("all-providers selects only recognized supplied references in stable order", () => {
    const result = resolve({ allProviders: true });
    expect(result.providers.filter((provider) => provider.selected).map((provider) => provider.provider)).toEqual([
      "openrouter",
      "groq",
      "tavily",
    ]);
    expect(result.providers.find((provider) => provider.provider === "openai")?.state).toBe("not-selected");
    expect(capability(result, "chat").experience).toBe("baseline");
    expect(capability(result, "search").experience).toBe("enhanced");
    expect(capability(result, "stt").experience).toBe("baseline");
  });

  test("explicit inclusion reports missing credentials and exclusion wins deterministically", () => {
    const result = resolve({
      allProviders: true,
      includeProviders: ["openai", "openrouter", "openai"],
      excludeProviders: ["openrouter"],
    });
    expect(result.providers.find((provider) => provider.provider === "openai")).toMatchObject({
      selected: true,
      state: "missing",
    });
    expect(result.providers.find((provider) => provider.provider === "openrouter")).toMatchObject({
      selected: false,
      state: "excluded",
    });
    expect(result.issues).toContainEqual({ code: "provider.missing-credential", provider: "openai" });
  });

  test("uses qualified OpenRouter embeddings without manufacturing search or voice coverage", () => {
    const result = resolve({ includeProviders: ["openrouter"] });
    expect(capability(result, "chat").experience).toBe("baseline");
    expect(capability(result, "embeddings").experience).toBe("baseline");
    expect(capability(result, "search").experience).toBe("unavailable");
    expect(capability(result, "tts").experience).toBe("unavailable");
    expect(capability(result, "stt").experience).toBe("unavailable");
    expect(result.readiness).toMatchObject({
      outcome: "blocked",
      coreReadiness: "blocked",
      mutationAuthorized: false,
    });
  });

  test("uses qualified Venice embeddings without manufacturing search or voice coverage", () => {
    const result = resolve({
      references: [{ provider: "venice", source: "environment", state: "configured" }],
      includeProviders: ["venice"],
    });
    expect(capability(result, "chat").experience).toBe("baseline");
    expect(capability(result, "embeddings").experience).toBe("baseline");
    expect(capability(result, "search").experience).toBe("unavailable");
    expect(capability(result, "tts").experience).toBe("unavailable");
    expect(capability(result, "stt").experience).toBe("unavailable");
  });

  test("emits optional warnings only when caller-provided baselines are qualified", () => {
    const withoutBaselines = resolve({ includeProviders: ["openrouter"] });
    expect(withoutBaselines.readiness.notices.some((notice) =>
      notice.code === "hosting.optional-enhancement-unavailable",
    )).toBe(false);

    const withBaselines = resolve({
      includeProviders: ["openrouter"],
      qualifiedBaselineCapabilities: ["embeddings", "search", "tts", "stt"],
    });
    expect(withBaselines.readiness).toMatchObject({
      outcome: "authorized",
      coreReadiness: "useful-ready",
      mutationAuthorized: true,
    });
    expect(withBaselines.readiness.notices).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "hosting.optional-enhancement-unavailable",
        capability: "search",
      }),
      expect.objectContaining({
        severity: "warning",
        code: "hosting.optional-enhancement-unavailable",
        capability: "tts",
      }),
    ]);
  });

  test("keeps an invalid enhancement as a warning when a baseline remains", () => {
    const result = resolve({
      references: [
        { provider: "openrouter", source: "environment", state: "configured" },
        { provider: "elevenlabs", source: "documented-config", state: "invalid" },
      ],
      includeProviders: ["openrouter", "elevenlabs"],
      qualifiedBaselineCapabilities: ["embeddings", "search", "tts", "stt"],
    });
    expect(capability(result, "tts")).toMatchObject({
      experience: "baseline",
      enhancement: { provider: "elevenlabs", availability: "invalid" },
    });
    expect(result.readiness.coreReadiness).toBe("useful-ready");
    expect(result.issues).toContainEqual({
      code: "provider.invalid-credential",
      provider: "elevenlabs",
    });
  });

  test("fails duplicate sources closed regardless of reference order", () => {
    const first = resolve({
      references: [
        { provider: "openrouter", source: "environment", state: "configured" },
        { provider: "openrouter", source: "documented-config", state: "configured" },
      ],
      allProviders: true,
    });
    const second = resolve({
      references: [
        { provider: "openrouter", source: "documented-config", state: "configured" },
        { provider: "openrouter", source: "environment", state: "configured" },
      ],
      allProviders: true,
    });
    for (const result of [first, second]) {
      expect(result.providers.find((provider) => provider.provider === "openrouter")).toMatchObject({
        selected: true,
        state: "invalid",
      });
      expect(result.issues).toContainEqual({
        code: "provider.duplicate-reference",
        provider: "openrouter",
      });
    }
    expect(second).toEqual(first);
  });

  test("never returns raw values, filesystem paths, or unknown caller strings", () => {
    const secret = "sk-secret-that-must-never-surface";
    const path = "/private/operator/provider-keys.env";
    const unknown = `unknown-${secret}`;
    const result = resolveProviderCapabilities({
      references: [
        {
          provider: "openrouter",
          source: "environment",
          state: "configured",
          value: secret,
          path,
        },
        { provider: unknown, source: "documented-config", state: "configured", value: secret, path },
      ] as unknown as readonly ProviderCredentialReference[],
      allProviders: true,
      includeProviders: [unknown],
      excludeProviders: [`excluded-${secret}`],
      qualifiedBaselineCapabilities: [...HOSTING_CAPABILITIES, unknown as HostingCapability],
      infrastructure: "planned",
      coreDegradedConsent: false,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(path);
    expect(serialized).not.toContain(unknown);
    expect(result.issues).toContainEqual({ code: "provider.unsupported-reference", count: 1 });
    expect(result.issues).toContainEqual({ code: "provider.unsupported-selection", count: 2 });
    expect(result.issues).toContainEqual({ code: "provider.invalid-baseline", count: 1 });
  });

  test("requires explicit core-degraded consent without requiring OpenAI by brand", () => {
    const blocked = resolve({ includeProviders: ["openrouter"] });
    const degraded = resolve({ includeProviders: ["openrouter"], coreDegradedConsent: true });
    expect(blocked.readiness.coreReadiness).toBe("blocked");
    expect(degraded.readiness).toMatchObject({
      outcome: "authorized",
      coreReadiness: "degraded",
      coreDegradedConsent: true,
      mutationAuthorized: true,
    });
    expect(JSON.stringify(degraded.readiness)).not.toContain("OpenAI is required");
  });
});
