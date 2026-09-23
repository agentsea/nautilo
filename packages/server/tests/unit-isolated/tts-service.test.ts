import { afterEach, describe, expect, test } from "bun:test";
import { TtsService, type TtsServiceDependencies } from "../../src/realtime/tts-service";
import type { VoiceAudience } from "../../src/realtime/voice-delivery";
import { getServerSpeechModel } from "@nautilo/agent";
import type { VoiceSentenceEvent } from "@nautilo/types";
import { ServerProviderCredentialsDeniedError } from "@nautilo/trust";

const services: TtsService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.dispose())); });
const sentence = (userId = "owner-a", turnId = "turn-a", index = 0): VoiceSentenceEvent =>
  ({ type: "voice.sentence", text: "A complete spoken sentence.", index, final: false, userId, turnId, roomId: "room-a", agentId: "agent-a" });
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(1);
  expect(check()).toBe(true);
}
function harness(overrides: Partial<TtsServiceDependencies> = {}, format: VoiceAudience["format"] = "pcm_24000") {
  const controls: Array<{ userId: string; event: Record<string, unknown> }> = [];
  const audio: Array<{ userId: string; pcm: Uint8Array; sequence: number }> = [];
  const legacy: unknown[] = [];
  const receipts: unknown[] = [];
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let voiceReads = 0;
  const service = new TtsService({
    assertCanUseServerProviderCredentials: async () => {},
    apiKey: () => "synthetic-test-key",
    model: () => getServerSpeechModel("elevenlabs:eleven_v3", { ELEVENLABS_API_KEY: "synthetic-test-key" }),
    voices: async () => { voiceReads++; return { default: { voiceId: "TestVoice1234", voiceName: "Test" } }; },
    admit: userId => {
      const controller = new AbortController();
      return { format, signal: controller.signal, dispose: () => controller.abort(), drained: async () => {},
        control: event => { if (format === "pcm_24000") controls.push({ userId, event }); },
        audio: async frame => { audio.push({ userId, pcm: frame.pcm, sequence: frame.sequence }); },
        legacy: event => { if (format === "mp3_44100_128") legacy.push(event); } };
    },
    fetch: async (url, init) => {
      requests.push({ url, init });
      return new Response(new Uint8Array([0, 1, 2, 3]));
    },
    record: async receipt => { receipts.push(receipt); },
    observe: () => {},
    ...overrides,
  });
  services.push(service);
  return { service, controls, audio, legacy, requests, receipts, voiceReads: () => voiceReads };
}

