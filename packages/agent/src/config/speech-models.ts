import type { ModelCatalogSpeech } from "@nautilo/types";
import { getCachedServerModelConfigRow } from "@nautilo/db";
import { getActiveModelCatalogSync } from "./model-catalog/runtime-catalog";
import { resolveCatalogModel } from "./resolved-catalog";

export interface SpeechModel {
  id: string;
  displayName: string;
  provider: string;
  providerModelId: string;
  available: boolean;
  unavailableReason?: string;
  speech: ModelCatalogSpeech;
}

/** Only locally implemented transports can execute catalog speech rows. */
export function listSpeechModels(env: NodeJS.ProcessEnv = process.env): SpeechModel[] {
  return getActiveModelCatalogSync().catalog.entries
    .filter(entry => "speech" in entry && entry.workload === "speech" && entry.speech)
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
    .map(entry => {
      const speech = (entry as typeof entry & { speech: ModelCatalogSpeech }).speech;
      const row = resolveCatalogModel(entry.id, { env });
      const supported = entry.provider === "elevenlabs" &&
        (speech.transport === "elevenlabs-tts-http" || speech.transport === "elevenlabs-dialogue-http") &&
        speech.outputFormats.includes("pcm_24000") && speech.outputFormats.includes("mp3_44100_128");
      return { id: entry.id, displayName: entry.displayName, provider: entry.provider,
        providerModelId: entry.id.slice(entry.id.indexOf(":") + 1), speech,
        available: supported && row.availability === "selectable",
        ...(!supported ? { unavailableReason: "Speech transport or output format is unsupported on this server" }
          : row.unavailableReason ? { unavailableReason: row.unavailableReason } : {}),
      };
    });
}

/** Freeze this result at reply admission; an admin change applies to the next reply. */
export function getServerSpeechModel(
  selection: string | null = getCachedServerModelConfigRow()?.speechModel ?? null,
  env: NodeJS.ProcessEnv = process.env,
): SpeechModel {
  const models = listSpeechModels(env);
  const selected = selection ? models.find(model => model.id === selection) : models.find(model => model.available);
  if (!selected || !selected.available) throw new Error(selected?.unavailableReason ?? "Configured speech model is unavailable");
  return { ...selected, speech: { ...selected.speech, outputFormats: [...selected.speech.outputFormats] } };
}

export function estimateSpeechCostUsd(text: string, model: SpeechModel): string {
  return (Array.from(text).length * Number(model.speech.usdPerThousandCharacters) / 1000).toFixed(8);
}
