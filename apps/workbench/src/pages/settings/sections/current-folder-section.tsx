import { isDesktop } from "../../../lib/desktop";
import { useBrowserColumn } from "../../../components/browser-column/browser-column.context";
import { FieldRow, SectionCard } from "../ui";

/**
 * Settings → Current folder (D079 Phase 1 rename of WorkspaceSection).
 *
 * Shows the path of Surface B — the user's task-scoped folder. Phase 3
 * will add a sibling "Genie's Workspace" section above this one for
 * Surface A (her persistent drawer).
 *
 * Subscribes to the live current-folder path exposed by
 * BrowserColumnProvider. Context hydrates from
 * `desktopAPI.currentFolder.getPath()` on mount and refreshes on the
 * `currentFolder:pathChanged` push event whenever any commit path
 * (dropdown, tray menu, native File menu) persists a new value — so
 * Settings stays in sync without its own subscription plumbing.
 * Flagged by PR-007 review (N-7).
 */
export function CurrentFolderSection({
  isDesktopShell = isDesktop,
}: {
  isDesktopShell?: boolean;
} = {}) {
  const { currentFolderPath } = useBrowserColumn();

  if (!isDesktopShell) {
    // Web clients don't have a local current folder — skip the entire
    // section rather than render empty scaffolding.
    return null;
  }

  return (
    <SectionCard
      id="current-folder"
      title="Current folder"
      description="Task-scoped folder Nautilo is currently looking at. Change via File → Open Folder… or the 📂 picker in the browser column."
    >
      <FieldRow label="Current path">
        {currentFolderPath ? (
          <code className="block break-all rounded bg-background-element px-2 py-1.5 text-xs text-foreground">
            {currentFolderPath}
          </code>
        ) : (
          <p className="text-sm text-foreground-muted">
            No folder open. Choose one from File → Open Folder…
          </p>
        )}
      </FieldRow>
    </SectionCard>
  );
}
