/**
 * Presentation-only state for the Design canvas shell.  This deliberately has
 * no dependency on the document Store: hiding a supporting panel must never
 * change artwork, selection, tool choice, or autosave state.
 */

export type CanvasPanel = "layers" | "inspector";

export type CanvasLayout = {
  layersVisible: boolean;
  inspectorVisible: boolean;
  narrowDrawer: CanvasPanel | null;
  fullCanvas: boolean;
  restore: Omit<CanvasLayout, "restore"> | null;
};

export function createCanvasLayout(): CanvasLayout {
  return {
    layersVisible: true,
    inspectorVisible: true,
    narrowDrawer: null,
    fullCanvas: false,
    restore: null,
  };
}

/** Desktop panels toggle independently. Narrow layouts expose one drawer at a time. */
export function toggleCanvasPanel(
  layout: CanvasLayout,
  panel: CanvasPanel,
  narrow: boolean,
): CanvasLayout {
  if (layout.fullCanvas) return exitFullCanvas(layout);
  if (narrow) {
    return { ...layout, narrowDrawer: layout.narrowDrawer === panel ? null : panel };
  }
  return panel === "layers"
    ? { ...layout, layersVisible: !layout.layersVisible }
    : { ...layout, inspectorVisible: !layout.inspectorVisible };
}

export function enterFullCanvas(layout: CanvasLayout): CanvasLayout {
  if (layout.fullCanvas) return layout;
  return {
    layersVisible: false,
    inspectorVisible: false,
    narrowDrawer: null,
    fullCanvas: true,
    restore: {
      layersVisible: layout.layersVisible,
      inspectorVisible: layout.inspectorVisible,
      narrowDrawer: layout.narrowDrawer,
      fullCanvas: false,
    },
  };
}

export function exitFullCanvas(layout: CanvasLayout): CanvasLayout {
  if (!layout.fullCanvas) return layout;
  const restore = layout.restore;
  return restore
    ? { ...restore, restore: null }
    : { ...createCanvasLayout(), restore: null };
}

export function toggleFullCanvas(layout: CanvasLayout): CanvasLayout {
  return layout.fullCanvas ? exitFullCanvas(layout) : enterFullCanvas(layout);
}

/** Escape closes a narrow supporting drawer before it affects canvas state. */
export function closeNarrowDrawer(layout: CanvasLayout): CanvasLayout {
  return layout.narrowDrawer === null ? layout : { ...layout, narrowDrawer: null };
}
