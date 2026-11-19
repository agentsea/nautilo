import { describe, expect, test } from "bun:test";
import { HtmlTextDocumentHistory, type HtmlTextHistoryEvent, type HtmlTextHistoryView } from "../../src/editors/html-text-history";

describe("document-wide HTML edit history", () => {
  test("undo follows chronological document edits, not the focused region", () => {
    const history = new HtmlTextDocumentHistory("<p>A</p><td>B</td>");
    history.record("<p>A1</p><td>B</td>");
    history.record("<p>A1</p><td>B2</td>");
    expect(history.undo()).toBe(true);
    expect(history.getSnapshot()).toEqual({ source: "<p>A1</p><td>B</td>", canUndo: true, canRedo: true });
    history.undo();
    expect(history.getSnapshot().source).toBe("<p>A</p><td>B</td>");
    history.redo(); history.redo();
    expect(history.getSnapshot()).toEqual({ source: "<p>A1</p><td>B2</td>", canUndo: true, canRedo: false });
  });
  test("source-mode edits participate in the same timeline and clear abandoned redo", () => {
    const history = new HtmlTextDocumentHistory("base");
    const caret: HtmlTextHistoryView = { kind: "source", anchor: 2, head: 4, scrollTop: 100 };
    const events: HtmlTextHistoryEvent[] = [];
    const unsubscribe = history.subscribe(event => events.push(event));
    history.record("text edit");
    history.record("source edit", { before: caret, after: { ...caret, anchor: 3 } });
    history.undo();
    expect(events.at(-1)).toMatchObject({ kind: "restore", source: "text edit", view: caret });
    history.redo();
    expect(events.at(-1)).toMatchObject({ kind: "restore", source: "source edit", view: { anchor: 3 } });
    history.undo(); history.record("new branch");
    expect(history.redo()).toBe(false);
    unsubscribe();
    const count = events.length;
    history.undo();
    expect(events.length).toBe(count);
  });
  test("save echoes do not add history and external replacements reset it", () => {
    const history = new HtmlTextDocumentHistory("base");
    history.record("edited");
    expect(history.record("edited")).toBe(false);
    history.undo();
    expect(history.getSnapshot().source).toBe("base");
    expect(history.undo()).toBe(false);
    history.reset("external");
    expect(history.getSnapshot()).toEqual({ source: "external", canUndo: false, canRedo: false });
  });
});
