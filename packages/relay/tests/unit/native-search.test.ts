import { describe, expect, test } from "bun:test";
import {
  buildRipgrepArgv,
  runNativeSearch,
  type NativeSearchExecutionInput,
  type NativeSearchExecutor,
} from "../../src/native-search";

function executor(input: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number | null;
  readonly aborted?: boolean;
  readonly timedOut?: boolean;
  readonly chunkSize?: number;
  readonly capture?: (call: NativeSearchExecutionInput) => void;
}): NativeSearchExecutor {
  return async (call) => {
    input.capture?.(call);
    const stdout = Buffer.from(input.stdout ?? "");
    const size = input.chunkSize ?? Math.max(1, stdout.length);
    let stoppedEarly = false;
    for (let offset = 0; offset < stdout.length; offset += size) {
      if (call.onStdoutChunk(stdout.subarray(offset, offset + size)) === "stop") {
        stoppedEarly = true;
        break;
      }
    }
    return {
      exitCode: input.exitCode ?? (stoppedEarly ? null : 0),
      stderr: input.stderr ?? "",
      timedOut: input.timedOut ?? false,
      aborted: input.aborted ?? false,
      stoppedEarly,
    };
  };
}

const mapPath = (relativePath: string) => ({ relativePath, path: `project/${relativePath}` });

