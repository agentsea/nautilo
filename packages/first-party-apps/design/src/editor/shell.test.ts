import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { appendChild, createEmptyDocument, createNode } from "../scene-graph";
import {
  acceptsCanvasPanningShortcut,
  acceptsEditorShortcut,
  historyControlState,
  initialToolForLoad,
  isGenuinelyEmptyDocument,
} from "./shell";

describe("canvas shell first-load tool", () => {
  test("activates Frame only for the first genuinely empty load", () => {
    const empty = createEmptyDocument();
    expect(isGenuinelyEmptyDocument(empty)).toBe(true);
    expect(initialToolForLoad({ isInitialLoad: true, document: empty, userHasChosenTool: false })).toBe("frame");
    expect(initialToolForLoad({ isInitialLoad: false, document: empty, userHasChosenTool: false })).toBeNull();
    expect(initialToolForLoad({ isInitialLoad: true, document: empty, userHasChosenTool: true })).toBeNull();
  });

  test("does not reset a nonempty document to Frame", () => {
    const node = createNode({ id: "node-1", type: "frame", parentId: null });
    const document = appendChild({ ...createEmptyDocument(), nodes: { "node-1": node } }, null, "node-1", "page-1");
    expect(isGenuinelyEmptyDocument(document)).toBe(false);
    expect(initialToolForLoad({ isInitialLoad: true, document, userHasChosenTool: false })).toBeNull();
  });
});

describe("canvas shell keyboard ownership", () => {
  test("does not intercept Cmd/Ctrl shortcuts from editable controls", () => {
    const window = new Window();
    const input = window.document.createElement("input");
    const textarea = window.document.createElement("textarea");
    const select = window.document.createElement("select");
    const editable = window.document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const button = window.document.createElement("button");

    expect(acceptsEditorShortcut(input)).toBe(false);
    expect(acceptsEditorShortcut(textarea)).toBe(false);
    expect(acceptsEditorShortcut(select)).toBe(false);
    expect(acceptsEditorShortcut(editable)).toBe(false);
    expect(acceptsEditorShortcut(button)).toBe(true);
  });

  test("does not turn Space into canvas pan while an editable or pressable control owns it", () => {
    const window = new Window();
    expect(acceptsCanvasPanningShortcut(window.document.createElement("textarea"))).toBe(false);
    expect(acceptsCanvasPanningShortcut(window.document.createElement("button"))).toBe(false);
    expect(acceptsCanvasPanningShortcut(window.document.createElement("div"))).toBe(true);
  });
});

describe("canvas shell visible controls", () => {
  test("derives disabled Undo and Redo controls from local history truth", () => {
    expect(historyControlState(false, false)).toEqual({ undoDisabled: true, redoDisabled: true });
    expect(historyControlState(true, false)).toEqual({ undoDisabled: false, redoDisabled: true });
    expect(historyControlState(true, true)).toEqual({ undoDisabled: false, redoDisabled: false });
  });

});
