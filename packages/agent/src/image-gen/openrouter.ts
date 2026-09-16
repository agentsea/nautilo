import type { GenerateImagesArgs, GenerateImagesResult } from "./types";

const OPENROUTER_IMAGES_URL = "https://openrouter.ai/api/v1/images";

function failure(status: number): Error {
  if (status === 401 || status === 403) {
    return new Error("OpenRouter rejected the image-generation credential.");
  }
  if (status === 402) return new Error("OpenRouter has insufficient credits for image generation.");
  if (status === 429) return new Error("OpenRouter rate-limited image generation. Retry shortly.");
  return new Error(`OpenRouter image generation failed (HTTP ${status}).`);
}

export async function generateImagesOpenRouter(
  args: GenerateImagesArgs,
  apiKey: string,
): Promise<GenerateImagesResult> {
  const body: Record<string, unknown> = {
    model: args.model,
    prompt: args.prompt,
    n: Math.min(4, Math.max(1, Math.floor(args.count))),
    quality: args.quality,
    output_format: args.format,
    background: args.background,
  };
  if (args.size !== "auto") body["size"] = args.size;
  const response = await fetch(OPENROUTER_IMAGES_URL, {
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
  let parsed: { data?: Array<{ b64_json?: unknown }> };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new Error("OpenRouter image generation failed: invalid JSON body");
  }
  const bytes = (parsed.data ?? []).map((item) => {
    if (typeof item.b64_json !== "string" || !item.b64_json) {
      throw new Error("OpenRouter image generation failed: missing b64_json in response");
    }
    return Buffer.from(item.b64_json, "base64");
  });
  if (bytes.length === 0) throw new Error("OpenRouter image generation failed: empty response");
  return { bytes, model: args.model, mime: `image/${args.format}` };
}
