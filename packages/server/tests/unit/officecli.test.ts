/**
 * D372 P4 — OfficeCLI managed-binary groundwork unit tests.
 *
 * Covers the pure helpers (path resolution, env construction, argv
 * builders) plus the runner with an injectable execFile. No real binary
 * is spawned; the version/env/argv contracts are locked here.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter as pathDelimiter, join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  buildDumpArgvRun as buildDumpArgv,
  buildGetArgvRun as buildGetArgv,
  buildOfficeCliEnv,
  buildVersionArgv,
  OFFICECLI_STDIO_MAX_BYTES,
  OfficeCliRunError,
  OfficeCliVersionError,
  resolveOfficeCliPath,
  runOfficeCliRaw,
  runOfficeCliVersion,
  type OfficeCliExecFileFn,
  type OfficeCliSpawnFn,
} from "@nautilo/config/officecli";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Cross-platform executable bit. On Windows accessSync X_OK still resolves
 *  to a meaningful check for existing files, so we use it everywhere. */
function makeExecutable(filePath: string): void {
  if (process.platform === "win32") return;
  chmodSync(filePath, 0o755);
}

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "officecli-test-"));
}

/** Build a fake execFile that records calls and returns canned output. */
interface RecordingCall {
  file: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  maxBuffer?: number;
  timeout?: number;
  signal?: AbortSignal;
}

interface RecordingResponse {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  throw?: Error & { code?: unknown; stdout?: string; stderr?: string };
}

function makeRecordingExec(responses: RecordingResponse[]): {
  exec: OfficeCliExecFileFn;
  calls: RecordingCall[];
} {
  const calls: RecordingCall[] = [];
  let i = 0;
  const exec: OfficeCliExecFileFn = (file, args, options) => {
    const call: RecordingCall = { file, args };
    if (options.env !== undefined) call.env = options.env;
    if (options.cwd !== undefined) call.cwd = options.cwd;
    if (options.maxBuffer !== undefined) call.maxBuffer = options.maxBuffer;
    if (options.timeout !== undefined) call.timeout = options.timeout;
    if (options.signal !== undefined) call.signal = options.signal;
    calls.push(call);
    const resp = responses[i];
    i += 1;
    const fallback = responses[responses.length - 1];
    const r = resp ?? fallback;
    if (r === undefined) {
      throw new Error("makeRecordingExec: no response configured");
    }
    if (r.throw) throw r.throw;
    const stdout = r.stdout ?? "";
    const stderr = r.stderr ?? "";
    const code = r.exitCode ?? 0;
    if (code !== 0) {
      throw Object.assign(new Error(`non-zero exit ${code}`), {
        code,
        stdout,
        stderr,
      });
    }
    return Promise.resolve({ stdout, stderr });
  };
  return { exec, calls };
}

function makeSpawnedChild(): {
  child: ChildProcess;
  stdout: PassThrough;
  stderr: PassThrough;
  spawn: OfficeCliSpawnFn;
  calls: Array<{ file: string; args: readonly string[] }>;
  killCalls: () => number;
  killSignals: () => Array<NodeJS.Signals | number | undefined>;
} {
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let kills = 0;
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const child = Object.assign(events, {
    stdout,
    stderr,
    kill: (signal?: NodeJS.Signals | number) => {
      kills += 1;
      signals.push(signal);
      return true;
    },
  }) as unknown as ChildProcess;
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  return {
    child,
    stdout,
    stderr,
    calls,
    spawn: (file, args) => {
      calls.push({ file, args });
      return child;
    },
    killCalls: () => kills,
    killSignals: () => signals,
  };
}

