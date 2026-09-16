import { desktopVideoEncoderArgs } from "../../electron/video-encoder";
import { afterEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  MEDIA_PROCESS_PROTOCOL_VERSION,
  parseMediaProcessResult,
} from "@nautilo/relay";
import { executeMediaProcess, type MediaProcessDependencies } from "../../electron/media-process.ts";

const REQUEST = {
  type: "relay:media-process-request",
  version: MEDIA_PROCESS_PROTOCOL_VERSION,
  requestId: "request_7",
  operation: "transcode_proxy",
  sourceRef: "asset_approved",
} as const;
const MP4_HEADER = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(12)]);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nautilo-media-process-test-"));
  roots.push(root);
  return root;
}

class FakeChild extends EventEmitter {
  readonly stderr = new EventEmitter();
  readonly signals: string[] = [];
  constructor(private readonly closeOnTerm = true, private readonly closeOnKill = true) { super(); }
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? "SIGTERM");
    if ((signal === "SIGKILL" && this.closeOnKill) || (signal === "SIGTERM" && this.closeOnTerm)) {
      queueMicrotask(() => this.emit("close", null, signal));
    }
    return true;
  }
}

function completeChild(child: FakeChild, task: () => Promise<void>): void {
  queueMicrotask(() => {
    void task().then(
      () => child.emit("close", 0, null),
      (error: unknown) => child.emit("error", error),
    );
  });
}

function deps(root: string, overrides: Partial<MediaProcessDependencies> = {}): MediaProcessDependencies {
  return {
    resolveSource: async (ref) => ref === "asset_approved"
      ? { ok: true, canonicalPath: path.join(root, "input.mp4") }
      : { ok: false },
    resolveFfmpeg: async () => ({ ok: true, binaryPath: "/managed/ffmpeg" }),
    registerOutput: async () => ({ ok: true, outputRef: "proxy_approved" }),
    discardOutput: async () => {},
    ...overrides,
  };
}

