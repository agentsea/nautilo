import { describe, expect, test } from "bun:test";
import {
  consumeSoulStreamChunk,
  readSoulGenerationStream,
} from "../../../src/genie-customization/soul-stream";

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }));
}

describe("Genie soul stream", () => {
  test("preserves started, delta, and completed events across chunk boundaries", async () => {
    const events: string[] = [];
    const soulFile = await readSoulGenerationStream(streamResponse([
      'event: soul.started\ndata: {}\n\nevent: soul.delta\ndata: {"text":"Hel',
      'lo"}\n\nevent: soul.completed\ndata: {"soulFile":"# Genie"}\n\n',
    ]), {
      onEvent: (event) => events.push(event.type),
    });

    expect(soulFile).toBe("# Genie");
    expect(events).toEqual(["started", "delta", "completed"]);
  });

  test("keeps an incomplete frame until the next response chunk", () => {
    const events: string[] = [];
    const carry = consumeSoulStreamChunk(
      'event: soul.delta\ndata: {"text":"partial"}',
      "",
      { onEvent: (event) => events.push(event.type) },
    );
    expect(events).toEqual([]);
    consumeSoulStreamChunk("\n\n", carry, { onEvent: (event) => events.push(event.type) });
    expect(events).toEqual(["delta"]);
  });

  test("rejects malformed and incomplete terminal responses safely", async () => {
    const malformedEvents: string[] = [];
    await expect(readSoulGenerationStream(streamResponse([
      "event: soul.delta\ndata: not-json\n\n",
    ]), { onEvent: (event) => malformedEvents.push(event.type) })).rejects.toThrow(
      "Soul generation returned an invalid response",
    );
    expect(malformedEvents).toEqual(["error"]);

    await expect(readSoulGenerationStream(streamResponse([
      'event: soul.started\ndata: {}\n\n',
    ]), { onEvent: () => {} })).rejects.toThrow("Soul generation ended before it finished");
  });

  test("uses a provider fallback as the final soul while preserving its error event", async () => {
    const events: string[] = [];
    const soulFile = await readSoulGenerationStream(streamResponse([
      'event: soul.error\ndata: {"error":"provider unavailable","fallback":"# fallback"}\n\n',
    ]), { onEvent: (event) => events.push(event.type) });
    expect(soulFile).toBe("# fallback");
    expect(events).toEqual(["error"]);
  });
});
