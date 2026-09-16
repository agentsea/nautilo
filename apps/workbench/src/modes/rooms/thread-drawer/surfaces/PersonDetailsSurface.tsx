import { DrawerShell } from "../components/DrawerShell";

export interface PersonDetailsSurfaceProps {
  personActorId: string;
}

export function PersonDetailsSurface({ personActorId }: PersonDetailsSurfaceProps) {
  return (
    <DrawerShell title="Person Details">
      <div className="flex flex-1 items-center justify-center p-4">
        <div className="text-center text-sm text-foreground-muted">
          <div className="mb-2 text-foreground">Person Details</div>
          <div>Actor ID: {personActorId}</div>
          <div className="mt-4 text-xs">Full implementation in follow-up (M1 stub)</div>
        </div>
      </div>
    </DrawerShell>
  );
}
