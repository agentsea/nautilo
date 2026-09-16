import { beforeAll, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  createWorkspaceGuard,
  RELAY_MEDIA_CHUNK_BYTES,
  type RelayDispatchRequest,
} from "@nautilo/relay";
import {
  createMediaDispatchHandler,
  type MediaSessionRecord,
  type MediaSessionsPort,
} from "../../electron/relay-dispatch/media.ts";
import { FIXED_DESKTOP_DISPATCH_NOT_HANDLED } from "../../electron/relay-dispatch/router.ts";

mock.module("electron", () => ({
  app: {
    getPath: () => "/tmp/nautilo-relay-media-extract",
    isPackaged: true,
  },
}));

let makeDispatchHandler: typeof import("../../electron/relay.ts").makeDispatchHandler;

beforeAll(async () => {
  ({ makeDispatchHandler } = await import("../../electron/relay.ts"));
});

const guard = createWorkspaceGuard({ workspaceRoot: "/tmp" });
const mp4 = Buffer.from([
  0x00, 0x00, 0x00, 0x0c,
  0x66, 0x74, 0x79, 0x70,
  0x00, 0x00, 0x00, 0x00,
]);

function request(
  toolName: string,
  args: Record<string, unknown>,
  overrides: Partial<RelayDispatchRequest> = {},
): RelayDispatchRequest {
  return {
    correlationId: "media-adapter",
    toolName,
    args,
    impact: "high",
    approvalObtained: true,
    ...overrides,
  };
}

function sessionFixture(): {
  readonly port: MediaSessionsPort;
  readonly records: Map<string, MediaSessionRecord>;
  readonly bufferedBytes: () => number;
  readonly expireCalls: () => number;
  readonly releaseCalls: () => readonly string[];
} {
  const records = new Map<string, MediaSessionRecord>();
  let bufferedBytes = 0;
  let expireCalls = 0;
  const releaseCalls: string[] = [];
  return {
    records,
    bufferedBytes: () => bufferedBytes,
    expireCalls: () => expireCalls,
    releaseCalls: () => releaseCalls,
    port: {
      size: () => records.size,
      get: (sessionId) => records.get(sessionId),
      has: (sessionId) => records.has(sessionId),
      set: (sessionId, session) => {
        records.set(sessionId, session);
      },
      release: (sessionId) => {
        releaseCalls.push(sessionId);
        const session = records.get(sessionId);
        if (!session) return;
        bufferedBytes -= session.receivedBytes + (session.audio?.byteLength ?? 0);
        records.delete(sessionId);
      },
      expire: () => {
        expireCalls += 1;
      },
      getBufferedBytes: () => bufferedBytes,
      adjustBufferedBytes: (delta) => {
        bufferedBytes += delta;
      },
    },
  };
}

