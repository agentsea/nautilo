import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const workbenchRoot = join(import.meta.dir, "../..");

function readSource(path: string): string {
  return readFileSync(join(workbenchRoot, path), "utf8");
}

describe("editor shell wiring", () => {
  test("file focus opens read mode and ReaderSurface can switch to edit mode", () => {
    const shell = readSource("src/layouts/workbench-shell.tsx");
    expect(shell).toContain('setWorkSurface({ kind: "file", file: target, mode: "read" })');
    expect(shell).toContain('...(readingFile?.kind === "fs" || canWriteArtifacts');
    expect(shell).toContain("onEdit: (f: ReaderFile) => setWorkSurface({ kind: \"file\", file: f, mode: \"edit\" })");
  });

  test("Current Folder is an authenticated-Human editor surface", () => {
    const shell = readSource("src/layouts/workbench-shell.tsx");
    const filesTab = readSource("src/components/browser-column/files-tab.tsx");
    expect(filesTab).toContain("isAuthenticatedHumanViewer(auth.viewer)");
    expect(shell).toContain('workSurface.kind === "file" && authenticatedHuman');
    expect(shell).toContain("if (!authenticatedHuman) return;");
  });

  test("reader chat carries the exact open artifact or local file into each agent send", () => {
    const shell = readSource("src/layouts/workbench-shell.tsx");
    const conversation = readSource("src/components/conversation.tsx");
    expect(shell).toContain("const readerFocusedResourceTarget");
    expect(shell).toContain('workSurfaceEventFile?.kind === "fs"');
    expect(shell).toContain('kind: "local-file"');
    expect(shell).toContain("readerFocusedResourceTarget ? { readerFocusedResourceTarget }");
    expect(conversation).toContain("? await getDesktopRelayId()");
    expect(conversation).toContain(
      "const contextualFocusedResources = await resolveContextualFocusedResources();",
    );
    expect(conversation).toContain("void resolveContextualFocusedResources().then");
  });

  test("edit mode renders EditorSurface and patch sync stays in the hook", () => {
    const shell = readSource("src/layouts/workbench-shell.tsx");
    const editorSurface = readSource("src/editors/editor-surface.tsx");
    expect(shell).toContain('<EditorSurface');
    expect(shell).toContain('workSurface.mode === "edit"');
    expect(editorSurface).toContain("usePatchDocumentSession");
    // Own-save resolution happens OUTSIDE the setState updater (StrictMode
    // double-invokes updaters; a one-shot consume inside would misclassify).
    expect(shell).toContain("isLocalArtifactSaveMutation(workspaceArtifactEventClientMutationId(event))");
    expect(shell).toContain(
      "isWorkspaceArtifactCommittedMutation(event)",
    );
    // Own save → no reload in any mode; external edit-mode sync stays in hook.
    expect(shell).toContain("if (isOwnArtifactSave) return prev;");
    expect(shell).toContain('event.type === "document.patch.applied"');
    expect(shell).toContain('prev.mode === "edit"');
    expect(shell).toContain('reloadToken: (prev.file.reloadToken ?? 0) + 1');
    expect(shell).toContain("onReconnect: () =>");
  });

  test("EditorSurface reload is keyed on remountKey, not file object identity", () => {
    const editorSurface = readSource("src/editors/editor-surface.tsx");
    expect(editorSurface).toContain("const target = fileRef.current;");
    expect(editorSurface).toContain("}, [editable, remountKey]);");
  });

  test("local fs files reload on external change in read mode but edit sync stays in hook", () => {
    const shell = readSource("src/layouts/workbench-shell.tsx");
    const editorSurface = readSource("src/editors/editor-surface.tsx");
    const patchHook = readSource("src/editors/use-patch-document-session.ts");
    // Shell watches fs files only in read mode; edit mode stays mounted.
    expect(shell).toContain('workSurface.mode === "read"');
    expect(shell).toContain("onDirectoryChanged");
    expect(shell).toContain("isLocalFsSaveSha(watchingFsFile.path, currentSha)");
    expect(shell).toContain("Edit-mode sync is handled by usePatchDocumentSession");
    // Hook owns edit-mode fs watcher + own-save SHA suppression.
    expect(patchHook).toContain("registerLocalFsSaveSha");
    expect(patchHook).toContain("isLocalFsSaveSha");
    expect(patchHook).toContain("onDirectoryChanged");
    expect(editorSurface).toContain("usePatchDocumentSession");
    expect(editorSurface).not.toContain("useDocEditor");
  });

  test("create-new callbacks open directly in edit mode", () => {
    const shell = readSource("src/layouts/workbench-shell.tsx");
    const browserColumn = readSource("src/components/browser-column/browser-column.tsx");
    const filesTab = readSource("src/components/browser-column/files-tab.tsx");
    const artifactTree = readSource("src/components/browser-column/artifact-tree-view.tsx");

    expect(shell).toContain("onOpenFileEdit={focusFileInEditMode}");
    expect(browserColumn).toContain("onOpenFileEdit?: (target: OpenFileTarget) => void");
    expect(filesTab).toContain('desktopAPI.fs.writeFile(built.path, "", { baseSha256: null })');
    expect(artifactTree).toContain("apiClient.createWorkspaceArtifact(file,");
    expect(artifactTree).toContain("onOpenFileEdit(");
  });

  test("mini-app context is cleared on surface switches and wired to MiniAppSurface", () => {
    const shell = readSource("src/layouts/workbench-shell.tsx");
    expect(shell).toContain("setActiveMiniAppContext(null)");
    expect(shell).toContain("clearActiveMiniApp()");
    expect(shell).toContain("publishActiveMiniApp(");
    expect(shell).toContain("const handleMiniAppContextUpdate = useCallback");
    expect(shell).toContain("setActiveMiniAppContext(context)");
    expect(shell).toContain("onContextUpdate={handleMiniAppContextUpdate}");
    expect(shell).toContain('const mode = options?.mode ?? "edit"');
    expect(shell).toContain('mode === "edit" && (!canInvokeAgents || !canWriteArtifacts)');
    expect(shell).toContain("mode={workSurface.mode}");
    expect(shell).toContain("mode: prev.mode");
    expect(shell).toContain("next.mode !== current.mode");
    expect(shell).toContain('openMiniApp(workSurface.appId, workSurface.target, { mode: "edit" })');
  });

  test("mini-app draft guard owns explicit shell surface transitions", () => {
    const shell = readSource("src/layouts/workbench-shell.tsx");
    expect(shell).toContain("const requestWorkSurfaceTransition = useCallback");
    expect(shell).toContain("registerBeforeLeave={registerMiniAppBeforeLeave}");
    const miniAppSurface = shell.slice(shell.indexOf("<MiniAppSurface"), shell.indexOf("/>", shell.indexOf("<MiniAppSurface")));
    expect(miniAppSurface).toContain("onClose={clearWorkSurfaceImmediately}");
    expect(shell).toContain("requestWorkSurfaceTransition(() => {");
    expect(shell).toContain("requestWorkSurfaceTransition(clearWorkSurfaceImmediately)");
    expect(shell).toContain("clearWorkSurfaceImmediately();");
  });

  test("MiniAppSurface installs the themed app bridge without relaxing iframe sandbox", () => {
    const surface = readSource("src/apps/mini-app-surface.tsx");
    expect(surface).toContain("buildNautiloAppBridgeClientScript(");
    expect(surface).toContain("initialTheme");
    expect(surface).toContain("hostCapabilities?.assetReadRaster");
    expect(surface).toContain("buildNautiloAppBridgeClientScript(bootstrap, mode, capabilities)");
    expect(surface).toContain('mode === "edit" && (appId === "nautilo-presentation" || appId === "nautilo-board") && nativeRecovery !== undefined');
    expect(surface).toContain("installAppBridge({");
    expect(surface).toContain("iframe,");
    expect(surface).toContain("target,");
    expect(surface).toContain("onContextUpdate,");
    expect(surface).toContain('sandbox="allow-scripts"');
  });
});

