import {
  createOoxmlLoadOwner as createSharedOoxmlLoadOwner,
  destroyOnce,
  type OoxmlDestroyable,
  type OoxmlLoadOwner,
} from "@nautilo/browser-document-viewer";
import { OOXML_TOTAL_LOAD_TIMEOUT_MS } from "./contract";
import { sanitizeOoxmlError } from "./runtime";

export type { OoxmlDestroyable, OoxmlLoadOwner };
export { destroyOnce };

/** Workbench adapter preserves its established timeout and sanitized-error policy. */
export function createOoxmlLoadOwner(
  timeoutMs = OOXML_TOTAL_LOAD_TIMEOUT_MS,
  signal?: AbortSignal,
): OoxmlLoadOwner {
  return createSharedOoxmlLoadOwner({
    timeoutMs,
    signal,
    sanitizeError: sanitizeOoxmlError,
  });
}
