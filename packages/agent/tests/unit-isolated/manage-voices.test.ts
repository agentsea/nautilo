/**
 * D261 Phase 3 — manage_voices list/add/remove against profile-store helpers.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

const voicesState: Record<string, { voiceId: string; voiceName: string }> = {};
let upsertCalls: Array<[string, string, { voiceId: string; voiceName: string }]> = [];
let removeCalls: Array<[string, string]> = [];
let emitCount = 0;

const fakeProfile = {
  id: "p1",
  userId: "owner-1",
  agentId: "agent-1",
  name: "Genie",
  soulFile: null,
  language: "en",
  privacySpectrum: null,
  workLifeMode: null,
  voiceName: null,
  voiceId: null,
  voices: voicesState,
  personalityPrompt: null,
  motherAnswer: null,
  avatar: null,
  publicProfile: false,
  personalityTone: null,
  defaultModel: null,
  onboardingCompleted: false,
  welcomeMessageSent: false,
  fallbackEnabled: false,
  fallbackChain: [],
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeAll(() => {
  mock.module("../../src/store/profile-store", () => ({
    getProfile: async () => fakeProfile,
    getVoices: async () => ({ ...voicesState }),
    upsertVoiceAssignment: async (
      agentId: string,
      lang: string,
      voice: { voiceId: string; voiceName: string },
    ) => {
      upsertCalls.push([agentId, lang, voice]);
      voicesState[lang] = voice;
    },
    removeVoiceAssignment: async (agentId: string, lang: string) => {
      removeCalls.push([agentId, lang]);
      delete voicesState[lang];
    },
    assertValidVoiceLangKey: (lang: string) => {
      if (!/^(default|[a-z]{2,3}(-[A-Za-z0-9]+)*)$/.test(lang)) {
        throw new Error(`Invalid voice language key "${lang}"`);
      }
    },
  }));
  mock.module("../../src/tools/config/emit-profile-updated", () => ({
    emitProfileUpdated: () => {
      emitCount += 1;
    },
  }));
});

afterAll(() => {
  for (const k of Object.keys(voicesState)) delete voicesState[k];
  upsertCalls = [];
  removeCalls = [];
  emitCount = 0;
});

describe("D261 — manage_voices", () => {
  test("list returns formatted assignments", async () => {
    voicesState["default"] = { voiceId: "abc12345", voiceName: "Carolyn" };
    voicesState["es"] = { voiceId: "esVoice1", voiceName: "Beatriz" };
    const { createManageVoicesTool } = await import("../../src/tools/config/manage-voices");
    const tool = createManageVoicesTool({ ownerId: "owner-1", agentId: "agent-1" });
    const out = await tool.invoke({ action: "list", language: "default" });
    expect(out).toContain("PRIMARY: Carolyn");
    expect(out).toContain("ES: Beatriz");
  });

  test("add validates voiceId and writes via store", async () => {
    upsertCalls = [];
    emitCount = 0;
    const { createManageVoicesTool } = await import("../../src/tools/config/manage-voices");
    const tool = createManageVoicesTool({ ownerId: "owner-1", agentId: "agent-1" });
    const bad = await tool.invoke({
      action: "add",
      language: "es",
      voiceId: "bad/id",
      voiceName: "X",
    });
    expect(bad).toContain("invalid voiceId");
    expect(upsertCalls).toHaveLength(0);

    const ok = await tool.invoke({
      action: "add",
      language: "es",
      voiceId: "gJlzF5JxsCvM5hQAoRyD",
      voiceName: "Beatriz",
    });
    expect(ok).toContain("Voice assigned for es");
    expect(upsertCalls).toEqual([
      ["agent-1", "es", { voiceId: "gJlzF5JxsCvM5hQAoRyD", voiceName: "Beatriz" }],
    ]);
    expect(emitCount).toBe(1);
  });

  test("remove calls store and emits profile update", async () => {
    voicesState["fr"] = { voiceId: "kKgyAHjGAbeWHCNd7qoC", voiceName: "Augustin" };
    removeCalls = [];
    emitCount = 0;
    const { createManageVoicesTool } = await import("../../src/tools/config/manage-voices");
    const tool = createManageVoicesTool({ ownerId: "owner-1", agentId: "agent-1" });
    const out = await tool.invoke({ action: "remove", language: "fr" });
    expect(out).toContain("Removed voice assignment for fr");
    expect(removeCalls).toEqual([["agent-1", "fr"]]);
    expect(emitCount).toBe(1);
  });

  test("fails closed without agentId in context", async () => {
    const { createManageVoicesTool } = await import("../../src/tools/config/manage-voices");
    const tool = createManageVoicesTool({ ownerId: "owner-1" });
    const out = await tool.invoke({ action: "list", language: "default" });
    expect(out).toContain("no agent in context");
  });
});
