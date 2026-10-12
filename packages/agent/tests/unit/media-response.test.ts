import { describe, expect, test } from "bun:test";
import {
  MAX_IMAGE_RESPONSE_JSON_BYTES,
  MediaResponseReadError,
  readBoundedMediaJson,
  readBoundedMediaBytes,
} from "../../src/providers/media-response";

describe("bounded media provider JSON", () => {
  test("reads UTF-8 across chunk boundaries at the exact byte limit", async () => {
    const bytes = new TextEncoder().encode('{"text":"é"}');
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, 10));
        controller.enqueue(bytes.slice(10));
        controller.close();
      },
    }));
    expect(await readBoundedMediaJson(response, bytes.length)).toEqual({ text: "é" });
    expect(MAX_IMAGE_RESPONSE_JSON_BYTES).toBe(42_008_832);
  });

  test("rejects a declared oversized body before reading it", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      cancel() { cancelled = true; },
    }), { headers: { "content-length": "1000" } });
    let failure: unknown;
    try { await readBoundedMediaJson(response, 8); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ reason: "too_large" });
    expect(cancelled).toBe(true);
  });

  test("counts actual bytes with a false Content-Length and cancels the stream", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"x":'));
        controller.enqueue(new TextEncoder().encode('"oversized"}'));
      },
      cancel() { cancelled = true; },
    }), { headers: { "content-length": "1" } });
    let failure: unknown;
    try { await readBoundedMediaJson(response, 8); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ reason: "too_large" });
    expect(cancelled).toBe(true);
  });

  test("does not echo invalid provider content or transport errors", async () => {
    for (const response of [
      new Response("sensitive-provider-body"),
      new Response(new ReadableStream({
        start(controller) { controller.error(new Error("sensitive-transport-detail")); },
      })),
      new Response(new Uint8Array([0xff])),
    ]) {
      try {
        await readBoundedMediaJson(response);
        throw new Error("Expected the response to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(MediaResponseReadError);
        expect(String(error)).not.toContain("sensitive");
      }
    }
  });
});

test("binary reader counts actual bytes and cancels oversized delivery", async () => {
  for (const declared of [undefined, "1"]) {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(6)); controller.enqueue(new Uint8Array(5)); },
      cancel() { cancelled = true; },
    }), { headers: declared ? { "content-length": declared } : {} });
    let failure: unknown;
    try { await readBoundedMediaBytes(response, 10); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ reason: "too_large" });
    expect(cancelled).toBe(true);
  }
  expect(await readBoundedMediaBytes(new Response(new Uint8Array([1, 2, 3])), 3)).toEqual(new Uint8Array([1, 2, 3]));
});
