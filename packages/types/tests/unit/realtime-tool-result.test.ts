import { describe, expect, test } from "bun:test";

import {
  TOOL_RESULT_MAX_BYTES,
  isStagedToolResult,
  projectToolResultForEvent,
} from "../../src/realtime";

/** Mirrors `encodeStagedResult` — `JSON.stringify` with `staged` first. */
function encodeStagedResult(env: {
  staged: true;
  patchId: string;
  path: string;
  zone: "workspace" | "current" | "absolute";
  command: string;
  stats: { additions: number; deletions: number };
  summary: string;
  unifiedDiff: string;
}): string {
  return JSON.stringify(env);
}

function applyPatchResult() {
  const pathResults = Array.from({ length: 80 }, (_, index) => ({
    operation: "update",
    path: `src/very-long-file-name-${index}.ts`,
    status: "applied",
    revisionId: `revision-${index}`,
  }));
  return JSON.stringify({
    status: "partial",
    partial: true,
    runtimeVersion: "apply-patch-1",
    turnId: "turn-448",
    operationCounts: { add: 0, update: 80, move: 0, delete: 0 },
    pathResults,
    changedFiles: pathResults,
    revisionIds: pathResults.map((result) => result.revisionId),
    unifiedDiff: Array.from(
      { length: 80 },
      (_, index) => `diff --git a/src/very-long-file-name-${index}.ts b/src/very-long-file-name-${index}.ts\n@@ -1 +1 @@\n-old\n+${"x".repeat(400)}\n`,
    ).join(""),
    error: { code: "partial_execution", message: "one operation was not applied", retryable: false },
  });
}

function parseProjection(value: string): {
  status: string;
  partial: boolean;
  runtimeVersion: string;
  turnId: string;
  operationCounts: Record<string, number>;
  pathResults: Array<{ path: string }>;
  changedFiles: Array<{ revisionId: string }>;
  revisionIds: string[];
  unifiedDiff: string;
  error?: { code?: string; retryable?: boolean; message?: string };
  eventProjection: {
    totalPaths: number;
    shownPaths: number;
    totalChangedFiles: number;
    shownChangedFiles: number;
    totalDiffChars: number;
    shownDiffChars: number;
    totalErrorMessageChars: number;
    shownErrorMessageChars: number;
    truncated: boolean;
  };
} {
  return JSON.parse(value) as unknown as ReturnType<typeof parseProjection>;
}

