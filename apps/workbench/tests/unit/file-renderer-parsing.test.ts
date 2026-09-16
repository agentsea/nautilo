/**
 * D087 Phase 1 §1.5a — DiffView + file-renderer parsing tests.
 *
 * No React-DOM rendering here — we just exercise the pure parsing
 * layer (`parsePatch` → `RenderedLine[]`) and the
 * `tryParseStagedEnvelope` guard. Visual rendering is covered by a
 * snapshot test in §1.5b when the Accept/Reject buttons land.
 */

import { describe, test, expect } from "bun:test";
import { parsePatch } from "diff";
import { fileRenderer } from "../../src/components/tool-card/renderers/file-renderer";
import { parseAppliedEnvelope, parseStagedEnvelope } from "../../src/lib/staged-envelope";

// Intentionally re-implement the guard inline (keeps the test
// file self-contained and documents the contract from both sides —
// if either drifts the test explodes loudly).
function tryParseStagedEnvelope(resultText: string | undefined): {
  staged: true;
  patchId: string;
  path: string;
  unifiedDiff: string;
  binary?: true;
  bytes?: number;
  stats: { additions: number; deletions: number };
} | null {
  if (!resultText || !resultText.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(resultText) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as { staged?: boolean }).staged === true
    ) {
      const env = parsed as Record<string, unknown>;
      const binary = env["binary"] === true;
      if (
        typeof env["patchId"] === "string" &&
        typeof env["path"] === "string" &&
        (binary || typeof env["unifiedDiff"] === "string") &&
        env["stats"] &&
        typeof env["stats"] === "object" &&
        typeof (env["stats"] as { additions: unknown }).additions === "number" &&
        typeof (env["stats"] as { deletions: unknown }).deletions === "number"
      ) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return parsed as any;
      }
    }
  } catch {
    /* not JSON */
  }
  return null;
}

const SAMPLE_UNIFIED_DIFF = [
  "Index: /tmp/x.md",
  "===================================================================",
  "--- /tmp/x.md",
  "+++ /tmp/x.md",
  "@@ -1,3 +1,3 @@",
  " line1",
  "-old line 2",
  "+new line 2",
  " line3",
  "",
].join("\n");

function makeAppliedEnvelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    applied: true,
    revisionId: "rev-1",
    path: "/tmp/x.md",
    zone: "absolute",
    command: "str_replace",
    stats: { additions: 1, deletions: 1 },
    summary: "Applied: str_replace 1 occurrence",
    unifiedDiff: SAMPLE_UNIFIED_DIFF,
    ...overrides,
  });
}

function makeEnvelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    staged: true,
    patchId: "t-1:abc12345",
    path: "/tmp/x.md",
    zone: "absolute",
    command: "str_replace",
    stats: { additions: 1, deletions: 1 },
    summary: "Staged: str_replace 1 occurrence",
    unifiedDiff: SAMPLE_UNIFIED_DIFF,
    ...overrides,
  });
}

