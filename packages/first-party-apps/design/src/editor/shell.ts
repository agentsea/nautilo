/**
 * Small shell decisions kept separate from DOM wiring so first-load and
 * keyboard behavior cannot accidentally regress while the canvas UI evolves.
 */

import type { DesignDocument } from "../scene-graph";

export type InitialCanvasTool = "frame";

export type InitialToolDecision = {
  isInitialLoad: boolean;
  document: DesignDocument;
  userHasChosenTool: boolean;
};

/** A document is genuinely empty only when it has neither nodes nor page children. */
export function isGenuinelyEmptyDocument(document: DesignDocument): boolean {
  return Object.keys(document.nodes).length === 0 && document.pages.every((page) => page.children.length === 0);
}

/**
 * Frame is a first-load affordance, not a persistent default: never replace a
 * nonempty/reloaded document's tool, nor a tool the person already chose while
 * the initial bridge read was pending.
 */
export function initialToolForLoad(decision: InitialToolDecision): InitialCanvasTool | null {
  if (!decision.isInitialLoad || decision.userHasChosenTool || !isGenuinelyEmptyDocument(decision.document)) {
    return null;
  }
  return "frame";
}

/** Canvas/document shortcuts must never intercept typing in an editor control. */
export function acceptsEditorShortcut(target: unknown): boolean {
  if (!target || typeof target !== "object") return true;
  const element = target as {
    tagName?: unknown;
    isContentEditable?: unknown;
    getAttribute?: (name: string) => string | null;
  };
  const tag = typeof element.tagName === "string" ? element.tagName : "";
  const contentEditable = element.isContentEditable === true || element.getAttribute?.("contenteditable") === "true";
  return tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT" && !contentEditable;
}

/** Space should activate a canvas gesture, never replace a focused control's native press/scroll. */
export function acceptsCanvasPanningShortcut(target: unknown): boolean {
  if (!acceptsEditorShortcut(target) || !target || typeof target !== "object") return false;
  const tag = (target as { tagName?: unknown }).tagName;
  return tag !== "BUTTON" && tag !== "A" && tag !== "SUMMARY";
}

/** The visible history controls mirror the local Store's actual history state. */
export function historyControlState(canUndo: boolean, canRedo: boolean): {
  undoDisabled: boolean;
  redoDisabled: boolean;
} {
  return { undoDisabled: !canUndo, redoDisabled: !canRedo };
}