describe("Phase 10 patch path guards", () => {
  function countOccurrences(source: string, needle: string): number {
    let count = 0;
    let index = 0;
    while ((index = source.indexOf(needle, index)) !== -1) {
      count += 1;
      index += needle.length;
    }
    return count;
  }

  test("EditorSurface normal path uses patch hook, not useDocEditor snapshot editor", () => {
    const editorSurface = readSource("src/editors/editor-surface.tsx");
    expect(editorSurface).toContain("usePatchDocumentSession");
    expect(editorSurface).not.toContain("useDocEditor");
    expect(editorSurface).not.toContain("saveEditableText(");
  });

  test("usePatchDocumentSession uses patch APIs for artifact and fs targets", () => {
    const hook = readSource("src/editors/use-patch-document-session.ts");
    expect(hook).toContain("applyWorkspaceArtifactPatch");
    expect(hook).toContain("registerLocalFsSaveSha");
    expect(hook).toContain("api.fs.writeFile");
    expect(hook).toContain("saveEditableText");
  });

  test("saveWorkspaceArtifactContent is confined to fallback/editor-io paths", () => {
    const editorIo = readSource("src/editors/editor-io.ts");
    expect(editorIo).toContain("saveWorkspaceArtifactContent");
    expect(countOccurrences(editorIo, "saveWorkspaceArtifactContent")).toBe(1);

    const hook = readSource("src/editors/use-patch-document-session.ts");
    expect(hook).not.toContain("saveWorkspaceArtifactContent");
  });

  test("app-bridge artifact writes use patch path", () => {
    const appBridge = readSource("src/apps/app-bridge.ts");
    expect(appBridge).toContain("applyWorkspaceArtifactPatch");
    expect(appBridge).toContain("writeArtifactWithPatch");
  });
});
