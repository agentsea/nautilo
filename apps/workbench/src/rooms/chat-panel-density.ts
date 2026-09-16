/**
 * D110 — layout-driven density for the Workbench chat column.
 * Below this width, room navigation uses compact chrome instead of the full tab strip.
 */
export const CHAT_PANEL_COMPACT_ROOM_CHROME_MAX_WIDTH_PX = 520;

export function chatPanelUsesCompactRoomChrome(widthPx: number): boolean {
  return widthPx > 0 && widthPx < CHAT_PANEL_COMPACT_ROOM_CHROME_MAX_WIDTH_PX;
}
