import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import { expect, mock, test } from "bun:test";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";

let sessionMounts = 0;
const save = mock(async () => true);
mock.module("../../src/editors/editor-io", () => ({
  loadEditableText: async () => ({ kind: "ready", content: "<p>Before</p>", baseSha256: "a".repeat(64), baseRevision: 1 }),
}));
mock.module("../../src/editors/use-patch-document-session", () => ({
  usePatchDocumentSession: ({ initialContent }: { initialContent: string }) => {
    const [draft, setDraft] = useState(initialContent);
    useEffect(() => { sessionMounts += 1; }, []);
    return { draft, setDraftFromEditor: setDraft, dirty: draft !== initialContent, autosaveEnabled: false,
      conflict: null, conflictLoading: false, conflictLoadError: null, errorMessage: null, lastSavedAt: null,
      status: "unsaved", saveNow: save, setAutosaveEnabled: () => {}, keepMine: save, markMergedAndSave: save,
      retryConflict: save, saveCopy: save, takeTheirs: () => {} };
  },
}));
mock.module("../../src/editors/html-text-editor", () => ({
  HtmlTextEditor: ({ value, onChange, onSave }: { value: string; onChange: (value: string) => void; onSave?: () => void }) => (
    <div><textarea aria-label="HTML text draft" value={value} readOnly /><button onClick={() => onChange("<p>From text mode</p>")}>Change text draft</button><button onClick={onSave}>Save HTML text</button></div>
  ),
}));
mock.module("../../src/editors/code-editor", () => ({
  CodeEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <div><textarea aria-label="HTML source draft" value={value} readOnly /><button onClick={() => onChange("<p>From source mode</p>")}>Change source draft</button></div>
  ),
}));
const { EditorSurface } = await import("../../src/editors/editor-surface");

test("HTML Text and Source modes share one draft and patch session, including explicit save", async () => {
  reapplyHappyDomGlobals();
  const view = render(<EditorSurface file={{ kind: "artifact", id: "synthetic-html", path: "page.html", mimeType: "text/html" }} onClose={() => {}} onView={() => {}} />);
  await view.findByRole("textbox", { name: "HTML text draft" });
  fireEvent.click(view.getByRole("button", { name: "Change text draft" }));
  fireEvent.click(view.getByRole("button", { name: "Source", exact: true }));
  const sourceDraft = await view.findByRole("textbox", { name: "HTML source draft" });
  expect((sourceDraft as HTMLTextAreaElement).value).toBe("<p>From text mode</p>");
  fireEvent.click(view.getByRole("button", { name: "Change source draft" }));
  fireEvent.click(view.getByRole("button", { name: "Text", exact: true }));
  await waitFor(() => expect((view.getByRole("textbox", { name: "HTML text draft" }) as HTMLTextAreaElement).value).toBe("<p>From source mode</p>"));
  fireEvent.click(view.getByRole("button", { name: "Save HTML text" }));
  expect(save).toHaveBeenCalledWith({ checkpoint: true });
  expect(sessionMounts).toBe(1);
  view.unmount();
});
