export type AppSourceTarget = {
  kind: "app-source";
  appId: string;
  path: string;
};

type OpenAppSourceDispatcher = (target: AppSourceTarget) => void;

let dispatcher: OpenAppSourceDispatcher | null = null;

export function setOpenAppSourceDispatcher(fn: OpenAppSourceDispatcher | null): void {
  dispatcher = fn;
}

/**
 * Dispatch a request to open a mini-app source file in the work surface.
 * Returns `false` when no dispatcher is registered (shell not mounted).
 */
export function requestOpenAppSource(target: AppSourceTarget): boolean {
  if (!dispatcher || target.appId.length === 0 || target.path.length === 0) return false;
  dispatcher(target);
  return true;
}
