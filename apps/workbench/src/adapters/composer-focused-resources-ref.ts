import type { ChatFocusedResourceRef } from "@nautilo/types";

export const MAX_FOCUSED_RESOURCES = 30;

export type ComposerFocusedResource = {
  entryId: string;
  /** Public, bounded display text including the `@` marker. */
  label: string;
  ref: ChatFocusedResourceRef;
};

type Listener = () => void;

const state: { items: ComposerFocusedResource[] } = { items: [] };
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

function identity(ref: ChatFocusedResourceRef): string {
  return ref.kind === "workspace-artifact"
    ? `workspace-artifact:${ref.artifactId}`
    : `local-file:${ref.relayId}:${ref.path}`;
}

function newEntryId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `focus-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function boundedLabel(label: string): string {
  // eslint-disable-next-line no-control-regex -- strip controls from display-only labels
  const clean = label.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 160);
  return clean.startsWith("@") ? clean : `@${clean || "file"}`;
}

/** Add a turn-scoped focus ref, deduped by its kind-specific stable identity. */
export function addFocusedResource(
  ref: ChatFocusedResourceRef,
  label: string,
): ComposerFocusedResource | null {
  const existing = state.items.find((item) => identity(item.ref) === identity(ref));
  if (existing) return existing;
  if (state.items.length >= MAX_FOCUSED_RESOURCES) return null;
  const item = { entryId: newEntryId(), label: boundedLabel(label), ref };
  state.items = [...state.items, item];
  notify();
  return item;
}

export function getFocusedResources(): readonly ComposerFocusedResource[] {
  return state.items;
}

export function getFocusedResourcesSnapshot(): readonly ComposerFocusedResource[] {
  return state.items;
}

export function hasFocusedResource(entryId: string): boolean {
  return state.items.some((item) => item.entryId === entryId);
}


export function removeFocusedResource(entryId: string): void {
  const items = state.items.filter((item) => item.entryId !== entryId);
  if (items.length === state.items.length) return;
  state.items = items;
  notify();
}

export function clearFocusedResources(): void {
  if (state.items.length === 0) return;
  state.items = [];
  notify();
}

/** Restores a bounded room-draft snapshot; malformed/untrusted entries are dropped. */
export function restoreFocusedResources(items: readonly ComposerFocusedResource[]): void {
  const next: ComposerFocusedResource[] = [];
  const identities = new Set<string>();
  for (const item of items) {
    if (
      next.length >= MAX_FOCUSED_RESOURCES ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(item.entryId) ||
      !item.ref ||
      (item.ref.kind !== "workspace-artifact" && item.ref.kind !== "local-file")
    ) {
      continue;
    }
    const key = identity(item.ref);
    if (identities.has(key)) continue;
    identities.add(key);
    next.push({ entryId: item.entryId, label: boundedLabel(item.label), ref: item.ref });
  }
  state.items = next;
  notify();
}

export function subscribeFocusedResources(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