describe("turn-owned streaming speech", () => {
  test("the server Conversational model uses dialogue with the saved voice and its own estimate", async () => {
    let model = ""; let voiceId = "";
    const h = harness({
      model: () => getServerSpeechModel("elevenlabs:eleven_v3_conversational", { ELEVENLABS_API_KEY: "synthetic-test-key" }),
      voices: async () => ({ default: { voiceId: "SavedVoice123", voiceName: "Saved voice" } }),
      dialogue: async request => { model = request.model; voiceId = request.voiceId; request.onSubmitted(); return new Response(new Uint8Array([0, 1, 2, 3])); },
    });
    h.service.enqueue(sentence()); h.service.finish("owner-a", "turn-a", false);
    await until(() => h.receipts.length === 1);
    expect(h.requests).toHaveLength(0);
    expect(model).toBe("eleven_v3_conversational"); expect(voiceId).toBe("SavedVoice123");
    expect(h.controls[0]!.event["model"]).toBe("elevenlabs:eleven_v3_conversational");
    expect(h.receipts[0]).toMatchObject({ estimatedCostUsd: (sentence().text.length * 0.00005).toFixed(8) });
  });
  test("missing authority never reaches a provider", async () => {
    const h = harness();
    h.service.enqueue({ ...sentence(), userId: undefined });
    h.service.enqueue({ ...sentence(), agentId: undefined });
    h.service.enqueue({ ...sentence(), turnId: undefined });
    await Bun.sleep(1);
    expect(h.requests).toHaveLength(0);
  });

  test("a Human without current server funding authority never reaches the provider", async () => {
    const checked: string[] = [];
    const h = harness({
      assertCanUseServerProviderCredentials: async (humanUserId) => {
        checked.push(humanUserId);
        throw new ServerProviderCredentialsDeniedError(humanUserId, "realtime_text_to_speech");
      },
    });
    h.service.enqueue(sentence("community-human"));
    h.service.finish("community-human", "turn-a", false);
    await until(() => checked.length === 1);
    expect(checked).toEqual(["community-human"]);
    expect(h.requests).toHaveLength(0);
    expect(h.receipts).toHaveLength(0);
    expect(h.controls).toHaveLength(0);
  });

  test("rechecks current Human authority before every paid sentence dispatch", async () => {
    let checks = 0;
    const h = harness({
      assertCanUseServerProviderCredentials: async (humanUserId) => {
        checks += 1;
        if (checks > 1) {
          throw new ServerProviderCredentialsDeniedError(humanUserId, "realtime_text_to_speech");
        }
      },
    });
    h.service.enqueue(sentence());
    h.service.enqueue({ ...sentence("owner-a", "turn-a", 1), text: "Authority was revoked." });
    h.service.finish("owner-a", "turn-a", false);
    await until(() => checks === 2);
    expect(h.requests).toHaveLength(1);
    expect(h.receipts).toHaveLength(1);
    await until(() => h.controls.some(item => item.event["type"] === "voice.stream.abort"));
  });

  test("enabling voice after the first segment does not admit a partial turn", async () => {
    const h = harness(); h.service.enqueue(sentence("owner-a", "turn-a", 1));
    await Bun.sleep(1); expect(h.requests).toHaveLength(0);
  });

  for (const scenario of ["missing", "invalid", "lookup failure"] as const) {
    test(`uses Jessica when the voice assignment is ${scenario}`, async () => {
      const h = harness({ voices: async () => {
        if (scenario === "lookup failure") throw new Error("Profile unavailable");
        return scenario === "missing" ? {} : { default: { voiceId: "invalid/id", voiceName: "Invalid" } };
      } });
      h.service.enqueue(sentence()); h.service.finish("owner-a", "turn-a", false);
      await until(() => h.receipts.length === 1);
      expect(new URL(h.requests[0]!.url).pathname).toBe("/v1/text-to-speech/cgSgspJ2msm6clMCkdW9/stream");
      expect(h.audio).toHaveLength(1);
    });
  }

  test("preserves an explicitly assigned Carolyn voice", async () => {
    const h = harness({ voices: async () => ({ default: { voiceId: "JSWO6cw2AyFE324d5kEr", voiceName: "Carolyn" } }) });
    h.service.enqueue(sentence()); h.service.finish("owner-a", "turn-a", false);
    await until(() => h.receipts.length === 1);
    expect(new URL(h.requests[0]!.url).pathname).toBe("/v1/text-to-speech/JSWO6cw2AyFE324d5kEr/stream");
  });

  test("uses the saved Genie voice and its assigned language voices exactly", async () => {
    const h = harness({ voices: async () => ({
      default: { voiceId: "SavedGenieVoice", voiceName: "Saved voice" },
      es: { voiceId: "SavedSpanishVoice", voiceName: "Saved Spanish voice" },
    }) });
    h.service.enqueue(sentence());
    h.service.enqueue({ ...sentence("owner-a", "turn-a", 1), lang: "es" });
    h.service.finish("owner-a", "turn-a", false);
    await until(() => h.receipts.length === 2);
    expect(h.requests.map(request => new URL(request.url).pathname)).toEqual([
      "/v1/text-to-speech/SavedGenieVoice/stream", "/v1/text-to-speech/SavedSpanishVoice/stream",
    ]);
  });

  test("a second Genie waits until the prior turn's playback has drained", async () => {
    let release!: () => void;
    const drained = new Promise<void>(resolve => { release = resolve; });
    let admits = 0;
    const h = harness({ admit: () => {
      const abort = new AbortController(); const first = admits++ === 0;
      return { format: "pcm_24000", signal: abort.signal, control: () => {}, audio: async () => {},
        legacy: () => {}, dispose: () => abort.abort(), drained: () => first ? drained : Promise.resolve() };
    } });
    h.service.enqueue(sentence());
    h.service.enqueue({ ...sentence(), agentId: "agent-b" });
    h.service.finish("owner-a", "turn-a", false, "agent-a");
    await until(() => h.receipts.length === 1);
    expect(h.requests).toHaveLength(1);
    release(); await until(() => h.requests.length === 2);
    h.service.finish("owner-a", "turn-a", false, "agent-b");
  });

  test("plays split PCM before completion, preserves samples and closes exactly once", async () => {
    let writer!: ReadableStreamDefaultController<Uint8Array>;
    const h = harness({ fetch: async () => new Response(new ReadableStream<Uint8Array>({ start(c) { writer = c; } })) });
    h.service.enqueue(sentence());
    await until(() => Boolean(writer));
    writer.enqueue(new Uint8Array([0, 1, 2]));
    await until(() => h.audio.length === 1);
    expect([...h.audio[0]!.pcm]).toEqual([0, 1]);
    expect(h.controls.map(x => x.event["type"])).toEqual(["voice.stream.start"]);
    h.service.finish("owner-a", "turn-a", false);
    writer.enqueue(new Uint8Array([3, 4, 5])); writer.close();
    await until(() => h.controls.some(x => x.event["type"] === "voice.stream.end"));
    expect([...h.audio[1]!.pcm]).toEqual([2, 3, 4, 5]);
    expect(h.audio.map(x => x.sequence)).toEqual([0, 1]);
    expect(h.controls.map(x => x.event["type"])).toEqual(["voice.stream.start", "voice.stream.end"]);
    expect(h.legacy).toHaveLength(0);
    expect(h.receipts).toHaveLength(1);
  });

  test("freezes one voice snapshot and keeps a single ordered stream for multiple sentences", async () => {
    const h = harness();
    h.service.enqueue(sentence());
    h.service.enqueue({ ...sentence("owner-a", "turn-a", 1), text: "The next sentence follows." });
    h.service.finish("owner-a", "turn-a", false);
    await until(() => h.controls.some(x => x.event["type"] === "voice.stream.end"));
    expect(h.voiceReads()).toBe(1);
    expect(h.requests).toHaveLength(2);
    expect(h.requests.every(x => x.url.includes("TestVoice1234") && x.url.endsWith("pcm_24000"))).toBe(true);
    expect(h.controls.map(x => x.event["type"])).toEqual(["voice.stream.start", "voice.stream.end"]);
    expect(h.audio.map(x => x.sequence)).toEqual([0, 1]);
  });

  test("stopping one owner leaves another owner's request running; late tokens stay fenced", async () => {
    const signals: AbortSignal[] = [];
    const writers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const h = harness({ fetch: async (_url, init) => {
      const signal = init.signal!;
      signals.push(signal);
      return new Response(new ReadableStream<Uint8Array>({
        start(c) { writers.push(c); signal.addEventListener("abort", () => c.error(new DOMException("Aborted", "AbortError")), { once: true }); },
      }));
    } });
    h.service.enqueue(sentence());
    h.service.enqueue(sentence("owner-b", "turn-b"));
    await until(() => writers.length === 2);
    writers[0]!.enqueue(new Uint8Array([0, 1]));
    writers[1]!.enqueue(new Uint8Array([2, 3]));
    await until(() => h.audio.length === 2);
    h.service.stop("owner-a", "turn-a");
    expect(signals[0]!.aborted).toBe(true); expect(signals[1]!.aborted).toBe(false);
    h.service.enqueue(sentence("owner-a", "turn-a", 1));
    h.service.finish("owner-a", "turn-a", true);
    h.service.finish("owner-b", "turn-b", false); writers[1]!.close();
    await until(() => h.receipts.length === 2);
    expect(signals).toHaveLength(2);
    expect(h.controls.filter(x => x.event["type"] === "voice.stream.abort").map(x => x.userId)).toEqual(["owner-a"]);
    expect(h.controls.filter(x => x.event["type"] === "voice.stream.end").map(x => x.userId)).toEqual(["owner-b"]);
  });

  test("mixed/old audience requests one MP3 representation", async () => {
    const h = harness({}, "mp3_44100_128");
    h.service.enqueue(sentence()); h.service.finish("owner-a", "turn-a", false);
    await until(() => h.receipts.length === 1);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.url.endsWith("mp3_44100_128")).toBe(true);
    expect(h.audio).toHaveLength(0);
    expect(h.legacy).toHaveLength(2);
  });

  test("a lookup rejected after Stop cannot create a new provider request", async () => {
    let resolve!: (voices: Record<string, never>) => void;
    const h = harness({ voices: () => new Promise(r => { resolve = r; }) });
    h.service.enqueue(sentence()); h.service.stop("owner-a"); resolve({});
    h.service.finish("owner-a", "turn-a", true);
    await Bun.sleep(2);
    expect(h.requests).toHaveLength(0); expect(h.controls).toHaveLength(0);
  });

  test("two Genies in the same turn retain distinct terminal ownership", async () => {
    const h = harness();
    h.service.enqueue(sentence());
    h.service.enqueue({ ...sentence(), agentId: "agent-b" });
    h.service.finish("owner-a", "turn-a", false, "agent-a");
    await until(() => h.requests.length === 2);
    expect(h.controls.filter(x => x.event["type"] === "voice.stream.end")).toHaveLength(1);
    h.service.finish("owner-a", "turn-a", false, "agent-b");
    await until(() => h.controls.filter(x => x.event["type"] === "voice.stream.end").length === 2);
  });
});

