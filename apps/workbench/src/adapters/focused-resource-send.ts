import type { ChatFocusedResourceRef } from "@nautilo/types";
import { MAX_FOCUSED_RESOURCES } from "./composer-focused-resources-ref";

function focusedResourceIdentity(ref: ChatFocusedResourceRef): string {
  return ref.kind === "workspace-artifact"
    ? `workspace-artifact:${ref.artifactId}`
    : `local-file:${ref.relayId}:${ref.path}`;
}

/**
 * Merge composer-authored focus with exact work-surface context.
 *
 * Explicit composer references stay first and win duplicates. Ambient context
 * is bounded by the same wire limit and never mutates the composer store, so a
 * Reader-side send can carry "this document" without creating a visible chip
 * or leaking the context into a later Room draft.
 */
export function mergeFocusedResourcesForSend(
  explicit: readonly ChatFocusedResourceRef[],
  contextual: readonly ChatFocusedResourceRef[],
): ChatFocusedResourceRef[] {
  const merged: ChatFocusedResourceRef[] = [];
  const seen = new Set<string>();
  for (const ref of [...explicit, ...contextual]) {
    if (merged.length >= MAX_FOCUSED_RESOURCES) break;
    const key = focusedResourceIdentity(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(ref);
  }
  return merged;
}
