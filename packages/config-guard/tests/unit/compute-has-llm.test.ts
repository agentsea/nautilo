import { describe, expect, test } from "bun:test";
import { computeHasLlmFromKeys } from "../../src/compute-has-llm";
import type { KeyReport } from "../../src/types";

function key(id: string, status: KeyReport["status"]): KeyReport {
  return { id, status } as KeyReport;
}

describe("computeHasLlmFromKeys", () => {
  test("false when no LLM keys are present or verified", () => {
    expect(computeHasLlmFromKeys([key("slack", "present")])).toBe(false);
    expect(computeHasLlmFromKeys([key("typesafe", "verified")])).toBe(false);
    expect(computeHasLlmFromKeys([key("openai", "missing")])).toBe(false);
  });

  test("true when any known LLM id is present or verified", () => {
    expect(computeHasLlmFromKeys([key("openai", "present")])).toBe(true);
    expect(computeHasLlmFromKeys([key("anthropic", "verified")])).toBe(true);
    expect(computeHasLlmFromKeys([key("google", "present")])).toBe(true);
    expect(computeHasLlmFromKeys([key("fireworks", "verified")])).toBe(true);
    expect(computeHasLlmFromKeys([key("openrouter", "present")])).toBe(true);
    expect(computeHasLlmFromKeys([key("gateway", "present")])).toBe(true);
    expect(computeHasLlmFromKeys([key("venice", "verified")])).toBe(true);
  });

  test("managed Gateway requires its canonical key and a valid API root", () => {
    const gateway = [key("nautilo-gateway", "present")];
    const validKey = `ngw_${"a".repeat(43)}`;

    expect(computeHasLlmFromKeys(gateway, {
      NAUTILO_MANAGED_GATEWAY_API_KEY: validKey,
    })).toBe(false);
    expect(computeHasLlmFromKeys(gateway, {
      NAUTILO_MANAGED_GATEWAY_API_KEY: validKey,
      NAUTILO_MANAGED_GATEWAY_BASE_URL: "http://gateway.example/v1",
    })).toBe(false);
    expect(computeHasLlmFromKeys(gateway, {
      NAUTILO_MANAGED_GATEWAY_API_KEY: "ngw_not-canonical",
      NAUTILO_MANAGED_GATEWAY_BASE_URL: "https://gateway.example/v1",
    })).toBe(false);
    expect(computeHasLlmFromKeys(gateway, {
      NAUTILO_MANAGED_GATEWAY_API_KEY: validKey,
      NAUTILO_MANAGED_GATEWAY_BASE_URL: "https://gateway.example/v1",
    })).toBe(true);
  });
});
