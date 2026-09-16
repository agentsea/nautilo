import { expect, test } from "bun:test";

test("viewer actions keep rename and require a separate destructive delete confirmation", async () => {
  const source = await Bun.file(new URL("./artifact-viewer-actions-sheet.tsx", import.meta.url)).text();
  const viewer = await Bun.file(new URL("../../app/files/artifact/[id].tsx", import.meta.url)).text();
  expect(source).toContain('accessibilityLabel="New filename"');
  expect(source).toContain('accessibilityLabel={retryable ? "Retry rename" : "Rename file"}');
  expect(source).toContain('accessibilityLabel="Delete file"');
  expect(source).toContain('accessibilityLabel={retryable ? "Retry delete" : "Confirm delete file"}');
  expect(source).toContain('"Cancel delete"');
  expect(source).toContain("Delete file?");
  expect(source).toContain("onPress={onClose}");
  expect(source).toContain("deleteReconcileRequired");
  expect(source).toContain("const deterministicReconcile = reconcileRequired && !retryable");
  expect(source).toContain("!deterministicReconcile ? <Pressable");
  expect(source).toContain("const handleClose = (): void => { setMode(\"actions\"); onClose(); }");
  expect(source).toContain('accessibilityLabel={reconcileRequired ? "Close and check latest file" : "Cancel delete"}');
  expect(source).toContain("Only the filename changes; its folder stays the same.");
  expect(source).toContain("useAppTheme");
  expect(source).toContain("useSafeAreaInsets");
  expect(source).toContain('import { KeyboardAvoidingView } from "react-native-keyboard-controller"');
  expect(source).toContain('<KeyboardAvoidingView behavior="padding" style={[styles.root, mode === "share" && { paddingTop: insets.top }]}>');
  expect(source).toContain("Folder: {parentPath(artifact.path)}");
  expect(source).toContain("retryable ? \"Retry rename\" : \"Rename\"");
  expect(source).toContain("editable={!busy && !retryable}");
  expect(source).toContain("disabled={!canClose}");
  expect(source).not.toContain("deleteWorkspaceArtifact"); // Confirmation is presentation only.
  expect(source).not.toContain("renameWorkspaceArtifact");
  // Read-only users need Save original; only mutation actions require write.
  expect(viewer).toContain("showOverflow={artifact !== null}");
  expect(source).toContain("canWrite={artifact.canWrite && !saveBusy}");
  expect(viewer).toContain("A rename can alter an extension and therefore the derived viewer kind.");
  expect(viewer).toContain("useFocusEffect(useCallback(() => {");
  expect(viewer).toContain("shouldPassivelyRefreshArtifactViewerOnFocus(");
  expect(viewer).toContain("return refresh ? reloadPassiveArtifact() : loadArtifact();");
  expect(viewer).toContain("new ArtifactRenameCoordinator");
  expect(viewer).toContain("renameReloadOnClose");
  expect(viewer).toContain("renameCoordinator.retry");
  expect(viewer).toContain("renameCoordinator.abandon()");
  expect(viewer).toContain("renameRequestGeneration");
  expect(viewer).toContain("renameRetryable={renameRetryable}");
  expect(viewer).toContain("new ArtifactDeleteCoordinator");
  expect(viewer).toContain("deleteCoordinator.retry");
  expect(viewer).toContain("deleteCoordinator.abandon()");
  expect(viewer).toContain("deleteReconcileOnClose");
  expect(viewer).toContain("deleteReconcileRequired={deleteReconcileOnClose}");
  expect(viewer).toContain("setRenameReloadOnClose(false)");
  expect(viewer).toContain("setDeleteReconcileOnClose(false)");
  expect(viewer).toContain("setRenameVisible(false)");
  expect(viewer).toContain("returnToFiles();");
  expect(viewer).toContain("shouldExitAfterArtifactConvergence(fresh.kind)");
  expect(viewer).toContain("useArtifactEvents");
  expect(viewer).toContain("viewerConvergenceAction(event, artifactId, mutationBusyRef.current)");
  expect(viewer).toContain('loadArtifact({ mode: "passive"');
  expect(viewer).toContain('loadArtifact({ mode: "reconcile"');
  expect(viewer).toContain('options?.mode !== undefined && stateRef.current.kind === "result"');
  expect(viewer).toContain('stateRef.current.kind === "result"');
  expect(viewer).toContain("shouldInstallArtifactConvergenceResult(");
  expect(viewer).toContain('if (action === "reconcile") reconcileArtifact()');
  expect(viewer).toContain('else if (action === "reload") reloadPassiveArtifact()');
  expect(viewer).toContain('setMutationBusy("rename", true)');
  expect(viewer).toContain('setMutationBusy("delete", true)');
  expect(viewer).toContain('setMutationBusy("rename", false)');
  expect(viewer).toContain('setMutationBusy("delete", false)');
  // A room hint is retained for return navigation and Discuss, never mutation
  // authority: the viewer's canWrite admission is aggregate.
  expect(viewer).not.toContain("...(originRoomId ? { roomId: originRoomId } : {})");
});

