import type { ChatArtifactRef } from "@nautilo/types";

/**
 * D356 — composer artifact-reference shim.
 *
 * Legacy send-time slot for metadata-only workspace-artifact refs. New UI
 * paths queue `ChatFocusedResourceRef` via `composer-focused-resources-ref`
 * instead; this store remains so the runtime can still forward any queued
 * D356 refs until that path is retired.
 */

export interface ComposerArtifactRef extends ChatArtifactRef {
  entryId: string;
}

const state: { items: ComposerArtifactRef[] } = { items: [] };

export function getArtifactRefs(): readonly ComposerArtifactRef[] {
  return state.items;
}

export function clearArtifactRefs(): void {
  if (state.items.length === 0) return;
  state.items = [];
}
