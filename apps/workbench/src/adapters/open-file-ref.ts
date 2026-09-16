import type { ReaderFile } from "../components/work-surface/reader-surface";
import { isOpenFileTarget } from "../components/browser-column/open-file-target";

type OpenFileDispatcher = (file: ReaderFile) => void;

let dispatcher: OpenFileDispatcher | null = null;

export function setOpenFileDispatcher(fn: OpenFileDispatcher | null): void {
  dispatcher = fn;
}

/**
 * Dispatch a request to open a file in the reader surface.
 *
 * Returns `false` and skips the dispatcher when:
 *  - no dispatcher is registered (workbench shell not mounted yet), or
 *  - the payload doesn't have a valid `kind` discriminator (M088C
 *    item 4: silently passing through to the artifact branch would
 *    cause the viewer to 404 against the workspace artifacts API).
 *
 * Returns `true` when the dispatcher was called.
 */
export function requestOpenFile(file: ReaderFile): boolean {
  if (!dispatcher) return false;
  if (!isOpenFileTarget(file)) return false;
  dispatcher(file);
  return true;
}
