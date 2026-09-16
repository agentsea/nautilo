import type {
  GenerateImagesArgs,
  GenerateImagesResult,
  GenerateImagesStreamEvent,
} from "./types";

const MIME_FOR_FORMAT: Record<GenerateImagesArgs["format"], string> = {
  png: "image/png",
  webp: "image/webp",
  jpeg: "image/jpeg",
};

type Uint8StreamReadResult =
  | { readonly done: true; readonly value?: undefined }
  | { readonly done: false; readonly value: Uint8Array };

function truncateBody(text: string, max = 300): string {
  return text.length <= max ? text : text.slice(0, max);
}

/**
 * OpenAI Images API — `POST /v1/images/generations`.
 */
export async function generateImagesOpenAi(
  args: GenerateImagesArgs,
  apiKey: string,
): Promise<GenerateImagesResult> {
  const n = Math.min(4, Math.max(1, Math.floor(Number(args.count)) || 1));
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

  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const bodyText = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(
      `OpenAI image generation failed (HTTP ${res.status}): ${truncateBody(bodyText)}`,
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(bodyText) as unknown;
  } catch {
    throw new Error(
      `OpenAI image generation failed (HTTP ${res.status}): invalid JSON body`,
    );
  }

  const row = data as { data?: Array<{ b64_json?: string }> };
  const items = row.data ?? [];
  const buffers: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    const b64 = items[i]?.b64_json;
    if (typeof b64 !== "string" || !b64.length) {
      throw new Error("OpenAI image generation failed: missing b64_json in response");
    }
    buffers.push(Buffer.from(b64, "base64"));
  }

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

  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(
      `OpenAI image generation failed (HTTP ${res.status}): ${truncateBody(bodyText)}`,
    );
  }
  if (!res.body) {
    throw new Error("OpenAI image generation failed: missing streaming body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const readResult = (await reader.read()) as Uint8StreamReadResult;
    if (readResult.done) break;
    const value = readResult.value;
    buffer += decoder.decode(value, { stream: true });
    const { frames, remainder } = splitSseFrames(buffer);
    buffer = remainder;
    for (const event of parseSseFrames(frames)) {
      if (event.data === "[DONE]") continue;
      const parsed = JSON.parse(event.data) as {
        type?: unknown;
        b64_json?: unknown;
        partial_image_index?: unknown;
      };
      if (
        parsed.type === "image_generation.partial_image" &&
        typeof parsed.b64_json === "string"
      ) {
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
      const parsed = JSON.parse(event.data) as {
        type?: unknown;
        b64_json?: unknown;
        partial_image_index?: unknown;
      };
      if (
        parsed.type === "image_generation.partial_image" &&
        typeof parsed.b64_json === "string"
      ) {
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
