import { expect, test } from "bun:test";
import { runGenerationSequence } from "./generation-sequence";
import type { NautiloVideoGenerationRequest } from "./bridge";

const sources = [{ kind: "shot", shotId: "opening" }, { kind: "shot", shotId: "ending" }] as const;

test("preparation shows the server recovery reason and never submits or continues", async () => {
  const message = "A selected Workspace reference is no longer available. No generation was started.";
  let count = 0;
  const result = await runGenerationSequence({ sources, signal: new AbortController().signal, onProgress: () => undefined,
    prepare: async source => requestFor(source as typeof sources[number]),
    request: async () => { count++; return { kind: "unavailable", code: "request_invalid", message }; },
    waitUntilReady: async () => { throw new Error("must not wait"); },
  });
  expect(result.message).toBe(message);
  expect(result.submittedTakeIds).toEqual([]);
  expect(count).toBe(1);
});
const requestFor = (source: typeof sources[number]): NautiloVideoGenerationRequest => ({
  document: { sha256: "a".repeat(64), revision: 1 }, sourceFingerprint: `sha256:${"b".repeat(64)}`,
  job: { source, modelId: "venice:seedance-2-5-text-to-video-basic", prompt: source.shotId },
});

test("sequence waits for the exact submitted take before preparing the next scene", async () => {
  const calls: string[] = [];
  const result = await runGenerationSequence({
    sources, signal: new AbortController().signal, onProgress: () => undefined,
    prepare: async (source) => { calls.push(`prepare:${JSON.stringify(source)}`); return requestFor(source as typeof sources[number]); },
    request: async (request) => { calls.push(`approve:${request.job.prompt}`); return { kind: "queued", takeId: request.job.prompt }; },
    waitUntilReady: async (takeId) => { calls.push(`ready:${takeId}`); },
  });
  expect(calls).toEqual([
    'prepare:{"kind":"shot","shotId":"opening"}', "approve:opening", "ready:opening",
    'prepare:{"kind":"shot","shotId":"ending"}', "approve:ending", "ready:ending",
  ]);
  expect(result.message).toBe("Generation complete. Your video is saved in Workspace.");
  expect(result).toMatchObject({ kind: "complete", completedTakeIds: ["opening", "ending"], nextIndex: 2 });
});

test("cancelled approval does not submit subsequent scenes", async () => {
  let requests = 0;
  const result = await runGenerationSequence({
    sources, signal: new AbortController().signal, onProgress: () => undefined,
    prepare: async (source) => requestFor(source as typeof sources[number]),
    request: async () => { requests++; return { kind: "cancelled" }; },
    waitUntilReady: async () => { throw new Error("must not wait"); },
  });
  expect(requests).toBe(1);
  expect(result).toMatchObject({ kind: "stopped", submittedTakeIds: [], nextIndex: 0 });
});

test("unknown submission, old hosts and failed jobs never trigger a paid retry", async () => {
  for (const failure of ["response-lost", "legacy-host", "provider-failed"]) {
    let requests = 0;
    const result = await runGenerationSequence({
      sources, signal: new AbortController().signal, onProgress: () => undefined,
      prepare: async (source) => requestFor(source as typeof sources[number]),
      request: async () => {
        requests++;
        if (failure === "response-lost") throw new Error("Network lost");
        return { kind: "queued", ...(failure === "legacy-host" ? {} : { takeId: "exact-take" }) };
      },
      waitUntilReady: async () => { throw new Error("Provider failed"); },
    });
    expect(requests).toBe(1);
    expect(result.kind).toBe("needs-attention");
    expect(result.nextIndex).toBe(1);
    expect(result.completedTakeIds).toEqual([]);
  }
});

test("stopping an active sequence preserves its submitted job and does not prepare the next", async () => {
  const controller = new AbortController();
  let requests = 0;
  const result = await runGenerationSequence({
    sources, signal: controller.signal, onProgress: () => undefined,
    prepare: async (source) => requestFor(source as typeof sources[number]),
    request: async () => { requests++; controller.abort(); return { kind: "queued", takeId: "retained-take" }; },
    waitUntilReady: async () => { throw new Error("must not wait"); },
  });
  expect(requests).toBe(1);
  expect(result).toMatchObject({ kind: "stopped", submittedTakeIds: ["retained-take"], nextIndex: 1 });
});

test("edits invalidating preparation stop before requesting another quote", async () => {
  let prepared = 0; let requests = 0;
  const result = await runGenerationSequence({
    sources, signal: new AbortController().signal, onProgress: () => undefined,
    prepare: async (source) => { if (++prepared > 1) throw new Error("Direction changed"); return requestFor(source as typeof sources[number]); },
    request: async () => { requests++; return { kind: "queued", takeId: "retained-take" }; },
    waitUntilReady: async () => undefined,
  });
  expect(requests).toBe(1);
  expect(result).toMatchObject({ kind: "needs-attention", completedTakeIds: ["retained-take"], nextIndex: 1 });
});


test("known preparation failure and expired approval do not imply a submission", async () => {
  for (const outcome of [{ kind: "unavailable", code: "unavailable" }, { kind: "expired" }] as const) {
    let requests = 0;
    const result = await runGenerationSequence({ sources, signal: new AbortController().signal, onProgress: () => undefined,
      prepare: async (source) => requestFor(source as typeof sources[number]),
      request: async () => { requests++; return outcome; },
      waitUntilReady: async () => { throw new Error("must not observe an unsubmitted take"); },
    });
    expect(requests).toBe(1);
    expect(result.nextIndex).toBe(0);
    expect(result.submittedTakeIds).toEqual([]);
    expect(result.message).not.toContain("Submission could not be confirmed");
    expect(result.message).not.toContain("Check the scene");
  }
});

test("uncertain submission retains the originating take and never starts the next scene", async () => {
  let requests = 0;
  const result = await runGenerationSequence({ sources, signal: new AbortController().signal, onProgress: () => undefined,
    prepare: async (source) => requestFor(source as typeof sources[number]),
    request: async () => { requests++; return { kind: "submission-unknown", takeId: "take_uncertain_receipt" }; },
    waitUntilReady: async () => { throw new Error("sequence must stop"); },
  });
  expect(requests).toBe(1);
  expect(result).toMatchObject({ kind: "needs-attention", nextIndex: 1, submittedTakeIds: ["take_uncertain_receipt"], completedTakeIds: [] });
});
