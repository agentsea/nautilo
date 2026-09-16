export type VoiceCatalogEntry = {
  voiceId: string;
  name: string;
  labels: Record<string, string>;
  description: string | null;
};

export function normalizeElevenLabsLabels(raw: Record<string, unknown> | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string") {
      out[k] = v;
    } else if (typeof v === "number" || typeof v === "boolean") {
      out[k] = String(v);
    } else {
      out[k] = JSON.stringify(v);
    }
  }
  return out;
}

/** Fetch full ElevenLabs voice list (requires API key). */
export async function fetchElevenLabsCatalog(apiKey: string): Promise<VoiceCatalogEntry[]> {
  const res = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": apiKey },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs voices ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    voices?: Array<{
      voice_id: string;
      name: string;
      labels?: Record<string, unknown>;
      description?: string | null;
    }>;
  };
  const voices = data.voices ?? [];
  return voices.map((v) => ({
    voiceId: v.voice_id,
    name: v.name,
    labels: normalizeElevenLabsLabels(v.labels),
    description: v.description ?? null,
  }));
}
