import type { GenerateImagesArgs, GenerateImagesResult } from "./types";
import { VENICE_IMAGE_GENERATION_URL } from "../providers/venice-api";

function aspectRatio(size: GenerateImagesArgs["size"]): string {
  if (size === "1536x1024") return "3:2";
  if (size === "1024x1536") return "2:3";
  return "1:1";
}

function failure(status: number): Error {
  if (status === 401 || status === 403) {
    return new Error("Venice rejected the image-generation credential.");
  }
  if (status === 402) return new Error("Venice has insufficient credits for image generation.");
  if (status === 429) return new Error("Venice rate-limited image generation. Retry shortly.");
  return new Error(`Venice image generation failed (HTTP ${status}).`);
}

export async function generateImagesVenice(
  args: GenerateImagesArgs,
  apiKey: string,
): Promise<GenerateImagesResult> {
  const body: Record<string, unknown> = {
    model: args.model,
    prompt: args.prompt,
    variants: Math.min(4, Math.max(1, Math.floor(args.count))),
    format: args.format,
    aspect_ratio: aspectRatio(args.size),
    resolution: "1K",
    safe_mode: false,
    ...(args.model === "gpt-image-2" && args.quality !== "auto"
      ? { quality: args.quality }
      : {}),
  };
  const response = await fetch(VENICE_IMAGE_GENERATION_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    throw failure(response.status);
  }
  let parsed: { images?: unknown[] };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new Error("Venice image generation failed: invalid JSON body");
  }
  const bytes = (parsed.images ?? []).map((image) => {
    if (typeof image !== "string" || !image) {
      throw new Error("Venice image generation failed: missing base64 image in response");
    }
    return Buffer.from(image, "base64");
  });
  if (bytes.length === 0) throw new Error("Venice image generation failed: empty response");
  return { bytes, model: args.model, mime: `image/${args.format}` };
}
