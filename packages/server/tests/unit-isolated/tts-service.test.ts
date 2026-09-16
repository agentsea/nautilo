/**
 * Isolated runner: this suite `mock.module`s `../../src/realtime/ws-publisher`
 * (broadcast) and `@nautilo/agent`. Bun's `mock.module` is process-global and
 * never auto-restores, so the no-op `broadcast` overlay would leak into any
 * later file in a shared `bun test` process and silently break real-broadcast
 * suites (e.g. `ws-publisher-m075-audience`). Each file under
 * `tests/unit-isolated/` runs in its own `bun test` invocation (see
 * `scripts/run-unit.sh`) so the leak is contained.
 */
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { eventBus } from "@nautilo/runtime";

const broadcastMock = mock((_event: unknown, _audience?: unknown) => {});
mock.module("../../src/realtime/ws-publisher", () => ({
  broadcast: (event: unknown, audience?: unknown) => broadcastMock(event, audience),
}));

const CATALOG_VOICE_ID = "Zz9K7mNpQx2wY4vB6nHj";
const JESSICA_VOICE_ID = "cgSgspJ2msm6clMCkdW9";
// D261 — the sole hard default when no voices-map entry resolves.
const HARD_DEFAULT_VOICE_ID = "JSWO6cw2AyFE324d5kEr";
const AGENT_A = "11111111-1111-4111-8111-111111111111";
const AGENT_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type VoiceMap = Record<string, { voiceId: string; voiceName: string }>;

// D261 — resolver reads the per-language voices map: getVoices(agentId) for the
// agent path, getProfile(userId).voices for the legacy user-keyed fallback.
const getVoicesMock = mock(async (_agentId: string) => ({}) as VoiceMap);
const getProfileMock = mock(
  async (_userId: string) => null as { voices: VoiceMap } | null,
);

const realAgent = await import("@nautilo/agent");
mock.module("@nautilo/agent", () => ({
  ...realAgent,
  getVoices: (agentId: string) => getVoicesMock(agentId),
  getProfile: (userId: string) => getProfileMock(userId),
}));

import { TtsService } from "../../src/realtime/tts-service";

function ref(voiceId: string, voiceName = "Test"): { voiceId: string; voiceName: string } {
  return { voiceId, voiceName };
}

type TtsServiceInternals = {
  queue: { text: string; index: number; final: boolean }[];
  stopped: boolean;
  processing: boolean;
  abortController: AbortController | null;
  voiceCache: Map<string, { voiceId: string; source: string; expiresAt: number }>;
  suggestionEmitted: Set<string>;
  maybeEmitVoiceSuggestion: (
    sentence: { agentId?: string; userId?: string; lang?: string },
    voices: VoiceMap,
  ) => void;
  loadVoicesMap: (agentId?: string, userId?: string) => Promise<VoiceMap>;
  enqueue: (event: {
    type: "voice.sentence";
    text: string;
    index: number;
    final: boolean;
    roomId?: string;
    userId?: string;
    agentId?: string;
    lang?: string;
  }) => void;
  synthesize: (sentence: {
    text: string;
    index: number;
    final: boolean;
    roomId?: string;
    userId?: string;
    agentId?: string;
    lang?: string;
  }) => Promise<void>;
  resolveVoiceId: (
    agentId?: string,
    userId?: string,
    lang?: string,
  ) => Promise<{ voiceId: string; source: string }>;
  invalidateVoiceCache: (userId?: string) => void;
};

function internals(service: TtsService): TtsServiceInternals {
  return service as unknown as TtsServiceInternals;
}

