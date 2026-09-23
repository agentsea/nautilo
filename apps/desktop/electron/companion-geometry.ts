import type { CompanionDock as Dock, CompanionView as View } from "./companion-contract";
export interface Rect { x: number; y: number; width: number; height: number }

// Visual dimensions in desktop logical pixels; these are layout choices, not
// limits on user content. Chat scrolls, and all sizes fit the available display.
const sizes: Record<View, { width: number; height: number }> = {
  orb: { width: 88, height: 88 },
  waveform: { width: 192, height: 72 },
  prompt: { width: 380, height: 132 },
  chat: { width: 380, height: 460 },
};
const inset = 8;
export function clampRect(rect: Rect, work: Rect): Rect {
  const width = Math.min(rect.width, work.width);
  const height = Math.min(rect.height, work.height);
  return {
    width, height,
    x: Math.round(Math.max(work.x, Math.min(rect.x, work.x + work.width - width))),
    y: Math.round(Math.max(work.y, Math.min(rect.y, work.y + work.height - height))),
  };
}
export function place(view: View, dock: Dock, previous: Rect, work: Rect): Rect {
  const size = sizes[view];
  const rect = { ...size, x: previous.x + (previous.width - size.width) / 2, y: previous.y + (previous.height - size.height) / 2 };
  if (dock === "left") rect.x = work.x + inset;
  if (dock === "right") rect.x = work.x + work.width - size.width - inset;
  if (dock === "top") rect.y = work.y + inset;
  if (dock === "bottom") rect.y = work.y + work.height - size.height - inset;
  return clampRect(rect, work);
}
export function nearestDock(rect: Rect, work: Rect): Dock {
  // Snap only within a deliberate 24-DIP edge target at release.
  const edges: [Dock, number][] = [
    ["left", Math.abs(rect.x - work.x)],
    ["right", Math.abs(work.x + work.width - rect.x - rect.width)],
    ["top", Math.abs(rect.y - work.y)],
    ["bottom", Math.abs(work.y + work.height - rect.y - rect.height)],
  ];
  edges.sort((a, b) => a[1] - b[1]);
  return edges[0]![1] <= 24 ? edges[0]![0] : "free";
}
export function validRect(value: unknown): value is Rect {
  if (!value || typeof value !== "object") return false;
  const r = value as Rect;
  return [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0;
}
