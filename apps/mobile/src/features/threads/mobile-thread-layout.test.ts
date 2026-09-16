import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mobileRoot = join(import.meta.dir, "../..");
const bubbleSource = readFileSync(join(mobileRoot, "components/message-bubble.tsx"), "utf8");
const threadSource = readFileSync(
  join(mobileRoot, "app/chat/thread/[threadRoomId].tsx"),
  "utf8",
);
const paneSource = readFileSync(join(mobileRoot, "components/room-chat-pane.tsx"), "utf8");

describe("mobile thread presentation", () => {
  test("keeps thread discovery visible before and after the first reply", () => {
    expect(bubbleSource).toContain("getMessageActionDescriptors");
    expect(bubbleSource).toContain("actionSurface");
    expect(bubbleSource).toContain("Open thread with ${replyCount}");
    expect(bubbleSource).toContain("styles.threadAffordanceChevron");
  });

  test("keeps adding a reaction visible without a long press or bright word action", () => {
    expect(bubbleSource).toContain("onReactPress?.(messageId)");
    expect(bubbleSource).toContain("<MessageActionRail");
    expect(bubbleSource).not.toContain("☺ React");
  });

  test("opens a distinct thread surface with parent context and the normal composer", () => {
    expect(threadSource).toContain("Original message");
    expect(threadSource).toContain('<RoomChatPane controller={controller} actionSurface="subthread" />');
    expect(threadSource).toContain("<RoomChatComposer");
    expect(threadSource).toContain('navigation.setOptions({ title: "Thread" })');
    expect(threadSource).not.toContain("returnToLatest");
  });

  test("bounds long parent context while replies scroll and the composer stays pinned", () => {
    expect(threadSource).toContain('accessibilityLabel="Original message content"');
    expect(threadSource).toContain("nestedScrollEnabled");
    expect(threadSource).toMatch(/maxHeight:\s*"34%"/);
    expect(threadSource).toMatch(/threadContent:\s*\{\s*flex:\s*1,\s*minHeight:\s*0\s*\}/);
    expect(threadSource).toMatch(
      /<View style=\{styles\.threadContent\}>[\s\S]*?<RoomChatPane controller=\{controller\} actionSurface="subthread" \/>[\s\S]*?<\/View>\s*<View style=\{styles\.composerDock\}>[\s\S]*?<RoomChatComposer/,
    );
    expect(threadSource).toMatch(/composerDock:\s*\{[\s\S]*?flexShrink:\s*0/);
  });

  test("dismisses the revealed rail before navigating into a thread", () => {
    expect(paneSource).toMatch(
      /dispatchReveal\(\{ type: "dismiss" \}\);\s*onThreadPress\(numericId\);/,
    );
  });
});
