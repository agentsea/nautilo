import type {
  GenerateImagesArgs,
  GenerateImagesResult,
  GenerateImagesStreamEvent,
} from "./types";
import { readBoundedMediaJson, MAX_IMAGE_RESPONSE_JSON_BYTES, MediaResponseReadError } from "../providers/media-response";
import { assertImageOutputBounds, decodeBoundedImageBase64 } from "./bounds";
import { directImageHttpError, directImageInvalidResponse, directImageTransportError } from "./errors";

const MIME_FOR_FORMAT: Record<GenerateImagesArgs["format"], string> = {
  png: "image/png",
  webp: "image/webp",
  jpeg: "image/jpeg",
};

type Uint8StreamReadResult =
  | { readonly done: true; readonly value?: undefined }
  | { readonly done: false; readonly value: Uint8Array };

/**
 * OpenAI Images API — `POST /v1/images/generations`.
 */
export async function generateImagesOpenAi(
  args: GenerateImagesArgs,
  apiKey: string,
): Promise<GenerateImagesResult> {
  const n = Math.min(4, Math.max(1, Math.floor(Number(args.count)) || 1));
  const references = args.references ?? [];
  if (references.length > 0) {
    const body = new FormData();
    body.set("model", args.model);
    body.set("prompt", args.prompt);
    body.set("n", String(n));
    body.set("output_format", args.format);
    body.set("background", args.background);
    body.set("quality", args.quality);
    if (args.size !== "auto") body.set("size", args.size);
    for (const [index, reference] of references.entries()) {
      const extension = reference.mime === "image/jpeg"
        ? "jpg"
        : reference.mime.slice("image/".length);
      body.append(
        "image[]",
        new Blob([reference.bytes], { type: reference.mime }),
        `reference-${index + 1}.${extension}`,
      );
    }
    let res: Response;
    try {
      res = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body,
        redirect: "error",
      });
    } catch {
      throw directImageTransportError("OpenAI");
    }
    return parseOpenAiImageResponse(res, n, args);
  }
  const body: Record<string, unknown> = {
    model: args.model,
    prompt: args.prompt,
    n,
    quality: args.quality,
    output_format: args.format,
    background: args.background,
    moderation: "low", // ARCH: filters at documented minimum — see ISSUE-D113 §5.
  };
  if (args.size !== "auto") {
    body["size"] = args.size;
  }

  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
    });
  } catch {
    throw directImageTransportError("OpenAI");
  }

  return parseOpenAiImageResponse(res, n, args);
}

async function parseOpenAiImageResponse(
  res: Response,
  count: number,
  args: GenerateImagesArgs,
): Promise<GenerateImagesResult> {
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw directImageHttpError("openai", res.status);
  }

  let data: unknown;
  try {
    data = await readBoundedMediaJson(res, MAX_IMAGE_RESPONSE_JSON_BYTES);
  } catch (error) {
    if (error instanceof MediaResponseReadError) {
      throw directImageInvalidResponse("OpenAI", error.reason === "too_large" ? "oversized response" : "invalid response");
    }
    throw error;
  }

  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw directImageInvalidResponse("OpenAI", "invalid response envelope");
  }
  const row = data as { data?: Array<{ b64_json?: string }> };
  const items = row.data ?? [];
  const buffers: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    const b64 = items[i]?.b64_json;
    if (typeof b64 !== "string" || !b64.length) {
      throw directImageInvalidResponse("OpenAI", "missing b64_json in response");
    }
    buffers.push(decodeBoundedImageBase64(b64, "OpenAI"));
  }
  assertImageOutputBounds(buffers, "OpenAI");

  return {
    bytes: buffers,
    model: args.model,
    mime: MIME_FOR_FORMAT[args.format],
  };
}

function splitSseFrames(raw: string): { frames: string[]; remainder: string } {
  const frames: string[] = [];
  let start = 0;
  const frameBoundary = /\r?\n\r?\n/g;
  for (;;) {
    const match = frameBoundary.exec(raw);
    if (!match) break;
    frames.push(raw.slice(start, match.index));
    start = match.index + match[0].length;
  }
  return { frames, remainder: raw.slice(start) };
}