async function expectRejects(
  run: () => Promise<unknown>,
  assert: (err: unknown) => void,
): Promise<void> {
  let thrown: unknown;
  try {
    await run();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeDefined();
  assert(thrown);
}

// ---------------------------------------------------------------------------
// resolveOfficeCliPath
// ---------------------------------------------------------------------------

describe("resolveOfficeCliPath", () => {
  test("override wins over env and PATH", () => {
    const dir = makeTmpDir();
    const candidate = join(dir, "officecli");
    writeFileSync(candidate, "#!/bin/sh\n");
    makeExecutable(candidate);

    const result = resolveOfficeCliPath({
      override: "/pinned/officecli",
      env: { OFFICECLI_PATH: "/env/officecli", PATH: dir },
    });
    expect(result).toBe("/pinned/officecli");
  });

  test("OFFICECLI_PATH wins over PATH when no override", () => {
    const dir = makeTmpDir();
    const onPath = join(dir, "officecli");
    writeFileSync(onPath, "#!/bin/sh\n");
    makeExecutable(onPath);

    const result = resolveOfficeCliPath({
      env: { OFFICECLI_PATH: "/env/officecli", PATH: dir },
    });
    expect(result).toBe("/env/officecli");
  });

  test("falls back to PATH lookup for executable named officecli", () => {
    const dir = makeTmpDir();
    const candidate = join(dir, "officecli");
    writeFileSync(candidate, "#!/bin/sh\n");
    makeExecutable(candidate);

    const result = resolveOfficeCliPath({
      env: { PATH: dir },
    });
    expect(result).toBe(candidate);
  });

  test("PATH lookup skips non-executable candidates", () => {
    const dir = makeTmpDir();
    const candidate = join(dir, "officecli");
    writeFileSync(candidate, "not executable");
    if (process.platform !== "win32") chmodSync(candidate, 0o644);

    const result = resolveOfficeCliPath({
      env: { PATH: dir },
    });
    expect(result).toBeNull();
  });

  test("returns null when nothing is configured", () => {
    const result = resolveOfficeCliPath({ env: {} });
    expect(result).toBeNull();
  });

  test("whitespace-only override is treated as unset", () => {
    const dir = makeTmpDir();
    const candidate = join(dir, "officecli");
    writeFileSync(candidate, "#!/bin/sh\n");
    makeExecutable(candidate);

    const result = resolveOfficeCliPath({
      override: "   ",
      env: { PATH: dir },
    });
    expect(result).toBe(candidate);
  });

  test("empty-string OFFICECLI_PATH falls back to PATH", () => {
    const dir = makeTmpDir();
    const candidate = join(dir, "officecli");
    writeFileSync(candidate, "#!/bin/sh\n");
    makeExecutable(candidate);

    const result = resolveOfficeCliPath({
      env: { OFFICECLI_PATH: "", PATH: dir },
    });
    expect(result).toBe(candidate);
  });

  test("relative override is resolved against cwd", () => {
    const dir = makeTmpDir();
    const result = resolveOfficeCliPath({
      override: "bin/officecli",
      cwd: dir,
      env: {},
    });
    expect(result).toBe(join(dir, "bin", "officecli"));
  });

  test("absolute override is returned unchanged", () => {
    const result = resolveOfficeCliPath({
      override: "/usr/local/bin/officecli",
      env: {},
    });
    expect(result).toBe("/usr/local/bin/officecli");
  });

  test("PATH lookup scans multiple dirs and picks the first executable", () => {
    const dirA = makeTmpDir();
    const dirB = makeTmpDir();
    const candidate = join(dirB, "officecli");
    writeFileSync(candidate, "#!/bin/sh\n");
    makeExecutable(candidate);

    const result = resolveOfficeCliPath({
      env: { PATH: [dirA, dirB].join(pathDelimiter) },
    });
    expect(result).toBe(candidate);
  });
});

// ---------------------------------------------------------------------------
// buildOfficeCliEnv
// ---------------------------------------------------------------------------

describe("buildOfficeCliEnv", () => {
  test("sets OFFICECLI_SKIP_UPDATE=1 by default", () => {
    const env = buildOfficeCliEnv({ env: { FOO: "bar" } });
    expect(env["OFFICECLI_SKIP_UPDATE"]).toBe("1");
    expect(env["FOO"]).toBe("bar");
  });

  test("skipUpdate=false removes OFFICECLI_SKIP_UPDATE", () => {
    const env = buildOfficeCliEnv({
      env: { OFFICECLI_SKIP_UPDATE: "1" },
      skipUpdate: false,
    });
    expect("OFFICECLI_SKIP_UPDATE" in env).toBe(false);
  });

  test("does not mutate the input env object", () => {
    const input: NodeJS.ProcessEnv = { FOO: "bar" };
    buildOfficeCliEnv({ env: input });
    expect(input["OFFICECLI_SKIP_UPDATE"]).toBeUndefined();
  });

  test("applies overrides on top of skip-update default", () => {
    const env = buildOfficeCliEnv({
      env: { FOO: "bar" },
      overrides: { OFFICECLI_NO_AUTO_RESIDENT: "1", FOO: "baz" },
    });
    expect(env["OFFICECLI_SKIP_UPDATE"]).toBe("1");
    expect(env["OFFICECLI_NO_AUTO_RESIDENT"]).toBe("1");
    expect(env["FOO"]).toBe("baz");
  });

  test("override with undefined deletes the key", () => {
    const env = buildOfficeCliEnv({
      env: { FOO: "bar", OFFICECLI_SKIP_UPDATE: "1" },
      overrides: { FOO: undefined },
    });
    expect("FOO" in env).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildVersionArgv
// ---------------------------------------------------------------------------

describe("buildVersionArgv", () => {
  test("returns the --version flag", () => {
    expect(buildVersionArgv()).toEqual(["--version"]);
  });
});

// ---------------------------------------------------------------------------
// buildDumpArgv
// ---------------------------------------------------------------------------

describe("buildDumpArgv", () => {
  test("minimal: dump <file> / --format batch", () => {
    expect(buildDumpArgv({ file: "report.docx" })).toEqual([
      "dump",
      "report.docx",
      "/",
      "--format",
      "batch",
    ]);
  });

  test("path positional is honoured", () => {
    expect(buildDumpArgv({ file: "r.docx", path: "/body" })).toEqual([
      "dump",
      "r.docx",
      "/body",
      "--format",
      "batch",
    ]);
  });

  test("format is honoured", () => {
    expect(buildDumpArgv({ file: "r.docx", format: "json" })).toEqual([
      "dump",
      "r.docx",
      "/",
      "--format",
      "json",
    ]);
  });

  test("--out is appended when outPath is non-empty", () => {
    expect(buildDumpArgv({ file: "r.docx", outPath: "/tmp/out.json" })).toEqual([
      "dump",
      "r.docx",
      "/",
      "--format",
      "batch",
      "--out",
      "/tmp/out.json",
    ]);
  });

  test("empty outPath is ignored", () => {
    expect(buildDumpArgv({ file: "r.docx", outPath: "" })).toEqual([
      "dump",
      "r.docx",
      "/",
      "--format",
      "batch",
    ]);
  });

  test("--json flag is appended when json=true", () => {
    expect(buildDumpArgv({ file: "r.docx", json: true })).toEqual([
      "dump",
      "r.docx",
      "/",
      "--format",
      "batch",
      "--json",
    ]);
  });

  test("full combo: path + out + json", () => {
    expect(
      buildDumpArgv({
        file: "r.docx",
        path: "/body/p[1]",
        outPath: "out.json",
        json: true,
      }),
    ).toEqual([
      "dump",
      "r.docx",
      "/body/p[1]",
      "--format",
      "batch",
      "--out",
      "out.json",
      "--json",
    ]);
  });

  test("empty file throws", () => {
    expect(() => buildDumpArgv({ file: "" })).toThrow("file is required");
  });
});

// ---------------------------------------------------------------------------
// buildGetArgv
// ---------------------------------------------------------------------------

describe("buildGetArgv", () => {
  test("minimal: get <file> /", () => {
    expect(buildGetArgv({ file: "r.docx" })).toEqual(["get", "r.docx", "/"]);
  });

  test("path positional is honoured", () => {
    expect(buildGetArgv({ file: "r.docx", path: "/body/p[1]" })).toEqual([
      "get",
      "r.docx",
      "/body/p[1]",
    ]);
  });

  test("--depth is appended when set", () => {
    expect(buildGetArgv({ file: "r.docx", depth: 3 })).toEqual([
      "get",
      "r.docx",
      "/",
      "--depth",
      "3",
    ]);
  });

  test("depth=0 is allowed", () => {
    expect(buildGetArgv({ file: "r.docx", depth: 0 })).toEqual([
      "get",
      "r.docx",
      "/",
      "--depth",
      "0",
    ]);
  });

  test("negative depth throws", () => {
    expect(() => buildGetArgv({ file: "r.docx", depth: -1 })).toThrow("depth");
  });

  test("non-integer depth throws", () => {
    expect(() => buildGetArgv({ file: "r.docx", depth: 1.5 })).toThrow("depth");
  });

  test("--save is appended when savePath is non-empty", () => {
    expect(buildGetArgv({ file: "r.docx", savePath: "/tmp/img.png" })).toEqual([
      "get",
      "r.docx",
      "/",
      "--save",
      "/tmp/img.png",
    ]);
  });

  test("empty savePath is ignored", () => {
    expect(buildGetArgv({ file: "r.docx", savePath: "" })).toEqual([
      "get",
      "r.docx",
      "/",
    ]);
  });

  test("--json flag is appended when json=true", () => {
    expect(buildGetArgv({ file: "r.docx", json: true })).toEqual([
      "get",
      "r.docx",
      "/",
      "--json",
    ]);
  });

  test("full combo: path + depth + save + json", () => {
    expect(
      buildGetArgv({
        file: "r.docx",
        path: "/body/p[1]",
        depth: 2,
        savePath: "img.png",
        json: true,
      }),
    ).toEqual([
      "get",
      "r.docx",
      "/body/p[1]",
      "--depth",
      "2",
      "--save",
      "img.png",
      "--json",
    ]);
  });

  test("empty file throws", () => {
    expect(() => buildGetArgv({ file: "" })).toThrow("file is required");
  });
});

// ---------------------------------------------------------------------------
// runOfficeCliRaw
// ---------------------------------------------------------------------------

describe("runOfficeCliRaw", () => {
  test("returns stdout/stderr and exit 0 on success", async () => {
    const { exec, calls } = makeRecordingExec([
      { stdout: "ok\n", stderr: "" },
    ]);
    const result = await runOfficeCliRaw({
      binaryPath: "/bin/officecli",
      argv: ["--version"],
      execFile: exec,
    });
    expect(result).toEqual({ stdout: "ok\n", stderr: "", exitCode: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("/bin/officecli");
    expect(calls[0]?.args).toEqual(["--version"]);
  });

  test("defaults env to OFFICECLI_SKIP_UPDATE=1", async () => {
    const { exec, calls } = makeRecordingExec([{ stdout: "" }]);
    await runOfficeCliRaw({
      binaryPath: "/bin/officecli",
      argv: [],
      execFile: exec,
    });
    expect(calls[0]?.env?.["OFFICECLI_SKIP_UPDATE"]).toBe("1");
  });

  test("bounds OfficeCLI stdio above Node's 1 MiB execFile default", async () => {
    const { exec, calls } = makeRecordingExec([{ stdout: "" }]);
    await runOfficeCliRaw({
      binaryPath: "/bin/officecli",
      argv: ["get", "large.docx", "/body", "--json"],
      execFile: exec,
    });
    expect(OFFICECLI_STDIO_MAX_BYTES).toBe(50 * 1024 * 1024);
    expect(calls[0]?.maxBuffer).toBe(OFFICECLI_STDIO_MAX_BYTES);
  });

  test("uses the real streamed child-process path by default", async () => {
    const result = await runOfficeCliRaw({
      binaryPath: process.execPath,
      argv: ["-e", 'process.stdout.write("streamed"); process.stderr.write("diagnostic");'],
    });
    expect(result).toEqual({ stdout: "streamed", stderr: "diagnostic", exitCode: 0 });
  });

  test("passes through a caller-provided env unchanged", async () => {
    const { exec, calls } = makeRecordingExec([{ stdout: "" }]);
    await runOfficeCliRaw({
      binaryPath: "/bin/officecli",
      argv: [],
      env: { CUSTOM: "yes" },
      execFile: exec,
    });
    expect(calls[0]?.env?.["CUSTOM"]).toBe("yes");
    // Caller-provided env is NOT augmented with skip-update automatically.
    expect(calls[0]?.env?.["OFFICECLI_SKIP_UPDATE"]).toBeUndefined();
  });

  test("passes cwd, timeout, and cancellation through to the execFile test seam", async () => {
    const { exec, calls } = makeRecordingExec([{ stdout: "" }]);
    const controller = new AbortController();
    await runOfficeCliRaw({
      binaryPath: "/bin/officecli",
      argv: [],
      cwd: "/tmp",
      timeoutMs: 123,
      signal: controller.signal,
      execFile: exec,
    });
    expect(calls[0]?.cwd).toBe("/tmp");
    expect(calls[0]?.timeout).toBe(123);
    expect(calls[0]?.signal).toBe(controller.signal);
  });

  test("non-zero exit is returned, not thrown", async () => {
    const { exec } = makeRecordingExec([{ stdout: "partial", stderr: "err", exitCode: 2 }]);
    const result = await runOfficeCliRaw({
      binaryPath: "/bin/officecli",
      argv: ["get", "missing.docx"],
      execFile: exec,
    });
    expect(result).toEqual({ stdout: "partial", stderr: "err", exitCode: 2 });
  });

  test("spawn errors (no exit code) rethrow", async () => {
    const { exec } = makeRecordingExec([
      { throw: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) },
    ]);
    await expectRejects(
      () => runOfficeCliRaw({
        binaryPath: "/no/such/officecli",
        argv: [],
        execFile: exec,
      }),
      (err) => expect(err).toBeInstanceOf(Error),
    );
  });

  test("empty binaryPath throws", async () => {
    await expectRejects(
      () => runOfficeCliRaw({ binaryPath: "", argv: [], execFile: makeRecordingExec([]).exec }),
      (err) => {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain("binaryPath is required");
      },
    );
  });

  test("argv is copied so the caller's array is not mutated", async () => {
    const { exec, calls } = makeRecordingExec([{ stdout: "" }]);
    const argv = ["--version"];
    await runOfficeCliRaw({
      binaryPath: "/bin/officecli",
      argv,
      execFile: exec,
    });
    expect(calls[0]?.args).not.toBe(argv);
    expect(calls[0]?.args).toEqual(["--version"]);
  });

  test("rejects an elapsed zero deadline before spawning", async () => {
    const fake = makeSpawnedChild();
    await expectRejects(
      () => runOfficeCliRaw({
        binaryPath: "/bin/officecli",
        argv: [],
        timeoutMs: 0,
        spawn: fake.spawn,
      }),
      (err) => expect(err).toMatchObject({
        code: "deadline",
        stage: "process",
        deadlineMs: 0,
      }),
    );
    expect(fake.calls).toHaveLength(0);
  });

  test("rejects a negative deadline before spawning", async () => {
    const fake = makeSpawnedChild();
    await expectRejects(
      () => runOfficeCliRaw({
        binaryPath: "/bin/officecli",
        argv: [],
        timeoutMs: -1,
        spawn: fake.spawn,
      }),
      (err) => expect(err).toMatchObject({
        code: "deadline",
        stage: "process",
        deadlineMs: -1,
      }),
    );
    expect(fake.calls).toHaveLength(0);
  });

  test("rejects with a typed stdout limit error only after killing and closing the child", async () => {
    const fake = makeSpawnedChild();
    const pending = runOfficeCliRaw({
      binaryPath: "/bin/officecli",
      argv: [],
      spawn: fake.spawn,
    });
    fake.stdout.write(Buffer.alloc(OFFICECLI_STDIO_MAX_BYTES + 1));
    expect(fake.killCalls()).toBe(1);
    fake.child.emit("close", null);
    await expectRejects(
      () => pending,
      (err) => {
        expect(err).toBeInstanceOf(OfficeCliRunError);
        expect(err).toMatchObject({
          code: "capacity",
          stage: "stdout",
          limitBytes: OFFICECLI_STDIO_MAX_BYTES,
          observedBytes: OFFICECLI_STDIO_MAX_BYTES + 1,
        });
      },
    );
    expect(fake.killSignals()).toEqual(["SIGKILL"]);
  });

  test("rejects with a typed stderr limit error distinct from stdout", async () => {
    const fake = makeSpawnedChild();
    const pending = runOfficeCliRaw({
      binaryPath: "/bin/officecli",
      argv: [],
      spawn: fake.spawn,
    });
    fake.stderr.write(Buffer.alloc(OFFICECLI_STDIO_MAX_BYTES + 1));
    expect(fake.killCalls()).toBe(1);
    fake.child.emit("close", null);
    await expectRejects(
      () => pending,
      (err) => expect(err).toMatchObject({
        code: "capacity",
        stage: "stderr",
        limitBytes: OFFICECLI_STDIO_MAX_BYTES,
        observedBytes: OFFICECLI_STDIO_MAX_BYTES + 1,
      }),
    );
    expect(fake.killSignals()).toEqual(["SIGKILL"]);
  });

  test("cancellation kills the child and rejects only after child cleanup", async () => {
    const fake = makeSpawnedChild();
    const controller = new AbortController();
    const pending = runOfficeCliRaw({
      binaryPath: "/bin/officecli",
      argv: [],
      signal: controller.signal,
      spawn: fake.spawn,
    });
    controller.abort();
    expect(fake.killCalls()).toBe(1);
    let settled = false;
    void pending.catch(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    fake.child.emit("close", null);
    await expectRejects(
      () => pending,
      (err) => expect(err).toMatchObject({ code: "cancelled", stage: "process" }),
    );
    expect(fake.killSignals()).toEqual(["SIGKILL"]);
  });

  test("timeout kills the child and reports its deadline accounting", async () => {
    const fake = makeSpawnedChild();
    const pending = runOfficeCliRaw({
      binaryPath: "/bin/officecli",
      argv: [],
      timeoutMs: 5,
      spawn: fake.spawn,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.killCalls()).toBe(1);
    fake.child.emit("close", null);
    await expectRejects(
      () => pending,
      (err) => expect(err).toMatchObject({
        code: "deadline",
        stage: "process",
        deadlineMs: 5,
      }),
    );
    expect(fake.killSignals()).toEqual(["SIGKILL"]);
  });

  test("catches an abort that happens during spawn before listener attachment", async () => {
    const fake = makeSpawnedChild();
    const controller = new AbortController();
    const pending = runOfficeCliRaw({
      binaryPath: "/bin/officecli",
      argv: [],
      signal: controller.signal,
      spawn: (file, args, options) => {
        controller.abort();
        return fake.spawn(file, args, options);
      },
    });
    expect(fake.killCalls()).toBe(1);
    expect(fake.killSignals()).toEqual(["SIGKILL"]);
    fake.child.emit("close", null);
    await expectRejects(
      () => pending,
      (err) => expect(err).toMatchObject({ code: "cancelled", stage: "process" }),
    );
  });

  test("stdout stream errors terminate the child and reject through the runner envelope", async () => {
    const fake = makeSpawnedChild();
    const pending = runOfficeCliRaw({
      binaryPath: "/bin/officecli",
      argv: [],
      spawn: fake.spawn,
    });
    fake.stdout.emit("error", new Error("stdout broke"));
    expect(fake.killSignals()).toEqual(["SIGKILL"]);
    fake.child.emit("close", null);
    await expectRejects(
      () => pending,
      (err) => expect(err).toMatchObject({ code: "runner", stage: "stdout" }),
    );
  });

  test("stderr stream errors terminate the child and reject through the runner envelope", async () => {
    const fake = makeSpawnedChild();
    const pending = runOfficeCliRaw({
      binaryPath: "/bin/officecli",
      argv: [],
      spawn: fake.spawn,
    });
    fake.stderr.emit("error", new Error("stderr broke"));
    expect(fake.killSignals()).toEqual(["SIGKILL"]);
    fake.child.emit("close", null);
    await expectRejects(
      () => pending,
      (err) => expect(err).toMatchObject({ code: "runner", stage: "stderr" }),
    );
  });
});

// ---------------------------------------------------------------------------
// runOfficeCliVersion
// ---------------------------------------------------------------------------

describe("runOfficeCliVersion", () => {
  test("returns the semver prefix from --version stdout", async () => {
    const { exec } = makeRecordingExec([{ stdout: "1.2.3 (build abc)\n" }]);
    const v = await runOfficeCliVersion({
      binaryPath: "/bin/officecli",
      execFile: exec,
    });
    expect(v).toBe("1.2.3");
  });

  test("accepts pre-release suffix in stdout", async () => {
    const { exec } = makeRecordingExec([{ stdout: "0.9.0-rc.1\n" }]);
    const v = await runOfficeCliVersion({
      binaryPath: "/bin/officecli",
      execFile: exec,
    });
    expect(v).toBe("0.9.0");
  });

  test("uses --version argv", async () => {
    const { exec, calls } = makeRecordingExec([{ stdout: "1.0.0\n" }]);
    await runOfficeCliVersion({
      binaryPath: "/bin/officecli",
      execFile: exec,
    });
    expect(calls[0]?.args).toEqual(["--version"]);
  });

  test("non-zero exit throws OfficeCliVersionError with stderr", async () => {
    const { exec } = makeRecordingExec([
      { stdout: "", stderr: "binary not found", exitCode: 127 },
    ]);
    await expectRejects(
      () => runOfficeCliVersion({ binaryPath: "/bin/officecli", execFile: exec }),
      (err) => {
      expect(err).toBeInstanceOf(OfficeCliVersionError);
      const e = err as OfficeCliVersionError;
      expect(e.exitCode).toBe(127);
      expect(e.stderr).toBe("binary not found");
      },
    );
  });

  test("non-semver stdout throws OfficeCliVersionError", async () => {
    const { exec } = makeRecordingExec([{ stdout: "not a version\n" }]);
    await expectRejects(
      () => runOfficeCliVersion({ binaryPath: "/bin/officecli", execFile: exec }),
      (err) => expect(err).toBeInstanceOf(OfficeCliVersionError),
    );
  });

  test("empty stdout throws OfficeCliVersionError", async () => {
    const { exec } = makeRecordingExec([{ stdout: "" }]);
    await expectRejects(
      () => runOfficeCliVersion({ binaryPath: "/bin/officecli", execFile: exec }),
      (err) => expect(err).toBeInstanceOf(OfficeCliVersionError),
    );
  });

  test("default env has OFFICECLI_SKIP_UPDATE=1", async () => {
    const { exec, calls } = makeRecordingExec([{ stdout: "1.0.0\n" }]);
    await runOfficeCliVersion({
      binaryPath: "/bin/officecli",
      execFile: exec,
    });
    expect(calls[0]?.env?.["OFFICECLI_SKIP_UPDATE"]).toBe("1");
  });

  test("empty binaryPath throws", async () => {
    await expectRejects(
      () => runOfficeCliVersion({
        binaryPath: "",
        execFile: makeRecordingExec([]).exec,
      }),
      (err) => {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain("binaryPath is required");
      },
    );
  });
});