describe("Electron D417 media extraction dispatch", () => {
  test("uses the probed FFmpeg binary, fixed argv, bounded execution, and removes temp files", async () => {
    const sessions = sessionFixture();
    const audio = Buffer.from("bounded audio");
    const executions: Array<{
      binary: string;
      argv: string[];
      options: unknown;
    }> = [];
    let probeCalls = 0;
    const handler = createMediaDispatchHandler({
      sessions: sessions.port,
      probeFfmpeg: async () => {
        probeCalls += 1;
        return { ok: true, bin: "/managed/ffmpeg" };
      },
      execFile: async (binary, argv, options) => {
        executions.push({ binary, argv, options });
        await fsp.writeFile(argv.at(-1)!, audio);
      },
    });

    expect(await handler({
      request: request("extract_audio_from_video", {
        sourceBase64: mp4.toString("base64"),
        outputFormat: "m4a",
      }),
      signal: new AbortController().signal,
      guard,
    })).toEqual({
      handled: true,
      result: {
        status: "ok",
        result: {
          ok: true,
          audioBase64: audio.toString("base64"),
          mimeType: "audio/mp4",
        },
      },
    });
    expect(probeCalls).toBe(1);
    expect(executions).toHaveLength(1);
    const execution = executions[0]!;
    const inputPath = execution.argv[4]!;
    const outputPath = execution.argv.at(-1)!;
    expect(execution).toEqual({
      binary: "/managed/ffmpeg",
      argv: [
        "-hide_banner",
        "-nostdin",
        "-y",
        "-i",
        inputPath,
        "-map",
        "0:a:0",
        "-vn",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        outputPath,
      ],
      options: { timeout: 60_000, maxBuffer: 1024 * 1024 },
    });
    expect(path.basename(inputPath)).toBe("input.mp4");
    expect(path.basename(outputPath)).toBe("output.m4a");
    expect(existsSync(path.dirname(inputPath))).toBe(false);
  });

  test("requires approval before work and validates request shape and canonical MP4 before probing", async () => {
    const sessions = sessionFixture();
    let probeCalls = 0;
    let execCalls = 0;
    const handler = createMediaDispatchHandler({
      sessions: sessions.port,
      probeFfmpeg: async () => {
        probeCalls += 1;
        return {
          ok: false,
          code: "FFMPEG_UNAVAILABLE",
          message: "stub managed FFmpeg unavailable",
        };
      },
      execFile: async () => {
        execCalls += 1;
      },
    });
    const sourceBase64 = mp4.toString("base64");

    expect(await handler({
      request: request("extract_audio_from_video", {
        sourceBase64,
        outputFormat: "m4a",
      }, { approvalObtained: false }),
      signal: undefined,
      guard,
    })).toMatchObject({
      handled: true,
      result: {
        status: "error",
        error: "extract_audio_from_video requires high impact and approvalObtained=true from the server.",
      },
    });
    expect(await handler({
      request: request("extract_audio_from_video", {
        sourceBase64,
        outputFormat: "m4a",
        binary: "/untrusted/ffmpeg",
      }),
      signal: undefined,
      guard,
    })).toMatchObject({
      handled: true,
      result: {
        status: "ok",
        result: { ok: false, code: "EXTRACTION_FAILED" },
      },
    });
    expect(await handler({
      request: request("extract_audio_from_video", {
        sourceBase64: `${sourceBase64}=`,
        outputFormat: "m4a",
      }),
      signal: undefined,
      guard,
    })).toMatchObject({
      handled: true,
      result: {
        status: "ok",
        result: { ok: false, code: "INVALID_MP4" },
      },
    });
    expect(await handler({
      request: request("extract_audio_from_video", {
        sourceBase64,
        outputFormat: "m4a",
      }),
      signal: undefined,
      guard,
    })).toEqual({
      handled: true,
      result: {
        status: "ok",
        result: {
          ok: false,
          code: "FFMPEG_UNAVAILABLE",
          message: "stub managed FFmpeg unavailable",
        },
      },
    });
    expect(probeCalls).toBe(1);
    expect(execCalls).toBe(0);
  });

  test("classifies FFmpeg failures without returning arbitrary diagnostics", async () => {
    const cases = [
      {
        error: Object.assign(new Error("missing"), { code: "ENOENT" }),
        code: "FFMPEG_MISSING",
      },
      {
        error: Object.assign(new Error("timeout"), { killed: true }),
        code: "FFMPEG_UNAVAILABLE",
      },
      {
        error: Object.assign(new Error("stream"), {
          stderr: "Output file does not contain any stream",
        }),
        code: "NO_AUDIO_STREAM",
      },
      {
        error: Object.assign(new Error("invalid"), {
          stderr: "moov atom not found",
        }),
        code: "INVALID_MP4",
      },
      {
        error: Object.assign(new Error("private path"), {
          stderr: "failure at /Users/human/private/source.mp4",
        }),
        code: "EXTRACTION_FAILED",
      },
    ] as const;

    for (const entry of cases) {
      const handler = createMediaDispatchHandler({
        sessions: sessionFixture().port,
        probeFfmpeg: async () => ({ ok: true, bin: "/managed/ffmpeg" }),
        execFile: async () => {
          throw entry.error;
        },
      });
      const decision = await handler({
        request: request("extract_audio_from_video", {
          sourceBase64: mp4.toString("base64"),
          outputFormat: "m4a",
        }),
        signal: undefined,
        guard,
      });
      expect(decision).toMatchObject({
        handled: true,
        result: {
          status: "ok",
          result: { ok: false, code: entry.code },
        },
      });
      expect(JSON.stringify(decision)).not.toContain("/Users/human/private");
    }
  });

  test("runs the bounded chunk protocol with exact accounting and final-chunk release timing", async () => {
    const sessions = sessionFixture();
    const audio = Buffer.from("chunked audio");
    const sessionId = "00000000-0000-4000-8000-000000000001";
    const chunkCount = Math.ceil(mp4.byteLength / RELAY_MEDIA_CHUNK_BYTES);
    const handler = createMediaDispatchHandler({
      sessions: sessions.port,
      probeFfmpeg: async () => ({ ok: true, bin: "/managed/ffmpeg" }),
      execFile: async (_binary, argv) => {
        await fsp.writeFile(argv.at(-1)!, audio);
      },
    });
    const call = async (toolName: string, args: Record<string, unknown>) =>
      await handler({ request: request(toolName, args), signal: undefined, guard });

    expect(await call("media_extract_start", {
      sessionId,
      outputFormat: "m4a",
      totalBytes: mp4.byteLength,
      chunkCount,
    })).toEqual({ handled: true, result: { status: "ok", result: { ok: true } } });
    expect(sessions.bufferedBytes()).toBe(0);
    expect(await call("media_extract_chunk", {
      sessionId,
      index: 0,
      chunkCount,
      data: mp4.toString("base64"),
    })).toEqual({ handled: true, result: { status: "ok", result: { ok: true } } });
    expect(sessions.bufferedBytes()).toBe(mp4.byteLength);
    expect(await call("media_extract_finish", { sessionId })).toEqual({
      handled: true,
      result: {
        status: "ok",
        result: {
          ok: true,
          totalBytes: audio.byteLength,
          chunkCount: 1,
          sha256: createHash("sha256").update(audio).digest("hex"),
          mimeType: "audio/mp4",
        },
      },
    });
    expect(sessions.bufferedBytes()).toBe(audio.byteLength);
    expect(sessions.records.has(sessionId)).toBe(true);
    expect(await call("media_extract_output_chunk", {
      sessionId,
      index: 0,
      chunkCount: 1,
    })).toEqual({
      handled: true,
      result: {
        status: "ok",
        result: {
          ok: true,
          index: 0,
          chunkCount: 1,
          data: audio.toString("base64"),
        },
      },
    });
    expect(sessions.records.has(sessionId)).toBe(false);
    expect(sessions.bufferedBytes()).toBe(0);
    expect(sessions.releaseCalls()).toEqual([sessionId]);
    expect(sessions.expireCalls()).toBe(4);
  });

  test("rejects chunk approval and malformed ordering before retaining artifacts", async () => {
    const sessions = sessionFixture();
    const sessionId = "00000000-0000-4000-8000-000000000002";
    let probeCalls = 0;
    const handler = createMediaDispatchHandler({
      sessions: sessions.port,
      probeFfmpeg: async () => {
        probeCalls += 1;
        return { ok: true, bin: "/managed/ffmpeg" };
      },
    });
    const call = async (
      toolName: string,
      args: Record<string, unknown>,
      overrides: Partial<RelayDispatchRequest> = {},
    ) => await handler({
      request: request(toolName, args, overrides),
      signal: undefined,
      guard,
    });

    expect(await call("media_extract_start", {
      sessionId,
      outputFormat: "m4a",
      totalBytes: mp4.byteLength,
      chunkCount: 1,
    }, { approvalObtained: false })).toEqual({
      handled: true,
      result: {
        status: "error",
        error: "chunked media transport requires server approval",
      },
    });
    expect(sessions.expireCalls()).toBe(0);
    expect(sessions.records.size).toBe(0);

    await call("media_extract_start", {
      sessionId,
      outputFormat: "m4a",
      totalBytes: mp4.byteLength,
      chunkCount: 1,
    });
    expect(await call("media_extract_chunk", {
      sessionId,
      index: 1,
      chunkCount: 1,
      data: mp4.toString("base64"),
    })).toEqual({
      handled: true,
      result: { status: "error", error: "out-of-order media chunk" },
    });
    expect(sessions.records.has(sessionId)).toBe(false);
    expect(probeCalls).toBe(0);
  });

  test("declines unrelated tools canonically", async () => {
    const handler = createMediaDispatchHandler({
      sessions: sessionFixture().port,
      probeFfmpeg: async () => ({ ok: true, bin: "/managed/ffmpeg" }),
    });
    expect(await handler({
      request: request("browser_snapshot", {}),
      signal: undefined,
      guard,
    })).toBe(FIXED_DESKTOP_DISPATCH_NOT_HANDLED);
  });

  test("routes the dedicated operation through the fixed media lane before sandbox dispatch", async () => {
    let probeCalls = 0;
    let sandboxCalls = 0;
    const handler = makeDispatchHandler(guard, {
      isProduction: true,
      probeFfmpeg: async () => {
        probeCalls += 1;
        return {
          ok: false as const,
          code: "FFMPEG_UNAVAILABLE" as const,
          message: "stub managed FFmpeg unavailable",
        };
      },
      createSandbox: async () => {
        sandboxCalls += 1;
        throw new Error("media extraction must not reach sandbox preparation");
      },
    });
    const mediaRequest = request("extract_audio_from_video", {
      sourceBase64: mp4.toString("base64"),
      outputFormat: "m4a",
    });

    expect(await handler(mediaRequest)).toEqual({
      status: "ok",
      result: {
        ok: false,
        code: "FFMPEG_UNAVAILABLE",
        message: "stub managed FFmpeg unavailable",
      },
    });
    expect(probeCalls).toBe(1);
    expect(sandboxCalls).toBe(0);
  });
});
