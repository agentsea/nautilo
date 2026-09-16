import { describe, expect, test } from "bun:test";
import {
  MODEL_ROLE_CANDIDATES,
  candidatesForModelRole,
} from "../../src/model-role-candidates";

describe("model role candidates", () => {
  const minimaxRoles = [
    "chat",
    "conductor",
    "stenographer",
    "sessionSearch",
    "memoryFlush",
    "memoryReview",
    "webSearchSynthesis",
    "systemTasks",
    "visionFallback",
  ] as const;
  const deepResearchRoles = [
    "deepResearchSupervisor",
    "deepResearchResearcher",
    "deepResearchSynthesis",
    "deepResearchFinalReport",
  ] as const;

  test("every role is ordered, non-empty, and duplicate-free", () => {
    for (const [role, candidates] of Object.entries(MODEL_ROLE_CANDIDATES)) {
      expect(candidates.length, role).toBeGreaterThan(0);
      expect(new Set(candidates).size, role).toBe(candidates.length);
      expect(candidatesForModelRole(role as keyof typeof MODEL_ROLE_CANDIDATES)).toEqual(
        candidates,
      );
    }
  });

  test("mini-cloud roles have OpenRouter and Venice candidates", () => {
    for (const [role, candidates] of Object.entries(MODEL_ROLE_CANDIDATES)) {
      expect(candidates.some((id) => id.startsWith("openrouter:")), role).toBe(true);
      expect(candidates.some((id) => id.startsWith("venice:")), role).toBe(true);
    }
  });

  test("general automatic roles prefer MiniMax M3 through OpenRouter then Venice", () => {
    for (const role of minimaxRoles) {
      expect(MODEL_ROLE_CANDIDATES[role].slice(0, 2), role).toEqual([
        "openrouter:minimax/minimax-m3",
        "venice:minimax-m3-preview",
      ]);
      expect(MODEL_ROLE_CANDIDATES[role].some((id) => id.startsWith("openai:")), role)
        .toBe(role === "webSearchSynthesis" || role === "visionFallback" ? false : true);
    }
  });

  test("all four Deep Research roles prefer Kimi K3 through OpenRouter then Venice", () => {
    for (const role of deepResearchRoles) {
      expect(MODEL_ROLE_CANDIDATES[role].slice(0, 2), role).toEqual([
        "openrouter:moonshotai/kimi-k3",
        "venice:kimi-k3",
      ]);
      expect(MODEL_ROLE_CANDIDATES[role].some((id) => id.startsWith("openai:")), role)
        .toBe(true);
    }
  });

  test("routed image identities stay distinct", () => {
    expect(MODEL_ROLE_CANDIDATES.imageGeneration).toEqual([
      "openai:gpt-image-2.5-sunburst",
      "openai:gpt-image-2.5-flare",
      "venice:gpt-image-2",
      "openrouter:openai/gpt-5.4-image-2",
      "openrouter:openai/gpt-image-2",
      "openai:gpt-image-2",
      "google:gemini-2.5-flash-image",
    ]);
  });

  test("embeddings prefer Qwen 3 while retaining the existing provider choices", () => {
    expect(MODEL_ROLE_CANDIDATES.embeddings).toEqual([
      "venice:text-embedding-qwen3-8b",
      "openrouter:qwen/qwen3-embedding-8b",
      "venice:text-embedding-3-small",
      "openrouter:openai/text-embedding-3-small",
      "openai:text-embedding-3-small",
    ]);
  });
});
