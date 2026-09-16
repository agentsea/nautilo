/**
 * D079 Phase 2 — module-level ref for passing file-surface paths
 * from the browser column into the runtime's `sendText` without
 * restructuring the provider tree.
 *
 * Motivation: `NautiloRuntimeProvider` wraps `BrowserColumnProvider`
 * in `app.tsx`, so `useBrowserColumn()` can't be called from inside
 * the runtime provider. But every `sendText(...)` call needs the
 * *current* value of `currentFolderPath` (which changes when the
 * user swaps folders mid-conversation). Three approaches:
 *
 *   1. Flip the provider tree order. Cleaner architecturally but
 *      a larger change — `BrowserColumnProvider`'s positioning
 *      under `ToastProvider` is intentional (see app.tsx comment).
 *   2. Pass state through React context all the way up. Works but
 *      couples the runtime to browser-column internals.
 *   3. **This file** — a tiny module-level ref that
 *      `BrowserColumnProvider` publishes to on every state change
 *      (an effect), and that `sendText` reads on each call. Zero
 *      React-API surface area; it's a global variable with a
 *      getter/setter pair.
 *
 * Approach #3 is the right size for the change. The ref never
 * renders anything, doesn't own state, and isn't a replacement for
 * context — `useBrowserColumn()` stays canonical for UI consumers.
 * This ref is specifically a pathway-between-providers shim.
 *
 * Paths are always absolute when set (BrowserColumnProvider source
 * is `desktopAPI.currentFolder.getPath()` which returns absolute or
 * null). Empty string and null both mean "not set" — the runtime's
 * read-side coerces to `null` for API serialization so the wire
 * contract is consistent.
 */

export interface FileContextRef {
  currentFolder: string | null;
  /** Opaque Desktop relay identity; never included in prompt prose. */
  currentFolderRelayId: string | null;
  /**
   * D079 Phase 3 wires this. Until then, always `null` — server
   * tolerates absence by omitting the workspace sub-block in the
   * system prompt (see `buildTwoPathBlock`).
   */
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

/**
 * D079 Phase 3 — called by `WorkspaceProvider` on every root change.
 * First call fires on initial `genieWorkspace:getRoot` resolve;
 * later calls fire when setRoot/pickAndSetRoot land (Phase 3
 * follow-up work). Always-set post-boot — `ensureDefaultGenieWorkspace`
 * guarantees a non-null root.
 */
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
