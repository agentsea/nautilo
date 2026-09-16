import { describe, expect, test } from "bun:test";

import {
  runApplyPatchProcess,
  type ApplyPatchAdapterCompletion,
  type ApplyPatchSandboxAdapter,
} from "../../src/tools/apply-patch/process-wrapper";

const PATCH = "*** Begin Patch\n*** Add File: src/example.ts\n+hello\n*** End Patch\n";
const ROOT = "/private/work/project";
const BINARY = "/opt/nautilo/nautilo-apply-patch";
const MEBIBYTE = 1024 * 1024;
const WITHDRAWN_FILE_COUNT = 101;
const WITHDRAWN_HUNK_COUNT = 1001;
const RUNTIME_IDENTITY = {
  protocol: "nautilo.apply_patch/v1",
  runtimeVersion: "0.1.2",
  upstreamRevision: "pinned-upstream",
  nautiloExtractionRevision: "pinned-extraction",
} as const;

function appliedReport(): string {
  return JSON.stringify({
    protocol: "nautilo.apply_patch/v1",
    runtime_version: "0.1.2",
    upstream_revision: "pinned-upstream",
    nautilo_extraction_revision: "pinned-extraction",
    ok: true,
    partial: false,
    planned_paths: ["src/example.ts"],
    applied_paths: ["src/example.ts"],
    planned_operations: [{ kind: "add", path: "src/example.ts" }],
    operation_states: [{ kind: "add", path: "src/example.ts", state: "applied" }],
  });
}

function historicallyLargePatch(): string {
  const lines = ["*** Begin Patch", "*** Add File: bulk/large.txt", `+${"x".repeat(MEBIBYTE + 1)}`];
  for (let index = 0; index < WITHDRAWN_FILE_COUNT - 1; index += 1) {
    lines.push(`*** Add File: bulk/file-${index.toString().padStart(3, "0")}.txt`);
    lines.push(`+${"y".repeat(80_000)}`);
  }
  lines.push("*** Update File: existing.txt");
  for (let index = 0; index < WITHDRAWN_HUNK_COUNT; index += 1) {
    lines.push("@@", `-old-${index}`, `+new-${index}`);
  }
  lines.push("*** End Patch");
  return lines.join("\n");
}

function appliedReportForOperations(): string {
  const paths = [
    "bulk/large.txt",
    ...Array.from(
      { length: WITHDRAWN_FILE_COUNT - 1 },
      (_value, index) => `bulk/file-${index.toString().padStart(3, "0")}.txt`,
    ),
    "existing.txt",
  ];
  const plannedOperations = paths.map((path, index) => ({
    kind: index === paths.length - 1 ? "update" : "add",
    path,
  }));
  return JSON.stringify({
    protocol: "nautilo.apply_patch/v1",
    runtime_version: "0.1.2",
    upstream_revision: "pinned-upstream",
    nautilo_extraction_revision: "pinned-extraction",
    ok: true,
    partial: false,
    planned_paths: paths,
    applied_paths: paths,
    planned_operations: plannedOperations,
    operation_states: plannedOperations.map((operation) => ({ ...operation, state: "applied" })),
  });
}

function partialUnknownReport(): string {
  return JSON.stringify({
    protocol: "nautilo.apply_patch/v1",
    runtime_version: "0.1.2",
    upstream_revision: "pinned-upstream",
    nautilo_extraction_revision: "pinned-extraction",
    ok: false,
    partial: true,
    planned_paths: ["src/example.ts", "src/later.ts"],
    applied_paths: ["src/example.ts"],
    planned_operations: [
      { kind: "add", path: "src/example.ts" },
      { kind: "delete", path: "src/later.ts" },
    ],
    operation_states: [
      { kind: "add", path: "src/example.ts", state: "applied" },
      { kind: "delete", path: "src/later.ts", state: "unknown" },
    ],
    failure_kind: "execution",
    error: "committed prefix remains",
  });
}

function correctnessFailureReport(): string {
  return JSON.stringify({
    protocol: "nautilo.apply_patch/v1",
    runtime_version: "0.1.2",
    upstream_revision: "pinned-upstream",
    nautilo_extraction_revision: "pinned-extraction",
    ok: false,
    partial: false,
    planned_paths: [],
    applied_paths: [],
    planned_operations: [],
    operation_states: [],
    failure_kind: "context",
    error: "hunk context did not match",
  });
}

function parseFailureReport(): string {
  return JSON.stringify({
    protocol: "nautilo.apply_patch/v1",
    runtime_version: "0.1.2",
    upstream_revision: "pinned-upstream",
    nautilo_extraction_revision: "pinned-extraction",
    ok: false,
    partial: false,
    planned_paths: [],
    applied_paths: [],
    planned_operations: [],
    operation_states: [],
    failure_kind: "parse",
    error: "invalid hunk",
  });
}

