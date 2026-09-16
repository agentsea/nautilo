/**
 * Files tab (D057 2a.1.3–2a.1.6 + 2a.1.10).
 *
 * Tree view of the **current folder** — thin wrapper around
 * {@link FileTreeView} (shared with the Workspace tab, D079).
 */

import { useCallback, useState } from "react";
import { FolderOpen } from "lucide-react";
import { useAuth } from "../../hooks/use-auth";
import { isAuthenticatedHumanViewer } from "../../hooks/viewer-authentication";
import { desktopAPI, isDesktop } from "../../lib/desktop";
import { useBrowserColumn } from "./browser-column.context";
import {
  executeFileTreeMkdir,
  formatFsMkdirError,
  type FileTreeCreateFolderContext,
  FileTreeView,
} from "./file-tree-view";
import { GuestPanel } from "../guest-panel";
import { NewFileDialog } from "../new-file-dialog";
import { buildNewEditablePath } from "../../editors/new-editable-path";
import { fsOpenFileTarget, type OpenFileTarget } from "./open-file-target";
import { useToast } from "../toast";

export function FilesTab({
  onOpenFile,
  onOpenFileEdit,
}: {
  onOpenFile?: (target: OpenFileTarget) => void;
  onOpenFileEdit?: (target: OpenFileTarget) => void;
}) {
  // Current Folder is local Human editor state, not Agent or Workspace
  // Artifact authority. The Electron profile owns the selected local root;
  // Role names and server Artifact capabilities do not govern this surface.
  const auth = useAuth();
  const toast = useToast();
  const { currentFolderPath } = useBrowserColumn();
  const [newFileDialogOpen, setNewFileDialogOpen] = useState(false);
  const [newFolderDialogOpen, setNewFolderDialogOpen] = useState(false);
  const [createFolderContext, setCreateFolderContext] = useState<FileTreeCreateFolderContext>({
    parentPath: "",
    siblingNames: [],
  });
  const [expandDirectoryPath, setExpandDirectoryPath] = useState<string | null>(null);

  const handleChooseFolder = useCallback(async () => {
    if (!desktopAPI) return;
    try {
      await desktopAPI.currentFolder.pickAndCommit();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[files-tab] current-folder pick cancelled or rejected:", msg);
    }
  }, []);

  const validateNewFileName = useCallback(
    (name: string): string | null => {
      if (!currentFolderPath) return "Open a folder first.";
      const parentPath = createFolderContext.parentPath || currentFolderPath;
      const built = buildNewEditablePath({
        parentPath,
        name,
        existingNames: createFolderContext.siblingNames,
      });
      return built.ok ? null : built.reason;
    },
    [createFolderContext.parentPath, createFolderContext.siblingNames, currentFolderPath],
  );

  const validateNewFolderName = useCallback(
    (name: string): string | null => {
      if (!currentFolderPath) return "Open a folder first.";
      const parentPath = createFolderContext.parentPath || currentFolderPath;
      const built = buildNewEditablePath({
        parentPath,
        name,
        existingNames: createFolderContext.siblingNames,
      });
      return built.ok ? null : built.reason;
    },
    [createFolderContext.parentPath, createFolderContext.siblingNames, currentFolderPath],
  );

  const handleCreateNew = useCallback(async (name: string) => {
    if (!desktopAPI || !currentFolderPath || !onOpenFileEdit) return;

    // Create inside the focused/selected directory (same context New folder
    // uses); fall back to the current-folder root when nothing is focused.
    const parentPath = createFolderContext.parentPath || currentFolderPath;
    const built = buildNewEditablePath({
      parentPath,
      name,
      existingNames: createFolderContext.siblingNames,
    });
    if (!built.ok) {
      console.warn("[files-tab] create:", built.reason);
      alert(built.reason);
      return;
    }

    try {
      const stat = await desktopAPI.fs.stat(built.path);
      if (stat.exists) {
        console.warn("[files-tab] file already exists:", built.path);
        alert("A file with that name already exists.");
        return;
      }
    } catch (err) {
      console.warn("[files-tab] stat before create failed:", err);
    }

    try {
      const result = await desktopAPI.fs.writeFile(built.path, "", { baseSha256: null });
      if (!result.ok) {
        console.warn("[files-tab] write failed:", result);
        alert("Could not create file.");
        return;
      }
      onOpenFileEdit(fsOpenFileTarget(built.path, currentFolderPath));
      setNewFileDialogOpen(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[files-tab] create failed:", msg);
      alert(msg);
    }
  }, [
    createFolderContext.parentPath,
    createFolderContext.siblingNames,
    currentFolderPath,
    onOpenFileEdit,
  ]);

  const handleCreateFolder = useCallback(
    async (name: string) => {
      if (!desktopAPI || !currentFolderPath) return;

      const parentPath = createFolderContext.parentPath || currentFolderPath;
      const built = buildNewEditablePath({
        parentPath,
        name,
        existingNames: createFolderContext.siblingNames,
      });
      if (!built.ok) {
        toast.show({
          variant: "warning",
          title: "Cannot create",
          message: built.reason,
        });
        return;
      }

      const result = await executeFileTreeMkdir({
        mkdir: desktopAPI.fs.mkdir.bind(desktopAPI.fs),
        path: built.path,
      });
      if (!result.ok) {
        const err = formatFsMkdirError(result.code, result.message);
        toast.show({ variant: "warning", title: err.title, message: err.message });
        return;
      }

      setExpandDirectoryPath(parentPath);
      setNewFolderDialogOpen(false);
      toast.show({
        variant: "success",
        title: "Folder created",
        message: built.path,
      });
    },
    [createFolderContext.parentPath, createFolderContext.siblingNames, currentFolderPath, toast],
  );

  if (!isAuthenticatedHumanViewer(auth.viewer)) {
    return <GuestPanel surface="Current folder" />;
  }

  if (!isDesktop || !desktopAPI) {
    return <CurrentFolderMissing onChooseFolder={() => void handleChooseFolder()} />;
  }

  if (!currentFolderPath) {
    return <CurrentFolderMissing onChooseFolder={() => void handleChooseFolder()} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        {/* M205: current-folder import affordance TODO - FileTreeView has no per-file context menu yet. */}
        <FileTreeView
          rootPath={currentFolderPath}
          onChooseFolderOnError={() => void handleChooseFolder()}
          dataTestId="files-tab"
          treeAriaLabel="Current folder files"
          emptyState="empty-folder"
          onOpenFile={onOpenFile}
          onNewFile={() => setNewFileDialogOpen(true)}
          onNewFolder={() => setNewFolderDialogOpen(true)}
          onCreateFolderContextChange={setCreateFolderContext}
          expandDirectoryPath={expandDirectoryPath}
          onExpandDirectoryHandled={() => setExpandDirectoryPath(null)}
        />
      </div>
      {newFileDialogOpen ? (
        <NewFileDialog
          title="New local file"
          description="Create a blank editable file in the focused directory, or the current folder root."
          validateName={validateNewFileName}
          onCancel={() => setNewFileDialogOpen(false)}
          onCreate={(name) => void handleCreateNew(name)}
        />
      ) : null}
      {newFolderDialogOpen ? (
        <NewFileDialog
          title="New local folder"
          description="Create an empty folder in the focused directory, or the current folder root."
          initialName="New folder"
          validateName={validateNewFolderName}
          onCancel={() => setNewFolderDialogOpen(false)}
          onCreate={(name) => void handleCreateFolder(name)}
        />
      ) : null}
    </div>
  );
}

/**
 * D079 Phase 1 — when no current folder is open OR Electron's bridge
 * isn't available.
 */
function CurrentFolderMissing({ onChooseFolder }: { onChooseFolder: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <FolderOpen className="h-5 w-5 text-foreground-muted" aria-hidden="true" />
      <p className="text-xs text-foreground-muted">
        No folder open.
      </p>
      <button
        type="button"
        onClick={onChooseFolder}
        className="rounded-md border border-border bg-background-element px-3 py-1.5 text-xs font-medium text-foreground hover:bg-[var(--primary-muted)]"
      >
        Open folder…
      </button>
      <p className="max-w-[16rem] text-[11px] text-foreground-muted">
        Also available via <span className="font-mono">File → Open Folder…</span>
      </p>
    </div>
  );
}
