import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateImagesOpenAi, generateImagesOpenAiStream } from "@nautilo/agent";
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

const baseArgs = (): GenerateImagesArgs => ({
  model: "gpt-image-2",
  prompt: "test prompt",
  count: 1,
  size: "1024x1024",
  quality: "low",
  background: "opaque",
  format: "png",
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

describe("generateImagesOpenAi", () => {
  test("POSTs v1/images/generations with moderation low and returns buffers", async () => {
    let url = "";
    let parsedBody: Record<string, unknown> | null = null;
    globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
      url = String(input);
      parsedBody = bodyJson(init);
      return Promise.resolve(
        new Response(JSON.stringify({ data: [{ b64_json: ONE_PX_PNG_B64 }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;

    const out = await generateImagesOpenAi(baseArgs(), "sk-test");
    expect(url).toBe("https://api.openai.com/v1/images/generations");
    expect(parsedBody!["moderation"]).toBe("low");
    expect(parsedBody!["model"]).toBe("gpt-image-2");
    expect(out.bytes.length).toBe(1);
    expect(out.bytes[0]!.length).toBeGreaterThan(0);
    expect(out.mime).toBe("image/png");
  });

  test("4xx response throws with image generation failed message", () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response("bad request body here", { status: 400 }))) as unknown as typeof fetch;

    return expect(generateImagesOpenAi(baseArgs(), "sk-test")).rejects.toThrow(/image generation failed/i);
  });

  test("streaming mode requests gpt-image-2 partial images and yields previews", async () => {
    let parsedBody: Record<string, unknown> | null = null;
    globalThis.fetch = ((_input: string | URL, init?: RequestInit) => {
      parsedBody = bodyJson(init);
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `event: image_generation.partial_image\r\n` +
                `data: {"type":"image_generation.partial_image","b64_json":"${ONE_PX_PNG_B64}","partial_image_index":0}\r\n\r\n` +
                `event: image_generation.completed\r\n` +
                `data: {"type":"image_generation.completed","b64_json":"${ONE_PX_PNG_B64}"}\r\n\r\n`,
            ),
          );
          controller.close();
        },
      });
      return Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    }) as unknown as typeof fetch;

    const events = [];
    for await (const event of generateImagesOpenAiStream(baseArgs(), "sk-test", 3)) {
      events.push(event);
    }

    expect(parsedBody!["model"]).toBe("gpt-image-2");
    expect(parsedBody!["stream"]).toBe(true);
    expect(parsedBody!["partial_images"]).toBe(3);
    expect(events.map((event) => event.type)).toEqual(["partial", "completed"]);
  });
});
