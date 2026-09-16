import { DrawerShell } from "../components/DrawerShell";

export interface RoomDetailsSurfaceProps {
  roomId: string;
}

export function RoomDetailsSurface({ roomId }: RoomDetailsSurfaceProps) {
  return (
    <DrawerShell title="Room Details">
      <div className="flex flex-1 items-center justify-center p-4">
        <div className="text-center text-sm text-foreground-muted">
          <div className="mb-2 text-foreground">Room Details</div>
          <div>Room ID: {roomId}</div>
          <div className="mt-4 text-xs">Full implementation in follow-up (M1 stub)</div>
        </div>
      </div>
    </DrawerShell>
  );
}
