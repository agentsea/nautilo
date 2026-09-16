import { describe, test, expect } from "bun:test";
import {
  boundDiffPreview,
  DIFF_PREVIEW_MAX_BYTES,
} from "../../src/tools/file/commands/_shared";

describe("boundDiffPreview (D268 graceful degradation)", () => {
  test("passes through diffs at or under the preview limit unchanged", () => {
    const diff = "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n";
    const out = boundDiffPreview(diff, "Staged: write");
    expect(out.omitted).toBe(false);
    expect(out.unifiedDiff).toBe(diff);
    expect(out.summary).toBe("Staged: write");
  });

  test("exactly at the limit is NOT omitted (boundary)", () => {
    const diff = "x".repeat(DIFF_PREVIEW_MAX_BYTES);
    const out = boundDiffPreview(diff, "Staged: write");
    expect(out.omitted).toBe(false);
    expect(out.unifiedDiff.length).toBe(DIFF_PREVIEW_MAX_BYTES);
  });

  test("over the limit drops the preview without truncating (graceful)", () => {
    const diff = "x".repeat(DIFF_PREVIEW_MAX_BYTES + 1);
    const out = boundDiffPreview(diff, "Staged: write");
    expect(out.omitted).toBe(true);
    expect(out.unifiedDiff.length).toBeLessThan(500);
    expect(out.unifiedDiff).toContain("preview omitted");
    expect(out.unifiedDiff).not.toContain("xxxxx");
    expect(out.summary).toContain("inline preview omitted");
  });

  test("the bounded envelope stays valid JSON (the original bug was corrupted JSON)", () => {
    const diff = "x".repeat(DIFF_PREVIEW_MAX_BYTES + 1024);
    const out = boundDiffPreview(diff, "Staged: write");
    const envelope = {
      applied: true as const,
      path: "/tmp/big.html",
      stats: { additions: 99999, deletions: 0 },
      summary: out.summary,
      unifiedDiff: out.unifiedDiff,
      ...(out.omitted ? { diffPreviewOmitted: true as const } : {}),
    };
    const serialized = JSON.stringify(envelope);
    const reparsed = JSON.parse(serialized) as typeof envelope;
    expect(reparsed.applied).toBe(true);
    expect(reparsed.diffPreviewOmitted).toBe(true);
    expect(reparsed.stats.additions).toBe(99999);
  });
});
