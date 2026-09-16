import { describe, test, expect, beforeEach } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DiffView, UnifiedDiffBody } from "../../src/components/tool-card/renderers/diff-view";
import {
  hasRevertDispatcher,
  requestRevert,
  setRevertDispatcher,
} from "../../src/adapters/tool-invoke-ref";

const SAMPLE_STATS = { additions: 1, deletions: 1 };

describe("DiffView revert actions", () => {
  beforeEach(() => {
    setRevertDispatcher(null);
  });

  test("mode=applied renders Revert when path is present", () => {
    const html = renderToStaticMarkup(
      <DiffView
        unifiedDiff=""
        path="/tmp/x.md"
        stats={SAMPLE_STATS}
        revisionId="rev-1"
        zone="absolute"
        command="str_replace"
        mode="applied"
      />,
    );
    expect(html).toContain("diff-view-revert");
    expect(html).not.toContain("diff-view-accept");
    expect(html).not.toContain("diff-view-reject");
  });

  test("mode=historical renders no action button", () => {
    const html = renderToStaticMarkup(
      <DiffView
        unifiedDiff=""
        path="/tmp/x.md"
        stats={SAMPLE_STATS}
        mode="historical"
      />,
    );
    expect(html).toContain("diff-view-historical-badge");
    expect(html).not.toContain("diff-view-revert");
    expect(html).not.toContain("diff-view-accept");
  });

  test("requestRevert sends the deterministic revert message", () => {
    let sent: string | null = null;
    setRevertDispatcher((text) => {
      sent = text;
    });
    expect(hasRevertDispatcher()).toBe(true);

    requestRevert({
      revisionId: "rev-42",
      path: "/tmp/x.md",
      zone: "workspace",
      command: "write",
    });
    expect(sent).toBe(
      "Revert the write I just applied to /tmp/x.md (zone: workspace, revision: rev-42).",
    );
  });

  test("requestRevert omits optional zone and revision segments", () => {
    let sent: string | null = null;
    setRevertDispatcher((text) => {
      sent = text;
    });

    requestRevert({ path: "/tmp/y.md" });
    expect(sent).toBe("Revert the edit I just applied to /tmp/y.md.");
  });

  test("UnifiedDiffBody retains the shared line renderer for a selected complete section", () => {
    const html = renderToStaticMarkup(
      <UnifiedDiffBody unifiedDiff={"diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n"} />,
    );
    expect(html).toContain("text-tool-error");
    expect(html).toContain("text-tool-success");
    expect(html).toContain("new");
  });

  test("malformed historical diffs degrade to raw text instead of throwing", () => {
    const malformed = [
      "--- a/probe.txt",
      "+++ b/probe.txt",
      "@@ -0,0 +1,2 @@",
      "+STACK208_APPROVAL_PROBE",
      "(content changed: 0 → 23 bytes)",
    ].join("\n");

    const html = renderToStaticMarkup(
      <DiffView
        unifiedDiff={malformed}
        path="probe.txt"
        stats={{ additions: 1, deletions: 0 }}
        mode="historical"
      />,
    );

    expect(html).toContain("diff-view-raw-fallback");
    expect(html).toContain("Diff preview unavailable. Showing the raw change.");
    expect(html).toContain("content changed: 0 → 23 bytes");
    expect(html).toContain("diff-view-historical-badge");
  });
});
