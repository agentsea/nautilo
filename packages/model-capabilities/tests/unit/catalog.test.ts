import { afterEach, describe, expect, test } from "bun:test";
import {
  mapOpenRouterModalitiesToInput,
  mapOpenRouterModalitiesToOutput,
  mapOpenRouterSupportedParameters,
  modelSupportsFeature,
  modelSupportsInput,
  modelSupportsOutput,
  replaceActiveModelCapabilityCatalog,
  resetModelCapabilitiesCacheForTests,
  resolveModelCapabilities,
  setModelCapabilitiesCacheForTests,
} from "../../src/index";
import { MODEL_CAPABILITY_OVERRIDES } from "../../src/overrides";

describe("mapOpenRouterModalitiesToInput", () => {
  test("defaults to text when absent", () => {
    expect(mapOpenRouterModalitiesToInput(undefined)).toEqual(["text"]);
    expect(mapOpenRouterModalitiesToInput([])).toEqual(["text"]);
  });

  test("maps image + text", () => {
    expect(mapOpenRouterModalitiesToInput(["text", "image"])).toEqual(["text", "image"]);
  });
});

describe("mapOpenRouterModalitiesToOutput", () => {
  test("defaults sensibly", () => {
    expect(mapOpenRouterModalitiesToOutput(undefined)).toEqual(["text"]);
  });

  test("maps text and image", () => {
    expect(mapOpenRouterModalitiesToOutput(["text", "image"])).toEqual(["text", "image"]);
  });
});

describe("mapOpenRouterSupportedParameters", () => {
  test("maps known flags", () => {
    expect(
      mapOpenRouterSupportedParameters(["tools", "structured_outputs", "reasoning"]),
    ).toEqual({
      tools: true,
      structuredOutputs: true,
      reasoning: true,
    });
  });

  test("treats absent array as all false", () => {
    expect(mapOpenRouterSupportedParameters(undefined)).toEqual({
      tools: false,
      structuredOutputs: false,
      reasoning: false,
    });
  });

  test("accepts response_format as structured outputs", () => {
    expect(mapOpenRouterSupportedParameters(["response_format"]).structuredOutputs).toBe(true);
  });
});

