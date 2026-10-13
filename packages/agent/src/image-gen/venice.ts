import type { GenerateImagesArgs, GenerateImagesResult } from "./types";
import { VENICE_IMAGE_GENERATION_URL } from "../providers/venice-api";
import { readBoundedMediaJson, MAX_IMAGE_RESPONSE_JSON_BYTES, MediaResponseReadError } from "../providers/media-response";
import { assertImageOutputBounds, decodeBoundedImageBase64 } from "./bounds";
import { directImageAdmissionError, directImageHttpError, directImageInvalidResponse, directImageTransportError } from "./errors";

function aspectRatio(size: GenerateImagesArgs["size"]): string {
  if (size === "1536x1024") return "3:2";
  if (size === "1024x1536") return "2:3";
  return "1:1";
}

export async function generateImagesVenice(
  args: GenerateImagesArgs,
  apiKey: string,
): Promise<GenerateImagesResult> {
  if ((args.references?.length ?? 0) > 0) {
    throw directImageAdmissionError(`Venice image model ${args.model} has no qualified reference-edit request shape.`);
  }
  const count = Math.min(4, Math.max(1, Math.floor(args.count)));
  const body: Record<string, unknown> = {
    model: args.model,
    prompt: args.prompt,
    variants: count,
    format: args.format,
    aspect_ratio: aspectRatio(args.size),
    resolution: "1K",
    safe_mode: false,
    ...(args.model === "gpt-image-2" && args.quality !== "auto"
      ? { quality: args.quality }
      : {}),
  };
  let response: Response;
  try {
    response = await fetch(VENICE_IMAGE_GENERATION_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
    });
  } catch {
    throw directImageTransportError("Venice");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw directImageHttpError("venice", response.status);
  }
  let parsed: { images?: unknown[] };
  try {
    parsed = await readBoundedMediaJson(response, MAX_IMAGE_RESPONSE_JSON_BYTES) as typeof parsed;
  } catch (error) {
    if (error instanceof MediaResponseReadError) {
      throw directImageInvalidResponse("Venice", error.reason === "too_large" ? "oversized response" : "invalid response");
    }
    throw error;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw directImageInvalidResponse("Venice", "invalid response envelope");
  }
  const bytes = (parsed.images ?? []).map((image) => {
    if (typeof image !== "string" || !image) {
      throw directImageInvalidResponse("Venice", "missing base64 image in response");
    }
    return decodeBoundedImageBase64(image, "Venice");
  });
  if (bytes.length !== count) {
    throw directImageInvalidResponse("Venice", "unexpected image count");
  }
  assertImageOutputBounds(bytes, "Venice");
  return { bytes, model: args.model, mime: `image/${args.format}` };
}
