import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import React from "react";
import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, expect, mock, test } from "bun:test";
import { artifactOpenFileTarget } from "../../src/components/browser-column/open-file-target";
import type { PatchEditorConflict, PatchEditorStatus } from "../../src/editors/use-patch-document-session";

const retryConflict = mock(async () => {});
const takeTheirs = mock(() => {});
const markMergedAndSave = mock(async () => true);
const session = {
  draft: "retained draft",
  dirty: true,
  status: "conflict" as PatchEditorStatus,
  lastSavedAt: null,
  autosaveEnabled: true,
  errorMessage: null,
  conflict: null as PatchEditorConflict | null,
  conflictLoading: false,
  conflictLoadError: null as string | null,
  setDraftFromEditor: mock(() => {}),
  setAutosaveEnabled: mock(() => {}),
  saveNow: mock(async () => false),
  keepMine: mock(async () => true),
  takeTheirs,
  markMergedAndSave,
  retryConflict,
  saveCopy: mock(async () => true),
};

mock.module("../../src/editors/use-patch-document-session", () => ({
  usePatchDocumentSession: () => session,
}));
mock.module("../../src/editors/editor-io", () => ({
  loadEditableText: async () => ({ kind: "ready", content: "", baseSha256: "empty-sha", baseRevision: 1 }),
}));
mock.module("../../src/lib/desktop", () => ({ desktopAPI: null, isDesktop: false }));
mock.module("../../src/viewers/html/index", () => ({
  htmlViewerAdapter: { canView: () => false },
}));
mock.module("../../src/editors/code-editor", () => ({ CodeEditor: () => <div /> }));

const { EditorSurface } = await import("../../src/editors/editor-surface");
const file = artifactOpenFileTarget({ id: "artifact-1", path: "notes.txt", mimeType: "text/plain" });
const props = { file, onView: () => {}, onClose: () => {} };

beforeEach(() => {
  reapplyHappyDomGlobals();
  retryConflict.mockClear();
  takeTheirs.mockClear();
  markMergedAndSave.mockClear();
  session.status = "conflict";
  session.conflictLoading = false;
  session.conflictLoadError = "Read failed.";
  session.conflict = { latestContent: null, currentSha256: "remote-sha" };
});

test("failed latest-version read exposes a retry and protects unavailable resolution choices", async () => {
  const view = render(<EditorSurface {...props} />);
  await act(async () => {});
  expect(view.getByText("Read failed.")).toBeTruthy();
  expect(view.queryByText("Loading latest version...")).toBeNull();
  expect((view.getByRole("button", { name: "Take theirs" }) as HTMLButtonElement).disabled).toBe(true);
  expect((view.getByRole("button", { name: "Merge and save" }) as HTMLButtonElement).disabled).toBe(true);
  expect((view.getByRole("button", { name: "Keep mine" }) as HTMLButtonElement).disabled).toBe(false);
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "Retry loading latest" })); });
  expect(retryConflict).toHaveBeenCalledTimes(1);

  session.conflictLoadError = null;
  session.conflict = { latestContent: "", currentSha256: "empty-sha" };
  view.rerender(<EditorSurface {...props} />);
  expect(view.queryByRole("button", { name: "Retry loading latest" })).toBeNull();
  expect((view.getByRole("button", { name: "Take theirs" }) as HTMLButtonElement).disabled).toBe(false);
  expect((view.getByRole("button", { name: "Merge and save" }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(view.getByRole("button", { name: "Take theirs" }));
  expect(takeTheirs).toHaveBeenCalledTimes(1);
});

test("resolution controls stay disabled while the selected draft is being saved", async () => {
  session.status = "patching";
  session.conflictLoadError = null;
  session.conflict = { latestContent: "latest", currentSha256: "remote-sha" };
  const view = render(<EditorSurface {...props} />);
  await act(async () => {});
  for (const name of ["Keep mine", "Take theirs", "Merge and save"]) {
    expect((view.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
  }
});
