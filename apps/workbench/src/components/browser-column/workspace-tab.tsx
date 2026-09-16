import { useEffect, useState } from "react";
import { SharedWorkspaceFiles } from "./shared-workspace-files";
/**
 * D079 Phase 3 — Workspace tab (Surface A, Genie's persistent drawer).
 *
 * Lists server-backed workspace artifacts (M088C); opens previews via HTTP.
 *
 * D184 Phase 1 — scope label header. The artifact tree is room-scoped
 * (see `ArtifactTreeView` line 108: `roomId: activeRoomId ?? undefined`),
 * which means switching rooms changes which namespace's artifacts are
 * visible. Without a clear "you're looking at room X's artifacts" signal,
 * users panic when their files seem to vanish on room switch. The label
 * here makes the scope explicit. Cross-namespace view + provenance chips
 * + share/move verbs are deferred to D184 Phase 2-4.
 */

import { useAuth } from "../../hooks/use-auth";
import { isAuthenticatedHumanViewer } from "../../hooks/viewer-authentication";
import { useCan } from "../../hooks/use-can";
import { useRoomNavigation } from "../../contexts/room-navigation-context";
import { GuestPanel } from "../guest-panel";
import { ArtifactTreeView } from "./artifact-tree-view";
import type { ActiveArtifactTarget, OpenFileTarget } from "./open-file-target";
import { useConversationEncryptionPolicyMode } from "../../adapters/runtime-contexts";

function WorkspaceScopeLabel() {
  const roomNav = useRoomNavigation();
  const activeRoomLabel = roomNav.activeRoom?.label?.trim();
  // Empty / no-room → just "Workspace" (matches pre-D184 behavior so
  // users without a room context don't see a confusing scope chip).
  // With a room → "Workspace · <room label>" so the scope is unambiguous.
  const display = activeRoomLabel ? `Workspace · ${activeRoomLabel}` : "Workspace";
  return (
    <div
      data-testid="workspace-scope-label"
      className="border-b border-border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-foreground-muted"
      title={
        activeRoomLabel
          ? `Artifacts in ${activeRoomLabel}'s namespace`
          : "Workspace artifacts (no room context)"
      }
    >
      {display}
    </div>
  );
}

export function WorkspaceTab({
  onOpenFile,
  onOpenFileEdit,
  activeArtifact,
  onCloseActiveArtifact,
}: {
  onOpenFile?: (target: OpenFileTarget) => void;
  onOpenFileEdit?: (target: OpenFileTarget) => void;
  activeArtifact?: ActiveArtifactTarget | null;
  onCloseActiveArtifact?: () => void;
}) {
  const [shared, setShared] = useState(false);
  const auth = useAuth();
  const can = useCan();
  const canWriteArtifacts = can("write_artifacts");
  const encryptionPolicyMode = useConversationEncryptionPolicyMode();
  const showLegacySharedInbox = encryptionPolicyMode !== "plaintext_only";
  const effectiveShared = shared && showLegacySharedInbox;

  useEffect(() => {
    if (!showLegacySharedInbox) setShared(false);
  }, [showLegacySharedInbox]);

  if (!isAuthenticatedHumanViewer(auth.viewer)) {
    return <GuestPanel surface="Workspace files" verb="are" />;
  }

  return (
    <div className="flex h-full flex-col">
      {showLegacySharedInbox ? <div className="flex flex-wrap items-center border-b border-border" aria-label="Workspace view">
        <button type="button" aria-pressed={!effectiveShared} onClick={() => setShared(false)} className={`px-3 py-2 text-xs ${!effectiveShared ? "border-b-2 border-accent" : "text-foreground-muted"}`}>Conversation files</button>
        <button type="button" aria-pressed={effectiveShared} onClick={() => setShared(true)} className={`px-3 py-2 text-xs ${effectiveShared ? "border-b-2 border-accent" : "text-foreground-muted"}`}>Shared with me</button>
      </div> : null}
      {!effectiveShared && <WorkspaceScopeLabel />}
      <div data-testid="workspace-tab-listing" className="min-h-0 flex-1">
        {effectiveShared ? <SharedWorkspaceFiles key={auth.viewerGeneration} onOpenFile={onOpenFile} /> : <ArtifactTreeView
          key={auth.viewerGeneration}
          onOpenFile={onOpenFile}
          onOpenFileEdit={canWriteArtifacts ? onOpenFileEdit : undefined}
          activeArtifact={activeArtifact}
          onCloseActiveArtifact={onCloseActiveArtifact}
        />}
      </div>
    </div>
  );
}
