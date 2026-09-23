import { expect, test } from "bun:test";
import { SpeechCapture, type CaptureSnapshot, type SpeechCaptureDependencies } from "../../src/lib/speech-capture";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(overrides: Partial<SpeechCaptureDependencies> = {}) {
  let tracksStopped = 0;
  const stream = { getTracks: () => [{ stop: () => { tracksStopped++; } }] } as unknown as MediaStream;
  const recorder = {
    state: "inactive", mimeType: "audio/webm", onstop: null as (() => void) | null,
    ondataavailable: null as ((e: { data: Blob }) => void) | null, onerror: null,
    start() { this.state = "recording"; },
    stop() { this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["audio"]) }); this.onstop?.(); },
  };
  const states: CaptureSnapshot[] = []; const results: string[] = [];
  let signal: AbortSignal | undefined;
  const capture = new SpeechCapture({ permission: async () => {}, stream: async () => stream,
    recorder: () => recorder as unknown as MediaRecorder,
    transcribe: async (_blob, current) => { signal = current; return "Hello"; }, ...overrides,
  }, state => states.push(state), text => results.push(text));
  return { capture, states, results, stream, recorder, stopped: () => tracksStopped, signal: () => signal };
}

test("finish stops hardware and transcribes once; a new capture remains usable", async () => {
  const f = fixture(); await f.capture.start(); expect(f.capture.getState().state).toBe("listening");
  f.capture.finish(); f.capture.finish(); await Promise.resolve();
  expect(f.stopped()).toBeGreaterThan(0); expect(f.results).toEqual(["Hello"]);
  await f.capture.start(); f.capture.cancel(); expect(f.results).toEqual(["Hello"]);
});
test("mute while OS permission is pending never acquires the microphone", async () => {
  const permission = deferred<void>(); let acquired = false;
  const f = fixture({ permission: () => permission.promise, stream: async () => { acquired = true; return f.stream; } });
  const start = f.capture.start(); f.capture.cancel(); permission.resolve(); await start;
  expect(acquired).toBe(false); expect(f.capture.getState().state).toBe("idle");
});
test("late getUserMedia after mute closes all acquired tracks without recording", async () => {
  const stream = deferred<MediaStream>(); const f = fixture({ stream: () => stream.promise });
  const start = f.capture.start(); await Promise.resolve(); f.capture.cancel(); stream.resolve(f.stream); await start;
  expect(f.stopped()).toBe(1); expect(f.recorder.state).toBe("inactive");
});
test("mute aborts STT and fences a server response that still arrives", async () => {
  const pending = deferred<string>(); let signal: AbortSignal | undefined;
  const f = fixture({ transcribe: (_blob, s) => { signal = s; return pending.promise; } });
  await f.capture.start(); f.capture.finish(); f.capture.cancel();
  expect(signal?.aborted).toBe(true); pending.resolve("Do not send"); await Promise.resolve();
  expect(f.results).toEqual([]); expect(f.capture.getState().state).toBe("idle");
});
test("main composer and companion cannot own the microphone simultaneously", async () => {
  const first = fixture(); const second = fixture();
  await first.capture.start(); await second.capture.start();
  expect(first.capture.getState().state).toBe("idle"); expect(first.stopped()).toBeGreaterThan(0);
  expect(second.capture.getState().state).toBe("listening"); second.capture.cancel();
});
test("permission and transcription failures release the lease and remain retryable", async () => {
  const f = fixture({ permission: async () => { throw new Error("Denied"); } }); await f.capture.start();
  expect(f.capture.getState()).toMatchObject({ state: "error", error: "Denied", errorKind: "capture" });
  const next = fixture({ transcribe: async () => { throw new Error("Unavailable"); } });
  await next.capture.start(); next.capture.finish(); await Promise.resolve(); await Promise.resolve();
  expect(next.capture.getState()).toMatchObject({ state: "error", error: "Unavailable", errorKind: "transcription" }); next.capture.cancel();
});
