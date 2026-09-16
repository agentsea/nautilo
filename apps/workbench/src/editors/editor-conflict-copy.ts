import { joinPath, separatorFor } from "../components/browser-column/cited-paths";
import type { OpenFileTarget } from "../components/browser-column/open-file-target";
import { basename } from "../lib/file-preview";
import { apiClient } from "../lib/api";
import { desktopAPI } from "../lib/desktop";

export type SaveConflictCopyResult =
  | { kind: "saved"; path: string }
  | { kind: "error"; message: string };

export function buildConflictCopyFileName(originalName: string): string {
  const dot = originalName.lastIndexOf(".");
  if (dot <= 0) {
    return `${originalName}.conflict-copy`;
  }
  return `${originalName.slice(0, dot)}.conflict-copy${originalName.slice(dot)}`;
}

export function resolveAvailableConflictCopyName(
  originalName: string,
  existingNames: readonly string[],
): string {
  const taken = new Set(existingNames.map((name) => name.toLowerCase()));
  let candidate = buildConflictCopyFileName(originalName);
  let counter = 2;
  while (taken.has(candidate.toLowerCase())) {
    const dot = originalName.lastIndexOf(".");
    if (dot <= 0) {
      candidate = `${originalName}.conflict-copy-${counter}`;
    } else {
      candidate = `${originalName.slice(0, dot)}.conflict-copy-${counter}${originalName.slice(dot)}`;
    }
    counter += 1;
  }
  return candidate;
}

function parentDirectory(path: string): string {
  const sep = separatorFor(path);
  const idx = path.lastIndexOf(sep);
  if (idx <= 0) return "";
  return path.slice(0, idx);
}

function artifactParentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(0, slash) : "";
}

export async function saveConflictCopy(
  file: OpenFileTarget,
  content: string,
): Promise<SaveConflictCopyResult> {
  try {
    if (file.kind === "fs") {
      const api = desktopAPI;
      if (!api) {
        return { kind: "error", message: "Desktop file bridge unavailable." };
      }

      const originalName = basename(file.path);
      const parent = parentDirectory(file.path);
      const taken: string[] = [];
      let copyName = resolveAvailableConflictCopyName(originalName, taken);
      let copyPath = parent.length > 0 ? joinPath(parent, copyName) : joinPath(file.rootPath, copyName);

      while (true) {
        try {
          const existing = await api.fs.stat(copyPath);
          if (!existing.exists) break;
          taken.push(copyName);
          copyName = resolveAvailableConflictCopyName(originalName, taken);
          copyPath = parent.length > 0 ? joinPath(parent, copyName) : joinPath(file.rootPath, copyName);
        } catch {
          break;
        }
      }

      const result = await api.fs.writeFile(copyPath, content, { baseSha256: null });
      if (!result.ok) {
        return {
          kind: "error",
          message: result.message ?? "Could not save conflict copy.",
        };
      }
      return { kind: "saved", path: copyPath };
    }

    const originalName = basename(file.path);
    const parentPath = artifactParentPath(file.path);
    const roomOpts = file.roomId !== undefined ? { roomId: file.roomId } : {};
    let siblingNames: string[] = [];
    try {
      const { artifacts } = await apiClient.listWorkspaceArtifacts(roomOpts);
      siblingNames = (artifacts ?? [])
        .filter((artifact) => artifactParentPath(artifact.path) === parentPath)
        .map((artifact) => basename(artifact.path));
    } catch {
      /* best-effort dedup */
    }

    const copyName = resolveAvailableConflictCopyName(originalName, siblingNames);
    const copyPath = parentPath.length > 0 ? joinPath(parentPath, copyName) : copyName;
    const blob = new Blob([content], { type: file.mimeType });
    await apiClient.createWorkspaceArtifact(blob, {
      path: copyPath,
      mimeType: file.mimeType,
      ...(file.roomId !== undefined ? { roomId: file.roomId } : {}),
    });
    return { kind: "saved", path: copyPath };
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : "Could not save conflict copy.",
    };
  }
}
