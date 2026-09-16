import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mobileRoot = join(import.meta.dir, "../..");
const layoutSource = readFileSync(join(mobileRoot, "app/chat/_layout.tsx"), "utf8");
const actionsSource = readFileSync(join(mobileRoot, "components/chat-header-actions.tsx"), "utf8");
const bottomSheetSource = readFileSync(join(mobileRoot, "components/bottom-sheet.tsx"), "utf8");
const roomSource = readFileSync(join(mobileRoot, "app/chat/[roomId].tsx"), "utf8");

describe("mobile chat header contract", () => {
  test("uses one explicit Chat action and suppresses the unrelated global overflow", () => {
    expect(layoutSource).toContain("<ChatSettingsHeaderButton />");
    expect(layoutSource).toContain("showOverflow={false}");
    expect(layoutSource).not.toContain("<ChatSearchHeaderButton />");
    expect(layoutSource).not.toContain("<ChatRenameHeaderButton />");
    expect(layoutSource).not.toContain("<ChatMembersHeaderButton />");
  });

  test("keeps every existing room action reachable from the Chat sheet", () => {
    expect(actionsSource).toContain('accessibilityLabel="Chat settings"');
    expect(actionsSource).toContain('label="Search in chat"');
    expect(actionsSource).toContain('label="Rename chat"');
    expect(actionsSource).toContain('label="People"');
    expect(actionsSource).toContain("onDismiss={handleDismiss}");
    expect(actionsSource).toContain("pendingHandlerRef");
    expect(actionsSource).not.toContain("setTimeout(handler");
    expect(bottomSheetSource).toContain("Platform.OS !== 'ios'");
  });

  test("clears parent room actions while a child thread owns the header", () => {
    expect(roomSource).toContain("useIsFocused");
    // These are the three route-owned header action cleanup effects. The
    // overview has its own focus teardown guard and must not make this action
    // ownership contract brittle.
    expect(roomSource.match(/if \(!isScreenFocused \|\|/g)).toHaveLength(3);
    expect(roomSource).toContain("!canRenameRoom || !roomProjectionScope || !controller.serverUrl");
    expect(roomSource).toContain("!controller.groupedRoom");
    expect(roomSource).toContain("!controller.roomIdValid");
  });
});