describe("projectToolResultForEvent", () => {
  test("retains staged-result detection for the existing file-review path", () => {
    const encoded = encodeStagedResult({
      staged: true,
      patchId: "turn-1:small",
      path: "/tmp/a.html",
      zone: "workspace",
      command: "write",
      stats: { additions: 1, deletions: 0 },
      summary: "Staged: write",
      unifiedDiff: "+hello\n",
    });
    expect(isStagedToolResult(encoded)).toBe(true);
    expect(isStagedToolResult("stdout:\n" + "x".repeat(500) + '\nfound {"staged":true} in logs\n')).toBe(false);
    expect(isStagedToolResult("plain text")).toBe(false);
  });

  test("keeps ordinary result behavior unchanged", () => {
    const projected = projectToolResultForEvent("run_shell", "x".repeat(TOOL_RESULT_MAX_BYTES + 1));
    expect(projected.truncated).toBe(true);
    expect(projected.result).toContain("bytes truncated");
    expect(projected.result.slice(0, TOOL_RESULT_MAX_BYTES)).toBe("x".repeat(TOOL_RESULT_MAX_BYTES));
  });

  test("admits only a bounded strict DesktopShellResult for run_shell", () => {
    const shell = {
      version: 1,
      execution: "workstation",
      exitCode: 7,
      signal: null,
      timedOut: false,
      cancelled: false,
      durationMs: 12,
      stdout: "out",
      stderr: "err",
      stdoutTruncated: false,
      stderrTruncated: false,
      sideEffectsMayHaveStarted: true,
      profileRevision: null,
    };
    const valid = JSON.stringify(shell);
    expect(projectToolResultForEvent("run_shell", valid)).toEqual({ result: valid, truncated: false });

    const withArtifact = JSON.stringify({
      ...shell,
      outputArtifact: {
        version: 1,
        reference: "a".repeat(43),
        expiresAt: "2026-08-06T12:00:00.000Z",
        capturedBytes: 1024,
        totalBytes: 2048,
        truncated: true,
      },
    });
    expect(projectToolResultForEvent("run_shell", withArtifact)).toEqual({ result: withArtifact, truncated: false });

    const malformedArtifact = JSON.stringify({
      ...shell,
      stdout: "x".repeat(12 * 1024),
      outputArtifact: {
        version: 1,
        reference: "not an opaque reference",
        expiresAt: "2026-08-06T12:00:00.000Z",
        capturedBytes: 1024,
        totalBytes: 2048,
        truncated: true,
      },
    });
    expect(projectToolResultForEvent("run_shell", malformedArtifact).truncated).toBe(true);

    const wrongReferenceLength = JSON.stringify({
      ...shell,
      stdout: "x".repeat(12 * 1024),
      outputArtifact: {
        version: 1,
        reference: "a".repeat(42),
        expiresAt: "2026-08-06T12:00:00.000Z",
        capturedBytes: 1024,
        totalBytes: 2048,
        truncated: true,
      },
    });
    expect(projectToolResultForEvent("run_shell", wrongReferenceLength).truncated).toBe(true);

    const spoof = JSON.stringify({ ...shell, stdout: "x".repeat(70 * 1024) });
    const projectedSpoof = projectToolResultForEvent("run_shell", spoof);
    expect(projectedSpoof.truncated).toBe(true);
    expect(projectedSpoof.result.length).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES + 64);

    const extraField = JSON.stringify({ ...shell, stdout: "x".repeat(70 * 1024), untrusted: "x" });
    expect(projectToolResultForEvent("run_shell", extraField).truncated).toBe(true);
  });

  test("retains only a strict bounded run_shell output-artifact page", () => {
    const page = JSON.stringify({
      version: 1,
      reference: "b".repeat(43),
      stdout: "x".repeat(12 * 1024),
      stderr: "",
      offsetBytes: 0,
      nextOffsetBytes: 12 * 1024,
      capturedBytes: 32 * 1024,
      totalBytes: 64 * 1024,
      truncated: true,
      expiresAt: "2026-08-06T12:00:00.000Z",
      deleted: false,
    });
    expect(projectToolResultForEvent("run_shell", page)).toEqual({ result: page, truncated: false });

    const malformed = JSON.stringify({
      version: 1,
      reference: "b".repeat(43),
      stdout: "x".repeat(12 * 1024),
      stderr: "",
      offsetBytes: 0,
      nextOffsetBytes: 12 * 1024,
      capturedBytes: 32 * 1024,
      totalBytes: 64 * 1024,
      truncated: true,
      expiresAt: "2026-08-06T12:00:00.000Z",
      deleted: false,
      extra: true,
    });
    expect(projectToolResultForEvent("run_shell", malformed).truncated).toBe(true);

    const controlHeavy = JSON.stringify({
      version: 1,
      reference: "c".repeat(43),
      stdout: "\u0000".repeat(16 * 1024),
      stderr: "",
      offsetBytes: 0,
      nextOffsetBytes: null,
      capturedBytes: 16 * 1024,
      totalBytes: 16 * 1024,
      truncated: false,
      expiresAt: "2026-08-06T12:00:00.000Z",
      deleted: false,
    });
    expect(projectToolResultForEvent("run_shell", controlHeavy)).toEqual({
      result: controlHeavy,
      truncated: false,
    });
  });

  test("retains only a strict bounded run_shell output-artifact literal search", () => {
    const searchValue = {
      version: 1,
      operation: "search",
      reference: "d".repeat(43),
      matches: [{
        stream: "stderr",
        matchOffsetBytes: 4,
        artifactOffsetBytes: 36,
        matchBytes: 6,
        contextOffsetBytes: 0,
        context: "oops NEEDLE here",
      }],
      totalMatches: 1,
      matchesTruncated: false,
      capturedBytes: 64,
      totalBytes: 64,
      truncated: false,
      expiresAt: "2026-08-06T12:00:00.000Z",
    };
    const search = JSON.stringify(searchValue);
    expect(projectToolResultForEvent("run_shell", search)).toEqual({ result: search, truncated: false });

    const malformed = JSON.stringify({
      ...searchValue,
      matches: [{
        stream: "stderr",
        matchOffsetBytes: 4,
        artifactOffsetBytes: 36,
        matchBytes: 6,
        contextOffsetBytes: 0,
        context: "x".repeat(12 * 1024),
        extra: true,
      }],
    });
    expect(projectToolResultForEvent("run_shell", malformed).truncated).toBe(true);

    const escapedOverflow = JSON.stringify({
      ...searchValue,
      matches: [{
        stream: "stdout",
        matchOffsetBytes: 0,
        artifactOffsetBytes: 0,
        matchBytes: 1,
        contextOffsetBytes: 0,
        context: "\u0000".repeat(3 * 1024),
      }],
      capturedBytes: 3 * 1024,
      totalBytes: 3 * 1024,
    });
    expect(new TextEncoder().encode(escapedOverflow).byteLength).toBeGreaterThan(16 * 1024);
    expect(projectToolResultForEvent("run_shell", escapedOverflow).truncated).toBe(true);

    const largeValid = {
      ...searchValue,
      matches: [0, 3_000, 6_000, 9_000].map((offset) => ({
        stream: "stdout",
        matchOffsetBytes: offset,
        artifactOffsetBytes: offset,
        matchBytes: 1,
        contextOffsetBytes: offset,
        context: "x".repeat(3_000),
      })),
      totalMatches: 4,
      matchesTruncated: false,
      capturedBytes: 20_000,
      totalBytes: 20_000,
      truncated: false,
    };
    const largeValidResult = JSON.stringify(largeValid);
    expect(new TextEncoder().encode(largeValidResult).byteLength).toBeGreaterThan(TOOL_RESULT_MAX_BYTES);
    expect(projectToolResultForEvent("run_shell", largeValidResult)).toEqual({
      result: largeValidResult,
      truncated: false,
    });
    const strictViolations = [
      { matches: [{ ...largeValid.matches[0], matchBytes: 1_025 }, ...largeValid.matches.slice(1)] },
      { totalMatches: 20_001 },
      { matchesTruncated: true },
      { truncated: true },
      { matches: [{ ...largeValid.matches[0], artifactOffsetBytes: 1 }, ...largeValid.matches.slice(1)] },
    ];
    for (const violation of strictViolations) {
      const oversized = JSON.stringify({
        ...largeValid,
        ...violation,
      });
      expect(projectToolResultForEvent("run_shell", oversized).truncated).toBe(true);
    }
  });

  test("projects a large apply_patch result as valid bounded JSON with complete ordered items", () => {
    const source = applyPatchResult();
    const projected = projectToolResultForEvent("apply_patch", source);
    const value = parseProjection(projected.result);

    expect(new TextEncoder().encode(projected.result).byteLength).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
    expect(value.status).toBe("partial");
    expect(value.partial).toBe(true);
    expect(value.runtimeVersion).toBe("apply-patch-1");
    expect(value.turnId).toBe("turn-448");
    expect(value.operationCounts["update"]).toBe(80);
    expect(value.eventProjection.totalPaths).toBe(80);
    expect(value.eventProjection.shownPaths).toBe(value.pathResults.length);
    expect(value.eventProjection.totalChangedFiles).toBe(80);
    expect(value.eventProjection.shownChangedFiles).toBe(value.changedFiles.length);
    expect(value.eventProjection.totalDiffChars).toBeGreaterThan(0);
    expect(value.eventProjection.shownDiffChars).toBe(value.unifiedDiff.length);
    expect(value.eventProjection.truncated).toBe(true);
    expect(value.pathResults.map((result) => result.path)).toEqual(
      Array.from({ length: value.pathResults.length }, (_, index) => `src/very-long-file-name-${index}.ts`),
    );
    expect(value.changedFiles.map((result) => result.revisionId)).toEqual(
      Array.from({ length: value.changedFiles.length }, (_, index) => `revision-${index}`),
    );
    expect(value.revisionIds).toEqual(
      Array.from({ length: value.revisionIds.length }, (_, index) => `revision-${index}`),
    );
    expect(projected.truncated).toBe(true);
  });

  test("projects a large browser_read_page result as valid metadata plus a bounded content preview", () => {
    const content = "semantic page content ".repeat(3_000);
    const source = JSON.stringify({
      targetRole: "interactive",
      finalUrl: "https://example.test/article",
      title: "Large article",
      content,
      blocks: Array.from({ length: 80 }, (_, index) => ({ kind: "paragraph", text: `Block ${index}` })),
      totalCharacters: content.length,
      totalCharactersCapped: false,
      totalBytes: content.length,
      estimatedTokens: Math.ceil(content.length / 4),
      offsetCharacters: 0,
      nextOffsetCharacters: content.length,
      returnedCharacters: content.length,
      remainingCharacters: 0,
      eof: true,
      truncated: false,
      contextClamped: false,
      extraction: { method: "mozilla-readability-turndown-v1", root: "article", iframeCount: 0 },
      timing: { readiness: "complete" },
      quality: "complete",
      challenge: { detected: false, confidence: "none", signals: [] },
      failure: "none",
      diagnostics: [],
    });
    const projected = projectToolResultForEvent("browser_read_page", source);
    const value = JSON.parse(projected.result) as {
      title: string;
      returnedCharacters: number;
      content: string;
      blocks: unknown[];
      eventProjection: {
        kind: string;
        totalContentCharacters: number;
        shownContentCharacters: number;
        totalBlocks: number;
        shownBlocks: number;
        contentTruncated: boolean;
        blocksTruncated: boolean;
        truncated: boolean;
      };
    };

    expect(new TextEncoder().encode(projected.result).byteLength).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
    expect(projected.truncated).toBe(true);
    expect(value.title).toBe("Large article");
    expect(value.returnedCharacters).toBe(content.length);
    expect(value.content.length).toBeGreaterThan(0);
    expect(value.content.length).toBeLessThan(content.length);
    expect(value.blocks).toEqual([]);
    expect(value.eventProjection).toEqual({
      kind: "browser_read_page",
      totalContentCharacters: content.length,
      shownContentCharacters: value.content.length,
      totalBlocks: 80,
      shownBlocks: 0,
      contentTruncated: true,
      blocksTruncated: true,
      truncated: true,
    });
  });

  test("projects a large semantic Computer Use inventory as valid bounded JSON", () => {
    const opaque = "a".repeat(43);
    const targets = Array.from({ length: 100 }, (_, index) => ({
      target: { version: 1, context: `dctx_${opaque}`, reference: `dtgt_${String(index).padStart(3, "0")}${"b".repeat(40)}` },
      evidence: {
        kind: "window",
        appLabel: `Application ${index}`,
        windowLabel: `Window ${index} ${"x".repeat(120)}`,
        bounds: { x: index, y: index, width: 800, height: 600 },
      },
    }));
    const source = JSON.stringify({
      version: 1,
      ok: true,
      settlement: "completed",
      presentation: {
        label: "Observe native computer state",
        summary: "Observed native computer state.",
      },
      result: {
        kind: "observation",
        observation: {
          version: 1,
          operation: "desktop_state",
          context: `dctx_${opaque}`,
          completeness: "complete",
          counts: { discovered: 100, returned: 100, omitted: 0, uninspected: null },
          boundary: { kind: "none", retryable: false },
          continuation: null,
          alternatives: [
            { kind: "observe_again", available: true },
            { kind: "request_access", available: false },
            { kind: "focus_target", available: true },
          ],
          targets,
          applicationTargets: { counts: { discovered: 0, returned: 0, omitted: 0 }, targets: [] },
          screenSnapshot: null,
          outcome: {
            version: 1,
            phase: "observe",
            retrySafety: "safe",
            stateChangeCertainty: "not_applicable",
            providerCondition: "ready",
            targetCondition: "current",
            recovery: ["retry_same_request"],
          },
        },
      },
    });
    expect(new TextEncoder().encode(source).byteLength).toBeGreaterThan(TOOL_RESULT_MAX_BYTES);

    const projected = projectToolResultForEvent("computer_observe", source);
    const parsed = JSON.parse(projected.result) as Record<string, unknown>;
    expect(new TextEncoder().encode(projected.result).byteLength).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
    expect(projected.truncated).toBe(true);
    expect(parsed).toMatchObject({
      settlement: "completed",
      presentation: {
        label: "Observe native computer state",
        summary: "Observed native computer state.",
      },
      eventProjection: { kind: "computer_use", resultOmitted: true },
    });
    expect(parsed).not.toHaveProperty("result");
    expect(projected.result).not.toContain("bytes truncated");
  });

  test("does not seal an oversized Computer Use envelope with inconsistent outcome fields", () => {
    const oversizedResult = { padding: "x".repeat(TOOL_RESULT_MAX_BYTES * 2) };
    for (const envelope of [
      { version: 1, ok: true, settlement: "failed", presentation: { label: "Computer Use", summary: "Failed." }, result: oversizedResult },
      { version: 1, ok: false, settlement: "completed", presentation: { label: "Computer Use", summary: "Completed." }, result: oversizedResult },
      { version: 1, ok: false, settlement: "invented", presentation: { label: "Computer Use", summary: "Unknown." }, result: oversizedResult },
    ]) {
      const projected = projectToolResultForEvent("computer_observe", JSON.stringify(envelope));
      expect(projected.truncated).toBe(true);
      expect(() => { JSON.parse(projected.result); }).toThrow();
      expect(projected.result).not.toContain('"eventProjection":{"kind":"computer_use"');
    }
  });

  test("does not turn apply_patch into an unbounded staged-result bypass", () => {
    const projected = projectToolResultForEvent("apply_patch", applyPatchResult());
    expect(projected.result.length).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
    expect(projected.result).not.toBe(applyPatchResult());
  });

  test("retains required scalars and totals when a partial diagnostic exceeds the event budget", () => {
    const diagnostic = "diagnostic ".repeat(2_000);
    const source = JSON.stringify({
      status: "partial",
      partial: true,
      runtimeVersion: "apply-patch-1",
      turnId: "turn-448",
      operationCounts: { add: 0, update: 1, move: 0, delete: 0 },
      pathResults: [{
        operation: "update",
        path: "src/app.ts",
        status: "not_applied",
        revisionId: null,
        error: { code: "partial_execution", message: diagnostic, retryable: false },
      }],
      changedFiles: [],
      revisionIds: [],
      unifiedDiff: "",
      error: { code: "partial_execution", message: diagnostic, retryable: false },
    });

    const projected = projectToolResultForEvent("apply_patch", source);
    const value = parseProjection(projected.result);
    expect(new TextEncoder().encode(projected.result).byteLength).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
    expect(value.status).toBe("partial");
    expect(value.partial).toBe(true);
    expect(value.runtimeVersion).toBe("apply-patch-1");
    expect(value.turnId).toBe("turn-448");
    expect(value.operationCounts["update"]).toBe(1);
    expect(value.error).toEqual({ code: "partial_execution", retryable: false });
    expect(value.eventProjection.totalPaths).toBe(1);
    expect(value.eventProjection.totalChangedFiles).toBe(0);
    expect(value.eventProjection.totalDiffChars).toBe(0);
    expect(value.eventProjection.totalErrorMessageChars).toBe(diagnostic.length);
    expect(value.eventProjection.shownErrorMessageChars).toBe(0);
    expect(value.eventProjection.truncated).toBe(true);
  });
});
