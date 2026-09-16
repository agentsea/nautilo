/**
 * Presentation-only viewport payload for the host state bridge.
 * The key is fixed by the caller; page ids are already part of the scene and
 * are never sent as host identifiers or filesystem paths.
 */

import { MAX_SCALE, MIN_SCALE, type Size, type Viewport, type ViewportBounds } from "./viewport";

export const VIEWPORT_STATE_VERSION = 1;

export type DesignViewportState = {
  version: typeof VIEWPORT_STATE_VERSION;
  pages: Record<string, Viewport>;
};

export function emptyViewportState(): DesignViewportState {
  return { version: VIEWPORT_STATE_VERSION, pages: {} };
}

/** A failed read never authorizes a write that could erase unseen page views. */
export function viewportStateWriteDisposition(
  eligible: boolean,
  ready: boolean,
  unavailable: boolean,
): "none" | "probe" | "write" {
  if (!eligible || unavailable) return "none";
  return ready ? "write" : "probe";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isUsableViewport(value: unknown): value is Viewport {
  if (!isPlainRecord(value)) return false;
  const { scale, tx, ty } = value;
  return (
    typeof scale === "number" &&
    Number.isFinite(scale) &&
    scale >= MIN_SCALE &&
    scale <= MAX_SCALE &&
    typeof tx === "number" &&
    Number.isFinite(tx) &&
    typeof ty === "number" &&
    Number.isFinite(ty)
  );
}

/** Drops malformed and unknown page records without discarding known-page state. */
export function parseViewportState(value: unknown, knownPageIds: readonly string[]): DesignViewportState {
  if (!isPlainRecord(value) || value["version"] !== VIEWPORT_STATE_VERSION || !isPlainRecord(value["pages"])) {
    return emptyViewportState();
  }
  const known = new Set(knownPageIds);
  const entries = Object.entries(value["pages"])
    .filter(([pageId, viewport]) => known.has(pageId) && isUsableViewport(viewport)) as Array<[string, Viewport]>;
  return { version: VIEWPORT_STATE_VERSION, pages: Object.fromEntries(entries) };
}

/** Reinsert at the end while preserving all known page presentation states. */
export function saveViewportForPage(
  state: DesignViewportState,
  pageId: string,
  viewport: Viewport,
): DesignViewportState {
  if (!isUsableViewport(viewport)) return state;
  const entries = Object.entries(state.pages).filter(([id]) => id !== pageId);
  entries.push([pageId, { ...viewport }]);
  return {
    version: VIEWPORT_STATE_VERSION,
    pages: Object.fromEntries(entries),
  };
}

/**
 * A finite transform can still leave all current-page artwork offscreen. Such
 * a view is recovered to fit rather than restoring an empty-looking canvas.
 */
export function isViewportStranded(viewport: Viewport, bounds: ViewportBounds, size: Size, margin = 32): boolean {
  if (!isUsableViewport(viewport) || size.width <= 0 || size.height <= 0) return true;
  const minX = bounds.minX * viewport.scale + viewport.tx;
  const maxX = bounds.maxX * viewport.scale + viewport.tx;
  const minY = bounds.minY * viewport.scale + viewport.ty;
  const maxY = bounds.maxY * viewport.scale + viewport.ty;
  return maxX < -margin || minX > size.width + margin || maxY < -margin || minY > size.height + margin;
}
