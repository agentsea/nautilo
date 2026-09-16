import {
  combinedBoundingBox,
  type Frame,
  type Point,
} from "@nautilo/office-slides/node";
import { screenToWorld, type Viewport } from "@nautilo/office-board";

type Size = { w: number; h: number };
export function centerOn(v: Viewport, point: Point, host: Size): Viewport {
  return {
    zoom: v.zoom,
    panX: host.w / 2 - point.x * v.zoom,
    panY: host.h / 2 - point.y * v.zoom,
  };
}
/** Fit the complete scene. The inset is UI breathing room, never a zoom floor. */
export function fitBoard(frames: Frame[], host: Size): Viewport | undefined {
  const bounds = combinedBoundingBox(frames);
  if (!bounds || host.w <= 0 || host.h <= 0) return;
  const inset = Math.min(96, host.w / 4, host.h / 4);
  const scale = Math.min(
    bounds.w > 0 ? (host.w - inset * 2) / bounds.w : Infinity,
    bounds.h > 0 ? (host.h - inset * 2) / bounds.h : Infinity,
  );
  return centerOn(
    { zoom: Number.isFinite(scale) && scale > 0 ? scale : 1, panX: 0, panY: 0 },
    { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 },
    host,
  );
}
/** A readable grid changes density as the view changes; source positions do not. */
export function gridStep(zoom: number): number {
  return 24 * Math.pow(2, Math.ceil(Math.log2(1 / zoom)));
}
export function viewportFrame(view: Viewport, size: Size): Frame {
  const top = screenToWorld(view, { x: 0, y: 0 });
  return { ...top, w: size.w / view.zoom, h: size.h / view.zoom, rotation: 0 };
}
export function editableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        'input,textarea,select,[contenteditable="true"],[data-text-edit-keepalive]',
      ),
    )
  );
}
export function readableName(kind: string): string {
  return kind
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (letter) => letter.toUpperCase());
}