test("the viewer Save action reuses Edit's compact button appearance", async () => {
  const viewer = await Bun.file(new URL("../../app/files/artifact/[id].tsx", import.meta.url)).text();
  const saveStart = viewer.indexOf('<Pressable onPress={() => void fileSave.save(artifact.id)}');
  const saveEnd = viewer.indexOf("</Pressable>", saveStart);
  const saveAction = viewer.slice(saveStart, saveEnd);
  expect(saveAction).toContain("artifactViewerActionButtonStyle(mimeBarActionAppearance, pressed)");
  expect(saveAction).toContain("artifactViewerActionLabelStyle(mimeBarActionAppearance)");
  expect(saveAction).toContain("disabled={fileSave.busy}");
  expect(saveAction).toContain('accessibilityLabel="Save original file"');
  expect(saveAction).not.toContain("styles.retryButton");
  expect(viewer).toContain("appearance={mimeBarActionAppearance}");
});

test("a server or artifact session switch clears its old result and discussion session", async () => {
  const viewer = await Bun.file(new URL("../../app/files/artifact/[id].tsx", import.meta.url)).text();
  expect(viewer).toContain("return refresh ? reloadPassiveArtifact() : loadArtifact();");
  // Only deliberate convergence supplies a mode. A default effect load cannot
  // retain an old result across a server/artifact session boundary.
  expect(viewer).toContain('const preserveMountedResult = options?.mode !== undefined && stateRef.current.kind === "result"');
  expect(viewer).toContain('loadArtifact({ mode: "passive"');
  expect(viewer).toContain('loadArtifact({ mode: "reconcile"');
  const resetStart = viewer.indexOf("  useEffect(() => {\n    // A server/artifact session change");
  const resetEnd = viewer.indexOf("  const result = state.kind", resetStart);
  const reset = viewer.slice(resetStart, resetEnd);
  expect(reset).toContain("setDiscussionRoomId(undefined)");
  expect(reset).toContain("setChooserVisible(false)");
  expect(reset).toContain("setCandidates([])");
  expect(reset).toContain("setSelectedCandidateId(undefined)");
  expect(reset).toContain("setDiscussionLoading(false)");
  expect(reset).toContain("setCreatingDiscussion(false)");
  expect(reset).toContain("setDiscussionError(null)");
});

test("the actual viewer mounts its chat controller only after Discuss resolves a room", async () => {
  const viewer = await Bun.file(new URL("../../app/files/artifact/[id].tsx", import.meta.url)).text();
  const mount = viewer.indexOf("{discussionRoomId && artifact && shouldMountArtifactDiscussion(true, discussionRoomId) ? (");
  const dock = viewer.indexOf("<ArtifactDiscussionDock", mount);
  const controller = viewer.indexOf("useRoomChatController", viewer.indexOf("function ArtifactDiscussionDock"));
  expect(mount).toBeGreaterThanOrEqual(0);
  expect(dock).toBeGreaterThan(mount);
  expect(controller).toBeGreaterThan(dock);
  expect((viewer.match(/<ArtifactDiscussionDock/g) ?? []).length).toBe(1);
  expect(viewer.slice(0, mount)).not.toContain("<ArtifactDiscussionDock");
});

test("Files has one aggregate listing path, then refreshes when focus returns", async () => {
  const files = await Bun.file(new URL("../../app/(drawer)/(tabs)/files.tsx", import.meta.url)).text();
  const focusStart = files.indexOf("useFocusEffect(useCallback(() => {");
  const focusEnd = files.indexOf("useEffect(() => {\n    const timer", focusStart);
  const focus = files.slice(focusStart, focusEnd);
  expect(focus).toContain("decideArtifactListFocus(");
  expect(focus).toContain("artifactFocusState.current");
  expect(focus).toContain("setArtifacts([])");
  expect(focus).toContain("void loadArtifacts(effectiveRoom, focus.action === \"refresh\")");
  expect(files).toContain("sole initial artifact request");
  const serverReset = files.slice(files.indexOf("  useEffect(() => {\n    requestGeneration"), files.indexOf("  useFocusEffect"));
  expect(serverReset).not.toContain("loadArtifacts(");
  expect(serverReset).toContain("artifactFocusState.current = resetArtifactListFocus()");
  expect(files).toContain("effectiveArtifactRoom(selectedRoom, activeServer?.id)");
  expect(files).toContain("useArtifactEvents");
  expect(files).toContain("shouldRefreshFocusedArtifactList(event)");
  expect(files).toContain("eventRefreshQueued.current");
  expect(files).toContain("client.listWorkspaceArtifacts(room ? { roomId: room.id } : undefined)");
  expect(files).toContain('placeholder="Search files"');
  expect(files).toContain("<ComputerSource");
  expect(files).not.toContain("workspaceTab");
  expect(files).not.toContain("SharedWorkspaceFiles");
  expect(files).not.toContain("listWorkspaceShares");
  expect(files).not.toContain("All files");
  expect(files).not.toContain("Shared with me");
  expect(files).not.toContain("void loadArtifacts(room)");
  expect(files).not.toContain("void loadArtifacts(null)");
});
