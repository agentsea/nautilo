import { useMemo } from "react";
import type { OpenFileTarget } from "../components/browser-column/open-file-target";

export type ArtifactEventTarget = {
  id: string;
  roomId?: string;
};

export type FsEventTarget = {
  path: string;
  rootPath: string;
};

/**
 * Keep the shell's event-subscription identity independent from reader refresh
 * state. Reconnect and external-change handlers bump `reloadToken`; using the
 * complete file object as an effect dependency would unsubscribe and subscribe
 * again, causing a ready event stream to invoke `onReconnect` forever.
 */
export function useWorkSurfaceEventTargets(target: OpenFileTarget | null | undefined): {
  artifact: ArtifactEventTarget | null;
  fs: FsEventTarget | null;
} {
  const artifactId = target?.kind === "artifact" ? target.id : null;
  const artifactRoomId = target?.kind === "artifact" ? target.roomId : undefined;
  const fsPath = target?.kind === "fs" ? target.path : null;
  const fsRootPath = target?.kind === "fs" ? target.rootPath : null;

  const artifact = useMemo<ArtifactEventTarget | null>(
    () =>
      artifactId
        ? {
            id: artifactId,
            ...(artifactRoomId !== undefined ? { roomId: artifactRoomId } : {}),
          }
        : null,
    [artifactId, artifactRoomId],
  );
  const fs = useMemo<FsEventTarget | null>(
    () => (fsPath && fsRootPath ? { path: fsPath, rootPath: fsRootPath } : null),
    [fsPath, fsRootPath],
  );

  return { artifact, fs };
}