test("server model changes apply to the next turn and never to later sentences in an admitted reply", async () => {
  let selection = "elevenlabs:eleven_v3";
  const models: string[] = [];
  const h = harness({ model: () => getServerSpeechModel(selection, { ELEVENLABS_API_KEY: "synthetic-test-key" }),
    dialogue: async request => { models.push(request.model); request.onSubmitted(); return new Response(new Uint8Array([0, 1])); },
  });
  h.service.enqueue(sentence());
  selection = "elevenlabs:eleven_v3_conversational";
  h.service.enqueue(sentence("owner-a", "turn-a", 1));
  h.service.finish("owner-a", "turn-a", false);
  await until(() => h.receipts.length === 2);
  expect(h.requests).toHaveLength(2); expect(models).toHaveLength(0);
  h.service.enqueue(sentence("owner-a", "turn-b")); h.service.finish("owner-a", "turn-b", false);
  await until(() => h.receipts.length === 3);
  expect(models).toEqual(["eleven_v3_conversational"]);
});

test("cost writes overlap the next request and bounded admission drains on shutdown", async () => {
  const releases: Array<() => void> = [];
  const h = harness({ record: () => new Promise(resolve => { releases.push(resolve); }) });
  h.service.enqueue(sentence()); h.service.enqueue(sentence("owner-a", "turn-a", 1)); h.service.enqueue(sentence("owner-a", "turn-a", 2));
  h.service.finish("owner-a", "turn-a", false);
  await until(() => releases.length === 2);
  expect(h.requests).toHaveLength(2);
  releases.shift()!();
  await until(() => h.requests.length === 3);
  await until(() => releases.length === 2);
  let disposed = false;
  const disposing = h.service.dispose().then(() => { disposed = true; });
  await Bun.sleep(0); expect(disposed).toBe(false);
  for (const release of releases) release();
  await disposing; expect(disposed).toBe(true);
});
test("failure before response headers records uncertain cost without retrying generation", async () => {
  const h = harness({ fetch: async () => { throw new Error("Connection closed after dispatch"); } });
  h.service.enqueue(sentence()); h.service.finish("owner-a", "turn-a", false);
  await until(() => h.receipts.length === 1);
  expect(h.receipts[0]).toMatchObject({ evidenceState: "unknown", estimatedCostUsd: null });
  expect(h.audio).toHaveLength(0);
});

