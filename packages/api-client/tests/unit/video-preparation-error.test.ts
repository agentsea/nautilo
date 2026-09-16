import { expect, test } from "bun:test";
import { NautiloApiClient, VideoGenerationPreparationError } from "../../src/client";

test("video preparation preserves the server's safe recovery reason", async () => {
  const recovery = "A selected Workspace reference is no longer available. No generation was started.";
  const calls: string[] = [];
  const client = new NautiloApiClient("https://example.test", { fetchImpl: async url => {
    calls.push(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
    return new Response(JSON.stringify({ ok: false, code: "request_invalid", recovery }), { status: 422, headers: { "content-type": "application/json" } });
  } });
  try {
    await client.prepareVideoGeneration({ roomId: "room", projectArtifactId: "project", requestId: "request",
      shotId: "shot-1", shotLabel: "Opening", briefDigest: `sha256:${"a".repeat(64)}`, documentRevision: 1,
      job: { modelId: "venice:seedance-2-5-text-to-video-basic", prompt: "A bird crosses a blue sky.", durationSeconds: 4 },
    }, "test-attestation");
    throw new Error("Expected preparation rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(VideoGenerationPreparationError);
    expect((error as VideoGenerationPreparationError).message).toBe(recovery);
    expect((error as VideoGenerationPreparationError).code).toBe("request_invalid");
  }
  expect(calls).toEqual(["https://example.test/api/video-generations/prepare"]);
});
