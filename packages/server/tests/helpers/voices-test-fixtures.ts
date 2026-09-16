import type {
  ElevenLabsSharedVoiceRaw,
  VoiceCatalogPersistentCache,
  VoiceCatalogPersistentPayload,
} from "../../src/routes/voices";

export class FakeVoiceCatalogCache implements VoiceCatalogPersistentCache {
  readonly rows = new Map<
    string,
    {
      payload: VoiceCatalogPersistentPayload;
      expiresAt: number;
      staleAt: number;
    }
  >();

  key(args: {
    kind: string;
    cacheKey: string;
    accountFingerprint: string;
    schemaVersion: string;
  }): string {
    return `${args.kind}:${args.accountFingerprint}:${args.schemaVersion}:${args.cacheKey}`;
  }

  get(
    args: Parameters<VoiceCatalogPersistentCache["get"]>[0],
  ): ReturnType<VoiceCatalogPersistentCache["get"]> {
    const row = this.rows.get(this.key(args));
    if (!row || row.staleAt <= args.now) return Promise.resolve(null);
    return Promise.resolve({
      payload: row.payload,
      state: row.expiresAt > args.now ? ("fresh" as const) : ("stale" as const),
    });
  }

  set(
    args: Parameters<VoiceCatalogPersistentCache["set"]>[0],
  ): ReturnType<VoiceCatalogPersistentCache["set"]> {
    this.rows.set(this.key(args), {
      payload: structuredClone(args.payload),
      expiresAt: args.now + args.ttlMs,
      staleAt: args.now + args.ttlMs + args.staleMs,
    });
    return Promise.resolve();
  }
}

export function v3Voice(
  overrides: Partial<ElevenLabsSharedVoiceRaw> = {},
): ElevenLabsSharedVoiceRaw {
  return {
    voice_id: "voice-v3",
    name: "V3 Voice",
    accent: "american",
    gender: "female",
    age: "young",
    descriptive: "warm",
    category: "professional",
    language: "en",
    locale: "en-US",
    preview_url: "https://example.com/preview.mp3",
    verified_languages: [{ language: "en", model_id: "eleven_v3" }],
    ...overrides,
  };
}

export function multilingualOnlyVoice(): ElevenLabsSharedVoiceRaw {
  return v3Voice({
    voice_id: "voice-v2",
    name: "V2 Only",
    verified_languages: [{ language: "en", model_id: "eleven_multilingual_v2" }],
    high_quality_base_model_ids: ["eleven_multilingual_v2"],
  });
}
