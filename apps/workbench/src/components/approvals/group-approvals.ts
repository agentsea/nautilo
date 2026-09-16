import type { CommandApprovalRow } from "@nautilo/api-client";

export interface ApprovalRoomGroup {
  roomId: string;
  roomLabel: string | null;
  rows: CommandApprovalRow[];
}

export interface GroupedApprovals {
  /** `ALWAYS · SERVER-WIDE` — scope === "server", server order preserved. */
  server: CommandApprovalRow[];
  /** One group per room, first-seen room order preserved. */
  rooms: ApprovalRoomGroup[];
}

export const SERVER_GROUP_TITLE = "ALWAYS · SERVER-WIDE";

export function roomGroupTitle(group: ApprovalRoomGroup): string {
  return `ROOM · ${group.roomLabel ?? "(unknown)"}`;
}

export function roomGroupTestId(group: ApprovalRoomGroup): string {
  return `approval-group-${roomGroupTitle(group)}`;
}

/**
 * Split standing approvals into scope groups. Server rows first in render;
 * within each group the caller keeps the server-provided order (newest-first).
 */
export function groupApprovalsByScope(rows: readonly CommandApprovalRow[]): GroupedApprovals {
  const server: CommandApprovalRow[] = [];
  const roomOrder: string[] = [];
  const roomMap = new Map<string, ApprovalRoomGroup>();

  for (const row of rows) {
    if (row.scope === "server") {
      server.push(row);
      continue;
    }

    const roomId = row.roomId ?? "__unknown__";
    let group = roomMap.get(roomId);
    if (!group) {
      group = { roomId, roomLabel: row.roomLabel, rows: [] };
      roomMap.set(roomId, group);
      roomOrder.push(roomId);
    }
    group.rows.push(row);
  }

  return {
    server,
    rooms: roomOrder.map((id) => roomMap.get(id)!),
  };
}
