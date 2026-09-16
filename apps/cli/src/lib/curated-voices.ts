/** Curated ElevenLabs slugs used by setup-time Genie randomization. */
export const ELEVENLABS_CURATED_VOICE_IDS: Readonly<Record<string, string>> = {
  carolyn: "JSWO6cw2AyFE324d5kEr",
  jessica: "cgSgspJ2msm6clMCkdW9",
  beatriz: "gJlzF5JxsCvM5hQAoRyD",
  augustin: "kKgyAHjGAbeWHCNd7qoC",
  daniel: "wcqN36SUOZ0EhToc2OIu",
  kana: "dhGvgIx0X6G3xzSWqOye",
};

/** Display name for curated slug. */
export function curatedVoiceDisplayName(slug: string): string {
  const s = slug.toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
