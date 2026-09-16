import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateImagesGoogle } from "@nautilo/agent";
import type { GenerateImagesArgs } from "@nautilo/agent";

/** Minimal valid PNG base64 (1×1). */
const ONE_PX_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let origFetch: typeof fetch;

beforeEach(() => {
  origFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

function bodyJson(init?: RequestInit): Record<string, unknown> {
  const b = init?.body;
  const text =
    typeof b === "string"
      ? b
      : b instanceof Uint8Array
        ? new TextDecoder().decode(b)
        : b instanceof ArrayBuffer
          ? new TextDecoder().decode(new Uint8Array(b))
          : (() => {
              throw new Error(`unexpected fetch mock body type: ${typeof b}`);
            })();
  return JSON.parse(text) as Record<string, unknown>;
}

describe("generateImagesGoogle", () => {
  test("Gemini flash image uses generateContent with BLOCK_NONE safetySettings", async () => {
    let url = "";
    let parsedBody: Record<string, unknown> | null = null;
    globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
      url = String(input);
      parsedBody = bodyJson(init);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ inlineData: { mimeType: "image/png", data: ONE_PX_PNG_B64 } }],
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }) as unknown as typeof fetch;

    const args: GenerateImagesArgs = {
      model: "gemini-2.5-flash-image",
      prompt: "avatar",
      count: 1,
      size: "1024x1024",
      quality: "low",
      background: "opaque",
      format: "png",
    };

    const out = await generateImagesGoogle(args, "google-key");
    expect(url).toContain("gemini-2.5-flash-image:generateContent");
    expect(url).toContain("key=google-key");
    const safety = parsedBody?.["safetySettings"] as Array<{ threshold?: string }> | undefined;
    expect(Array.isArray(safety)).toBe(true);
    expect(safety?.every((s) => s.threshold === "BLOCK_NONE")).toBe(true);
    expect(out.bytes[0]!.length).toBeGreaterThan(0);
  });

  test("Imagen-4 uses predict with sampleCount", async () => {
    let url = "";
    let parsedBody: Record<string, unknown> | null = null;
    globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
      url = String(input);
      parsedBody = bodyJson(init);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            predictions: [{ bytesBase64Encoded: ONE_PX_PNG_B64 }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }) as unknown as typeof fetch;

    const args: GenerateImagesArgs = {
      model: "imagen-4",
      prompt: "avatar",
      count: 1,
      size: "auto",
      quality: "auto",
      background: "auto",
      format: "png",
    };

    await generateImagesGoogle(args, "google-key");
    expect(url).toContain("imagen-4:predict");
    const parameters = parsedBody!["parameters"] as { sampleCount?: number } | undefined;
    expect(parameters?.sampleCount).toBe(1);
  });

  test("non-2xx throws image generation failed", () => {
    globalThis.fetch = (() => Promise.resolve(new Response("err", { status: 503 }))) as unknown as typeof fetch;

    const args: GenerateImagesArgs = {
      model: "gemini-2.5-flash-image",
      prompt: "x",
      count: 1,
      size: "1024x1024",
      quality: "low",
      background: "opaque",
      format: "png",
    };

    return expect(generateImagesGoogle(args, "k")).rejects.toThrow(/image generation failed/i);
  });
});
