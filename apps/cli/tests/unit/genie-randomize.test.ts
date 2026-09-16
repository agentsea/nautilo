import { describe, test, expect } from "bun:test";
import { randomizeGenie } from "../../src/lib/genie-randomize.ts";
import {
  mapGenieToProfileInput,
  resolveGenieDefaultVoice,
} from "../../src/lib/genie-mapping.ts";
import { candidatesForModelRole } from "@nautilo/config";
import {
  ELEVENLABS_CURATED_VOICE_IDS,
  curatedVoiceDisplayName,
} from "../../src/lib/curated-voices.ts";
import type { GenieBlock } from "@nautilo/api-client";

const openaiOnly = [{ key: "OPENAI_API_KEY", value: { value: "sk-test" } }];
const veniceOnly = [{ key: "VENICE_API_KEY", value: { value: "vk-test" } }];
const allProviders = [
  { key: "OPENAI_API_KEY", value: { value: "sk-test" } },
  { key: "ANTHROPIC_API_KEY", value: { value: "sk-ant-test" } },
  { key: "GOOGLE_API_KEY", value: { value: "g-test" } },
  { key: "FIREWORKS_API_KEY", value: { value: "fw-test" } },
  { key: "OPENROUTER_API_KEY", value: { value: "or-test" } },
  { key: "VENICE_API_KEY", value: { value: "vk-test" } },
  { key: "ELEVENLABS_API_KEY", value: { value: "el-test" } },
];

const CHAT_CANDIDATES = candidatesForModelRole("chat");
const TOP_MODEL_VALUES = new Set(CHAT_CANDIDATES);
/** D118: stale 2024-era ids the pre-fix randomizer used to pick. Listing
 *  them here so a regression that re-introduces the hardcoded list trips
 *  the test below loudly. */
const STALE_FORBIDDEN_MODELS = new Set([
  "openai:gpt-4o-mini",
  "openai:gpt-4o",
  "anthropic:claude-3-5-sonnet-20241022",
  "anthropic:claude-3-5-haiku-20241022",
  "google:gemini-2.0-flash",
]);

describe("randomizeGenie", () => {
  test("same seed → same identity (3 runs)", () => {
    const block = { mode: "randomize" as const, seed: 42 };
    const a = randomizeGenie(block, openaiOnly, 42);
    const b = randomizeGenie(block, openaiOnly, 42);
    const c = randomizeGenie(block, openaiOnly, 42);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  test("different seeds can diverge", () => {
    const block = { mode: "randomize" as const };
    const a = randomizeGenie(block, openaiOnly, 1);
    const b = randomizeGenie(block, openaiOnly, 9_001_337);
    const keys = ["name", "voice", "defaultModel", "personality"] as const;
    const diff = keys.some((k) => a[k] !== b[k]);
    expect(diff).toBe(true);
  });

  test("voice list filtered to available voice provider", () => {
    const block: GenieBlock = { mode: "randomize", seed: 99 };
    const onlyOpenai = randomizeGenie(block, openaiOnly, 99);
    expect(onlyOpenai.voice).toBeUndefined();

    const withElevenLabs = randomizeGenie(block, allProviders, 99);
    expect(withElevenLabs.voice).toBeDefined();
    expect(withElevenLabs.voice?.toLowerCase().startsWith("elevenlabs:")).toBe(true);
  });

  test("curated ElevenLabs voice slug maps to voices.default assignment", () => {
    const identity = {
      name: "Nova 1",
      voice: "elevenlabs:carolyn",
      personality: "Quiet coach.",
    };
    const payload = mapGenieToProfileInput(identity);
    const defaultVoice = resolveGenieDefaultVoice(identity);

    expect(payload["voiceName"]).toBeUndefined();
    expect(payload["voiceId"]).toBeUndefined();
    expect(defaultVoice?.voiceName).toBe(curatedVoiceDisplayName("carolyn"));
    expect(defaultVoice?.voiceId).toBe(ELEVENLABS_CURATED_VOICE_IDS["carolyn"]);
    expect(defaultVoice?.voiceId).not.toBe("elevenlabs:carolyn");
  });

  test("defaultModel comes from the shared chat-role policy, never a stale 2024-era id", () => {
    // Sweep a range of seeds across all-providers and openai-only to make sure
    // we always land in the canonical registry and never re-introduce the
    // pre-D118 hardcoded list.
    const block: GenieBlock = { mode: "randomize" };
    for (const providers of [allProviders, openaiOnly]) {
      for (const seed of [1, 7, 42, 99, 12345, 9_001_337]) {
        const out = randomizeGenie(block, providers, seed);
        expect(out.defaultModel).toBeDefined();
        expect(TOP_MODEL_VALUES.has(out.defaultModel as string)).toBe(true);
        expect(STALE_FORBIDDEN_MODELS.has(out.defaultModel as string)).toBe(false);
      }
    }
  });

  test("all providers loaded → defaultModel follows priority, not seed", () => {
    const block: GenieBlock = { mode: "randomize" };
    for (const seed of [1, 7, 42, 99, 12345, 9_001_337]) {
      const out = randomizeGenie(block, allProviders, seed);
      expect(out.defaultModel).toBe("openrouter:minimax/minimax-m3");
    }
  });

  test("Venice-only providers use the Venice MiniMax M3 route", () => {
    const block: GenieBlock = { mode: "randomize" };
    const out = randomizeGenie(block, veniceOnly, 42);
    expect(out.defaultModel).toBe("venice:minimax-m3-preview");
  });

  test("openai-only providers → openai's top model is the only candidate", () => {
    const block: GenieBlock = { mode: "randomize" };
    const out = randomizeGenie(block, openaiOnly, 42);
    expect(out.defaultModel).toBe("openai:gpt-5.6-terra");
  });

  test("randomize stamps a real soulFile with {{NAME}} substituted (Phase 19.6)", () => {
    // D112 Phase 19.6 — randomized setups must land with `soulFile`
    // populated to a hand-authored archetype, with the chosen name
    // substituted in. Without this, `profiles.soulFile` stays null on
    // fresh installs and the `onboarding_status` tool nudges the model
    // toward an unsolicited `regenerate_soul` on the first turn.
    const block: GenieBlock = { mode: "randomize" };
    for (const seed of [1, 7, 42, 99, 12345, 9_001_337]) {
      const out = randomizeGenie(block, allProviders, seed);
      expect(typeof out.soulFile).toBe("string");
      const soul = out.soulFile as string;
      expect(soul).not.toContain("{{NAME}}");
      expect(soul).toContain(out.name);
      expect(soul.length).toBeGreaterThan(400);
    }
  });

  test("explicit personality override skips seeded soulFile", () => {
    // When the caller supplies an explicit personality string, we do
    // not stamp a seeded soulFile — the caller is in control of the
    // persona and should populate `soulFile` themselves if they want
    // one. (Prevents a randomized archetype's soul from leaking into
    // an explicit setup.)
    const block: GenieBlock = {
      mode: "randomize",
      personality: "Custom personality, set by caller.",
    };
    const out = randomizeGenie(block, allProviders, 42);
    expect(out.personality).toBe("Custom personality, set by caller.");
    expect(out.soulFile).toBeUndefined();
  });
});