test("failed receipt writes release capacity without repeating paid synthesis", async () => {
  let attempts = 0;
  const h = harness({ record: async () => { attempts++; throw new Error("Synthetic storage failure"); } });
  for (let index = 0; index < 4; index++) h.service.enqueue(sentence("owner-a", "turn-a", index));
  h.service.finish("owner-a", "turn-a", false);
  await until(() => attempts === 4);
  await h.service.flushCosts();
  expect(h.requests).toHaveLength(4);
  expect(h.audio).toHaveLength(4);
  expect(h.controls.filter(x => x.event["type"] === "voice.stream.end")).toHaveLength(1);
});

test("partial provider failure aborts exposed speech and does not replay or switch models", async () => {
  let writer!: ReadableStreamDefaultController<Uint8Array>; let requests = 0;
  const h = harness({ fetch: async () => { requests++; return new Response(new ReadableStream<Uint8Array>({ start(c) { writer = c; } })); } });
  h.service.enqueue(sentence()); await until(() => Boolean(writer));
  writer.enqueue(new Uint8Array([0, 1])); await until(() => h.audio.length === 1);
  writer.error(new Error("Synthetic provider interruption"));
  await until(() => h.receipts.length === 1);
  h.service.enqueue(sentence("owner-a", "turn-a", 1)); h.service.finish("owner-a", "turn-a", true);
  expect(requests).toBe(1);
  expect(h.controls.map(x => x.event["type"])).toEqual(["voice.stream.start", "voice.stream.abort"]);
  expect(h.receipts[0]).toMatchObject({ evidenceState: "estimated" });
});