describe("resolveModelCapabilities", () => {
  afterEach(() => {
    resetModelCapabilitiesCacheForTests();
    replaceActiveModelCapabilityCatalog(null);
  });

  test("active signed catalog fields override legacy rows and reset atomically", () => {
    const id = "venice:minimax-m3-preview";
    replaceActiveModelCapabilityCatalog(null);
    expect(modelSupportsInput(id, "image")).toBe(false);

    replaceActiveModelCapabilityCatalog([{
      id,
      modalities: { input: ["text", "image"], output: ["text"] },
      features: { tools: true, structuredOutputs: false, reasoning: true },
      capabilityProvenance: "override",
    }]);
    expect(resolveModelCapabilities(id)).toMatchObject({
      modelId: id,
      input: ["text", "image"],
      output: ["text"],
      features: { tools: true, structuredOutputs: false, reasoning: true },
      provenance: "override",
    });

    replaceActiveModelCapabilityCatalog([]);
    expect(modelSupportsInput(id, "image")).toBe(false);
    expect(modelSupportsFeature(id, "reasoning")).toBe(false);
  });

  test("signed rows with omitted capability fields preserve legacy fallback", () => {
    const id = "anthropic:claude-sonnet-4-6";
    replaceActiveModelCapabilityCatalog([{ id }]);
    expect(modelSupportsInput(id, "image")).toBe(true);
    expect(modelSupportsInput(id, "file")).toBe(true);
    expect(modelSupportsFeature(id, "reasoning")).toBe(true);
  });

  test("anthropic:claude-sonnet-5 override exposes reasoning, vision, and file input", () => {
    const id = "anthropic:claude-sonnet-5";
    expect(modelSupportsFeature(id, "reasoning")).toBe(true);
    expect(modelSupportsInput(id, "image")).toBe(true);
    expect(modelSupportsInput(id, "file")).toBe(true);
    expect(resolveModelCapabilities(id).provenance).toBe("override");
  });

  test("anthropic:claude-fable-5 override exposes reasoning, vision, and file input", () => {
    const id = "anthropic:claude-fable-5";
    expect(modelSupportsFeature(id, "reasoning")).toBe(true);
    expect(modelSupportsInput(id, "image")).toBe(true);
    expect(modelSupportsInput(id, "file")).toBe(true);
    expect(resolveModelCapabilities(id).provenance).toBe("override");
  });

  test("Claude / GPT / Gemini overrides include vision", () => {
    expect(modelSupportsInput("anthropic:claude-sonnet-4-6", "image")).toBe(true);
    expect(modelSupportsInput("anthropic:claude-opus-4-7", "image")).toBe(true);
    expect(modelSupportsInput("anthropic:claude-opus-4-6", "image")).toBe(true);
    expect(modelSupportsInput("openai:gpt-5.5-2026-04-23", "image")).toBe(true);
    expect(modelSupportsInput("openai:gpt-5.4-2026-03-05", "image")).toBe(true);
    expect(modelSupportsInput("google:gemini-2.5-pro", "image")).toBe(true);
    expect(modelSupportsInput("google:gemini-3.1-pro-preview", "image")).toBe(true);
    expect(modelSupportsInput("fireworks:accounts/fireworks/models/gemma-4-31b-it", "image")).toBe(true);
    expect(modelSupportsInput("openrouter:google/gemma-4-26b-a4b-it", "image")).toBe(true);
  });

  test("full Fireworks GLM 5.3 exposes verified text/tools/reasoning without borrowing another route", () => {
    const id = "fireworks:accounts/fireworks/models/glm-5p3";
    expect(resolveModelCapabilities(id)).toEqual({ modelId: id, input: ["text"], output: ["text"], provenance: "override",
      features: { tools: true, structuredOutputs: false, reasoning: true } });
    expect(modelSupportsInput(id, "image")).toBe(false);
    expect(modelSupportsFeature(id, "reasoning")).toBe(true);
  });

  test("Fireworks Kimi / GLM overrides are text-only", () => {
    expect(modelSupportsInput("fireworks:accounts/fireworks/models/kimi-k2p5", "image")).toBe(false);
    expect(modelSupportsInput("fireworks:accounts/fireworks/models/glm-5p2", "image")).toBe(false);
    expect(modelSupportsInput("fireworks:accounts/fireworks/models/glm-5", "image")).toBe(false);
    expect(resolveModelCapabilities("fireworks:accounts/fireworks/models/glm-5p2").features?.tools).toBe(true);
  });

  test("Stack 166 — GPT-5.6 family (sol/terra/luna) resolve to overrides with vision, file, tools, and reasoning", () => {
    for (const id of ["openai:gpt-5.6-sol", "openai:gpt-5.6-terra", "openai:gpt-5.6-luna"]) {
      expect(resolveModelCapabilities(id).provenance).toBe("override");
      expect(modelSupportsInput(id, "image")).toBe(true);
      expect(modelSupportsInput(id, "file")).toBe(true);
      expect(modelSupportsFeature(id, "tools")).toBe(true);
      expect(modelSupportsFeature(id, "reasoning")).toBe(true);
      expect(modelSupportsFeature(id, "structuredOutputs")).toBe(false);
    }
  });

  test("provider reasoning overrides cover GPT, Fireworks, Venice, and OpenRouter", () => {
    expect(modelSupportsFeature("openai:gpt-5.5-2026-04-23", "reasoning")).toBe(true);
    expect(modelSupportsFeature("fireworks:accounts/fireworks/models/deepseek-v4-pro", "reasoning")).toBe(true);
    expect(modelSupportsFeature("fireworks:accounts/fireworks/models/deepseek-v4-pro-0813", "reasoning")).toBe(true);
    expect(modelSupportsFeature("fireworks:accounts/fireworks/models/deepseek-v4-pro-0813", "structuredOutputs")).toBe(false);
    expect(modelSupportsFeature("openrouter:deepseek/deepseek-v4-pro-0813", "reasoning")).toBe(true);
    expect(modelSupportsFeature("openrouter:deepseek/deepseek-v4-pro-0813", "structuredOutputs")).toBe(true);
    expect(modelSupportsFeature("fireworks:accounts/fireworks/models/glm-5p1", "reasoning")).toBe(true);
    expect(modelSupportsFeature("openrouter:z-ai/glm-5.1", "reasoning")).toBe(true);
    expect(modelSupportsFeature("venice:zai-org-glm-5-1", "reasoning")).toBe(true);
    expect(modelSupportsFeature("venice:openai-gpt-55-pro", "reasoning")).toBe(true);
  });

  test("GLM 5.3 overrides match the reviewed OpenRouter and Venice capabilities", () => {
    for (const id of ["openrouter:z-ai/glm-5.3", "venice:z-ai-glm-5-3"]) {
      expect(resolveModelCapabilities(id).provenance).toBe("override");
      expect(modelSupportsInput(id, "image")).toBe(false);
      expect(modelSupportsFeature(id, "tools")).toBe(true);
      expect(modelSupportsFeature(id, "structuredOutputs")).toBe(true);
      expect(modelSupportsFeature(id, "reasoning")).toBe(true);
    }
  });

  test("Venice Kimi K3 and the E2EE replacement preserve their distinct live capabilities", () => {
    expect(modelSupportsInput("venice:kimi-k3", "image")).toBe(true);
    expect(modelSupportsFeature("venice:kimi-k3", "tools")).toBe(true);
    expect(modelSupportsFeature("venice:kimi-k3", "structuredOutputs")).toBe(true);
    expect(modelSupportsFeature("venice:kimi-k3", "reasoning")).toBe(true);

    expect(modelSupportsInput("venice:e2ee-deepseek-v4-flash", "image")).toBe(false);
    expect(modelSupportsFeature("venice:e2ee-deepseek-v4-flash", "tools")).toBe(true);
    expect(modelSupportsFeature("venice:e2ee-deepseek-v4-flash", "reasoning")).toBe(true);
  });

  test("Fireworks Kimi K3 exposes its reviewed vision, tool, and reasoning capabilities", () => {
    const kimi = resolveModelCapabilities("fireworks:accounts/fireworks/models/kimi-k3");
    expect(kimi.input).toEqual(["text", "image"]);
    expect(kimi.features).toMatchObject({
      tools: true,
      structuredOutputs: false,
      reasoning: true,
    });
  });

  test("D113 image overrides expose image output where defined", () => {
    expect(modelSupportsOutput("openai:gpt-image-2", "image")).toBe(true);
    expect(modelSupportsOutput("openai:gpt-image-2", "text")).toBe(false);
    expect(modelSupportsOutput("google:imagen-4", "image")).toBe(true);
    expect(modelSupportsOutput("google:gemini-2.5-flash-image", "text")).toBe(true);
    expect(modelSupportsOutput("google:gemini-2.5-flash-image", "image")).toBe(true);
  });

  test("unknown model defaults to text-only", () => {
    const row = resolveModelCapabilities("unknown:model");
    expect(row.provenance).toBe("default");
    expect(row.input).toEqual(["text"]);
  });

  test("every baked override row lists text input", () => {
    for (const id of Object.keys(MODEL_CAPABILITY_OVERRIDES)) {
      expect(resolveModelCapabilities(id).input).toContain("text");
    }
  });

  test("dynamic openrouter ids resolve capabilities from cached slug rows", () => {
    setModelCapabilitiesCacheForTests({
      fetchedAt: "2026-04-30T00:00:00.000Z",
      models: {
        "openai/gpt-5.5": {
          input: ["text", "image"],
          output: ["text"],
          features: { tools: true, structuredOutputs: true, reasoning: true },
        },
      },
    });

    const row = resolveModelCapabilities("openrouter:openai/gpt-5.5");
    expect(row.provenance).toBe("openrouter");
    expect(row.fetchedAt).toBe("2026-04-30T00:00:00.000Z");
    expect(row.input).toEqual(["text", "image"]);
    expect(modelSupportsInput("openrouter:openai/gpt-5.5", "image")).toBe(true);
    expect(row.features?.tools).toBe(true);
  });
});