describe("D385 Phase 0 disk-to-disk media executor", () => {
  test("accepts the exact shared request/result contract, uses fixed argv, and registrar takes ownership", async () => {
    const root = await tempRoot();
    const processRoot = path.join(root, "process");
    const retained = path.join(root, "retained.mp4");
    const input = path.join(root, "input.mp4");
    await fsp.writeFile(input, MP4_HEADER);
    let args: readonly string[] = [];
    const result = await executeMediaProcess(REQUEST, deps(root, {
      makeTempDir: async () => (await fsp.mkdir(processRoot), processRoot),
      spawn: (_command, value) => {
        args = value;
        const child = new FakeChild();
        completeChild(child, async () => { await fsp.writeFile(value.at(-1)!, MP4_HEADER); });
        return child as unknown as ChildProcess;
      },
      registerOutput: async (output) => {
        await fsp.rename(output.outputPath, retained);
        return { ok: true, outputRef: "proxy_approved" };
      },
    }));
    expect(parseMediaProcessResult(result).ok).toBe(true);
    expect(result).toEqual({
      type: "relay:media-process-result", version: 1, requestId: "request_7", status: "succeeded",
      outputRef: "proxy_approved", mimeType: "video/mp4", sizeBytes: MP4_HEADER.byteLength,
    });
    expect(args).toEqual([
      "-hide_banner", "-nostdin", "-y", "-i", input, "-map", "0:v:0?", "-map", "0:a?",
      ...desktopVideoEncoderArgs(), "-c:a", "aac", "-movflags", "+faststart",
      "-progress", "pipe:2", "-nostats", path.join(processRoot, "output.mp4"),
    ]);
    expect(await fsp.readFile(retained)).toEqual(MP4_HEADER);
    expect(await fsp.stat(processRoot).then(() => true, () => false)).toBe(false);
    expect(JSON.stringify(result)).not.toContain(input);
  });

  test("rejects paths, URLs, argv, bytes, and unknown fields before any host work", async () => {
    const root = await tempRoot();
    let sourceCalls = 0;
    const dependencies = deps(root, { resolveSource: async () => (sourceCalls++, { ok: true, canonicalPath: "/never" }) });
    for (const request of [
      { ...REQUEST, sourceRef: "/Users/tester/movie.mp4" },
      { ...REQUEST, sourceRef: "https://example.test/movie.mp4" },
      { ...REQUEST, argv: ["-i", "movie.mp4"] },
      { ...REQUEST, bytes: [0, 1, 2] },
      { ...REQUEST, path: "/tmp/movie.mp4" },
    ]) {
      expect(await executeMediaProcess(request, dependencies)).toEqual({
        type: "relay:media-process-result", version: 1, requestId: "invalid", status: "failed", code: "invalid_request",
      });
    }
    expect(sourceCalls).toBe(0);
  });

  test("drains progress, emits bounded monotonic shared events, and cancels with cleanup and no registration", async () => {
    const root = await tempRoot();
    const processRoot = path.join(root, "process");
    await fsp.writeFile(path.join(root, "input.mp4"), MP4_HEADER);
    const controller = new AbortController();
    const events: unknown[] = [];
    let registered = false;
    let child: FakeChild | undefined;
    const pending = executeMediaProcess(REQUEST, deps(root, {
      signal: controller.signal,
      onProgress: (event) => events.push(event),
      makeTempDir: async () => (await fsp.mkdir(processRoot), processRoot),
      cancelKillGraceMs: 1,
      postKillWaitMs: 1,
      spawn: () => {
        child = new FakeChild();
        queueMicrotask(() => {
          child!.stderr.emit("data", Buffer.from("out_time_us=5\nout_time_us=5\nout_time_us=4\n"));
          child!.stderr.emit("data", Buffer.from(`${"x".repeat(2048)}\n`));
          child!.stderr.emit("data", Buffer.from("out_time_us=9\n"));
          controller.abort();
        });
        return child as unknown as ChildProcess;
      },
      registerOutput: async () => (registered = true, { ok: true, outputRef: "proxy_approved" }),
    }));
    expect(await pending).toEqual({ type: "relay:media-process-result", version: 1, requestId: "request_7", status: "cancelled" });
    expect(child?.signals).toContain("SIGTERM");
    expect(registered).toBe(false);
    expect(events).toEqual([
      { type: "relay:media-process-progress", version: 1, requestId: "request_7", stage: "queued", sequence: 1 },
      { type: "relay:media-process-progress", version: 1, requestId: "request_7", stage: "preparing", sequence: 2 },
      { type: "relay:media-process-progress", version: 1, requestId: "request_7", stage: "transcoding", sequence: 3, processedTimeUs: 5 },
      { type: "relay:media-process-progress", version: 1, requestId: "request_7", stage: "transcoding", sequence: 4, processedTimeUs: 9 },
    ]);
    expect(await fsp.stat(processRoot).then(() => true, () => false)).toBe(false);
  });

  test("escalates a stubborn child from SIGTERM to SIGKILL before returning cancelled", async () => {
    const root = await tempRoot();
    const processRoot = path.join(root, "process");
    await fsp.writeFile(path.join(root, "input.mp4"), MP4_HEADER);
    const controller = new AbortController();
    let registered = false;
    let child: FakeChild | undefined;
    const pending = executeMediaProcess(REQUEST, deps(root, {
      signal: controller.signal,
      makeTempDir: async () => (await fsp.mkdir(processRoot), processRoot),
      cancelKillGraceMs: 1,
      postKillWaitMs: 1,
      spawn: () => {
        child = new FakeChild(false, false);
        queueMicrotask(() => controller.abort());
        return child as unknown as ChildProcess;
      },
      registerOutput: async () => (registered = true, { ok: true, outputRef: "proxy_approved" }),
    }));
    expect(await pending).toEqual({ type: "relay:media-process-result", version: 1, requestId: "request_7", status: "cancelled" });
    expect(child?.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(registered).toBe(false);
    expect(await fsp.stat(processRoot).then(() => true, () => false)).toBe(false);
  });

  test("keeps consuming FFmpeg stderr even when no progress observer is installed", async () => {
    const root = await tempRoot();
    const processRoot = path.join(root, "process");
    await fsp.writeFile(path.join(root, "input.mp4"), MP4_HEADER);
    let child: FakeChild | undefined;
    await executeMediaProcess(REQUEST, deps(root, {
      makeTempDir: async () => (await fsp.mkdir(processRoot), processRoot),
      spawn: (_command, args) => {
        child = new FakeChild();
        completeChild(child, async () => {
          child!.stderr.emit("data", Buffer.alloc(32 * 1024, 120));
          await fsp.writeFile(args.at(-1)!, MP4_HEADER);
        });
        return child as unknown as ChildProcess;
      },
    }));
    expect(child?.stderr.listenerCount("data")).toBeGreaterThan(0);
  });

  test("fences cancellation during output stat, header inspection, and registration", async () => {
    for (const phase of ["stat", "header", "register"] as const) {
      const root = await tempRoot();
      const processRoot = path.join(root, `process-${phase}`);
      const retained = path.join(root, `retained-${phase}.mp4`);
      await fsp.writeFile(path.join(root, "input.mp4"), MP4_HEADER);
      const controller = new AbortController();
      const discarded: string[] = [];
      let statCalls = 0;
      const result = await executeMediaProcess(REQUEST, deps(root, {
        signal: controller.signal,
        makeTempDir: async () => (await fsp.mkdir(processRoot), processRoot),
        spawn: (_command, args) => {
          const child = new FakeChild();
          completeChild(child, async () => { await fsp.writeFile(args.at(-1)!, MP4_HEADER); });
          return child as unknown as ChildProcess;
        },
        stat: async (filePath) => {
          statCalls++;
          const result = await fsp.stat(filePath);
          if (phase === "stat" && statCalls === 2) controller.abort();
          return result;
        },
        readOutputHeader: async (filePath) => {
          if (phase === "header") controller.abort();
          return (await fsp.readFile(filePath)).subarray(0, 32);
        },
        registerOutput: async (output) => {
          await fsp.rename(output.outputPath, retained);
          if (phase === "register") controller.abort();
          return { ok: true, outputRef: `proxy_${phase}` };
        },
        discardOutput: async (outputRef) => {
          discarded.push(outputRef);
          await fsp.rm(retained, { force: true });
        },
      }));
      expect(result).toEqual({ type: "relay:media-process-result", version: 1, requestId: "request_7", status: "cancelled" });
      expect(await fsp.stat(retained).then(() => true, () => false)).toBe(false);
      expect(discarded).toEqual(phase === "register" ? ["proxy_register"] : []);
    }
  });

  test("returns the shared timed_out result for a deadline child with no terminal receipt", async () => {
    const root = await tempRoot();
    const processRoot = path.join(root, "never-terminal");
    await fsp.writeFile(path.join(root, "input.mp4"), MP4_HEADER);
    let child: FakeChild | undefined;
    let registered = false;
    const result = await Promise.race([
      executeMediaProcess(REQUEST, deps(root, {
        makeTempDir: async () => (await fsp.mkdir(processRoot), processRoot),
        processDeadlineMs: 1,
        cancelKillGraceMs: 1,
        postKillWaitMs: 1,
        spawn: () => (child = new FakeChild(false, false)) as unknown as ChildProcess,
        registerOutput: async () => (registered = true, { ok: true, outputRef: "proxy_approved" }),
      })),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("executor did not settle")), 250)),
    ]);
    expect(result).toEqual({ type: "relay:media-process-result", version: 1, requestId: "request_7", status: "failed", code: "timed_out" });
    expect(child?.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(registered).toBe(false);
  });

  test("rejects an ftyp lookalike with an invalid box size or incompatible major brand", async () => {
    const root = await tempRoot();
    await fsp.writeFile(path.join(root, "input.mp4"), MP4_HEADER);
    for (const spoof of [
      Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from("ftypisom"), Buffer.alloc(12)]),
      Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypzzzz"), Buffer.alloc(12)]),
    ]) {
      const result = await executeMediaProcess(REQUEST, deps(root, {
        makeTempDir: async () => await fsp.mkdtemp(path.join(root, "spoof-")),
        spawn: (_command, args) => {
          const child = new FakeChild();
          completeChild(child, async () => { await fsp.writeFile(args.at(-1)!, spoof); });
          return child as unknown as ChildProcess;
        },
      }));
      expect(result).toEqual({ type: "relay:media-process-result", version: 1, requestId: "request_7", status: "failed", code: "invalid_output" });
    }
  });

  test("keeps sparse >2 GiB source and output on disk without a proxy truncation quota", async () => {
    const root = await tempRoot();
    const sourcePath = path.join(root, "large.mp4");
    const processRoot = path.join(root, "process");
    const handle = await fsp.open(sourcePath, "w");
    await handle.truncate(2 * 1024 * 1024 * 1024 + 1);
    await handle.close();
    const statPaths: string[] = [];
    const headerPaths: string[] = [];
    let args: readonly string[] = [];
    const result = await executeMediaProcess({ ...REQUEST, sourceRef: "asset_large" }, deps(root, {
      resolveSource: async () => ({ ok: true, canonicalPath: sourcePath }),
      makeTempDir: async () => (await fsp.mkdir(processRoot), processRoot),
      stat: async (filePath) => (statPaths.push(filePath), fsp.stat(filePath)),
      readOutputHeader: async (filePath) => (headerPaths.push(filePath), MP4_HEADER),
      spawn: (_command, value) => {
        args = value;
        const child = new FakeChild();
        completeChild(child, async () => {
          const output = await fsp.open(value.at(-1)!, "w");
          await output.write(MP4_HEADER);
          await output.truncate(2 * 1024 * 1024 * 1024 + 1);
          await output.close();
        });
        return child as unknown as ChildProcess;
      },
    }));
    expect(result).toMatchObject({ status: "succeeded", outputRef: "proxy_approved", sizeBytes: 2 * 1024 * 1024 * 1024 + 1 });
    expect((await fsp.stat(sourcePath)).size).toBeGreaterThan(2 * 1024 * 1024 * 1024);
    expect(statPaths).toContain(sourcePath);
    expect(headerPaths).toEqual([path.join(processRoot, "output.mp4")]);
    expect(args).toContain(sourcePath);
    expect(args).not.toContain("-fs");
  });
});
