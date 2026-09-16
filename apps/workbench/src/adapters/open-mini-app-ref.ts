import type { OpenFileTarget } from "../components/browser-column/open-file-target";

export type OpenMiniAppMode = "edit" | "preview";

/** Apps whose document runtime has completed the host's read-only preview contract. */
export function supportsMiniAppPreview(appId: string): boolean {
  return appId === "nautilo-presentation" || appId === "nautilo-board";
}

type OpenMiniAppDispatcher = (
  appId: string,
  target?: OpenFileTarget,
  options?: { mode?: OpenMiniAppMode },
) => void;

let dispatcher: OpenMiniAppDispatcher | null = null;

export function setOpenMiniAppDispatcher(fn: OpenMiniAppDispatcher | null): void {
  dispatcher = fn;
}

/**
 * Dispatch a request to open an installed mini-app in the work surface.
 * Returns `false` when no dispatcher is registered (shell not mounted).
 */
export function requestOpenMiniApp(
  appId: string,
  target?: OpenFileTarget,
  options?: { mode?: OpenMiniAppMode },
): boolean {
  if (!dispatcher || appId.length === 0) return false;
  dispatcher(appId, target, options);
  return true;
}
