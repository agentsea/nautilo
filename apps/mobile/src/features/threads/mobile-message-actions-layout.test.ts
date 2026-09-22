import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const emojiPicker = readFileSync(join(root, "components/emoji-picker-sheet.tsx"), "utf8");
const bubble = readFileSync(join(root, "components/message-bubble.tsx"), "utf8");
const pane = readFileSync(join(root, "components/room-chat-pane.tsx"), "utf8");
const rail = readFileSync(join(root, "components/message-action-rail.tsx"), "utf8");
const deleteConfirmation = readFileSync(join(root, "components/message-delete-confirmation.tsx"), "utf8");
const controller = readFileSync(join(root, "hooks/use-room-chat-controller.ts"), "utf8");
const bottomSheet = readFileSync(join(root, "components/bottom-sheet.tsx"), "utf8");

describe("mobile message actions", () => {
  test("uses the standard Ionicons pencil for Edit without a platform-specific image path", () => {
    expect(rail).toContain('edit: "pencil"');
    expect(rail).toContain('import { Ionicons } from "@expo/vector-icons"');
    expect(rail).toContain("name={ICON_BY_ACTION[action.id]}");
    expect(rail).not.toContain("DesktopPencilIcon");
    expect(rail).not.toContain('action.id === "edit"');
  });

  test("uses a neutral fixed-size icon rail instead of visible word actions or an action sheet", () => {
    expect(rail).toContain("minHeight: 44");
    expect(rail).toContain("width: 44");
    expect(rail).toContain("accessibilityLabel={action.accessibleLabel}");
    expect(rail).toContain("if (actions.length === 0 || !visible) return null");
    expect(rail).toContain("action.destructive && pressed");
    expect(bubble).toContain("getMessageActionDescriptors");
    expect(bubble).toContain("automaticActionDescriptors");
    expect(bubble).toContain("action.destructive !== true");
    expect(bubble).toContain("<MessageActionRail");
    expect(bubble).not.toContain("☺ React");
    expect(bubble).not.toContain("Reply in thread</Text>");
    expect(pane).not.toContain("<MessageActionsSheet");
    expect(pane).toContain("latestPersistedMessageId");
    expect(pane).toContain("onViewableItemsChanged={handleViewableItemsChanged}");
    expect(pane).toContain("viewport.onViewableItemsChanged(info)");
    expect(pane).toContain("onTouchStart={handleTranscriptTouchStart}");
    expect(pane).toContain("onTouchEnd={handleTranscriptTouchEnd}");
    expect(pane).toContain("messageActionRevealReducer");
    expect(bottomSheet).toContain("<Modal");
    expect(bottomSheet).toContain('presentationStyle="overFullScreen"');
  });

  test("opens a keyboard-safe full emoji picker beyond quick reactions", () => {
    expect(emojiPicker).toContain("Choose a reaction");
    expect(emojiPicker).toContain("<BottomSheetTextInput");
    expect(emojiPicker).toContain("MOBILE_EMOJI_CATEGORIES");
    expect(emojiPicker).toContain("Recently used");
    expect(emojiPicker).toContain("<BottomSheetFlatList");
    expect(emojiPicker).toContain('keyboardDismissMode="on-drag"');
    expect(emojiPicker).toContain('BackHandler.addEventListener("hardwareBackPress"');
    expect(pane).toContain("<EmojiPickerSheet");
  });

  test("gates hard delete, confirms it explicitly, and retains the thread-starter denial", () => {
    expect(pane).toContain("<MessageDeleteConfirmation");
    expect(controller).toContain("canDeleteMessage");
    expect(controller).toContain("deleteRoomMessage(roomId, messageId)");
    expect(controller).toContain('error.status === 409');
    expect(deleteConfirmation).toContain("Delete message?");
    expect(deleteConfirmation).toContain("This permanently removes the message");
  });

  test("does not offer Copy for attachment-only messages", () => {
    expect(bubble).toContain("displayContent.trim().length > 0");
    expect(bubble).not.toContain('text || "Attachment"');
  });

  test("floats older rails outside row layout so reveal and Copy do not move messages", () => {
    expect(bubble).toContain("measureInWindow");
    expect(pane).toContain("setFloatingRail");
    expect(pane).toContain('pointerEvents="box-none"');
    expect(pane).toContain("StyleSheet.absoluteFill");
    expect(pane).toContain("styles.floatingRail");
    expect(pane).toContain("persisted && item.id === latestPersistedMessageId");
    expect(pane).toContain("onActionRailReveal={persisted ?");
  });

  test("keeps mobile compact and selection-native while closing stale older rails", () => {
    expect(bubble).toContain("<Text selectable");
    expect(bubble).not.toContain("onLongPress=");
    expect(pane).toContain("revealedAtTouchStartRef");
    expect(pane).toContain("onViewableItemsChanged={handleViewableItemsChanged}");
    expect(pane).toContain("if (emojiTarget != null && !hasMessage(emojiTarget.messageId)) setEmojiTarget(null)");
    expect(pane).toContain("deleteTarget?.scopeIdentity !== deleteScopeIdentity");
    expect(pane).toContain("c.canDeleteMessage(item) ? item.id : null");
    const highlightedRow = pane.match(/highlightedRow:\s*\{[\s\S]*?\n {4}\},/)?.[0] ?? "";
    expect(highlightedRow).not.toContain("borderWidth");
  });
});