describe("TtsService", () => {
  afterEach(() => {
    getVoicesMock.mockClear();
    getVoicesMock.mockImplementation(async () => ({}));
    getProfileMock.mockClear();
    getProfileMock.mockImplementation(async () => null);
    broadcastMock.mockClear();
  });

  afterAll(() => {
    mock.module("@nautilo/agent", () => realAgent);
  });

  test("stop() clears queue and sets stopped flag", () => {
    const service = new TtsService();
    const svc = internals(service);

    svc.enqueue({ type: "voice.sentence", text: "Hello world.", index: 0, final: false });
    svc.enqueue({ type: "voice.sentence", text: "Second sentence.", index: 1, final: true });

    service.stop();

    expect(svc.queue.length).toBe(0);
    expect(svc.stopped).toBe(true);
  });

  test("stop() aborts in-flight request", () => {
    const service = new TtsService();
    const svc = internals(service);

    const controller = new AbortController();
    svc.abortController = controller;

    service.stop();

    expect(controller.signal.aborted).toBe(true);
    expect(svc.abortController).toBeNull();
  });

  test("enqueue resets stopped flag", () => {
    const service = new TtsService();
    const svc = internals(service);

    service.stop();
    expect(svc.stopped).toBe(true);

    svc.enqueue({ type: "voice.sentence", text: "New sentence.", index: 0, final: false });
    expect(svc.stopped).toBe(false);
  });

  test("synthesize skips empty text after emoji/tag stripping", async () => {
    const service = new TtsService();
    const svc = internals(service);

    await svc.synthesize({ text: "[tag only]", index: 0, final: false });
    await svc.synthesize({ text: "", index: 1, final: false });
  });

  test("D570 — synthesized audio preserves requester and origin Room", async () => {
    const originalFetch = globalThis.fetch;
    const originalApiKey = process.env["ELEVENLABS_API_KEY"];
    process.env["ELEVENLABS_API_KEY"] = "test-key";
    globalThis.fetch = mock(async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
    })) as unknown as typeof fetch;

    try {
      const service = new TtsService();
      await internals(service).synthesize({
        text: "Peer feedback is ready.",
        index: 2,
        final: true,
        roomId: "room-origin",
        userId: USER_A,
        agentId: AGENT_A,
      });

      const audio = broadcastMock.mock.calls
        .map((call) => call[0] as Record<string, unknown>)
        .filter((event) => event["type"] === "voice.audio");
      expect(audio).toHaveLength(2);
      expect(audio[0]).toMatchObject({
        roomId: "room-origin",
        userId: USER_A,
        sentenceIndex: 2,
        final: false,
      });
      expect(audio[1]).toMatchObject({
        roomId: "room-origin",
        userId: USER_A,
        sentenceIndex: 2,
        final: true,
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalApiKey === undefined) delete process.env["ELEVENLABS_API_KEY"];
      else process.env["ELEVENLABS_API_KEY"] = originalApiKey;
    }
  });

  test("resolveVoiceId returns hard default when no agent or user", async () => {
    const service = new TtsService();
    const svc = internals(service);

    const resolved = await svc.resolveVoiceId();
    expect(resolved.voiceId).toBe(HARD_DEFAULT_VOICE_ID);
    expect(resolved.source).toBe("default");
    expect(getVoicesMock).not.toHaveBeenCalled();
    expect(getProfileMock).not.toHaveBeenCalled();
  });

  test("resolveVoiceId reads voices.default for the speaking agent", async () => {
    getVoicesMock.mockImplementation(async () => ({ default: ref(CATALOG_VOICE_ID) }));

    const service = new TtsService();
    const resolved = await internals(service).resolveVoiceId(AGENT_A);

    expect(resolved.voiceId).toBe(CATALOG_VOICE_ID);
    expect(resolved.source).toBe("profile");
    expect(getVoicesMock).toHaveBeenCalledWith(AGENT_A);
  });

  test("resolveVoiceId routes a tagged language to its voice, falling back to default", async () => {
    getVoicesMock.mockImplementation(async () => ({
      default: ref(CATALOG_VOICE_ID),
      es: ref(JESSICA_VOICE_ID),
    }));

    const service = new TtsService();
    const svc = internals(service);

    const es = await svc.resolveVoiceId(AGENT_A, undefined, "es");
    expect(es.voiceId).toBe(JESSICA_VOICE_ID);

    // Unmapped language → primary (voices.default).
    const fr = await svc.resolveVoiceId(AGENT_A, undefined, "fr");
    expect(fr.voiceId).toBe(CATALOG_VOICE_ID);
  });

  test("resolveVoiceId falls back to getProfile().voices when only a userId is present", async () => {
    getProfileMock.mockImplementation(async () => ({ voices: { default: ref(CATALOG_VOICE_ID) } }));

    const service = new TtsService();
    const resolved = await internals(service).resolveVoiceId(undefined, USER_A);

    expect(resolved.voiceId).toBe(CATALOG_VOICE_ID);
    expect(resolved.source).toBe("profile");
    expect(getProfileMock).toHaveBeenCalledWith(USER_A);
  });

  test("resolveVoiceId falls back to hard default when the mapped voiceId is invalid", async () => {
    getVoicesMock.mockImplementation(async () => ({ default: ref("bad/id") }));

    const service = new TtsService();
    const resolved = await internals(service).resolveVoiceId(AGENT_A);

    expect(resolved.voiceId).toBe(HARD_DEFAULT_VOICE_ID);
    expect(resolved.source).toBe("default");
  });

  test("resolveVoiceId cache hit avoids repeated getVoices within TTL", async () => {
    getVoicesMock.mockImplementation(async () => ({ default: ref(CATALOG_VOICE_ID) }));

    const service = new TtsService();
    const svc = internals(service);

    await svc.resolveVoiceId(AGENT_A);
    await svc.resolveVoiceId(AGENT_A);

    expect(getVoicesMock).toHaveBeenCalledTimes(1);
    // Cache key is agent-scoped + language: `${agentId}:default`.
    expect(svc.voiceCache.has(`${AGENT_A}:default`)).toBe(true);
  });

  test("profile.updated clears the whole voice cache", () => {
    const service = new TtsService();
    const svc = internals(service);
    svc.voiceCache.set(`${AGENT_A}:default`, {
      voiceId: CATALOG_VOICE_ID,
      source: "profile",
      expiresAt: Date.now() + 60_000,
    });
    svc.voiceCache.set(`${AGENT_B}:default`, {
      voiceId: JESSICA_VOICE_ID,
      source: "profile",
      expiresAt: Date.now() + 60_000,
    });

    service.start();
    eventBus.emit({
      type: "profile.updated",
      profileId: "profile-a",
      name: "User A",
      onboardingCompleted: true,
      userId: USER_A,
    });

    // Cache keys are agent-scoped; profile.updated carries only userId, so the
    // resolver clears the full cache rather than guessing the agent key.
    expect(svc.voiceCache.size).toBe(0);
  });

  test("D261 — resolveVoiceId routes tagged es and unmapped fr to default", async () => {
    getVoicesMock.mockImplementation(async () => ({
      default: ref(CATALOG_VOICE_ID),
      es: ref(JESSICA_VOICE_ID),
    }));

    const service = new TtsService();
    const svc = internals(service);

    const es = await svc.resolveVoiceId(AGENT_A, undefined, "es");
    expect(es.voiceId).toBe(JESSICA_VOICE_ID);

    const fr = await svc.resolveVoiceId(AGENT_A, undefined, "fr");
    expect(fr.voiceId).toBe(CATALOG_VOICE_ID);
  });

  test("D261 — unmapped tagged lang emits exactly one voice.suggestion", () => {
    getVoicesMock.mockImplementation(async () => ({ default: ref(CATALOG_VOICE_ID) }));

    const service = new TtsService();
    const svc = internals(service);
    const voices = { default: ref(CATALOG_VOICE_ID) };
    const sentence = { agentId: AGENT_A, userId: USER_A, lang: "fr" };

    svc.maybeEmitVoiceSuggestion(sentence, voices);
    svc.maybeEmitVoiceSuggestion(sentence, voices);
    svc.maybeEmitVoiceSuggestion({ ...sentence, lang: "de" }, voices);

    const suggestions = broadcastMock.mock.calls.filter(
      (call) => (call[0] as { type?: string }).type === "voice.suggestion",
    );
    expect(suggestions.length).toBe(2);
    expect(suggestions[0]![0]).toMatchObject({
      type: "voice.suggestion",
      language: "fr",
      agentId: AGENT_A,
      userId: USER_A,
    });
    expect(suggestions[1]![0]).toMatchObject({ language: "de" });
    expect(suggestions.filter((c) => (c[0] as { language: string }).language === "fr").length).toBe(
      1,
    );
  });

  test("D261 — profile.updated clears suggestion debounce", () => {
    getVoicesMock.mockImplementation(async () => ({ default: ref(CATALOG_VOICE_ID) }));

    const service = new TtsService();
    const svc = internals(service);
    svc.suggestionEmitted.add(`${AGENT_A}:fr`);

    service.start();
    eventBus.emit({
      type: "profile.updated",
      profileId: "profile-a",
      name: "User A",
      onboardingCompleted: true,
      userId: USER_A,
    });

    expect(svc.suggestionEmitted.size).toBe(0);
  });

  test("invalidateVoiceCache clears all entries", () => {
    const service = new TtsService();
    const svc = internals(service);
    svc.voiceCache.set(`${AGENT_A}:default`, {
      voiceId: CATALOG_VOICE_ID,
      source: "profile",
      expiresAt: Date.now() + 60_000,
    });
    svc.voiceCache.set(`${AGENT_B}:default`, {
      voiceId: JESSICA_VOICE_ID,
      source: "profile",
      expiresAt: Date.now() + 60_000,
    });

    svc.invalidateVoiceCache(USER_A);
    expect(svc.voiceCache.size).toBe(0);
  });
});
