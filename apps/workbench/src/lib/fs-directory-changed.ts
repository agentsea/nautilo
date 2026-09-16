import { separatorFor } from "../components/browser-column/cited-paths";
import type { DocumentPatchEvent } from "@nautilo/types";

/** Desktop `fs:directoryChanged` payload (see Electron main + preload). */
export type FsDirectoryChangedEvent = {
  rootPath: string;
  /** Parent directory of the changed entry. */
  path: string;
  /** Exact changed file path when the watcher knows it. */
  changedPath?: string;
  source?: "relay";
  op?: string;
  reloadRequired?: boolean;
  sha256?: string;
  /** Host-only accepted-write correlation; never forwarded to iframes. */
  clientMutationId?: string;
  patchEvent?: DocumentPatchEvent;
};

function parentDirectory(filePath: string): string {
  const sep = separatorFor(filePath);
  const idx = filePath.lastIndexOf(sep);
  if (idx <= 0) return "";
  return filePath.slice(0, idx);
}

/** True when an open file should react to a directory-changed event. */
export function fsDirectoryChangeAffectsFile(
  event: FsDirectoryChangedEvent,
  filePath: string,
): boolean {
  if (event.changedPath) {
    return event.changedPath === filePath;
  }
  if (event.path === filePath) return true;
  return event.path === parentDirectory(filePath);
}
