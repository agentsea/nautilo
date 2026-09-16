import { afterEach, describe, expect, test } from "bun:test";
import { resolveProviderKey } from "../../src/resolve-provider-key";

describe("resolveProviderKey (D120 A1.P4)", () => {
  // Capture pre-test values so the cleanup restores (instead of deleting)
  // any keys a developer has in their shell env. Running these tests
  // shouldn't wipe the operator's real OPENAI_API_KEY for the rest of
  // the bun process.
  const orig = {
    openai: process.env["OPENAI_API_KEY"],
    openrouter: process.env["OPENROUTER_API_KEY"],
    anthropic: process.env["ANTHROPIC_API_KEY"],
    google: process.env["GOOGLE_API_KEY"],
  };
  afterEach(() => {
    for (const [name, envVar] of [
      ["openai", "OPENAI_API_KEY"],
      ["openrouter", "OPENROUTER_API_KEY"],
      ["anthropic", "ANTHROPIC_API_KEY"],
      ["google", "GOOGLE_API_KEY"],
    ] as const) {
      const prev = orig[name];
      if (prev === undefined) delete process.env[envVar];
      else process.env[envVar] = prev;
    }
  });

  test("openai: returns env value when present", () => {
    process.env["OPENAI_API_KEY"] = "sk-test";
    expect(resolveProviderKey("openai")).toBe("sk-test");
  });

  test("openrouter + anthropic + google: same shape", () => {
    process.env["OPENROUTER_API_KEY"] = "or-test";
    process.env["ANTHROPIC_API_KEY"] = "ant-test";
    process.env["GOOGLE_API_KEY"] = "g-test";
    expect(resolveProviderKey("openrouter")).toBe("or-test");
    expect(resolveProviderKey("anthropic")).toBe("ant-test");
    expect(resolveProviderKey("google")).toBe("g-test");
  });

  test("returns null when env unset", () => {
    delete process.env["OPENAI_API_KEY"];
    expect(resolveProviderKey("openai")).toBeNull();
  });

  test("returns null for empty / whitespace-only env value", () => {
    process.env["OPENAI_API_KEY"] = "   ";
    expect(resolveProviderKey("openai")).toBeNull();
    process.env["OPENAI_API_KEY"] = "";
    expect(resolveProviderKey("openai")).toBeNull();
  });

  test("accepts an optional TenantContext (unused today, contract surface for per-tenant lookup)", () => {
    process.env["OPENAI_API_KEY"] = "sk-test";
    expect(resolveProviderKey("openai", { ownerId: "user-123", tenantId: "t-1" })).toBe("sk-test");
  });
});