function parseSseFrames(frames: readonly string[]): Array<{ event: string | null; data: string }> {
  const events: Array<{ event: string | null; data: string }> = [];
  for (const block of frames) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    let event: string | null = null;
    const dataLines: string[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice("event:".length).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
    }
    if (dataLines.length > 0) events.push({ event, data: dataLines.join("\n") });
  }
  return events;
}

function parseStreamEvent(data: string): {
  type?: unknown;
  b64_json?: unknown;
  partial_image_index?: unknown;
} {
  try {
    const parsed = JSON.parse(data) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid envelope");
    }
    return parsed as {
      type?: unknown;
      b64_json?: unknown;
      partial_image_index?: unknown;
    };
  } catch {
    throw directImageInvalidResponse("OpenAI", "invalid streaming response");
  }
}

/**
 * OpenAI Images API streaming mode. Uses `stream: true` and `partial_images`
 * so callers can show progressive `image_generation.partial_image` previews
 * before the final `image_generation.completed` event.
 */
export async function* generateImagesOpenAiStream(
  args: GenerateImagesArgs,
  apiKey: string,
  partialImages = 3,
): AsyncGenerator<GenerateImagesStreamEvent> {
  const body: Record<string, unknown> = {
    model: args.model,
    prompt: args.prompt,
    n: 1,
    quality: args.quality,
    output_format: args.format,
    background: args.background,
    moderation: "low",
    stream: true,
    partial_images: Math.min(3, Math.max(1, Math.floor(partialImages))),
  };
  if (args.size !== "auto") {
    body["size"] = args.size;
  }

  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw directImageTransportError("OpenAI");
  }

  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw directImageHttpError("openai", res.status);
  }
  if (!res.body) {
    throw new Error("OpenAI image generation failed: missing streaming body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    let readResult: Uint8StreamReadResult;
    try {
      readResult = (await reader.read()) as Uint8StreamReadResult;
    } catch {
      throw directImageTransportError("OpenAI");
    }
    if (readResult.done) break;
    const value = readResult.value;
    buffer += decoder.decode(value, { stream: true });
    if (Buffer.byteLength(buffer, "utf8") > MAX_IMAGE_RESPONSE_JSON_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw directImageInvalidResponse("OpenAI", "oversized streaming response");
    }
    const { frames, remainder } = splitSseFrames(buffer);
    buffer = remainder;
    for (const event of parseSseFrames(frames)) {
      if (event.data === "[DONE]") continue;
      const parsed = parseStreamEvent(event.data);
      if (
        parsed.type === "image_generation.partial_image" &&
        typeof parsed.b64_json === "string"
      ) {
        decodeBoundedImageBase64(parsed.b64_json, "OpenAI");
        yield {
          type: "partial",
          b64Json: parsed.b64_json,
          partialImageIndex:
            typeof parsed.partial_image_index === "number"
              ? parsed.partial_image_index
              : 0,
          mime: MIME_FOR_FORMAT[args.format],
          model: args.model,
        };
      }
      if (
        parsed.type === "image_generation.completed" &&
        typeof parsed.b64_json === "string"
      ) {
        decodeBoundedImageBase64(parsed.b64_json, "OpenAI");
        yield {
          type: "completed",
          b64Json: parsed.b64_json,
          mime: MIME_FOR_FORMAT[args.format],
          model: args.model,
        };
      }
    }
  }
  if (buffer.trim()) {
    for (const event of parseSseFrames([buffer])) {
      if (event.data === "[DONE]") continue;
      const parsed = parseStreamEvent(event.data);
      if (
        parsed.type === "image_generation.partial_image" &&
        typeof parsed.b64_json === "string"
      ) {
        decodeBoundedImageBase64(parsed.b64_json, "OpenAI");
        yield {
          type: "partial",
          b64Json: parsed.b64_json,
          partialImageIndex:
            typeof parsed.partial_image_index === "number"
              ? parsed.partial_image_index
              : 0,
          mime: MIME_FOR_FORMAT[args.format],
          model: args.model,
        };
      }
      if (
        parsed.type === "image_generation.completed" &&
        typeof parsed.b64_json === "string"
      ) {
        decodeBoundedImageBase64(parsed.b64_json, "OpenAI");
        yield {
          type: "completed",
          b64Json: parsed.b64_json,
          mime: MIME_FOR_FORMAT[args.format],
          model: args.model,
        };
      }
    }
  }
}
