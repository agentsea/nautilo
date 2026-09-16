import { describe, expect, test } from "bun:test";
import {
  MEDIA_PROCESS_MAX_FRAME_BYTES,
  MEDIA_PROCESS_MAX_PROGRESS_SEQUENCE,
  MEDIA_PROCESS_PROTOCOL_VERSION,
  parseMediaProcessCancel,
  parseMediaProcessJsonFrame,
  parseMediaProcessMessage,
  parseMediaProcessProgress,
  parseMediaProcessRequest,
  parseMediaProcessResult,
  type MediaProcessMessage,
} from "./media-process-protocol";

const request = {
  type: "relay:media-process-request",
  version: MEDIA_PROCESS_PROTOCOL_VERSION,
  requestId: "request-7",
  operation: "transcode_proxy",
  sourceRef: "asset_9c47e2",
} as const;

describe("D385 media process control protocol v1", () => {
  test("strictly round-trips the closed request, progress, terminal, and cancel frames", () => {
    const frames: readonly MediaProcessMessage[] = [
      request,
      {
        type: "relay:media-process-progress",
        version: MEDIA_PROCESS_PROTOCOL_VERSION,
        requestId: "request-7",
        stage: "queued",
        sequence: 1,
      },
      {
        type: "relay:media-process-progress",
        version: MEDIA_PROCESS_PROTOCOL_VERSION,
        requestId: "request-7",
        stage: "transcoding",
        sequence: 2,
        processedTimeUs: 1_240_000,
      },
      {
        type: "relay:media-process-result",
        version: MEDIA_PROCESS_PROTOCOL_VERSION,
        requestId: "request-7",
        status: "succeeded",
        outputRef: "proxy_25f1",
        mimeType: "video/mp4",
        sizeBytes: 8_192,
      },
      {
        type: "relay:media-process-result",
        version: MEDIA_PROCESS_PROTOCOL_VERSION,
        requestId: "request-7",
        status: "cancelled",
      },
      {
        type: "relay:media-process-result",
        version: MEDIA_PROCESS_PROTOCOL_VERSION,
        requestId: "request-7",
        status: "failed",
        code: "resource_limit",
      },
      {
        type: "relay:media-process-cancel",
        version: MEDIA_PROCESS_PROTOCOL_VERSION,
        requestId: "request-7",
      },
    ];

    for (const frame of frames) {
      expect(parseMediaProcessMessage(frame)).toEqual({ ok: true, value: frame });
      expect(parseMediaProcessJsonFrame(JSON.stringify(frame))).toEqual({ ok: true, value: frame });
    }
  });

  test("rejects paths and URLs disguised as opaque source or output refs", () => {
    for (const sourceRef of [
      "/Users/tester/movie.mp4",
      "assets/movie.mp4",
      "../movie.mp4",
      "./movie.mp4",
      "C:\\media\\movie.mp4",
      "file:///Users/tester/movie.mp4",
      "https://example.test/movie.mp4",
      "http://example.test/movie.mp4",
    ]) {
      expect(parseMediaProcessRequest({ ...request, sourceRef })).toEqual({
        ok: false,
        error: "MEDIA_PROCESS_FRAME_INVALID",
      });
    }
    expect(parseMediaProcessResult({
      type: "relay:media-process-result",
      version: MEDIA_PROCESS_PROTOCOL_VERSION,
      requestId: "request-7",
      status: "succeeded",
      outputRef: "file:///tmp/proxy.mp4",
      mimeType: "video/mp4",
      sizeBytes: 8_192,
    })).toEqual({ ok: false, error: "MEDIA_PROCESS_FRAME_INVALID" });
  });

  test("rejects executable, byte, option, and unknown-key smuggling", () => {
    for (const injected of [
      { argv: ["ffmpeg", "-i", "movie.mp4"] },
      { flags: ["-vf", "scale=640:-2"] },
      { bytes: [0, 1, 2] },
      { options: { codec: "h264" } },
      { path: "/tmp/movie.mp4" },
      { url: "https://example.test/movie.mp4" },
    ]) {
      expect(parseMediaProcessRequest({ ...request, ...injected })).toEqual({
        ok: false,
        error: "MEDIA_PROCESS_FRAME_INVALID",
      });
    }
  });

  test("rejects unknown operations, keys, and malformed bounded fields", () => {
    expect(parseMediaProcessRequest({ ...request, operation: "ffmpeg" })).toEqual({
      ok: false,
      error: "MEDIA_PROCESS_FRAME_INVALID",
    });
    expect(parseMediaProcessProgress({
      type: "relay:media-process-progress",
      version: MEDIA_PROCESS_PROTOCOL_VERSION,
      requestId: "request-7",
      stage: "transcoding",
      sequence: 3,
      processedTimeUs: -1,
    })).toEqual({ ok: false, error: "MEDIA_PROCESS_FRAME_INVALID" });
    expect(parseMediaProcessProgress({
      type: "relay:media-process-progress",
      version: MEDIA_PROCESS_PROTOCOL_VERSION,
      requestId: "request-7",
      stage: "transcoding",
      sequence: 3,
      processedTimeUs: Number.NaN,
    })).toEqual({ ok: false, error: "MEDIA_PROCESS_FRAME_INVALID" });
    expect(parseMediaProcessProgress({
      type: "relay:media-process-progress",
      version: MEDIA_PROCESS_PROTOCOL_VERSION,
      requestId: "request-7",
      stage: "queued",
      sequence: 0,
    })).toEqual({ ok: false, error: "MEDIA_PROCESS_FRAME_INVALID" });
    expect(parseMediaProcessProgress({
      type: "relay:media-process-progress",
      version: MEDIA_PROCESS_PROTOCOL_VERSION,
      requestId: "request-7",
      stage: "preparing",
      sequence: MEDIA_PROCESS_MAX_PROGRESS_SEQUENCE + 1,
    })).toEqual({ ok: false, error: "MEDIA_PROCESS_FRAME_INVALID" });
    expect(parseMediaProcessProgress({
      type: "relay:media-process-progress",
      version: MEDIA_PROCESS_PROTOCOL_VERSION,
      requestId: "request-7",
      stage: "queued",
      sequence: 1,
      processedTimeUs: 0,
    })).toEqual({ ok: false, error: "MEDIA_PROCESS_FRAME_INVALID" });
    expect(parseMediaProcessCancel({
      type: "relay:media-process-cancel",
      version: MEDIA_PROCESS_PROTOCOL_VERSION,
      requestId: "x".repeat(257),
    })).toEqual({ ok: false, error: "MEDIA_PROCESS_FRAME_INVALID" });
    expect(parseMediaProcessResult({
      type: "relay:media-process-result",
      version: MEDIA_PROCESS_PROTOCOL_VERSION,
      requestId: "request-7",
      status: "failed",
      code: "ffmpeg_exit_1",
    })).toEqual({ ok: false, error: "MEDIA_PROCESS_FRAME_INVALID" });
    for (const malformedSuccess of [
      { mimeType: "video/webm", sizeBytes: 8_192 },
      { mimeType: "video/mp4", sizeBytes: 0 },
      { mimeType: "video/mp4", sizeBytes: Number.MAX_SAFE_INTEGER + 1 },
      { mimeType: "video/mp4", sizeBytes: Number.POSITIVE_INFINITY },
    ]) {
      expect(parseMediaProcessResult({
        type: "relay:media-process-result",
        version: MEDIA_PROCESS_PROTOCOL_VERSION,
        requestId: "request-7",
        status: "succeeded",
        outputRef: "proxy_25f1",
        ...malformedSuccess,
      })).toEqual({ ok: false, error: "MEDIA_PROCESS_FRAME_INVALID" });
    }
    expect(parseMediaProcessJsonFrame("x".repeat(MEDIA_PROCESS_MAX_FRAME_BYTES + 1))).toEqual({
      ok: false,
      error: "MEDIA_PROCESS_FRAME_INVALID",
    });
  });

  test("accepts exactly the executor's closed no-detail failure taxonomy", () => {
    for (const code of [
      "invalid_request",
      "source_unavailable",
      "ffmpeg_unavailable",
      "resource_limit",
      "timed_out",
      "processing_failed",
      "invalid_output",
      "output_registration_failed",
    ] as const) {
      expect(parseMediaProcessResult({
        type: "relay:media-process-result",
        version: MEDIA_PROCESS_PROTOCOL_VERSION,
        requestId: "request-7",
        status: "failed",
        code,
      })).toEqual({
        ok: true,
        value: {
          type: "relay:media-process-result",
          version: MEDIA_PROCESS_PROTOCOL_VERSION,
          requestId: "request-7",
          status: "failed",
          code,
        },
      });
    }
  });
});
