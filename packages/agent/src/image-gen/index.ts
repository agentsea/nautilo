import type { GenerateImagesArgs, GenerateImagesResult } from "./types";
import { generateImagesOpenAi } from "./openai";
import { generateImagesGoogle } from "./google";
import { generateImagesOpenRouter } from "./openrouter";
import { generateImagesVenice } from "./venice";
import type { ImageProvider } from "../config/image-models";
import { recordLlmUsage } from "../usage/record-usage";
import { getUsageContext } from "../usage/usage-context";

export function imageUsageModelId(provider: ImageProvider, model: string): string {
  return `${provider}:${model}`;
}

function meterImages(result: GenerateImagesResult, provider: ImageProvider): GenerateImagesResult {
  // Costs dashboard (D405): image-gen is priced per image, not per token.
  const imageCount = result.bytes.length;
  if (imageCount > 0) {
    const ctx = getUsageContext();
    recordLlmUsage({
      model: imageUsageModelId(provider, result.model),
      callType: "image_gen",
      userId: ctx?.userId ?? null,
      roomId: ctx?.roomId ?? null,
      imageCount,
      ...(ctx?.metadata ? { metadata: ctx.metadata } : {}),
    });
  }
  return result;
}

export type {
  GenerateImagesArgs,
  GenerateImagesResult,
  GenerateImagesStreamEvent,
} from "./types";
export { generateImagesOpenAi, generateImagesOpenAiStream } from "./openai";
export { generateImagesGoogle } from "./google";
export { generateImagesOpenRouter } from "./openrouter";
export { generateImagesVenice } from "./venice";

export interface ProviderCreds {
  readonly openaiKey?: string;
  readonly googleKey?: string;
  readonly openrouterKey?: string;
  readonly veniceKey?: string;
}

export async function generateImages(
  args: GenerateImagesArgs,
  creds: ProviderCreds,
  provider: ImageProvider,
): Promise<GenerateImagesResult> {
  if (provider === "openai") {
    if (!creds.openaiKey) {
      throw new Error("OpenAI image-generation credential is not configured.");
    }
    return meterImages(await generateImagesOpenAi(args, creds.openaiKey), "openai");
  }
  if (provider === "google") {
    if (!creds.googleKey) {
      throw new Error("Google image-generation credential is not configured.");
    }
    return meterImages(await generateImagesGoogle(args, creds.googleKey), "google");
  }
  if (provider === "openrouter") {
    if (!creds.openrouterKey) throw new Error("OpenRouter API key not configured.");
    return meterImages(
      await generateImagesOpenRouter(args, creds.openrouterKey),
      "openrouter",
    );
  }
  if (provider === "venice") {
    if (!creds.veniceKey) throw new Error("Venice API key not configured.");
    return meterImages(await generateImagesVenice(args, creds.veniceKey), "venice");
  }
  throw new Error(`Unknown image provider: ${String(provider)}`);
}