function executionFailureReport(): string {
  return JSON.stringify({
    protocol: "nautilo.apply_patch/v1",
    runtime_version: "0.1.2",
    upstream_revision: "pinned-upstream",
    nautilo_extraction_revision: "pinned-extraction",
    ok: false,
    partial: false,
    planned_paths: ["src/example.ts"],
    applied_paths: [],
    planned_operations: [{ kind: "add", path: "src/example.ts" }],
    operation_states: [{ kind: "add", path: "src/example.ts", state: "not_applied" }],
    failure_kind: "execution",
    error: "private write failed",
  });
}

function completion(overrides: Partial<ApplyPatchAdapterCompletion> = {}): ApplyPatchAdapterCompletion {
  return {
    stdout: appliedReport(),
    stderr: "",
    exitCode: 0,
    signal: null,
    ...overrides,
  };
}

function fakeAdapter(completed: Promise<ApplyPatchAdapterCompletion>): {
  readonly adapter: ApplyPatchSandboxAdapter<{ readonly id: "sandbox" }>;
  readonly starts: Array<Record<string, unknown>>;
  readonly terminated: number[];
  readonly cleaned: number[];
} {
  const starts: Array<Record<string, unknown>> = [];
  const terminated: number[] = [];
  const cleaned: number[] = [];
  return {
    adapter: {
      createSandbox: () => ({ id: "sandbox" }),
      start: (_sandbox, input) => {
        starts.push(input as Record<string, unknown>);
        return { completed };
      },
      terminateProcessTree: () => {
        terminated.push(1);
      },
      cleanupSandbox: () => {
        cleaned.push(1);
      },
    },
    starts,
    terminated,
    cleaned,
  };
}

