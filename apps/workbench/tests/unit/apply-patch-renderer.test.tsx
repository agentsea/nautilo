import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { applyPatchRenderer } from "../../src/components/tool-card/renderers/apply-patch";
import type { ToolRendererProps } from "../../src/components/tool-card/renderers/types";

function projected(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    status: "applied",
    partial: false,
    turnId: "turn-448",
    operationCounts: { add: 1, update: 0, move: 1, delete: 1 },
    pathResults: [
      { operation: "add", path: "src/new.ts", status: "applied", revisionId: "rev-new" },
      { operation: "move", fromPath: "src/old.ts", path: "src/moved.ts", status: "applied", revisionId: "rev-move" },
      { operation: "delete", path: "src/remove.ts", status: "applied", revisionId: "rev-delete" },
    ],
    unifiedDiff: [
      "diff --git a/src/new.ts b/src/new.ts\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+new\n",
      "diff --git a/src/old.ts b/src/moved.ts\n--- a/src/old.ts\n+++ b/src/moved.ts\n@@ -1 +1 @@\n-old\n+new\n",
    ].join(""),
    eventProjection: {
      kind: "apply_patch",
      totalPaths: 3,
      shownPaths: 3,
      totalChangedFiles: 3,
      shownChangedFiles: 3,
      totalDiffChars: 170,
      shownDiffChars: 170,
      totalErrorMessageChars: 0,
      shownErrorMessageChars: 0,
      scalarFieldsTruncated: false,
      truncated: false,
    },
    ...overrides,
  });
}

function render(
  resultText: string,
  resultTruncated = false,
  args: Record<string, unknown> = { patch: "*** Begin Patch\nDO NOT RENDER RAW PATCH\n*** End Patch" },
): string {
  const Body = applyPatchRenderer.ExpandedBody;
  const props: ToolRendererProps = {
    args,
    result: undefined,
    state: "success",
    event: undefined,
    resultText,
    resultTruncated,
  };
  return renderToStaticMarkup(<Body {...props} />);
}

