import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sourceRoot = resolve(import.meta.dir, "../..");
const read = (path: string): string => readFileSync(resolve(sourceRoot, path), "utf8");

describe("physical-phone chat controls", () => {
  test("the model catalogue uses a gesture-aware scrolling sheet and exposes the inherited default", () => {
    const sheet = read("components/model-switcher-sheet.tsx");
    const primitive = read("components/bottom-sheet.tsx");

    expect(sheet).toContain("scrollable");
    expect(sheet).toContain("backdrop");
    expect(sheet).toContain('accessibilityLabel="Close model picker"');
    expect(sheet).toContain('accessibilityLabel="Search models"');
    expect(sheet).toContain("Use default");
    expect(sheet).toContain("defaultModelLabel");
    expect(primitive).toContain("BottomSheetScrollView");
  });

  test("the compact model and persistent 44-point actions share a stable row", () => {
    const composer = read("components/composer.tsx");

    expect(composer).toContain("styles.metadataControl");
    expect(composer).toContain("styles.actionRow");
    expect(composer).toContain("width: 44");
    expect(composer).toContain('accessibilityLabel="Stop generation"');
    expect(composer).toContain("disabled={!busy}");
    expect(composer).toContain("styles.stopButtonIdle");
    expect(composer).toMatch(/controlRow:\s*\{[\s\S]*?minHeight: 44,/);
  });

  test("background catch-up never replaces a mounted transcript with blocking state", () => {
    const controller = read("hooks/use-room-chat-controller.ts");

    expect(controller).toContain("if (!background) setLoading(true)");
    expect(controller).toContain("if (!background) setError(null)");
    expect(controller).toContain(
      "if (!background && roomOperationGuardRef.current.isCurrentInitialHistory(operation))",
    );
    expect(controller).toContain("reconcileLatestHistoryItems(current, latestItems)");
  });

  test("best-effort draft recovery never becomes a non-actionable composer warning", () => {
    const composer = read("components/composer.tsx");
    const roomComposer = read("features/room-chat-pane/room-chat-composer.tsx");
    const controller = read("hooks/use-room-chat-controller.ts");

    expect(composer).not.toContain("draftWarning");
    expect(roomComposer).not.toContain("draftPersistenceWarning");
    expect(controller).not.toContain("draftPersistenceWarning");
    expect(controller.toLowerCase()).not.toContain("restart recovery");
    expect(controller).toContain("void persist.catch(() => {});");
  });

  test("voice playback sits beside auto-approve instead of consuming model space", () => {
    const roomComposer = read("features/room-chat-pane/room-chat-composer.tsx");

    expect(roomComposer).toContain('"Talk: on"');
    expect(roomComposer).toContain('"Talk: off"');
    expect(roomComposer).toContain("styles.voiceSessionPill");
    expect(roomComposer).toContain("width: 116");
    expect(roomComposer).not.toContain("styles.voiceControlButton");
  });

  test("searched-message positioning is one-shot and only accepted sends return to latest", () => {
    const pane = read("components/room-chat-pane.tsx");
    const controller = read("hooks/use-room-chat-controller.ts");
    const viewport = read("features/room-chat-pane/use-room-chat-viewport.ts");
    const roomRoute = read("app/chat/[roomId].tsx");

    expect(pane).toContain("appliedScrollRequestRef.current === target.requestId");
    expect(pane).toContain("useRoomChatViewport");
    expect(pane).toContain("maintainVisibleContentPosition={viewport.maintainVisibleContentPosition}");
    expect(viewport).toContain("nextLatestScrollCommand");
    expect(viewport).toContain("appliedLatestRequestIdRef.current = command.requestId");
    expect(viewport).toContain("useLayoutEffect(() => {");
    expect(viewport).toContain('pendingReturn?.origin === "local-send"');
    expect(viewport).toMatch(
      /onContentSizeChange[\s\S]*?contentCommitted: true[\s\S]*?scrollToOffset\(\{ offset: 0, animated: true \}\)/,
    );
    expect(viewport).toContain("stillPending?.requestId !== requestId");
    expect(viewport).toContain("scrollToOffset({ offset: 1, animated: false })");
    expect(controller).toContain('requestLatestViewport("local-send", !resume)');
    expect(pane).toContain("onHumanReachedLiveEdge: c.releaseViewportAtLiveEdge");
    const voiceToggle = controller.match(
      /const handleToggleVoice = useCallback\(\(\) => \{([\s\S]*?)\n[ ]{2}\}, \[toggleVoice\]\);/,
    )?.[1] ?? "";
    const micStart = controller.match(
      /const handleMicStart = useCallback\(\(\) => \{([\s\S]*?)\n[ ]{2}\}, \[startRecording\]\);/,
    )?.[1] ?? "";
    const micCancel = controller.match(
      /const handleMicCancel = useCallback\(\(\) => \{([\s\S]*?)\n[ ]{2}\}, \[cancelRecording\]\);/,
    )?.[1] ?? "";
    const send = controller.match(
      /const handleSend = useCallback\(([\s\S]*?)\n[ ]{2}const handleMicStart/,
    )?.[1] ?? "";

    expect(voiceToggle).toContain("toggleVoice();");
    expect(micStart).toContain("void startRecording();");
    expect(micCancel).toContain("void cancelRecording();");
    expect(voiceToggle).not.toContain("requestLatestViewport");
    expect(micStart).not.toContain("requestLatestViewport");
    expect(micCancel).not.toContain("requestLatestViewport");
    expect(send.match(/requestLatestViewport\("local-send", !resume\)/g)).toHaveLength(1);
    expect(send.indexOf("acquireSend(operation)")).toBeLessThan(
      send.indexOf('requestLatestViewport("local-send", !resume)'),
    );
    expect(roomRoute).not.toContain("controller.returnToLatest()");
    expect(roomRoute).toMatch(
      /if \(!hit\) \{\s*controller\.cancelMessageTargetNavigation\(\);\s*return;/,
    );
    expect(roomRoute).toMatch(
      /searchController\.clear\(\);\s*controller\.cancelMessageTargetNavigation\(\);\s*setSearchOpen\(false\);/,
    );
  });

  test("attachment is integrated into the message surface instead of floating alone", () => {
    const composer = read("components/composer.tsx");
    const roomComposer = read("features/room-chat-pane/room-chat-composer.tsx");

    expect(roomComposer).toContain('name="paperclip"');
    expect(composer).toContain("styles.inputSurface");
    expect(composer).toContain("styles.inputLeadingAction");
    expect(composer).not.toContain("styles.leadingActions");
    expect(roomComposer).toMatch(/attachButton:\s*\{[\s\S]*?width: 48,/);
  });

  test("routine connection machinery stays silent", () => {
    const mobileBanner = read("components/disconnect-banner.tsx");

    expect(mobileBanner).toContain('connectionState !== "closed"');
    expect(mobileBanner).toContain("Offline — trying again…");
    expect(mobileBanner).not.toContain('"Signing in…"');
  });

  test("the Chats list keeps search visible while individual chats keep the compact trigger", () => {
    const chats = read("app/(drawer)/(tabs)/index.tsx");
    const search = read("app/search/chats.tsx");
    const room = read("app/chat/[roomId].tsx");

    expect(chats).toContain("styles.searchField");
    expect(chats).toContain("marginTop: t.spacing.sm");
    expect(chats).toContain('accessibilityLabel="Search conversations"');
    expect(chats).toContain("conversationMatchesQuery(room, searchQuery)");
    expect(chats).toContain('if (!searchQuery.trim() && value.trim()) setFilter("all")');
    expect(chats).toContain("createChatSearchController");
    expect(chats).toContain(".searchChats(options, { signal })");
    expect(chats).toContain("MATCHING MESSAGES");
    expect(chats).not.toContain('router.push("/search/chats")');
    expect(chats).not.toContain("onSearchPress={() => router.push(\"/search/chats\")}");
    expect(search).toContain("useFocusEffect");
    expect(search).toContain("autoFocus");
    expect(room).toContain("setOnSearchPress");
    expect(room).toContain("setSearchOpen(true)");
  });
});