describe("D448 apply-patch constrained process wrapper", () => {
  test("uses only fixed stdin/cwd/empty-env/zero-argv fields through the explicit sandbox adapter", async () => {
    const fake = fakeAdapter(Promise.resolve(completion()));
    const result = await runApplyPatchProcess({ root: ROOT, patch: PATCH, binaryPath: BINARY, expectedRuntime: RUNTIME_IDENTITY, sandbox: fake.adapter });
    expect(result).toMatchObject({ ok: true, report: { ok: true, operationStates: [{ state: "applied" }] } });
    expect(fake.starts).toHaveLength(1);
    expect(fake.starts[0]).toMatchObject({
      binaryPath: BINARY,
      argv: [],
      cwd: ROOT,
      env: {},
      stdin: JSON.stringify({ patch: PATCH }),
    });
    expect(fake.terminated).toEqual([]);
    expect(fake.cleaned).toEqual([1]);
  });

  test("streams a patch beyond every withdrawn D448 semantic ceiling to the sandbox adapter", async () => {
    const patch = historicallyLargePatch();
    expect(Buffer.byteLength(patch, "utf8")).toBeGreaterThan(8 * MEBIBYTE);
    expect(patch.match(/^@@$/gm)).toHaveLength(WITHDRAWN_HUNK_COUNT);
    const fake = fakeAdapter(Promise.resolve(completion({ stdout: appliedReportForOperations() })));

    const result = await runApplyPatchProcess({
      root: ROOT,
      patch,
      binaryPath: BINARY,
      expectedRuntime: RUNTIME_IDENTITY,
      sandbox: fake.adapter,
    });

    expect(result).toMatchObject({ ok: true, report: { plannedOperations: { length: WITHDRAWN_FILE_COUNT + 1 } } });
    expect(fake.starts).toHaveLength(1);
    const stdin = JSON.parse(fake.starts[0]!["stdin"] as string) as { patch: string };
    expect(Buffer.byteLength(stdin.patch, "utf8")).toBe(Buffer.byteLength(patch, "utf8"));
    expect(stdin.patch.slice(0, 64)).toBe(patch.slice(0, 64));
    expect(stdin.patch.slice(-64)).toBe(patch.slice(-64));
  });

  test("rejects malformed UTF-8-shaped input before sandbox creation", async () => {
    const fake = fakeAdapter(Promise.resolve(completion()));
    const invalid = await runApplyPatchProcess({
      root: ROOT,
      patch: `*** Begin Patch\n${"\ud800"}\n*** End Patch`,
      binaryPath: BINARY,
      expectedRuntime: RUNTIME_IDENTITY,
      sandbox: fake.adapter,
    });
    expect(invalid).toMatchObject({ ok: false, error: { code: "parse_error" } });
    expect(fake.starts).toEqual([]);
    expect(fake.cleaned).toEqual([]);
  });

  test("terminates the entire process tree and cleans up on cancellation", async () => {
    const cancelledController = new AbortController();
    const cancelled = fakeAdapter(new Promise(() => {}));
    const cancelledRun = runApplyPatchProcess({
      root: ROOT,
      patch: PATCH,
      binaryPath: BINARY,
      expectedRuntime: RUNTIME_IDENTITY,
      signal: cancelledController.signal,
      sandbox: cancelled.adapter,
    });
    await Promise.resolve();
    cancelledController.abort();
    expect(await cancelledRun).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(cancelled.terminated).toEqual([1]);
    expect(cancelled.cleaned).toEqual([1]);
  });

  test("terminates and cleans up when the adapter completion rejects", async () => {
    const rejected = fakeAdapter(Promise.reject(new Error("stream collector failed")));
    const result = await runApplyPatchProcess({
      root: ROOT,
      patch: PATCH,
      binaryPath: BINARY,
      expectedRuntime: RUNTIME_IDENTITY,
      sandbox: rejected.adapter,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "runtime_unavailable" } });
    expect(rejected.terminated).toEqual([1]);
    expect(rejected.cleaned).toEqual([1]);
  });

  test("separates a valid native partial/unknown report from crash, correctness, and malformed-report outcomes", async () => {
    const partial = fakeAdapter(Promise.resolve(completion({ stdout: partialUnknownReport(), exitCode: 1 })));
    expect(await runApplyPatchProcess({ root: ROOT, patch: PATCH, binaryPath: BINARY, expectedRuntime: RUNTIME_IDENTITY, sandbox: partial.adapter })).toMatchObject({
      ok: true,
      report: { ok: false, partial: true, operationStates: [{ state: "applied" }, { state: "unknown" }] },
    });

    const crash = fakeAdapter(Promise.resolve(completion({ exitCode: null, signal: "SIGSEGV" })));
    expect(await runApplyPatchProcess({ root: ROOT, patch: PATCH, binaryPath: BINARY, expectedRuntime: RUNTIME_IDENTITY, sandbox: crash.adapter })).toMatchObject({
      ok: false,
      error: { code: "runtime_unavailable" },
    });

    const inconsistentExit = fakeAdapter(Promise.resolve(completion({ stdout: appliedReport(), exitCode: 1 })));
    expect(await runApplyPatchProcess({ root: ROOT, patch: PATCH, binaryPath: BINARY, expectedRuntime: RUNTIME_IDENTITY, sandbox: inconsistentExit.adapter })).toMatchObject({
      ok: false,
      error: { code: "runtime_corrupt" },
    });

    const substituted = fakeAdapter(Promise.resolve(completion()));
    expect(await runApplyPatchProcess({
      root: ROOT,
      patch: PATCH,
      binaryPath: BINARY,
      expectedRuntime: { ...RUNTIME_IDENTITY, runtimeVersion: "unexpected-version" },
      sandbox: substituted.adapter,
    })).toMatchObject({
      ok: false,
      error: { code: "runtime_corrupt" },
    });

    const correctness = fakeAdapter(Promise.resolve(completion({ stdout: correctnessFailureReport(), exitCode: 1 })));
    expect(await runApplyPatchProcess({ root: ROOT, patch: PATCH, binaryPath: BINARY, expectedRuntime: RUNTIME_IDENTITY, sandbox: correctness.adapter })).toMatchObject({
      ok: false,
      error: {
        code: "reapply_required",
        message: "The target files did not match the patch context. Read the affected files again and construct a new patch.",
      },
    });

    const rejectedSyntax = fakeAdapter(Promise.resolve(completion({ stdout: parseFailureReport(), exitCode: 1 })));
    expect(await runApplyPatchProcess({ root: ROOT, patch: PATCH, binaryPath: BINARY, expectedRuntime: RUNTIME_IDENTITY, sandbox: rejectedSyntax.adapter })).toMatchObject({
      ok: false,
      error: { code: "parse_error", message: "apply_patch runtime rejected the patch syntax." },
    });

    const executionFailure = fakeAdapter(Promise.resolve(completion({ stdout: executionFailureReport(), exitCode: 1 })));
    expect(await runApplyPatchProcess({ root: ROOT, patch: PATCH, binaryPath: BINARY, expectedRuntime: RUNTIME_IDENTITY, sandbox: executionFailure.adapter })).toMatchObject({
      ok: false,
      error: {
        code: "runtime_unavailable",
        message: "apply_patch could not complete the patch in its private workspace.",
        retryable: true,
      },
    });

    const unknown = fakeAdapter(Promise.resolve(completion({ stdout: "{not-json" })));
    expect(await runApplyPatchProcess({ root: ROOT, patch: PATCH, binaryPath: BINARY, expectedRuntime: RUNTIME_IDENTITY, sandbox: unknown.adapter })).toMatchObject({
      ok: false,
      error: { code: "runtime_corrupt" },
    });

    const mismatchedNative = JSON.parse(partialUnknownReport()) as { applied_paths: string[] };
    mismatchedNative.applied_paths = [];
    const mismatched = fakeAdapter(Promise.resolve(completion({ stdout: JSON.stringify(mismatchedNative), exitCode: 1 })));
    expect(await runApplyPatchProcess({ root: ROOT, patch: PATCH, binaryPath: BINARY, expectedRuntime: RUNTIME_IDENTITY, sandbox: mismatched.adapter })).toMatchObject({
      ok: false,
      error: { code: "runtime_corrupt" },
    });
  });
});
