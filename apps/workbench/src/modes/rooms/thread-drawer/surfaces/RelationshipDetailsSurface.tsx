import { DrawerShell } from "../components/DrawerShell";

export interface RelationshipDetailsSurfaceProps {
  viewerActorId: string;
  counterpartActorId: string;
}

export function RelationshipDetailsSurface({
  viewerActorId,
  counterpartActorId,
}: RelationshipDetailsSurfaceProps) {
  return (
    <DrawerShell title="Relationship Details">
      <div className="flex flex-1 items-center justify-center p-4">
        <div className="text-center text-sm text-foreground-muted">
          <div className="mb-2 text-foreground">Relationship Details</div>
          <div>Viewer: {viewerActorId}</div>
          <div>Counterpart: {counterpartActorId}</div>
          <div className="mt-4 text-xs">Full implementation in follow-up (M1 stub)</div>
        </div>
      </div>
    </DrawerShell>
  );
}