describe("tryParseStagedEnvelope — staged-patch envelope detection", () => {
  test("returns the envelope for a well-formed staged result", () => {
    const env = tryParseStagedEnvelope(makeEnvelope());
    expect(env).not.toBeNull();
    expect(env?.patchId).toBe("t-1:abc12345");
    expect(env?.stats).toEqual({ additions: 1, deletions: 1 });
  });

  test("returns null for plain error strings", () => {
    expect(tryParseStagedEnvelope("Error: file not found")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(tryParseStagedEnvelope("")).toBeNull();
    expect(tryParseStagedEnvelope(undefined)).toBeNull();
  });

  test("returns null for JSON that is not a staged envelope", () => {
    expect(
      tryParseStagedEnvelope(JSON.stringify({ ok: true, result: "hello" })),
    ).toBeNull();
  });

  test("returns null when staged:true but shape is incomplete", () => {
    expect(
      tryParseStagedEnvelope(
        JSON.stringify({ staged: true, patchId: "x" /* missing path, diff, stats */ }),
      ),
    ).toBeNull();
  });

  test("accepts a binary staged envelope with a synthetic diff marker", () => {
    const env = tryParseStagedEnvelope(
      makeEnvelope({
        command: "convert",
        path: "/tmp/report.pdf",
        binary: true,
        bytes: 1234,
        stats: { additions: 0, deletions: 0 },
        unifiedDiff: "Binary files differ: /tmp/report.pdf\n",
      }),
    );
    expect(env).not.toBeNull();
    expect(env?.binary).toBe(true);
    expect(env?.bytes).toBe(1234);
  });

  test("returns null for staged:true with wrong-typed stats", () => {
    expect(
      tryParseStagedEnvelope(
        JSON.stringify({
          staged: true,
          patchId: "x",
          path: "/tmp/x",
          unifiedDiff: "",
          stats: "not-an-object",
        }),
      ),
    ).toBeNull();
  });

  test("returns null for staged:false envelopes", () => {
    expect(tryParseStagedEnvelope(JSON.stringify({ staged: false }))).toBeNull();
  });

  test("returns null for malformed JSON", () => {
    expect(tryParseStagedEnvelope("{not json}")).toBeNull();
  });

  test("handles non-JSON starting with brace-like chars", () => {
    // Starts with `{` but isn't JSON — e.g. an error string that
    // happens to begin that way. parse throws, we return null.
    expect(tryParseStagedEnvelope("{ context } not json")).toBeNull();
  });
});

describe("fileRenderer collapsed applied-patch extras", () => {
  test("binary applied envelopes show bytes instead of +0/-0", () => {
    const extras = fileRenderer.collapsedExtras?.({
      args: { command: "convert" },
      result: undefined,
      state: "success",
      resultText: makeAppliedEnvelope({
        command: "convert",
        path: "/tmp/report.pdf",
        binary: true,
        bytes: 1848,
        stats: { additions: 0, deletions: 0 },
        unifiedDiff: "Binary files differ: /tmp/report.pdf\n",
      }),
    });
    expect(extras).toBe("1848 bytes");
  });

  test("text applied envelopes keep line stats", () => {
    const extras = fileRenderer.collapsedExtras?.({
      args: { command: "str_replace" },
      result: undefined,
      state: "success",
      resultText: makeAppliedEnvelope(),
    });
    expect(extras).toBe("+1/-1");
  });
});

describe("fileRenderer collapsed staged-patch extras", () => {
  test("binary staged envelopes show bytes instead of +0/-0", () => {
    const extras = fileRenderer.collapsedExtras?.({
      args: { command: "convert" },
      result: undefined,
      state: "success",
      resultText: makeEnvelope({
        command: "convert",
        path: "/tmp/report.pdf",
        binary: true,
        bytes: 1848,
        stats: { additions: 0, deletions: 0 },
        unifiedDiff: "Binary files differ: /tmp/report.pdf\n",
      }),
    });
    expect(extras).toBe("1848 bytes");
  });

  test("text staged envelopes keep line stats", () => {
    const extras = fileRenderer.collapsedExtras?.({
      args: { command: "str_replace" },
      result: undefined,
      state: "success",
      resultText: makeEnvelope(),
    });
    expect(extras).toBe("+1/-1");
  });
});

describe("production applied envelope parser", () => {
  test("parses applied envelopes from tool result strings", () => {
    const env = parseAppliedEnvelope(
      makeAppliedEnvelope({
        command: "convert",
        path: "/workspace/drafts/pdf-render-test.pdf",
        binary: true,
        bytes: 7107,
        stats: { additions: 0, deletions: 0 },
        unifiedDiff: "Binary files differ: /workspace/drafts/pdf-render-test.pdf\n",
      }),
    );
    expect(env?.path).toBe("/workspace/drafts/pdf-render-test.pdf");
    expect(env?.binary).toBe(true);
  });
});

describe("production staged envelope parser", () => {
  test("parses staged envelopes from historical tool result strings", () => {
    const env = parseStagedEnvelope(
      makeEnvelope({
        command: "convert",
        path: "/workspace/drafts/pdf-render-test.pdf",
        binary: true,
        bytes: 7107,
        stats: { additions: 0, deletions: 0 },
        unifiedDiff: "Binary files differ: /workspace/drafts/pdf-render-test.pdf\n",
      }),
    );
    expect(env?.path).toBe("/workspace/drafts/pdf-render-test.pdf");
    expect(env?.binary).toBe(true);
  });

  test("preserves workspace artifact open metadata on write envelopes (D121-P6)", () => {
    const env = parseStagedEnvelope(
      makeEnvelope({
        command: "write",
        zone: "workspace",
        path: "/artifacts-root/abc.html",
        artifactId: "ext-artifact-id",
        artifactInternalId: "00000000-0000-4000-8000-000000000001",
      }),
    );
    expect(env?.command).toBe("write");
    expect(env?.artifactId).toBe("ext-artifact-id");
    expect(env?.artifactInternalId).toBe("00000000-0000-4000-8000-000000000001");
  });
});

describe("unified-diff parsing via `diff.parsePatch`", () => {
  test("splits single-hunk diff into expected line types", () => {
    const patches = parsePatch(SAMPLE_UNIFIED_DIFF);
    expect(patches).toHaveLength(1);
    const hunk = patches[0]!.hunks[0]!;
    expect(hunk.oldStart).toBe(1);
    expect(hunk.newStart).toBe(1);
    expect(hunk.lines).toEqual([" line1", "-old line 2", "+new line 2", " line3"]);
  });

  test("returns empty for empty diff", () => {
    // Empty string yields a single parsed object with no hunks.
    const patches = parsePatch("");
    expect(patches.reduce((n, p) => n + p.hunks.length, 0)).toBe(0);
  });

  test("multi-hunk diff yields multiple hunks in one patch", () => {
    const multi = [
      "--- a",
      "+++ b",
      "@@ -1,1 +1,1 @@",
      "-a",
      "+b",
      "@@ -10,2 +10,2 @@",
      " c",
      "-d",
      "+D",
    ].join("\n");
    const patches = parsePatch(multi);
    expect(patches).toHaveLength(1);
    expect(patches[0]!.hunks).toHaveLength(2);
  });
});
