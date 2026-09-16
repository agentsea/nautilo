import { describe, expect, test } from "bun:test";
import {
  CHAT_PANEL_COMPACT_ROOM_CHROME_MAX_WIDTH_PX,
  chatPanelUsesCompactRoomChrome,
} from "../../src/rooms/chat-panel-density";

describe("chatPanelUsesCompactRoomChrome", () => {
  test("treats zero width as unknown (full chrome)", () => {
    expect(chatPanelUsesCompactRoomChrome(0)).toBe(false);
  });

  test("uses compact chrome below threshold", () => {
    expect(chatPanelUsesCompactRoomChrome(400)).toBe(true);
    expect(chatPanelUsesCompactRoomChrome(CHAT_PANEL_COMPACT_ROOM_CHROME_MAX_WIDTH_PX - 1)).toBe(
      true,
    );
  });

  test("uses full chrome at or above threshold", () => {
    expect(chatPanelUsesCompactRoomChrome(CHAT_PANEL_COMPACT_ROOM_CHROME_MAX_WIDTH_PX)).toBe(
      false,
    );
    expect(chatPanelUsesCompactRoomChrome(900)).toBe(false);
  });
});
