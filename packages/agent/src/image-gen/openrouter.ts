import type { GenerateImagesArgs, GenerateImagesResult } from "./types";
import { readBoundedMediaJson, MAX_IMAGE_RESPONSE_JSON_BYTES, MediaResponseReadError } from "../providers/media-response";
import { assertImageOutputBounds, decodeBoundedImageBase64 } from "./bounds";
import {
  directImageAdmissionError,
  directImageHttpError,
  directImageInvalidResponse,
  directImageTransportError,
} from "./errors";

const OPENROUTER_IMAGES_URL = "https://openrouter.ai/api/v1/images";

export async function generateImagesOpenRouter(
  args: GenerateImagesArgs,
  apiKey: string,
): Promise<GenerateImagesResult> {
  if ((args.references?.length ?? 0) > 0) {
    throw directImageAdmissionError(`OpenRouter image model ${args.model} has no qualified reference-edit request shape.`);
  }
  const count = Math.min(4, Math.max(1, Math.floor(args.count)));
  const body: Record<string, unknown> = {
    model: args.model,
    prompt: args.prompt,
    n: count,
    quality: args.quality,
    output_format: args.format,
    background: args.background,
  };
  if (args.size !== "auto") body["size"] = args.size;
  let response: Response;
  try {
    response = await fetch(OPENROUTER_IMAGES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
    });
  } catch {
    throw directImageTransportError("OpenRouter");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw directImageHttpError("openrouter", response.status);
  }
  let parsed: { data?: Array<{ b64_json?: unknown }> };
  try {
    parsed = await readBoundedMediaJson(response, MAX_IMAGE_RESPONSE_JSON_BYTES) as typeof parsed;
  } catch (error) {
    if (error instanceof MediaResponseReadError) {
      throw directImageInvalidResponse("OpenRouter", error.reason === "too_large" ? "oversized response" : "invalid response");
    }
    throw error;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw directImageInvalidResponse("OpenRouter", "invalid response envelope");
  }
  const bytes = (parsed.data ?? []).map((item) => {
    if (typeof item.b64_json !== "string" || !item.b64_json) {
      throw directImageInvalidResponse("OpenRouter", "missing b64_json in response");
    }
    return decodeBoundedImageBase64(item.b64_json, "OpenRouter");
  });
  if (bytes.length !== count) {
    throw directImageInvalidResponse("OpenRouter", "unexpected image count");
  }
  assertImageOutputBounds(bytes, "OpenRouter");
  return { bytes, model: args.model, mime: `image/${args.format}` };
}
