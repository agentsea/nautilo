import { expect, test } from "bun:test";
import { dialogueSpeechResponse, type DialogueSpeechRequest } from "../../src/realtime/dialogue-speech";

const request = (signal = new AbortController().signal): DialogueSpeechRequest => ({
  text: "A short test sentence.", voiceId: "SavedVoice123", model: "eleven_v3_conversational",
  format: "pcm_24000", apiKey: "synthetic-test-key", signal, onSubmitted: () => {},
});

test("dialogue requests the exact model, assigned voice, format and abort signal", async () => {
  let submissions = 0;
  const input = { ...request(), onSubmitted: () => { submissions++; } };
  const expected = new Response(new Uint8Array([0, 1, 2, 3]));
  const actual = await dialogueSpeechResponse(input, (async (url, init) => {
    expect(String(url)).toBe("https://api.elevenlabs.io/v1/text-to-dialogue/stream?output_format=pcm_24000");
    expect(init.signal).toBe(input.signal);
    expect(JSON.parse(typeof init.body === "string" ? init.body : "{}") as unknown).toEqual({
      inputs: [{ text: input.text, voice_id: input.voiceId }],
      model_id: "eleven_v3_conversational", settings: { stability: 0.5 },
    });
    return expected;
  }));
  expect(actual).toBe(expected); expect(submissions).toBe(1);
});

test("cancellation before admission never submits", async () => {
  const abort = new AbortController(); abort.abort(); let calls = 0;
  let rejected = false;
  try { await dialogueSpeechResponse(request(abort.signal), async () => { calls++; return new Response(); }); } catch { rejected = true; }
  expect(rejected).toBe(true);
  expect(calls).toBe(0);
});

test("large frames and slow playback preserve every sample without reading the whole reply ahead", async () => {
  const chunks = Array.from({ length: 12 }, (_, index) => new Uint8Array(24000 * 2 * 6).fill(index));
  let pulled = 0; let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(sink) { if (pulled === chunks.length) sink.close(); else sink.enqueue(chunks[pulled++]); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const response = await dialogueSpeechResponse(request(), (async () => new Response(body)));
  expect(pulled).toBe(0);
  const reader = response.body!.getReader();
  for (let index = 0; index < chunks.length; index++) {
    const next = await reader.read();
    expect(Buffer.from(next.value as Uint8Array).equals(Buffer.from(chunks[index]!))).toBe(true);
    expect(pulled).toBe(index + 1);
    await Bun.sleep(1);
  }
  expect((await reader.read()).done).toBe(true);
  expect(cancelled).toBe(false);
});

test("cancelling response consumption releases the provider body", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const response = await dialogueSpeechResponse(request(), (async () => new Response(body)));
  await response.body!.cancel(); expect(cancelled).toBe(true);
});
