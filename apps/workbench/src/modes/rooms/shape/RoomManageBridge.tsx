import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { useRoomNavigation } from "../../../contexts/room-navigation-context";
import { useAuth } from "../../../hooks/use-auth";
import { useCan } from "../../../hooks/use-can";
import { EXPLORER_ROOM_MANAGE_EVENT } from "../explorer/sections/shared/ExplorerRow";
import { MembersPanel } from "./MembersPanel";

/**
 * One shell-level owner for the room-management modal.
 *
 * Entry points live in both the Rooms explorer and the right Members panel, so
 * the event consumer must not be nested under either conditional surface.
 */
export function RoomManageBridge(): ReactElement | null {
  const auth = useAuth();
  const can = useCan();
  const { refreshRooms } = useRoomNavigation();
  const [manageRoom, setManageRoom] = useState<{ roomId: string; label: string } | null>(null);

  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<{ roomId?: string; label?: string }>).detail;
      if (detail?.roomId) {
        setManageRoom({ roomId: detail.roomId, label: detail.label ?? "" });
      }
    };
    window.addEventListener(EXPLORER_ROOM_MANAGE_EVENT, handler);
    return () => window.removeEventListener(EXPLORER_ROOM_MANAGE_EVENT, handler);
  }, []);

  if (!manageRoom) return null;

  return (
    <MembersPanel
      roomId={manageRoom.roomId}
      viewerActorId={auth.viewer?.sessionActorId ?? ""}
      initialMembers={[]}
      open
      onClose={() => setManageRoom(null)}
      viewerCanManageRooms={can("manage_rooms")}
      onMembershipChanged={() => void refreshRooms()}
    />
  );
}
