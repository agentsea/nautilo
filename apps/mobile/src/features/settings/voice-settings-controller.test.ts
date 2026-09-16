/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import type { AgentProfileFull, AgentProfileResponse, CatalogResponse, CatalogVoice } from "@nautilo/types";

import { createVoiceSettingsController, type VoiceSettingsApi } from "./voice-settings-controller";

const scope = { serverId: "server-a", userId: "user-a", actorId: "actor-a" };
const voice = (id: string, name = id): CatalogVoice => ({ voiceId: id, name, accent: "", gender: "", age: "", descriptive: "", category: "", language: "en", locale: null, languageLabel: "English", previewUrl: null, verifiedLanguages: [], source: "provider" });
function profile(voices: AgentProfileFull["voices"] = {}): AgentProfileFull {
  return { name: "Genie", language: "en", voices, avatar: { kind: "preset", id: "avatar-01" }, avatarUrl: "/api/profile/avatar", defaultModel: null, personality: { prompt: null, tone: null, motherAnswer: null }, privacySpectrum: null, workLifeMode: null, soulFile: null, onboardingCompleted: true, welcomeMessageSent: true, agentIdentity: "agent-a", handle: "genie", publicProfile: false, fallback: { enabled: false, chain: [] } };
}
function response(agent: AgentProfileFull): AgentProfileResponse { return { viewerRole: "owner", agent, ownedAgents: [] }; }
function catalog(voices: CatalogVoice[], page = 0, hasMore = false): CatalogResponse { return { voices, languageGroups: [{ language: "en", locale: null, label: "English", count: 2 }], page, pageSize: 30, hasMore, totalCount: voices.length, elevenLabsConfigured: true, cachedAt: null }; }

function fakeApi(initial = profile()) {
  let current = initial;
  const calls: string[] = [];
  const api: VoiceSettingsApi = {
    getProfile: async () => { calls.push("get"); return response(current); },
    listVoiceCatalog: async (query) => { calls.push(`catalog:${JSON.stringify(query)}`); return query.page === 1 ? catalog([voice("voice-b")], 1) : catalog([voice("voice-a")], 0, true); },
    previewVoice: async (voiceId, input) => { calls.push(`preview:${voiceId}:${input?.text ?? ""}`); return new Blob(["audio"]); },
    upsertVoiceAssignment: async (language, ref) => { calls.push(`upsert:${language}:${ref.voiceId}`); current = { ...current, voices: { ...current.voices, [language]: ref } }; },
    removeVoiceAssignment: async (language) => { calls.push(`remove:${language}`); const { [language]: _removed, ...voices } = current.voices; current = { ...current, voices }; },
  };
  return { api, calls, get current() { return current; } };
}