describe("D446 native ripgrep runner", () => {
  test("builds fixed glob argv with ignore/hidden semantics and no Git metadata requirement", () => {
    expect(
      buildRipgrepArgv({
        command: "glob",
        noRequireGit: true,
        args: {
          path: ".",
          pattern: "**/*.ts",
          limit: 1000,
          includeIgnored: false,
          hidden: "include",
        },
      }),
    ).toEqual([
      "--files",
      "--null",
      "--sort",
      "path",
      "--color",
      "never",
      "--no-messages",
      "--hidden",
      "--no-require-git",
      "--glob",
      "!.git/**",
      ".",
    ]);
  });

  test("builds grep argv without exposing executable, shell, cwd, or arbitrary flags", () => {
    expect(
      buildRipgrepArgv({
        command: "grep",
        args: {
          path: ".",
          query: "Widget",
          glob: "**/*.ts",
          limit: 200,
          includeIgnored: true,
          hidden: "exclude",
          caseMode: "sensitive",
        },
      }),
    ).toEqual([
      "--json",
      "--sort",
      "path",
      "--color",
      "never",
      "--no-messages",
      "--no-ignore",
      "--glob",
      "!.git/**",
      "--case-sensitive",
      "--",
      "Widget",
      ".",
    ]);
    expect(
      buildRipgrepArgv({
        command: "grep",
        target: "job.ts",
        args: {
          path: "packages/agent-runtime/src/job.ts",
          query: "hasDocumentAccess",
          limit: 200,
          includeIgnored: false,
          hidden: "include",
          caseMode: "smart",
        },
      }).at(-1),
    ).toBe("job.ts");
  });

  test("glob parses the complete ordered discovery set while retaining one page", async () => {
    let call: NativeSearchExecutionInput | undefined;
    const result = await runNativeSearch({
      command: "glob",
      args: {
        path: ".",
        pattern: "**/*.ts",
        limit: 2,
        includeIgnored: false,
        hidden: "include",
      },
      binaryPath: "/product/rg",
      cwd: "/authorized/root",
      engineVersion: "15.1.0",
      noRequireGit: true,
      mapPath,
      execute: executor({
        stdout: "src/a.ts\0src/b.ts\0src/c.ts\0src/d.ts\0",
        chunkSize: 3,
        capture: (value) => {
          call = value;
        },
      }),
    });
    expect(call?.program).toBe("/product/rg");
    expect(call?.cwd).toBe("/authorized/root");
    expect(result).toMatchObject({ ok: true, command: "glob", count: 2, truncated: true });
    if (result.ok && result.command === "glob") {
      expect(result.entries.map((entry) => entry.relativePath)).toEqual(["src/a.ts", "src/b.ts"]);
      expect(result.recovery).toContain("discoveryCursor");
      expect(result.totalCount).toBe(4);
      expect(result.nextCursor).toBeString();
    }
  });

  test("applies path globs after ripgrep ignore filtering so includes cannot revive ignored files", async () => {
    const glob = await runNativeSearch({
      command: "glob",
      args: {
        path: ".",
        pattern: "**/*.ts",
        limit: 20,
        includeIgnored: false,
        hidden: "include",
      },
      binaryPath: "/product/rg",
      cwd: "/authorized/root",
      engineVersion: "15.1.0",
      mapPath,
      execute: executor({ stdout: "src/a.ts\0src/a.js\0README.md\0" }),
    });
    expect(glob).toMatchObject({ ok: true, count: 1 });

    const event = (path: string) => JSON.stringify({
      type: "match",
      data: {
        path: { text: path },
        lines: { text: "Widget\n" },
        line_number: 1,
        submatches: [{ match: { text: "Widget" }, start: 0, end: 6 }],
      },
    });
    const grep = await runNativeSearch({
      command: "grep",
      args: {
        path: ".",
        query: "Widget",
        glob: "**/*.ts",
        limit: 20,
        includeIgnored: false,
        hidden: "include",
        caseMode: "smart",
      },
      binaryPath: "/product/rg",
      cwd: "/authorized/root",
      engineVersion: "15.1.0",
      mapPath,
      execute: executor({ stdout: `${event("src/a.ts")}\n${event("src/a.js")}\n` }),
    });
    expect(grep).toMatchObject({ ok: true, count: 1 });
  });

  test("grep normalizes JSON matches, line range, preview, and no-match", async () => {
    const events = [
      { type: "begin", data: { path: { text: "src/a.ts" } } },
      {
        type: "match",
        data: {
          path: { text: "./src/a.ts" },
          lines: { text: `${"x".repeat(220)} Widget\n` },
          line_number: 12,
          submatches: [{ match: { text: "Widget" }, start: 221, end: 227 }],
        },
      },
      {
        type: "match",
        data: {
          path: { text: "src/outside.ts" },
          lines: { text: "Widget\n" },
          line_number: 40,
          submatches: [{ match: { text: "Widget" }, start: 0, end: 6 }],
        },
      },
      { type: "end", data: {} },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n";
    const result = await runNativeSearch({
      command: "grep",
      args: {
        path: ".",
        query: "Widget",
        lineRange: { from: 10, to: 20 },
        limit: 200,
        includeIgnored: false,
        hidden: "include",
        caseMode: "smart",
      },
      binaryPath: "/product/rg",
      cwd: "/authorized/root",
      engineVersion: "15.1.0",
      mapPath,
      execute: executor({ stdout: events, chunkSize: 11 }),
    });
    expect(result).toMatchObject({ ok: true, command: "grep", count: 1, truncated: false });
    if (result.ok && result.command === "grep") {
      expect(result.matches[0]).toMatchObject({
        relativePath: "src/a.ts",
        path: "project/src/a.ts",
        line: 12,
        column: 222,
        match: "Widget",
      });
      expect(result.matches[0]?.preview.endsWith("…")).toBe(true);
    }

    const empty = await runNativeSearch({
      command: "grep",
      args: {
        path: ".",
        query: "absent",
        limit: 200,
        includeIgnored: false,
        hidden: "include",
        caseMode: "smart",
      },
      binaryPath: "/product/rg",
      cwd: "/authorized/root",
      engineVersion: "15.1.0",
      mapPath,
      execute: executor({ exitCode: 1 }),
    });
    expect(empty).toMatchObject({ ok: true, command: "grep", count: 0, matches: [] });
  });

  test("returns stable cancellation, timeout, invalid-pattern, and malformed-output errors", async () => {
    const args = {
      path: ".",
      query: "x",
      limit: 200,
      includeIgnored: false,
      hidden: "include" as const,
      caseMode: "smart" as const,
    };
    const base = {
      command: "grep" as const,
      args,
      binaryPath: "/product/rg",
      cwd: "/authorized/root",
      engineVersion: "15.1.0",
      mapPath,
    };
    expect(await runNativeSearch({ ...base, execute: executor({ aborted: true }) })).toMatchObject({
      ok: false,
      error: { code: "SEARCH_CANCELLED" },
    });
    expect(await runNativeSearch({ ...base, execute: executor({ timedOut: true }) })).toMatchObject({
      ok: false,
      error: { code: "SEARCH_TIMEOUT" },
    });
    expect(
      await runNativeSearch({
        ...base,
        execute: executor({ exitCode: 2, stderr: "regex parse error: unclosed group" }),
      }),
    ).toMatchObject({ ok: false, error: { code: "SEARCH_INVALID_PATTERN" } });
    expect(
      await runNativeSearch({ ...base, execute: executor({ stdout: "not-json\n" }) }),
    ).toMatchObject({ ok: false, error: { code: "SEARCH_ENGINE_FAILURE" } });
  });
});

describe("D580 lossless discovery continuation", () => {
  const args = { path: ".", pattern: "**/*.ts", limit: 2, includeIgnored: false, hidden: "include" as const };
  const input = { command: "glob" as const, args, binaryPath: "/product/rg", cwd: "/authorized/root", engineVersion: "15.1.0", mapPath };
  const stdout = "a.ts\0b.ts\0c.ts\0d.ts\0e.ts\0";

  test("pages the whole result set exactly once without larger page requests", async () => {
    let discoveryCursor: string | undefined;
    const paths: string[] = [];
    let pageCount = 0;
    do {
      const result = await runNativeSearch({ ...input, args: { ...args, ...(discoveryCursor ? { discoveryCursor } : {}) }, execute: executor({ stdout, chunkSize: 1 }) });
      expect(result.ok).toBe(true);
      if (!result.ok || result.command !== "glob") throw new Error("expected glob page");
      expect(result.totalCount).toBe(5);
      expect(result.startOffset).toBe(paths.length);
      paths.push(...result.entries.map((entry) => entry.relativePath));
      expect(result.endOffset).toBe(paths.length);
      discoveryCursor = result.nextCursor ?? undefined;
      expect(result.complete).toBe(discoveryCursor === undefined);
      pageCount += 1;
    } while (discoveryCursor);
    expect(paths).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
    expect(pageCount).toBe(3);
  });

  test("rejects changed results or cursor identity instead of combining discoveries", async () => {
    const first = await runNativeSearch({ ...input, execute: executor({ stdout }) });
    if (!first.ok || !first.nextCursor) throw new Error("expected cursor");
    const resumed = { ...args, discoveryCursor: first.nextCursor };
    const changed = await runNativeSearch({ ...input, args: resumed, execute: executor({ stdout: "a.ts\0new.ts\0c.ts\0d.ts\0e.ts\0" }) });
    expect(changed).toMatchObject({ ok: false, error: { code: "SEARCH_STALE_CURSOR" } });
    for (const variant of [{ args: { ...resumed, pattern: "*.js" } }, { cwd: "/other/root", args: resumed }]) {
      const invalid = await runNativeSearch({ ...input, ...variant, execute: executor({ stdout }) });
      expect(invalid).toMatchObject({ ok: false, error: { code: "SEARCH_INVALID_ARGS" } });
    }
  });

  test("grep resumes matching lines and detects changes beyond the short preview", async () => {
    const event = (line: number, suffix = "original") => JSON.stringify({ type: "match", data: {
      path: { text: "source.ts" }, lines: { text: "match " + "x".repeat(250) + suffix + "\n" }, line_number: line,
      submatches: [{ match: { text: "match" }, start: 0, end: 5 }],
    } }) + "\n";
    const grep = { ...input, command: "grep" as const, args: { path: ".", query: "match", caseMode: "smart" as const, limit: 1, includeIgnored: false, hidden: "include" as const } };
    const first = await runNativeSearch({ ...grep, execute: executor({ stdout: event(1) + event(2) }) });
    if (!first.ok || first.command !== "grep" || !first.nextCursor) throw new Error("expected grep cursor");
    const nextArgs = { ...grep.args, discoveryCursor: first.nextCursor };
    const second = await runNativeSearch({ ...grep, args: nextArgs, execute: executor({ stdout: event(1) + event(2) }) });
    expect(second).toMatchObject({ ok: true, matches: [{ line: 2 }], nextCursor: null, complete: true });
    const changed = await runNativeSearch({ ...grep, args: nextArgs, execute: executor({ stdout: event(1, "changed") + event(2) }) });
    expect(changed).toMatchObject({ ok: false, error: { code: "SEARCH_STALE_CURSOR" } });
  });

  test("an externally stopped discovery cannot claim exhaustion", async () => {
    const result = await runNativeSearch({ ...input, execute: async (call) => {
      call.onStdoutChunk(Buffer.from("a.ts\0"));
      return { exitCode: null, stderr: "", timedOut: false, aborted: false, stoppedEarly: true };
    } });
    expect(result).toMatchObject({ ok: false, error: { code: "SEARCH_OUTPUT_CEILING" } });
  });
});
