import { describe, expect, test } from "bun:test";

import { formatSttHttpError } from "../../src/lib/speech-stt-error";

describe("formatSttHttpError", () => {
  test("returns empty string for ok responses", async () => {
    const res = new Response("{}", { status: 200 });
    expect(await formatSttHttpError(res)).toBe("");
  });

  test("parses error and detail from JSON body", async () => {
    const res = new Response(JSON.stringify({ error: "Voice transcription not configured" }), {
      status: 503,
    });
    expect(await formatSttHttpError(res)).toBe("Voice transcription not configured");
  });

  test("appends detail when present", async () => {
    const res = new Response(
      JSON.stringify({
        error: "Transcript blocked by content scanner",
        detail: "injection",
      }),
      { status: 400 },
    );
    expect(await formatSttHttpError(res)).toBe("Transcript blocked by content scanner injection");
  });

  test("falls back when body is not JSON", async () => {
    const res = new Response("not json", { status: 502 });
    expect(await formatSttHttpError(res)).toBe("Transcription failed (HTTP 502).");
  });
});
