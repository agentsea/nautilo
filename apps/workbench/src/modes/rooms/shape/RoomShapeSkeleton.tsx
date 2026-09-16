import type { ReactElement } from "react";

/**
 * Neutral placeholder shown while `useRoomMembers` is fetching the
 * roster for an active room. Avoids a cosmetic flash and a composer
 * remount (audible mic beep) that would occur if ActiveRoom rendered
 * the room shell before members arrived.
 *
 * Renders an empty column matching the message-area background so the
 * layout shell does not collapse or jump.
 */
export function RoomShapeSkeleton(): ReactElement {
  return (
    <div
      role="presentation"
      aria-busy="true"
      aria-label="Loading conversation"
      className="grid h-full min-h-0 grid-rows-[1fr] bg-background"
    />
  );
}
