export type WorkSurfaceKind =
  | "none"
  | "file"
  | "app"
  | "app-source"
  | "saas-app"
  | "browser-research"
  | "office-doc"
  | "apps-overview"
  | "scheduled-tasks"
  | "app-detail"
  | "terminal";

export function shouldClearWorkSurfaceForAuth(
  workSurfaceKind: WorkSurfaceKind,
  isVerified: boolean,
): boolean {
  return workSurfaceKind !== "none" && !isVerified;
}
