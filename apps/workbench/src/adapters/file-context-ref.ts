/**
 * Current file-surface paths shared with the runtime's sendText. The runtime
 * provider wraps the folder providers, so it reads this projection at message
 * submission rather than consuming their child contexts. BrowserColumnProvider
 * publishes folder changes synchronously; WorkspaceProvider publishes its root.
 * UI state remains owned by those providers. Empty paths serialize as null.
 */

export interface FileContextRef {
  currentFolder: string | null;
  /** Opaque Desktop relay identity; never included in prompt prose. */
  currentFolderRelayId: string | null;
  /** Current Genie Workspace root, or null when unavailable. */
  workspacePath: string | null;
}

const ref: FileContextRef = {
  currentFolder: null,
  currentFolderRelayId: null,
  workspacePath: null,
};

export function setCurrentFolder(path: string | null, relayId: string | null = null): void {
  ref.currentFolder = path && path.length > 0 ? path : null;
  ref.currentFolderRelayId = path && relayId && relayId.length > 0 ? relayId : null;
}

/** Published by WorkspaceProvider whenever its resolved root changes. */
export function setWorkspacePath(path: string | null): void {
  ref.workspacePath = path && path.length > 0 ? path : null;
}

/**
 * Called by `sendText` right before the `sendMessage` API call.
 * Returns a fresh snapshot every time — callers should NOT cache
 * the result. The snapshot shape matches `SendMessageRequest`'s
 * two optional path fields, so it can spread directly into the
 * request body.
 */
export function readFileContext(): Pick<FileContextRef, "currentFolder" | "currentFolderRelayId" | "workspacePath"> {
  return {
    currentFolder: ref.currentFolder,
    currentFolderRelayId: ref.currentFolderRelayId,
    workspacePath: ref.workspacePath,
  };
}
