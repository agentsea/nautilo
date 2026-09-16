/**
 * D079 Phase 3 — Genie's Workspace mount point (Surface A).
 *
 * Owns the Workspace root path. Queried at mount from
 * `desktopAPI.genieWorkspace.getRoot()` (main-process
 * `ensureDefaultGenieWorkspace` guarantees a non-null value on
 * desktop builds). Publishes to `file-context-ref.setWorkspacePath`
 * on every change so `NautiloRuntimeProvider.sendText` can carry the
 * workspace path in every outbound message.
 *
 * After M088C the Workspace tab no longer needs the root in-component
 * (the server's `/api/workspace/artifacts/...` routes own visibility),
 * so the prior `useWorkspace()` hook + React context were dropped.
 * This component is now a side-effect-only mount that keeps the
 * file-context-ref in sync — the React subtree it wraps consumes the
 * value through `getWorkspacePath()` instead of the React context.
 *
 * Provider order in `app.tsx`:
 *   NautiloRuntimeProvider > ToastProvider > WorkspaceProvider >
 *   BrowserColumnProvider
 * WorkspaceProvider sits ABOVE BrowserColumnProvider because both
 * publish to the file-context-ref, and because Workspace is
 * conceptually broader (app-wide) than browser-column.
 */

import { useEffect, useState, type ReactNode } from "react";
import { isDesktop, desktopAPI } from "../lib/desktop";
import { setWorkspacePath as publishWorkspacePath } from "../adapters/file-context-ref";

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [root, setRoot] = useState<string | null>(null);

  useEffect(() => {
    if (!isDesktop || !desktopAPI) return;
    let cancelled = false;
    void desktopAPI.genieWorkspace.getRoot().then((p) => {
      if (!cancelled) setRoot(p);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    publishWorkspacePath(root);
  }, [root]);

  return <>{children}</>;
}
