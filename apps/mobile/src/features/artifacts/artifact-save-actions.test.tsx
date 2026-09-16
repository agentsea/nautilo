import { expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildAppTheme } from "@/theme/tokens";

const container = ({ children }: { children: ReactNode }) => createElement("div", null, children);
mock.module("react-native", () => ({
  Modal: container, View: container, Text: container, ScrollView: container, TextInput: () => null, Platform: { OS: "ios" },
  Pressable: ({ children, accessibilityLabel, disabled }: { children: ReactNode; accessibilityLabel?: string; disabled?: boolean }) =>
    createElement("button", { "aria-label": accessibilityLabel, disabled }, children),
  StyleSheet: { create: <T,>(styles: T) => styles },
}));
mock.module("react-native-keyboard-controller", () => ({ KeyboardAvoidingView: container }));
mock.module("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
mock.module("@/providers/theme", () => ({ useAppTheme: () => buildAppTheme("dark") }));
const { ArtifactViewerActionsSheet } = await import("./artifact-viewer-actions-sheet");

function render(canWrite: boolean, saveBusy = false, media = false) {
  return renderToStaticMarkup(createElement(ArtifactViewerActionsSheet, {
    artifact: { id: "one", artifactId: "stable-one", path: "report.zip", size: 4, revision: 1,
      mimeType: "application/zip", namespaceIds: [], createdAt: "2026-01-01", updatedAt: "2026-01-01", canWrite },
    visible: true, renameBusy: false, renameRetryable: false, deleteBusy: false, deleteRetryable: false,
    deleteReconcileRequired: false, onClose() {}, onRename() {}, onRetryRename() {}, onDelete() {}, onRetryDelete() {},
    onSaveFile() {}, saveBusy,
    ...(media ? { onSaveMedia() {} } : {}),
  }));
}

test("a read-only unsupported original exposes Save but not mutation actions", () => {
  const markup = render(false);
  expect(markup).toContain("Save file…");
  expect(markup).not.toContain("Rename file");
  expect(markup).not.toContain("Delete file");
});

test("photo-library saving is independent from write permission and absent for other files", () => {
  expect(render(false, false, true)).toContain("Save to Photos");
  expect(render(false)).not.toContain("Save to Photos");
  expect(render(false, true, true)).toContain('aria-label="Save to Photos" disabled=""');
});
test("writers retain rename/delete while Save remains a separate operation", () => {
  const markup = render(true);
  expect(markup).toContain("Save file…");
  expect(markup).toContain("Rename file");
  expect(markup).toContain("Delete file");
});
test("in-progress saving disables repeat Save and hides conflicting mutations", () => {
  const markup = render(true, true);
  expect(markup).toContain('aria-label="Save original file" disabled=""');
  expect(markup).not.toContain("Rename file");
  expect(markup).not.toContain("Delete file");
  expect(markup).toContain("Cancel file actions");
});
