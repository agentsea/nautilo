/**
 * D083 Phase 1 — unit tests for the ToolCard pure helpers.
 *
 * Matches the workbench convention (see cited-paths.test.ts):
 * bun:test against pure modules only. The React component itself
 * is live-verified in Electron; these tests cover the state
 * machine, glyph mapping, duration format, args summary, and
 * aria-label shape.
 */

import { describe, test, expect } from "bun:test";
import {
  deriveCardState,
  glyphFor,
  shouldRenderSpinner,
  stateLabelFor,
  formatDuration,
  computeElapsedMs,
  argsSummary,
  cardAriaLabel,
  type ToolCardState,
} from "../../src/components/tool-card/tool-card-helpers";
import type { ToolActivityEvent } from "../../src/adapters/runtime-contexts";

// ---------------------------------------------------------------------------
// deriveCardState — the 5-state state machine
// ---------------------------------------------------------------------------

describe("deriveCardState (D083)", () => {
  test("error event status wins over any uiStatus", () => {
    expect(deriveCardState({
      uiStatus: { type: "complete" },
      event: mkEvent({ status: "error" }),
    })).toBe("error");
  });

  test("isError hint maps to error even with no event", () => {
    expect(deriveCardState({
      uiStatus: { type: "complete" },
      isError: true,
    })).toBe("error");
  });

  test("canonical OfficeCLI contract rejection overrides an ok lifecycle", () => {
    expect(deriveCardState({
      uiStatus: { type: "complete" },
      event: mkEvent({ status: "ok" }),
      resultText: "Error: `data` is merge-only; use `commands` when creating a document.",
    })).toBe("error");
  });

  test("event.ok → success", () => {
    expect(deriveCardState({
      uiStatus: { type: "complete" },
      event: mkEvent({ status: "ok" }),
    })).toBe("success");
  });

  test("canonical cancellation wins over a successful transport envelope", () => {
    expect(deriveCardState({
      uiStatus: { type: "complete" },
      event: mkEvent({ status: "ok" }),
      resultText: JSON.stringify({ version: 1, cancelled: true, signal: "SIGKILL" }),
    })).toBe("cancelled");
  });

  test("uiStatus.complete alone → success (no event yet)", () => {
    expect(deriveCardState({ uiStatus: { type: "complete" } })).toBe("success");
  });

  test("uiStatus.running → running", () => {
    expect(deriveCardState({ uiStatus: { type: "running" } })).toBe("running");
  });

  test("uiStatus.requires-action → running (assistant-UI shape for tools-in-flight)", () => {
    expect(deriveCardState({ uiStatus: { type: "requires-action" } })).toBe("running");
  });

  test("event.running alone → running even if uiStatus is unknown", () => {
    expect(deriveCardState({
      uiStatus: { type: "unknown-future-status" },
      event: mkEvent({ status: "running" }),
    })).toBe("running");
  });

  test("canonical event.running wins over graph-leg uiStatus.complete", () => {
    expect(deriveCardState({
      uiStatus: { type: "complete" },
      event: mkEvent({ status: "running" }),
    })).toBe("running");
  });

  test("default fallback → pending", () => {
    expect(deriveCardState({ uiStatus: { type: "unknown" } })).toBe("pending");
  });

  test("error wins over running (edge: in-flight then failed)", () => {
    expect(deriveCardState({
      uiStatus: { type: "running" },
      event: mkEvent({ status: "error" }),
    })).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Glyphs — one per state, per the issue-doc chart
// ---------------------------------------------------------------------------

describe("glyphFor (D083)", () => {
  test("maps every state to a stable glyph", () => {
    expect(glyphFor("pending")).toBe("◌");
    expect(glyphFor("running")).toBe("●");
    expect(glyphFor("success")).toBe("✓");
    expect(glyphFor("cancelled")).toBe("■");
    expect(glyphFor("error")).toBe("✗");
    expect(glyphFor("blocked")).toBe("⊘");
  });

  test("every ToolCardState value is covered (exhaustiveness)", () => {
    const allStates: ToolCardState[] = [
      "pending",
      "running",
      "success",
      "cancelled",
      "error",
      "blocked",
    ];
    for (const s of allStates) {
      expect(glyphFor(s).length).toBeGreaterThan(0);
    }
  });
});

describe("shouldRenderSpinner (D113A)", () => {
  test("running returns true", () => {
    expect(shouldRenderSpinner("running")).toBe(true);
  });

  test("every other state returns false", () => {
    for (const s of ["pending", "paused", "awaiting", "success", "cancelled", "error", "blocked"] as const) {
      expect(shouldRenderSpinner(s)).toBe(false);
    }
  });

  test('glyphFor("running") still returns "●" — the helper does not change the glyph table', () => {
    expect(glyphFor("running")).toBe("●");
  });
});

// ---------------------------------------------------------------------------
// stateLabelFor — screen-reader labels
// ---------------------------------------------------------------------------

describe("stateLabelFor (D083)", () => {
  test("every state has a human-readable label", () => {
    expect(stateLabelFor("pending")).toBe("pending");
    expect(stateLabelFor("running")).toBe("running");
    expect(stateLabelFor("paused")).toBe("paused");
    expect(stateLabelFor("awaiting")).toBe("awaiting reply");
    expect(stateLabelFor("success")).toBe("succeeded");
    expect(stateLabelFor("cancelled")).toBe("cancelled");
    expect(stateLabelFor("error")).toBe("errored");
    expect(stateLabelFor("blocked")).toBe("blocked");
  });
});

// ---------------------------------------------------------------------------
// formatDuration — Cursor-style compact display
// ---------------------------------------------------------------------------

describe("formatDuration (D083)", () => {
  test("sub-second rendered in ms", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(350)).toBe("350ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  test("seconds rendered with one decimal", () => {
    expect(formatDuration(1234)).toBe("1.2s");
    expect(formatDuration(2345)).toBe("2.3s");
    expect(formatDuration(10_500)).toBe("10.5s");
  });

  test("whole-second values don't show dangling .0", () => {
    expect(formatDuration(2000)).toBe("2s");
    expect(formatDuration(5000)).toBe("5s");
  });

  test("minute+ rendered in m s", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(90_500)).toBe("1m 30s");
    expect(formatDuration(3_600_000)).toBe("60m 0s");
  });

  test("negative or NaN returns empty string", () => {
    expect(formatDuration(-1)).toBe("");
    expect(formatDuration(Number.NaN)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// computeElapsedMs — live ticker for running cards
// ---------------------------------------------------------------------------

describe("computeElapsedMs (D083)", () => {
  test("pending → null", () => {
    const e = mkEvent({ status: "running", startedAt: 1000 });
    expect(computeElapsedMs(e, 5000, "pending")).toBe(null);
  });

  test("no event → null", () => {
    expect(computeElapsedMs(undefined, 5000, "running")).toBe(null);
  });

  test("running + live wall-clock = now - startedAt", () => {
    const e = mkEvent({ status: "running", startedAt: 1000 });
    expect(computeElapsedMs(e, 3500, "running")).toBe(2500);
  });

  test("ended event returns final duration regardless of now", () => {
    const e = mkEvent({ status: "ok", startedAt: 1000, endedAt: 3200 });
    expect(computeElapsedMs(e, 999_999_999, "success")).toBe(2200);
  });

  test("endedAt takes priority over state=running (defensive — if a card is mid-re-render during state transition)", () => {
    const e = mkEvent({ status: "ok", startedAt: 1000, endedAt: 3500 });
    expect(computeElapsedMs(e, 999_999_999, "running")).toBe(2500);
  });
});

// ---------------------------------------------------------------------------
// argsSummary — one-liner summary for the collapsed card
// ---------------------------------------------------------------------------

describe("argsSummary (D083)", () => {
  test("prefers command for shell-like tools", () => {
    expect(argsSummary({ command: "brew install jq" })).toBe("brew install jq");
    expect(argsSummary({ cmd: "ls -la" })).toBe("ls -la");
  });

  test("prefers path for file tools", () => {
    expect(argsSummary({ path: "/tmp/notes.md" })).toBe("/tmp/notes.md");
    expect(argsSummary({ file: "README.md" })).toBe("README.md");
  });

  test("prefers query for search tools", () => {
    expect(argsSummary({ query: "ToolCard" })).toBe("ToolCard");
    expect(argsSummary({ pattern: "foo.*bar" })).toBe("foo.*bar");
  });

  test("command wins over path when both exist (preference order)", () => {
    expect(argsSummary({ path: "/x", command: "cat /x" })).toBe("cat /x");
  });

  test("falls back to first string-valued arg", () => {
    expect(argsSummary({ unknownKey: "hello world" })).toBe("hello world");
  });

  test("skips credential redaction markers and keeps the next useful intent", () => {
    expect(argsSummary({
      sessionToken: "[redacted]",
      cursor: "page:2",
    })).toBe("page:2");
    expect(argsSummary({
      sessionToken: "[REDACTED TOOL ARG]",
    })).toBe("");
  });

  test("falls back to a non-null primitive", () => {
    expect(argsSummary({ count: 42 })).toBe("42");
    expect(argsSummary({ enabled: true })).toBe("true");
  });

  test("truncates long values with ellipsis", () => {
    const long = "a".repeat(80);
    const out = argsSummary({ command: long }, 20);
    expect(out).toBe("aaaaaaaaaaaaaaaaaaa…");
    expect(out.length).toBe(20);
  });

  test("returns empty string for empty / object-only args", () => {
    expect(argsSummary({})).toBe("");
    expect(argsSummary({ nested: { a: 1 } })).toBe("");
    expect(argsSummary({ nullish: null, undef: undefined })).toBe("");
  });
});

// ---------------------------------------------------------------------------
// cardAriaLabel — screen-reader-friendly composite label
// ---------------------------------------------------------------------------

describe("cardAriaLabel (D083)", () => {
  test("success with duration", () => {
    expect(cardAriaLabel({
      toolName: "run_shell",
      state: "success",
      summary: "brew install jq",
      durationMs: 2300,
    })).toBe("run_shell succeeded — brew install jq in 2.3s");
  });

  test("running without duration yet", () => {
    expect(cardAriaLabel({
      toolName: "grep",
      state: "running",
      summary: "'ToolCard'",
      durationMs: null,
    })).toBe("grep running — 'ToolCard'");
  });

  test("error includes state label", () => {
    expect(cardAriaLabel({
      toolName: "file",
      state: "error",
      summary: "/tmp/x.md",
      durationMs: 120,
    })).toBe("file errored — /tmp/x.md in 120ms");
  });

  test("empty summary is omitted from the label", () => {
    expect(cardAriaLabel({
      toolName: "unknown_tool",
      state: "pending",
      summary: "",
      durationMs: null,
    })).toBe("unknown_tool pending");
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkEvent(partial: Partial<ToolActivityEvent> & { status: ToolActivityEvent["status"] }): ToolActivityEvent {
  return {
    toolCallId: partial.toolCallId ?? "tc-1",
    toolName: partial.toolName ?? "test_tool",
    args: partial.args ?? {},
    status: partial.status,
    startedAt: partial.startedAt ?? 1000,
    ...(partial.endedAt !== undefined ? { endedAt: partial.endedAt } : {}),
    ...(partial.error !== undefined ? { error: partial.error } : {}),
  };
}
