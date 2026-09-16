/// <reference types="bun-types" />

import { describe, expect, mock, test } from "bun:test";

mock.module("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Pressable: "Pressable",
  StyleSheet: { create: <T,>(styles: T): T => styles },
  Text: "Text",
  View: "View",
}));
mock.module("@/providers/theme", () => ({
  useAppTheme: () => ({}),
}));

const { mobileToolCardResultText, taskTranscriptDetailsVisible, taskTranscriptToolState } = await import("./tool-card");

const GUIDE_FALLBACK = "Use Connections then SSH to continue.";
const RECOVERY_TEXT = "Ask the authorized Human to enter the SSH PIN, then retry.";

function recovery(name: string) {
  return {
    version: 1,
    text: RECOVERY_TEXT,
    recovery: {
      target: "connections.ssh",
      requirement: "pin",
      domainTool: name,
    },
  };
}

describe("mobile guidance tool fallback", () => {
  test("renders strict guide_user fallback text without an action, route, or JSON", () => {
    const result = mobileToolCardResultText("guide_user", JSON.stringify({
      version: 1,
      kind: "guidance",
      actionId: "guide-mobile",
      target: "connections.ssh",
      presentation: "reveal",
      fallbackText: GUIDE_FALLBACK,
    }));
    expect(result).toBe(GUIDE_FALLBACK);
    expect(result).not.toMatch(/\/connections|ui\.action|\{/i);
  });

  test("keeps discovery and malformed guide results inert and readable", () => {
    expect(mobileToolCardResultText("guide_user", JSON.stringify({
      version: 1,
      kind: "discovery",
      targets: [],
    }))).toBe("Use the visible Nautilo menus to continue.");
    expect(mobileToolCardResultText("guide_user", '{"target":"/connections#ssh"}'))
      .toBe("Use the visible Nautilo menus to continue.");
  });

  test("deduplicates a strict discover_tools SSH recovery array into its readable text", () => {
    expect(mobileToolCardResultText("discover_tools", JSON.stringify([
      { name: "structured_ssh_auth", recovery: recovery("structured_ssh_auth") },
      { name: "structured_ssh_auth", recovery: recovery("structured_ssh_auth") },
      { name: "structured_ssh_exec", recovery: recovery("structured_ssh_exec") },
    ]))).toBe(RECOVERY_TEXT);
  });

  test("renders a strict direct recovery result as its bounded readable text", () => {
    expect(mobileToolCardResultText("google_workspace", JSON.stringify({
      version: 1,
      text: "Sign in on the authorized Desktop, then retry.",
      recovery: {
        target: "connections.google",
        requirement: "login",
        domainTool: "google_workspace",
      },
    }))).toBe("Sign in on the authorized Desktop, then retry.");
  });

  test("never exposes malformed recovery JSON, opaque action tokens, or routes", () => {
    for (const result of [
      JSON.stringify([{ name: "structured_ssh_auth", recovery: { target: "connections.ssh" } }]),
      "LEGACY_ACTION:google_auth_required",
      "[Open SSH](/connections#ssh)",
    ]) {
      const toolName = result.startsWith("[") ? "discover_tools" : "google_workspace";
      expect(mobileToolCardResultText(toolName, result))
        .toBe("Use the visible Nautilo menus to continue.");
    }
  });

  test("preserves ordinary non-guidance tool output", () => {
    expect(mobileToolCardResultText("read_file", "Read 24 lines from notes.md."))
      .toBe("Read 24 lines from notes.md.");
    expect(mobileToolCardResultText("google_workspace", "Error:failed to refresh the connection."))
      .toBe("Error:failed to refresh the connection.");
    expect(mobileToolCardResultText("google_workspace", "ERR:network is unavailable."))
      .toBe("ERR:network is unavailable.");
  });
});

describe("Task transcript ToolCard state", () => {
  test("uses explicit provider-neutral live labels and durable receipt labels", () => {
    expect(taskTranscriptToolState("running", undefined)).toEqual({ label: "Working", tone: "muted" });
    expect(taskTranscriptToolState("completed", undefined)).toEqual({ label: "Completed", tone: "muted" });
    expect(taskTranscriptToolState("failed", "receipt")).toEqual({ label: "Failed", tone: "error" });
    expect(taskTranscriptToolState("waiting", undefined)).toEqual({ label: "Waiting", tone: "warning" });
    expect(taskTranscriptToolState(undefined, "receipt")).toEqual({ label: "Recorded", tone: "muted" });
    expect(taskTranscriptToolState(undefined, undefined)).toEqual({ label: "Result unavailable", tone: "muted" });
  });

  test("keeps Task tool args/results collapsed until its accessible disclosure opens", async () => {
    expect(taskTranscriptDetailsVisible(false, true)).toBe(false);
    expect(taskTranscriptDetailsVisible(true, true)).toBe(true);
    expect(taskTranscriptDetailsVisible(true, false)).toBe(false);
    const source = await Bun.file(new URL("./tool-card.tsx", import.meta.url)).text();
    expect(source).toContain('minHeight: 44');
    expect(source).toContain('accessibilityState={{ expanded: detailsOpen }}');
    expect(source).toContain('accessibilityLabel={detailsOpen ? `Hide details for ${name}` : `Show details for ${name}`}');
  });

  test("keeps ordinary Room results out of the row and exposes an accessible long-press disclosure", async () => {
    const source = await Bun.file(new URL("./tool-card.tsx", import.meta.url)).text();
    const pane = await Bun.file(new URL("./room-chat-pane.tsx", import.meta.url)).text();
    const sheet = await Bun.file(new URL("./tool-result-sheet.tsx", import.meta.url)).text();
    expect(source).not.toContain("!taskTranscript || taskTranscriptDetailsVisible");
    expect(source).toContain("taskTranscriptDetailsVisible(detailsOpen, taskTranscript) && visibleResult");
    expect(source).toContain("onLongPress={() => onResultLongPress(visibleResult)}");
    expect(source).toContain("Long press to show the available result");
    expect(source).toContain("failed ? styles.failedDot : styles.doneDot");
    expect(pane).toContain("<ToolResultSheet disclosure={toolResultDisclosure}");
    expect(pane).toContain("truncated: item.resultTruncated === true");
    expect(sheet).toContain('<BottomSheet visible={disclosure !== null} snapPoints={["72%"]} scrollable backdrop');
    expect(sheet).toContain("This result was truncated in transit.");
    expect(sheet).toContain("<Text selectable style={styles.result}>{disclosure.result}</Text>");
  });

  test("keeps a header-only Room card wide enough to show its tool name", async () => {
    const source = await Bun.file(new URL("./tool-card.tsx", import.meta.url)).text();
    expect(source).toContain("flexShrink: 1");
    expect(source).not.toMatch(/name:\s*\{\s*flex:\s*1,/u);
  });
});

test("public browser admission is displayed as started work on Mobile", () => {
  const result = { ok: true, status: "active", target: { url: "https://example.com", origin: "https://example.com" }, operation: { operationId: "44444444-4444-4444-8444-444444444444", driver: "hosted", lifecycle: "running", controlEpoch: 1, activity: { phase: "working", code: "browsing", summary: "Reading public content" }, receipt: null } };
  expect(mobileToolCardResultText("browse_web", JSON.stringify(result))).toContain("Browser research started");
  expect(mobileToolCardResultText("browse_web", JSON.stringify(result))).toContain("when the browser work finishes");
  expect(mobileToolCardResultText("browse_web", JSON.stringify({ ...result, profileId: "private-coordinate" }))).not.toContain("private-coordinate");
});
