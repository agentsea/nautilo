import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  generateImagesGoogle,
  generateImagesOpenAi,
  type GenerateImagesArgs,
} from "../../src/image-gen";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function editArgs(model: string): GenerateImagesArgs {
  return {
    model,
    prompt: "turn the square red",
    count: 1,
    size: "auto",
    quality: "low",
    background: "auto",
    format: "png",
    references: [
      { bytes: Buffer.from("first"), mime: "image/png" },
      { bytes: Buffer.from("second"), mime: "image/webp" },
    ],
  };
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("direct image editing", () => {
  test("OpenAI uses multipart edits with ordered image parts and request-local key", async () => {
    let url = "";
    let form: FormData | undefined;
    let authorization = "";
    globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
      url = String(input);
      form = init?.body as FormData;
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return Promise.resolve(new Response(JSON.stringify({
        data: [{ b64_json: PNG_B64 }],
      }), { status: 200 }));
    }) as typeof fetch;

    await generateImagesOpenAi(editArgs("gpt-image-2"), "personal-openai-key");

    expect(url).toBe("https://api.openai.com/v1/images/edits");
    expect(authorization).toBe("Bearer personal-openai-key");
    expect(form?.get("model")).toBe("gpt-image-2");
    expect(form?.get("prompt")).toBe("turn the square red");
    const images = form?.getAll("image[]") ?? [];
    expect(images).toHaveLength(2);
    expect((images[0] as File).type).toBe("image/png");
    expect((images[1] as File).type).toBe("image/webp");
  });

  test("Gemini places authorized references before the edit instruction", async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = ((_input: string | URL, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("expected JSON body");
      body = JSON.parse(init.body) as Record<string, unknown>;
      return Promise.resolve(new Response(JSON.stringify({
        candidates: [{
          content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG_B64 } }] },
        }],
      }), { status: 200 }));
    }) as typeof fetch;

    await generateImagesGoogle(
      editArgs("gemini-2.5-flash-image"),
      "personal-google-key",
    );

    const contents = body["contents"] as Array<{ parts: Array<Record<string, unknown>> }>;
    expect(contents[0]?.parts).toEqual([
      { inlineData: { mimeType: "image/png", data: Buffer.from("first").toString("base64") } },
      { inlineData: { mimeType: "image/webp", data: Buffer.from("second").toString("base64") } },
      { text: "turn the square red" },
    ]);
  });
});
