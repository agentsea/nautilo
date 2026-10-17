import { describe, expect, test } from "bun:test";
import {
  MemoryModelPreferenceError,
  resolveMemoryModelPreference,
  type MemoryOperatorDefaults,
  type PersonalMemoryModel,
} from "../../src/lib/memory-model-preferences";

const models: PersonalMemoryModel[] = [
  { modelId: "openrouter:automatic", displayName: "Automatic", provider: "openrouter" },
  { modelId: "anthropic:operator", displayName: "Operator", provider: "anthropic" },
  { modelId: "openai:personal", displayName: "Personal", provider: "openai" },
];
const defaults: MemoryOperatorDefaults = {
  memoryReview: "anthropic:operator",
  memoryReflection: "anthropic:operator",
  memorySummarization: null,
};

describe("Memory model preferences", () => {
  test("uses a sparse Human override before the exact operator default", () => {
    expect(resolveMemoryModelPreference("memoryReview", {
      revision: 7,
      overrides: { memoryReview: "openai:personal" },
    }, defaults, models)).toEqual({ modelId: "openai:personal", preferenceRevision: 7 });
    expect(resolveMemoryModelPreference("memoryReflection", {
      revision: 3,
      overrides: {},
    }, defaults, models)).toEqual({ modelId: "anthropic:operator", preferenceRevision: 3 });
  });

  test("uses the first admitted role candidate only when both choices are absent", () => {
    expect(resolveMemoryModelPreference("memorySummarization", {
      revision: 2,
      overrides: {},
    }, defaults, models)).toEqual({ modelId: "openrouter:automatic", preferenceRevision: 2 });
  });

  test("does not silently replace an unsupported explicit or operator choice", () => {
    for (const input of [
      { role: "memoryReview" as const, overrides: { memoryReview: "unknown:model" } },
      { role: "memoryReflection" as const, overrides: {} },
    ]) {
      const operatorDefaults = input.role === "memoryReflection"
        ? { ...defaults, memoryReflection: "unknown:model" }
        : defaults;
      expect(() => resolveMemoryModelPreference(
        input.role,
        { revision: 1, overrides: input.overrides },
        operatorDefaults,
        models,
      )).toThrow(MemoryModelPreferenceError);
    }
  });

  test("reports unavailable when no explicit, operator, or admitted candidate exists", () => {
    expect(() => resolveMemoryModelPreference("memorySummarization", {
      revision: 0,
      overrides: {},
    }, defaults, [])).toThrow("provider_credentials_missing");
  });
});
