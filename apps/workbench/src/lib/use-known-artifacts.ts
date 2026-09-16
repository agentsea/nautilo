import { useEffect } from "react";
import { useWorkspaceArtifacts } from "../artifacts/workspace-artifacts-provider";
import { setKnownArtifacts } from "./known-file-links";

/**
 * D322 — keep the known-artifact set (used by `linkKnownFileMentions` to
 * auto-linkify artifact mentions in a genie's prose) in sync with the
 * active room's workspace artifacts. List-based: covers artifacts authored
 * in earlier turns / earlier sessions, not just the current write. The shared
 * room artifact store applies events and reconciles incomplete payloads.
 *
 * Mounted once in the always-present `Conversation` root so linkification
 * works without the Work-surface workspace tab being open.
 */
export function useKnownArtifacts(activeRoomId: string | null | undefined): void {
  const workspaceArtifacts = useWorkspaceArtifacts();

  useEffect(() => {
    if (!activeRoomId || workspaceArtifacts.roomId !== activeRoomId) {
      setKnownArtifacts([]);
      return;
    }
    setKnownArtifacts(workspaceArtifacts.artifacts);
  }, [activeRoomId, workspaceArtifacts.artifacts, workspaceArtifacts.roomId]);
}
