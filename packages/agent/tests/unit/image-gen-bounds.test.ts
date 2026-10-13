import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ATTACHMENT_POLICY, maxChatImageBase64CharLength } from "@nautilo/attachments";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertImageOutputBounds,
  decodeBoundedImageBase64,
  generateImagesOpenAiStream,
  generateImagesOpenRouter,
  type GenerateImagesArgs,
} from "../../src/image-gen";
import { MAX_IMAGE_RESPONSE_JSON_BYTES } from "../../src/providers/media-response";
import { readBoundedImageReference } from "../../src/tools/media/generate-image";

const args: GenerateImagesArgs = {
  model: "openai/gpt-image-2",
  prompt: "a lighthouse",
  count: 1,
  size: "auto",
  quality: "low",
  background: "auto",
  format: "png",
};

let originalFetch: typeof fetch;
let tempRoot = "";

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((error: unknown) => error);
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : "";
}

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  tempRoot = await mkdtemp(join(tmpdir(), "nautilo-image-bounds-"));
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await rm(tempRoot, { recursive: true, force: true });
});

describe("image byte bounds", () => {
  test("rejects oversized references before allocation and detects a changed file", async () => {
    const path = join(tempRoot, "reference.png");
    await writeFile(path, Buffer.from("small"));

    expect(messageOf(await caught(readBoundedImageReference(
      path,
      ATTACHMENT_POLICY.maxImageBytes + 1,
      0,
    )))).toContain("exceeds the supported image size");
    expect(messageOf(await caught(readBoundedImageReference(path, 4, 0))))
      .toContain("changed or could not be read safely");
    expect(messageOf(await caught(readBoundedImageReference(
      path,
      5,
      ATTACHMENT_POLICY.maxAcceptedBytesPerMessage - 4,
    )))).toContain("exceed the supported total size");
  });

  test("enforces decoded per-image and aggregate output limits", () => {
    expect(() => decodeBoundedImageBase64(
      "A".repeat(maxChatImageBase64CharLength() + 4),
      "Test provider",
    )).toThrow("invalid or oversized image data");
    expect(() => assertImageOutputBounds([
      Buffer.alloc(ATTACHMENT_POLICY.maxImageBytes),
      Buffer.alloc(ATTACHMENT_POLICY.maxImageBytes),
      Buffer.alloc(1),
    ], "Test provider")).toThrow("more image data");
  });

  test("rejects a synchronous JSON response above the encoded image envelope", async () => {
    globalThis.fetch = (() => Promise.resolve(new Response("{}", {
      headers: { "Content-Length": String(MAX_IMAGE_RESPONSE_JSON_BYTES + 1) },
    }))) as unknown as typeof fetch;

    expect(messageOf(await caught(generateImagesOpenRouter(args, "key"))))
      .toContain("oversized response");
  });

  test("rejects an oversized base64 image carried by the streaming adapter", async () => {
    const payload = JSON.stringify({
      type: "image_generation.completed",
      b64_json: "A".repeat(maxChatImageBase64CharLength() + 4),
    });
    globalThis.fetch = (() => Promise.resolve(new Response(
      `data: ${payload}\n\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    ))) as unknown as typeof fetch;

    const consume = async () => {
      for await (const _event of generateImagesOpenAiStream(args, "key")) {
        // consume
      }
    };
    expect(messageOf(await caught(consume())))
      .toContain("invalid or oversized image data");
  });
});
