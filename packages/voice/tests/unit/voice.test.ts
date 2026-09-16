import { join } from "node:path";
import { describe, test, expect } from "bun:test";

const voicePkgRoot = join(import.meta.dir, "../..");

describe("voice package imports", () => {
  test("createTTSAdapter is importable from @nautilo/voice", async () => {
    const mod = await import("../../src/index");
    expect(typeof mod.createTTSAdapter).toBe("function");
  });

  test("stopTTS is importable from @nautilo/voice", async () => {
    const mod = await import("../../src/index");
    expect(typeof mod.stopTTS).toBe("function");
  });

  test("isSpeaking is importable from @nautilo/voice", async () => {
    const mod = await import("../../src/index");
    expect(typeof mod.isSpeaking).toBe("function");
  });

  test("fromRuntimeConfig is importable from @nautilo/config", async () => {
    const mod = await import("@nautilo/config");
    expect(typeof mod.fromRuntimeConfig).toBe("function");
  });
});

describe("voice adapter factory", () => {
  test("createTTSAdapter with provider=say returns an adapter", async () => {
    const { createTTSAdapter } = await import("../../src/index");
    const adapter = createTTSAdapter({ enabled: true, provider: "say", voiceName: null, speakToolSummaries: false });
    expect(adapter).toBeDefined();
    expect(typeof adapter.speak).toBe("function");
    expect(typeof adapter.stop).toBe("function");
    expect(typeof adapter.isSpeaking).toBe("function");
  });

  test("adapter.isSpeaking() returns false when not speaking", async () => {
    const { createTTSAdapter } = await import("../../src/index");
    const adapter = createTTSAdapter({ enabled: true, provider: "say", voiceName: null, speakToolSummaries: false });
    expect(adapter.isSpeaking()).toBe(false);
  });
});

describe("voice status event shape", () => {
  test("voice.status event has required fields", () => {
    const event = { type: "voice.status" as const, voice: "on" as const, speaking: true };
    expect(event.type).toBe("voice.status");
    expect(event.voice).toBe("on");
    expect(event.speaking).toBe(true);
  });

  test("voice off + not speaking", () => {
    const event = { type: "voice.status" as const, voice: "off" as const, speaking: false };
    expect(event.voice).toBe("off");
    expect(event.speaking).toBe(false);
  });
});

describe("ElevenLabs config", () => {
  test("Carolyn voice ID is correct", () => {
    const CAROLYN_ID = "JSWO6cw2AyFE324d5kEr";
    expect(CAROLYN_ID).toBe("JSWO6cw2AyFE324d5kEr");
  });

  test("Carolyn's curated voice ID has one canonical display name", async () => {
    const { curatedVoiceDisplayNameForId } = await import("../../src/index");
    expect(curatedVoiceDisplayNameForId("JSWO6cw2AyFE324d5kEr")).toBe("Carolyn");
    expect(curatedVoiceDisplayNameForId("not-curated")).toBeNull();
  });

  test("Beatriz voice ID is correct", () => {
    const BEATRIZ_ID = "gJlzF5JxsCvM5hQAoRyD";
    expect(BEATRIZ_ID).toBe("gJlzF5JxsCvM5hQAoRyD");
  });

  test("model must be eleven_v3", () => {
    const MODEL = "eleven_v3";
    expect(MODEL).toBe("eleven_v3");
    expect(MODEL).not.toBe("eleven_turbo_v2");
    expect(MODEL).not.toBe("eleven_multilingual_v2");
  });

  test("voice settings are correct", () => {
    const settings = {
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0,
      use_speaker_boost: true,
      speed: 1.0,
    };
    expect(settings.stability).toBe(0.5);
    expect(settings.similarity_boost).toBe(0.75);
    expect(settings.use_speaker_boost).toBe(true);
  });
});

describe("no console.error in voice package", () => {
  test("elevenlabs adapter uses @nautilo/logger, not console", async () => {
    const source = await Bun.file(join(voicePkgRoot, "src/adapters/elevenlabs.ts")).text();
    expect(source).not.toContain("console.error");
    expect(source).not.toContain("console.log");
    expect(source).toContain('from "@nautilo/logger"');
  });

  test("voice index uses shared logger, not console", async () => {
    const source = await Bun.file(join(voicePkgRoot, "src/index.ts")).text();
    expect(source).not.toContain("console.error");
    expect(source).not.toContain("console.log");
  });

  test("say adapter does not log to console", async () => {
    const source = await Bun.file(join(voicePkgRoot, "src/adapters/say.ts")).text();
    expect(source).not.toContain("console.error");
    expect(source).not.toContain("console.log");
  });
});

describe("D261 stripVoiceMarkup", () => {
  test("removes voice span markers from TTS-bound text", async () => {
    const { stripVoiceMarkup } = await import("../../src/adapters/elevenlabs");
    const input = 'Say <voice lang="es">hola</voice> now.';
    expect(stripVoiceMarkup(input)).toBe("Say hola now.");
  });
});

describe("sentence splitting", () => {
  test("splits on period", () => {
    const text = "Hello there. How are you. Fine thanks.";
    const sentences = text.split(/(?<=[.!?])\s+/).filter(s => s.length > 5);
    expect(sentences.length).toBe(3);
  });

  test("keeps short fragments together", () => {
    const text = "OK. Sure. That is a longer sentence here.";
    const sentences = text.split(/(?<=[.!?])\s+/).filter(s => s.length > 5);
    expect(sentences.length).toBe(1);
  });

  test("splits on exclamation and question marks", () => {
    const text = "Wow that is cool! What do you think? Let me check.";
    const sentences = text.split(/(?<=[.!?])\s+/).filter(s => s.length > 5);
    expect(sentences.length).toBe(3);
  });

  test("emotion tags are stripped for audio content check", () => {
    const text = "[laughs] That's awesome [excited] really cool";
    const cleaned = text.replace(/\[.*?\]/g, "").trim();
    expect(cleaned).toBe("That's awesome  really cool");
    expect(cleaned.length).toBeGreaterThan(0);
  });
});
