export interface TTSAdapter {
  speak(text: string, options?: SpeakOptions): Promise<void>;
  stop(): void;
  isSpeaking(): boolean;
}

export interface SpeakOptions {
  voice?: string;
  rate?: number;
}

export interface VoiceConfig {
  enabled: boolean;
  provider: "auto" | "elevenlabs" | "say";
  voiceName: string | null;
  /** When set (e.g. from DB profile), used instead of resolving `voiceName` to a curated slug. */
  voiceId?: string | null;
  speakToolSummaries: boolean;
}
