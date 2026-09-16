import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { EditorView } from "@codemirror/view";
import { TRANSCRIPT_MAX_RENDERED, type TranscriptWindowHandle } from "../../src/components/transcript-window";
import type { TranscriptMessageVM } from "../../src/modes/rooms/subagents/transcript-vm";

const actual = await import("use-stick-to-bottom");
const originalFrames = { requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame };
const scrollRef: { current: HTMLElement | null } = { current: null };
// Deliberately stale sticky intent reproduces the real Electron latch. The
// list must use actual scroll geometry rather than believing this flag.
mock.module("use-stick-to-bottom", () => ({ ...actual, useStickToBottomContext: () => ({ scrollRef, isAtBottom: true }) }));
const { VirtualTranscriptRows, TranscriptRow } = await import("../../src/modes/rooms/subagents/VirtualTranscriptRows");
afterEach(() => { cleanup(); scrollRef.current = null; Object.assign(globalThis, originalFrames); });

function transcript(): TranscriptMessageVM[] {
  return Array.from({ length: 643 }, (_, index) => ({ key: `stable-${index}`, role: "tool", content: "", createdAt: "2026-09-08T00:00:00.000Z",
    toolCallId: `read-${index}`, toolName: "file", toolStatus: "success", args: { command: "read", path: `src/file-${index}.ts` },
    resultText: `const source${index} = "full source bytes 🦀";\n` }));
}

test("a 643-row task mounts a bounded editor window and preserves full source and collapse choices when revisited", async () => {
  reapplyHappyDomGlobals();
  const messages = transcript(); const canonical = JSON.stringify(messages);
  const handle = createRef<TranscriptWindowHandle>();
  const view = render(<VirtualTranscriptRows messages={messages} handleRef={handle} />);
  await waitFor(() => expect(view.container.querySelectorAll(".cm-editor").length).toBeGreaterThan(0));
  expect(view.container.querySelectorAll(".cm-editor").length).toBeLessThanOrEqual(TRANSCRIPT_MAX_RENDERED);
  expect(view.container.querySelector('[data-transcript-total="643"]')).toBeTruthy();
  expect(view.container.querySelector('[aria-label="Source code: src/file-0.ts"]')).toBeNull();
  await act(async () => { handle.current!.materializeById("stable-0"); });
  await waitFor(() => expect(view.container.querySelector('[aria-label="Source code: src/file-0.ts"]')).toBeTruthy());
  const source = view.container.querySelector('[aria-label="Source code: src/file-0.ts"]') as HTMLElement;
  expect(EditorView.findFromDOM(source)!.state.doc.toString()).toBe(messages[0].resultText!);
  const row = view.container.querySelector('[data-index="0"]')!;
  fireEvent.click(row.querySelector('button[aria-label^="Collapse"]')!);
  expect(row.querySelector(".cm-editor")).toBeNull();
  await act(async () => { handle.current!.materializeById("stable-642"); });
  expect(view.container.querySelector('[data-index="0"]')).toBeNull();
  view.rerender(<VirtualTranscriptRows messages={messages.map((message) => ({ ...message }))} handleRef={handle} />);
  await act(async () => { handle.current!.materializeById("stable-0"); });
  const returned = view.container.querySelector('[data-index="0"]')!;
  expect(returned.querySelector('button[aria-label^="Expand"]')).toBeTruthy();
  expect(returned.querySelector(".cm-editor")).toBeNull();
  fireEvent.click(returned.querySelector('button[aria-label^="Expand"]')!);
  await waitFor(() => expect(returned.querySelector(".cm-editor")).toBeTruthy());
  expect(EditorView.findFromDOM(returned.querySelector(".cm-editor") as HTMLElement)!.state.doc.toString()).toBe(messages[0].resultText!);
  expect(view.container.querySelectorAll(".cm-editor").length).toBeLessThanOrEqual(TRANSCRIPT_MAX_RENDERED);
  expect(JSON.stringify(messages)).toBe(canonical);
});

test("restored manual choices survive result auto-open and terminal auto-collapse while untouched rows retain defaults", () => {
  reapplyHappyDomGlobals();
  const base = { key: "choice", role: "tool", content: "", createdAt: "2026-09-08T00:00:00.000Z", toolCallId: "choice", toolStatus: "success" as const };
  const patch = { ...base, toolName: "apply_patch", args: { patch: "*** Begin Patch\n*** End Patch" }, resultText: "Patch applied successfully" };
  const saved = { ...base, toolName: "act_connected_web_account", args: { account: "Notion", action: "save_item", target: "Project plan" },
    resultText: JSON.stringify({ ok: true, status: "completed", action: "save_item", target: "Project plan", account: {
      id: "11111111-1111-4111-8111-111111111111", label: "Notion", service: "Notion", origin: "https://www.notion.so" },
      receipt: { executionRef: "execution", effectState: "observed", postcondition: "The named item is saved.", evidenceCode: "postcondition_observed", cost: { amountUsd: null, state: "unknown" } } }) };
  for (const [message, choice, expected] of [[patch, false, false], [patch, undefined, true], [saved, true, true], [saved, undefined, false]] as const) {
    const view = render(<TranscriptRow message={message} index={0} expanded={choice} />);
    expect(view.container.querySelector('[data-tool-card-state="success"]')?.getAttribute("aria-expanded")).toBe(String(expected));
    view.unmount();
  }
});

test("real viewport scrolling reveals old rows despite a stale sticky-follow latch, including the first paint at top", async () => {
  reapplyHappyDomGlobals();
  Object.assign(globalThis, { requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window) });
  const messages = transcript();
  const viewport = document.createElement("div");
  viewport.style.overflowY = "auto"; viewport.style.height = "384px";
  document.body.appendChild(viewport);
  Object.defineProperties(viewport, { clientHeight: { configurable: true, value: 384 },
    scrollHeight: { configurable: true, value: messages.length * 96 } });
  scrollRef.current = viewport;
  const view = render(<VirtualTranscriptRows messages={messages} />, { container: viewport });
  await waitFor(() => expect(view.container.querySelector('[data-index="0"]')).toBeTruthy());
  expect(view.container.querySelectorAll(".cm-editor").length).toBeLessThanOrEqual(TRANSCRIPT_MAX_RENDERED);
  viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight;
  expect(viewport.scrollTop).toBeGreaterThan(0);
  fireEvent.scroll(viewport);
  await waitFor(() => expect(view.container.querySelector('[data-index="642"]')).toBeTruthy());
  expect(view.container.querySelector('[data-index="0"]')).toBeNull();
  viewport.scrollTop = 0;
  fireEvent.scroll(viewport);
  await waitFor(() => expect(view.container.querySelector('[data-index="0"]')).toBeTruthy());
  expect(view.container.querySelector('[data-index="642"]')).toBeNull();
  expect(EditorView.findFromDOM(view.container.querySelector('[aria-label="Source code: src/file-0.ts"]') as HTMLElement)!.state.doc.toString()).toBe(messages[0]?.resultText);
  expect(view.container.querySelectorAll(".cm-editor").length).toBeLessThanOrEqual(TRANSCRIPT_MAX_RENDERED);
  view.unmount(); viewport.remove();
});
