// D362 Tier 1/2 — launch adapter for the LibreOffice/Collabora office work
// surface. Mirrors `open-saas-app-ref.ts`: a module-level dispatcher the shell
// registers, so any launcher (artifacts panel, reader "open with") can request
// opening an office document without importing the shell.

export interface OfficeDocTarget {
  /** Workspace-artifact id backing the document. */
  artifactId: string;
  /** Human title shown in our chrome header. */
  displayName: string;
  /** Logical workspace path forwarded to the agent turn context. */
  documentPath?: string;
  /** Optional room scope for artifact resolution. */
  roomId?: string;
  /** v1 is read-only (viewer). Edit is Phase 3. */
  permission?: "readonly" | "edit";
}

type OpenOfficeDocDispatcher = (target: OfficeDocTarget) => void;

let dispatcher: OpenOfficeDocDispatcher | null = null;

export function setOpenOfficeDocDispatcher(fn: OpenOfficeDocDispatcher | null): void {
  dispatcher = fn;
}

export function requestOpenOfficeDoc(target: OfficeDocTarget): boolean {
  if (!dispatcher || target.artifactId.length === 0) {
    return false;
  }
  dispatcher(target);
  return true;
}
