import { spawn, execSync, type ChildProcess } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { resolveNautiloRuntimePaths } from "@nautilo/config";
import { warn, log } from "@nautilo/logger";
import type { TTSAdapter, SpeakOptions } from "../types";

 
const EMOJI_RE = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu;

/** D261 — strip `<voice lang="…">` / `</voice>` before full-message TTS. */
const VOICE_MARKUP_RE =
  /<voice\s+lang=["'][^"']*["']\s*>|<\/voice\s*>/gi;

export function stripVoiceMarkup(text: string): string {
  return text.replace(VOICE_MARKUP_RE, "");
}

/** Curated slugs → ElevenLabs voice IDs for voice setup. EN, ES, then FR/DE/JA. */
export const ELEVENLABS_CURATED_VOICE_IDS: Record<string, string> = {
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

/** Canonical Nautilo display name for a curated ElevenLabs voice ID. */
export function curatedVoiceDisplayNameForId(voiceId: string): string | null {
  const entry = Object.entries(ELEVENLABS_CURATED_VOICE_IDS).find(
    ([, curatedVoiceId]) => curatedVoiceId === voiceId,
  );
  return entry ? curatedVoiceDisplayName(entry[0]) : null;
}

const VOICES: Record<string, string> = ELEVENLABS_CURATED_VOICE_IDS;

const DEFAULT_VOICE = "carolyn";
const MODEL_ID = "eleven_v3";

const VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0,
  use_speaker_boost: true,
  speed: 1.0,
};

let mpvAvailable: boolean | null = null;

function hasMpv(): boolean {
  if (mpvAvailable !== null) return mpvAvailable;
  try {
    execSync("which mpv", { stdio: "ignore" });
    mpvAvailable = true;
  } catch {
    mpvAvailable = false;
  }
  return mpvAvailable;
}

export class ElevenLabsAdapter implements TTSAdapter {
  private apiKey: string;
  private voiceId: string;
  private currentProcess: ChildProcess | null = null;
  private playing = false;

  constructor(apiKey: string, voiceName?: string | null, explicitVoiceId?: string | null) {
    this.apiKey = apiKey;
    if (explicitVoiceId && explicitVoiceId.length > 0) {
      this.voiceId = explicitVoiceId;
    } else {
      const name = (voiceName ?? DEFAULT_VOICE).toLowerCase();
      this.voiceId = VOICES[name] ?? VOICES[DEFAULT_VOICE] ?? "JSWO6cw2AyFE324d5kEr";
    }
    if (hasMpv()) {
      log("[voice] Using mpv for streaming audio playback");
    } else {
      log("[voice] mpv not found, using afplay with temp files. Install mpv for faster playback: brew install mpv");
    }
  }

  async speak(text: string, _options?: SpeakOptions): Promise<void> {
    this.stop();

    const sentences = splitSentences(text);
    if (sentences.length === 0) return;

    this.playing = true;

    for (const sentence of sentences) {
      if (!this.playing) break;
      await this.speakSentence(sentence);
    }

    this.playing = false;
  }

  private async speakSentence(text: string): Promise<void> {
    const stripped = stripVoiceMarkup(text);
    const cleaned = stripped.replace(/\[.*?\]/g, "").replace(EMOJI_RE, "").trim();
    const ttsText = stripped.replace(EMOJI_RE, "").trim();
    if (!cleaned) return;

    try {
      const useStreaming = hasMpv();
      const url = useStreaming
        ? `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/stream?output_format=mp3_44100_128`
        : `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}?output_format=mp3_44100_128`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "xi-api-key": this.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: ttsText,
          model_id: MODEL_ID,
          voice_settings: VOICE_SETTINGS,
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        warn(`[voice] ElevenLabs API error ${response.status}: ${body.slice(0, 200)}`);
        await this.fallbackSay(cleaned);
        return;
      }

      if (useStreaming && response.body) {
        await this.streamToMpv(response.body);
      } else {
        await this.bufferToAfplay(response);
      }
    } catch (err) {
      warn(`[voice] ElevenLabs TTS failed: ${err instanceof Error ? err.message : String(err)}`);
      await this.fallbackSay(cleaned);
    }
  }

  private async streamToMpv(body: ReadableStream<Uint8Array>): Promise<void> {
    const mpv = spawn("mpv", ["--no-video", "--no-terminal", "--no-cache", "-"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    this.currentProcess = mpv;

    const reader = body.getReader();
    try {
      while (this.playing) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!mpv.stdin?.writable) break;
        mpv.stdin.write(value);
      }
    } finally {
      reader.releaseLock();
    }

    mpv.stdin?.end();
    await new Promise<void>((r) => {
      mpv.on("close", () => { this.currentProcess = null; r(); });
      mpv.on("error", () => { this.currentProcess = null; r(); });
    });
  }

  private async bufferToAfplay(response: Response): Promise<void> {
    const audioBuffer = Buffer.from(await response.arrayBuffer());
    // D049: TTS temp audio goes under data/audio/ (internal cache zone,
    // never exposed to the relay). Resolved from NautiloRuntimePaths so
    // an alternate user home / instance layout moves it with the rest of the tree.
    const tmpDir = resolveNautiloRuntimePaths().audioCacheDir;
    mkdirSync(tmpDir, { recursive: true });
    const tmpFile = resolve(tmpDir, `tts-${Date.now()}.mp3`);
    writeFileSync(tmpFile, audioBuffer);

    await new Promise<void>((resolvePromise) => {
      this.currentProcess = spawn("afplay", [tmpFile], { stdio: "ignore" });
      this.currentProcess.on("close", () => {
        this.currentProcess = null;
        try { unlinkSync(tmpFile); } catch { /* best effort */ }
        resolvePromise();
      });
      this.currentProcess.on("error", () => {
        this.currentProcess = null;
        try { unlinkSync(tmpFile); } catch { /* best effort */ }
        resolvePromise();
      });
    });
  }

  private async fallbackSay(text: string): Promise<void> {
    if (!this.playing || !text) return;
    warn("[voice] Falling back to macOS say");
    await new Promise<void>((resolvePromise) => {
      this.currentProcess = spawn("say", [text], { stdio: "ignore" });
      this.currentProcess.on("close", () => { this.currentProcess = null; resolvePromise(); });
      this.currentProcess.on("error", () => { this.currentProcess = null; resolvePromise(); });
    });
  }

  stop(): void {
    this.playing = false;
    if (this.currentProcess) {
      this.currentProcess.kill("SIGTERM");
      this.currentProcess = null;
    }
  }

  isSpeaking(): boolean {
    return this.playing;
  }
}

function splitSentences(text: string): string[] {
  const cleaned = text.trim();
  if (!cleaned) return [];

  const sentences: string[] = [];
  let current = "";

  for (let i = 0; i < cleaned.length; i++) {
    current += cleaned[i];
    const char = cleaned[i];
    const next = cleaned[i + 1];

    if ((char === "." || char === "!" || char === "?") && (!next || next === " " || next === "\n")) {
      const trimmed = current.trim();
      if (trimmed.length > 5) {
        sentences.push(trimmed);
        current = "";
      }
    }
  }

  const remaining = current.trim();
  if (remaining) sentences.push(remaining);

  return sentences;
}
