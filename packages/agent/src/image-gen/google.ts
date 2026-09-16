import type { GenerateImagesArgs, GenerateImagesResult } from "./types";

function truncateBody(text: string, max = 300): string {
  return text.length <= max ? text : text.slice(0, max);
}

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
): Promise<{ bytes: Buffer; mime: string }> {
  const res = await fetch(geminiGenerateContentUrl(apiModel, apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
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

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(
      `Google image generation failed (HTTP ${res.status}): ${truncateBody(text)}`,
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Google image generation failed (HTTP ${res.status}): invalid JSON body`);
  }

  const candidates = (data as { candidates?: unknown[] }).candidates ?? [];
  const parts =
    (candidates[0] as { content?: { parts?: unknown[] } } | undefined)?.content?.parts ?? [];
  for (const part of parts) {
    const p = part as { inlineData?: { mimeType?: string; data?: string } };
    const mime = p.inlineData?.mimeType ?? "";
    const b64 = p.inlineData?.data;
    if (typeof b64 === "string" && b64.length) {
      return { bytes: Buffer.from(b64, "base64"), mime: mime || "image/png" };
    }
  }
  throw new Error("Google image generation failed: no image in Gemini response");
}

async function fetchImagenBatch(
  apiModel: string,
  apiKey: string,
  prompt: string,
  count: number,
): Promise<{ bytes: Buffer[]; mime: string }> {
  // Imagen predict uses account-level safety only; no per-request safetySettings here.
  const res = await fetch(imagenPredictUrl(apiModel, apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: { sampleCount: count, aspectRatio: "1:1" },
    }),
  });

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(
      `Google image generation failed (HTTP ${res.status}): ${truncateBody(text)}`,
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Google image generation failed (HTTP ${res.status}): invalid JSON body`);
  }

  const predictions = (data as { predictions?: Array<{ bytesBase64Encoded?: string }> })
    .predictions ?? [];
  const buffers: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    const b64 = predictions[i]?.bytesBase64Encoded;
    if (typeof b64 !== "string" || !b64.length) {
      throw new Error("Google image generation failed: missing prediction bytes");
    }
    buffers.push(Buffer.from(b64, "base64"));
  }
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
      const one = await fetchGeminiOneImage(args.model, apiKey, args.prompt);
      buffers.push(one.bytes);
      mime = one.mime;
    }
    return { bytes: buffers, model: args.model, mime };
  }

  if (id.includes("imagen-4")) {
    const batch = await fetchImagenBatch(args.model, apiKey, args.prompt, args.count);
    return { bytes: batch.bytes, model: args.model, mime: batch.mime };
  }

  throw new Error(`Unknown Google image model: ${args.model}`);
}