describe("Voice settings controller", () => {
  test("does not request an unconfigured scope", async () => {
    const fake = fakeApi(); const controller = createVoiceSettingsController(() => fake.api);
    await controller.load(); await controller.loadCatalog();
    expect(fake.calls).toEqual([]);
  });

  test("can invalidate and reactivate its scope after a retained route cleanup", async () => {
    const fake = fakeApi(); const controller = createVoiceSettingsController(() => fake.api);
    controller.setScope(scope);
    await controller.load();
    controller.setScope(null);
    controller.setScope(scope);
    await controller.load();
    expect(controller.data.getState().data?.name).toBe("Genie");
    expect(fake.calls).toEqual(["get", "get"]);
  });

  test("keeps an unconfigured voice provider as an explicit catalog state", async () => {
    const fake = fakeApi();
    fake.api.listVoiceCatalog = async () => ({ ...catalog([]), elevenLabsConfigured: false });
    const controller = createVoiceSettingsController(() => fake.api);
    controller.setScope(scope);
    await controller.loadCatalog();
    expect(controller.getCatalog()).toMatchObject({ elevenLabsConfigured: false, voices: [] });
  });

  test("pages and replaces the catalog when filters change", async () => {
    const fake = fakeApi(); const controller = createVoiceSettingsController(() => fake.api);
    controller.setScope(scope);
    await controller.loadCatalog(); await controller.loadMore();
    expect(controller.getCatalog().voices.map((item) => item.voiceId)).toEqual(["voice-a", "voice-b"]);
    controller.setCatalogFilters({ search: "calm", language: "en", category: "professional", gender: "female", age: "middle_aged", accent: "British", useCase: "conversational" });
    await controller.loadCatalog();
    expect(fake.calls).toContain('catalog:{"page":0,"page_size":30,"search":"calm","language":"en","category":"professional","gender":"female","age":"middle_aged","accent":"British","use_cases":"conversational"}');
    expect(controller.getCatalog().voices.map((item) => item.voiceId)).toEqual(["voice-a"]);
  });

  test("uses the desktop trust order without disturbing equal-rank provider order", async () => {
    const fake = fakeApi();
    const ordinary = voice("ordinary");
    const verified = { ...voice("verified"), verifiedLanguages: [{ language: "en", locale: null, accent: "", previewUrl: null, modelId: "eleven_v3" }] };
    const curated = { ...voice("curated"), source: "curated" as const };
    const ordinaryTwo = voice("ordinary-two");
    fake.api.listVoiceCatalog = async () => catalog([ordinary, verified, curated, ordinaryTwo]);
    const controller = createVoiceSettingsController(() => fake.api);
    controller.setScope(scope);
    controller.setCatalogFilters({ language: "en" });

    await controller.loadCatalog();

    expect(controller.getCatalog().voices.map((item) => item.voiceId)).toEqual([
      "curated", "verified", "ordinary", "ordinary-two",
    ]);
  });

  test("restores a matching successful catalog while retrying a transient failure", async () => {
    const fake = fakeApi();
    let failing = false;
    fake.api.listVoiceCatalog = async () => {
      if (failing) throw Object.assign(new Error("Service Unavailable"), { status: 503 });
      return catalog([voice("voice-a")]);
    };
    const controller = createVoiceSettingsController(() => fake.api);
    controller.setScope(scope);
    controller.setCatalogFilters({ search: "calm" });
    await controller.loadCatalog();
    controller.setCatalogFilters({ search: "other" });
    controller.setCatalogFilters({ search: "calm" });
    expect(controller.getCatalog().voices.map((item) => item.voiceId)).toEqual(["voice-a"]);

    failing = true;
    await controller.loadCatalog();

    expect(controller.getCatalog().voices.map((item) => item.voiceId)).toEqual(["voice-a"]);
    expect(controller.getCatalog().error?.message).toBe("Service Unavailable");
  });

  test("assigns a primary or language voice then refreshes canonical profile", async () => {
    const fake = fakeApi(); const controller = createVoiceSettingsController(() => fake.api);
    controller.setScope(scope); await controller.load();
    expect(await controller.assign(voice("voice-a", "Ava"), "default")).toEqual({ status: "applied" });
    expect(await controller.assign(voice("voice-fr", "Amelie"), "fr")).toEqual({ status: "applied" });
    expect(fake.calls).toEqual(["get", "upsert:default:voice-a", "get", "upsert:fr:voice-fr", "get"]);
    expect(controller.data.getState().data?.voices).toMatchObject({ default: { voiceId: "voice-a" }, fr: { voiceId: "voice-fr" } });
  });

  test("promotes language assignment, removes language assignment, and protects primary removal", async () => {
    const fake = fakeApi(profile({ default: { voiceId: "primary", voiceName: "Primary" }, es: { voiceId: "spanish", voiceName: "Spanish" } }));
    const controller = createVoiceSettingsController(() => fake.api);
    controller.setScope(scope); await controller.load();
    expect(await controller.makePrimary("es")).toEqual({ status: "applied" });
    expect(await controller.removeLanguage("es")).toEqual({ status: "applied" });
    expect(await controller.removeLanguage("default")).toEqual({ status: "failed", message: "Your primary voice cannot be removed. Choose another primary voice instead." });
    expect(fake.calls).toEqual(["get", "upsert:default:spanish", "get", "remove:es", "get"]);
  });

  test("keeps local Speak responses state out of this server API controller", async () => {
    const fake = fakeApi(); const controller = createVoiceSettingsController(() => fake.api);
    controller.setScope(scope);
    // The controller has no local playback-toggle mutation; reads occur only when explicitly asked.
    expect(fake.calls).toEqual([]);
  });

  test("previews the exact selected ElevenLabs voice with canonical Genie copy", async () => {
    const fake = fakeApi(); const controller = createVoiceSettingsController(() => fake.api);
    controller.setScope(scope);
    await controller.preview("JSWO6cw2AyFE324d5kEr", "en");
    expect(fake.calls).toEqual([
      "preview:JSWO6cw2AyFE324d5kEr:Hi, I'm your Genie. [laughs] I can help you think, plan, and make things.",
    ]);
  });
});
