import type { GenerateImagesArgs, GenerateImagesResult } from "./types";
import { readBoundedMediaJson, MAX_IMAGE_RESPONSE_JSON_BYTES, MediaResponseReadError } from "../providers/media-response";
import { assertImageOutputBounds, decodeBoundedImageBase64 } from "./bounds";
import { directImageAdmissionError, directImageHttpError, directImageInvalidResponse, directImageTransportError } from "./errors";

function geminiGenerateContentUrl(apiModel: string, apiKey: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${apiModel}:generateContent?key=${encodeURIComponent(apiKey)}`;
}

function imagenPredictUrl(apiModel: string, apiKey: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${apiModel}:predict?key=${encodeURIComponent(apiKey)}`;
}

async function fetchGeminiOneImage(
  apiModel: string,
  apiKey: string,
  prompt: string,
  references: GenerateImagesArgs["references"],
): Promise<{ bytes: Buffer; mime: string }> {
  let res: Response;
  try {
    res = await fetch(geminiGenerateContentUrl(apiModel, apiKey), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            ...(references ?? []).map((reference) => ({
              inlineData: {
                mimeType: reference.mime,
                data: reference.bytes.toString("base64"),
              },
            })),
            { text: prompt },
          ],
        }],
        generationConfig: { responseModalities: ["IMAGE"] },
        safetySettings: [
          // ARCH: filters at documented minimum — see ISSUE-D113 §5.
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        ],
      }),
    });
  } catch {
    throw directImageTransportError("Google");
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw directImageHttpError("google", res.status);
  }

  let data: unknown;
  try {
    data = await readBoundedMediaJson(res, MAX_IMAGE_RESPONSE_JSON_BYTES);
  } catch (error) {
    if (error instanceof MediaResponseReadError) {
      throw directImageInvalidResponse("Google", error.reason === "too_large" ? "oversized response" : "invalid response");
    }
    throw error;
  }

  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw directImageInvalidResponse("Google", "invalid response envelope");
  }
  const candidates = (data as { candidates?: unknown[] }).candidates ?? [];
  const parts =
    (candidates[0] as { content?: { parts?: unknown[] } } | undefined)?.content?.parts ?? [];
  for (const part of parts) {
    const p = part as { inlineData?: { mimeType?: string; data?: string } };
    const mime = p.inlineData?.mimeType ?? "";
    const b64 = p.inlineData?.data;
    if (typeof b64 === "string" && b64.length) {
      return { bytes: decodeBoundedImageBase64(b64, "Google"), mime: mime || "image/png" };
    }
  }
  throw directImageInvalidResponse("Google", "no image in Gemini response");
}

async function fetchImagenBatch(
  apiModel: string,
  apiKey: string,
  prompt: string,
  count: number,
): Promise<{ bytes: Buffer[]; mime: string }> {
  // Imagen predict uses account-level safety only; no per-request safetySettings here.
  let res: Response;
  try {
    res = await fetch(imagenPredictUrl(apiModel, apiKey), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: { sampleCount: count, aspectRatio: "1:1" },
      }),
    });
  } catch {
    throw directImageTransportError("Google");
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw directImageHttpError("google", res.status);
  }

  let data: unknown;
  try {
    data = await readBoundedMediaJson(res, MAX_IMAGE_RESPONSE_JSON_BYTES);
  } catch (error) {
    if (error instanceof MediaResponseReadError) {
      throw directImageInvalidResponse("Google", error.reason === "too_large" ? "oversized response" : "invalid response");
    }
    throw error;
  }

  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw directImageInvalidResponse("Google", "invalid response envelope");
  }
  const predictions = (data as { predictions?: Array<{ bytesBase64Encoded?: string }> })
    .predictions ?? [];
  const buffers: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    const b64 = predictions[i]?.bytesBase64Encoded;
    if (typeof b64 !== "string" || !b64.length) {
      throw directImageInvalidResponse("Google", "missing prediction bytes");
    }
    buffers.push(decodeBoundedImageBase64(b64, "Google"));
  }
  assertImageOutputBounds(buffers, "Google");
  return { bytes: buffers, mime: "image/png" };
}

export async function generateImagesGoogle(
  args: GenerateImagesArgs,
  apiKey: string,
): Promise<GenerateImagesResult> {
  const id = args.model.trim();

  if (id.includes("gemini-2.5-flash-image")) {
    const n = Math.min(Math.max(1, args.count | 0), 4);
    const buffers: Buffer[] = [];
    let mime = "image/png";
    for (let i = 0; i < n; i++) {
      const one = await fetchGeminiOneImage(
        args.model,
        apiKey,
        args.prompt,
        args.references,
      );
      buffers.push(one.bytes);
      assertImageOutputBounds(buffers, "Google");
      mime = one.mime;
    }
    return { bytes: buffers, model: args.model, mime };
  }

  if (id.includes("imagen-4")) {
    if ((args.references?.length ?? 0) > 0) {
      throw directImageAdmissionError(`Google image model ${args.model} does not support reference editing.`);
    }
    const batch = await fetchImagenBatch(args.model, apiKey, args.prompt, args.count);
    return { bytes: batch.bytes, model: args.model, mime: batch.mime };
  }

  throw directImageAdmissionError(`Unknown Google image model: ${args.model}`);
}
