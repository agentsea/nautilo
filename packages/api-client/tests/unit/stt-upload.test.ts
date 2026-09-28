import { describe, expect, test } from "bun:test";
import { ApiError, NautiloApiClient } from "../../src/client";

describe("STT upload", () => {
  test("uses a fresh session bearer with the audio multipart body and capture signal", async () => {
    const controller = new AbortController();
    const requests: { url: string; init: RequestInit }[] = [];
    const client = new NautiloApiClient("https://nautilo.test", {
      fetchImpl: async (input, init) => {
        requests.push({
          url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          init: init ?? {},
        });
        return Response.json({ text: "hello", provider: "groq", model: "whisper-large-v3-turbo" });
      },
    });
    client.setToken("expired-bearer");
    client.setTokenProvider(async () => "fresh-bearer");

    const result = await client.transcribeAudio(
      new Blob(["audio bytes"], { type: "audio/webm" }),
      "recording.webm",
      { signal: controller.signal },
    );

    expect(result.text).toBe("hello");
    expect(requests).toHaveLength(1);
    const request = requests[0];
    if (!request) throw new Error("Expected one STT request");
    expect(request.url).toBe("https://nautilo.test/api/stt");
    expect(request.init.method).toBe("POST");
    expect(request.init.signal).toBe(controller.signal);
    expect(new Headers(request.init.headers).get("Authorization")).toBe("Bearer fresh-bearer");
    expect(new Headers(request.init.headers).has("Content-Type")).toBe(false);
    const body = request.init.body;
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get("audio")).toBeInstanceOf(File);
    expect(((body as FormData).get("audio") as File).name).toBe("recording.webm");
  });

  test("keeps the server's actionable detail on transcription errors", async () => {
    const client = new NautiloApiClient("https://nautilo.test", {
      fetchImpl: async () => Response.json({
        error: "Transcription failed",
        detail: "The transcription service returned an error.",
      }, { status: 502 }),
    });

    try {
      await client.transcribeAudio(new Blob(["audio bytes"]), "recording.webm");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).message).toBe(
        "Transcription failed The transcription service returned an error.",
      );
    }
  });

  test("shows a useful fallback when the service response is not JSON", async () => {
    const client = new NautiloApiClient("https://nautilo.test", {
      fetchImpl: async () => new Response("upstream failure", { status: 502 }),
    });

    try {
      await client.transcribeAudio(new Blob(["audio bytes"]), "recording.webm");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).message).toBe("Transcription failed (HTTP 502).");
    }
  });
});
