import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  generateImagesOpenRouter,
  generateImagesVenice,
  imageUsageModelId,
  type GenerateImagesArgs,
} from "../../src/image-gen";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const args = (model: string): GenerateImagesArgs => ({
  model,
  prompt: "a lighthouse",
  count: 2,
  size: "1536x1024",
  quality: "high",
  background: "opaque",
  format: "png",
});

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("routed image adapters", () => {
  test("usage identity retains the selected route", () => {
    expect(imageUsageModelId("openrouter", "openai/gpt-image-2")).toBe(
      "openrouter:openai/gpt-image-2",
    );
    expect(imageUsageModelId("venice", "gpt-image-2")).toBe("venice:gpt-image-2");
  });
  test("OpenRouter uses its dedicated Images API and route slug", async () => {
    let url = "";
    let body: Record<string, unknown> = {};
    globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
      url = String(input);
      if (typeof init?.body !== "string") throw new Error("expected JSON request body");
      body = JSON.parse(init.body) as Record<string, unknown>;
      return Promise.resolve(new Response(JSON.stringify({
        data: [{ b64_json: PNG }, { b64_json: PNG }],
        usage: { total_tokens: 10, cost: 0.1 },
      }), { status: 200 }));
    }) as typeof fetch;

    const result = await generateImagesOpenRouter(
      args("openai/gpt-image-2"),
      "or-key",
    );
    expect(url).toBe("https://openrouter.ai/api/v1/images");
    expect(body["model"]).toBe("openai/gpt-image-2");
    expect(body["n"]).toBe(2);
    expect(result.bytes).toHaveLength(2);
    expect(result.model).toBe("openai/gpt-image-2");
  });

  test("Venice uses the native endpoint and resolution-tier request", async () => {
    let url = "";
    let body: Record<string, unknown> = {};
    globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
      url = String(input);
      if (typeof init?.body !== "string") throw new Error("expected JSON request body");
      body = JSON.parse(init.body) as Record<string, unknown>;
      return Promise.resolve(new Response(JSON.stringify({ images: [PNG, PNG] }), { status: 200 }));
    }) as typeof fetch;

    const result = await generateImagesVenice(args("gpt-image-2"), "vk-key");
    expect(url).toBe("https://api.venice.ai/api/v1/image/generate");
    expect(body).toMatchObject({
      model: "gpt-image-2",
      variants: 2,
      aspect_ratio: "3:2",
      resolution: "1K",
      quality: "high",
    });
    expect(result.bytes).toHaveLength(2);
    expect(result.model).toBe("gpt-image-2");
  });

  test("Venice omits GPT-only quality for Seedream", async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = ((_input: string | URL, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("expected JSON request body");
      body = JSON.parse(init.body) as Record<string, unknown>;
      return Promise.resolve(new Response(JSON.stringify({ images: [PNG] }), { status: 200 }));
    }) as typeof fetch;

    await generateImagesVenice(args("seedream-v5-pro"), "vk-key");
    expect(body).toMatchObject({
      model: "seedream-v5-pro",
      aspect_ratio: "3:2",
      resolution: "1K",
    });
    expect(body).not.toHaveProperty("quality");
  });

  test("provider failures are labeled without leaking authorization", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response("secret-key should never escape", { status: 400 }))) as unknown as typeof fetch;
    expect(
      generateImagesOpenRouter(args("openai/gpt-image-2"), "secret-key"),
    ).rejects.toThrow("OpenRouter image generation failed (HTTP 400).");
    expect(generateImagesVenice(args("gpt-image-2"), "secret-key")).rejects.toThrow(
      "Venice image generation failed (HTTP 400).",
    );
  });
});