describe("apply_patch Workbench renderer", () => {
  test("renders a bounded external-harness patch summary without inventing native projection data", () => {
    const result = "File changes completed\nadd /workspace/.codex-harness-acceptance.txt";
    const html = render(result);
    const summary = applyPatchRenderer.collapsedSummary!({
      args: {},
      result: undefined,
      state: "success",
      resultText: result,
    });

    expect(html).toContain("File changes completed");
    expect(html).toContain("add /workspace/.codex-harness-acceptance.txt");
    expect(html).not.toContain("unavailable for structured display");
    expect(html).not.toContain("Revert entire patch");
    expect(summary).toBe("File changes completed");
  });

  test("renders a structured failed result even when no operation counts exist", () => {
    const failed = JSON.stringify({
      ok: false,
      error: {
        code: "denied_path",
        message: "The Desktop Filesystem Grant no longer matches the selected folder.",
        retryable: false,
      },
      pathResults: [],
      changedFiles: [],
      revisionIds: [],
      unifiedDiff: "",
      eventProjection: {
        kind: "apply_patch",
        totalPaths: 0,
        shownPaths: 0,
        totalChangedFiles: 0,
        shownChangedFiles: 0,
        totalDiffChars: 0,
        shownDiffChars: 0,
        totalErrorMessageChars: 65,
        shownErrorMessageChars: 65,
        scalarFieldsTruncated: false,
        truncated: false,
      },
    });

    const html = render(failed, false, { target: "current" });
    const summary = applyPatchRenderer.collapsedSummary!({
      args: { target: "current" },
      result: undefined,
      state: "error",
      resultText: failed,
    });

    expect(html).toContain("Apply patch failed");
    expect(html).toContain("denied_path");
    expect(html).toContain("no longer matches the selected folder");
    expect(html).not.toContain("unavailable for structured display");
    expect(summary).toBe("FAILED — denied_path · Current Folder");
  });

  test("shows the requested target in collapsed summaries without inferring an omitted selector", () => {
    const summary = applyPatchRenderer.collapsedSummary!({
      args: { target: "workspace" },
      result: undefined,
      state: "success",
      resultText: projected(),
    });
    const partialSummary = applyPatchRenderer.collapsedSummary!({
      args: { target: "current" },
      result: undefined,
      state: "success",
      resultText: projected({
        status: "partial",
        partial: true,
        operationCounts: { add: 0, update: 1, move: 0, delete: 0 },
        pathResults: [
          { operation: "update", path: "src/applied.ts", status: "applied", revisionId: "rev-applied" },
          { operation: "move", fromPath: "src/from.ts", path: "src/to.ts", status: "not_applied", revisionId: null, error: { message: "not attempted" } },
          { operation: "delete", path: "src/later.ts", status: "not_applied", revisionId: null, error: { message: "not attempted" } },
        ],
      }),
    });
    const automaticSummary = applyPatchRenderer.collapsedSummary!({
      args: {},
      result: undefined,
      state: "success",
      resultText: projected(),
    });
    expect(summary).toBe("3/3 applied · Workspace");
    expect(partialSummary).toBe("PARTIAL — 1/3 applied · Current Folder");
    expect(automaticSummary).toBe("3/3 applied · Automatic target");
  });

  test("renders complete ordered add, move, and delete rows with whole-file navigation", () => {
    const html = render(projected(), false, {
      patch: "*** Begin Patch\nDO NOT RENDER RAW PATCH\n*** End Patch",
      target: "workspace",
    });
    expect(html).toContain("Requested target:");
    expect(html).toContain("Workspace");
    expect(html).toContain("3 total paths");
    expect(html).toContain("Add src/new.ts");
    expect(html).toContain("Move src/old.ts → src/moved.ts");
    expect(html).toContain("Delete src/remove.ts");
    expect(html).toContain("revision rev-move");
    expect(html).toContain("apply-patch-diff-navigation");
    expect(html.match(/apply-patch-diff-tab/g)?.length).toBe(2);
    expect(html).toContain("Revert entire patch");
    expect(html).not.toContain("DO NOT RENDER RAW PATCH");
  });

  test("labels an omitted selector as automatic rather than claiming a resolved target", () => {
    const html = render(projected());
    expect(html).toContain("Requested target:");
    expect(html).toContain("Automatic target");
    expect(html).not.toContain("Resolved target");
  });

  test("shows a partial result as a warning with unknown diagnostics, not a generic failure", () => {
    const html = render(projected({
      status: "partial",
      partial: true,
      pathResults: [
        { operation: "update", path: "src/applied.ts", status: "applied", revisionId: "rev-applied" },
        { operation: "move", fromPath: "src/from.ts", path: "src/to.ts", status: "unknown", revisionId: null, error: { message: "connection ended during commit" } },
        { operation: "delete", path: "src/later.ts", status: "not_applied", revisionId: null, error: { message: "not attempted" } },
      ],
      operationCounts: { add: 0, update: 1, move: 0, delete: 0 },
      error: { message: "one operation was not applied" },
    }));
    expect(html).toContain("apply-patch-partial-warning");
    expect(html).toContain("Partially applied.");
    expect(html).toContain("Unknown outcome: connection ended during commit");
    expect(html).toContain("not applied");
    expect(html).toContain("Revert entire patch");
  });

  test("makes projection truncation explicit and does not offer recovery with a truncated turn id", () => {
    const html = render(projected({
      turnId: "truncated-turn",
      eventProjection: {
        kind: "apply_patch",
        totalPaths: 9,
        shownPaths: 3,
        totalChangedFiles: 9,
        shownChangedFiles: 3,
        totalDiffChars: 900,
        shownDiffChars: 170,
        totalErrorMessageChars: 200,
        shownErrorMessageChars: 0,
        scalarFieldsTruncated: true,
        truncated: true,
      },
      operationCounts: { add: 0, update: 8, move: 0, delete: 0 },
    }), true);
    expect(html).toContain("apply-patch-projection-banner");
    expect(html).toContain("Showing 3 of 9 path results");
    expect(html).toContain("8 applied");
    expect(html).toContain("shown: 3 applied");
    expect(html).toContain("whole-turn recovery is unavailable");
    expect(html).not.toContain("apply-patch-undo-turn");
  });

  test("omits recovery when no trusted turn id is present", () => {
    const html = render(projected({ turnId: undefined }));
    expect(html).not.toContain("apply-patch-undo-turn");
  });
});
