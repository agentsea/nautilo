/** Presentation-only layout state for the cutting-room shell.
 *
 * It deliberately carries no document, selection, or playback state: changing
 * panels must never affect the bridge payload or the autosave document.
 */
export type CuttingRoomLayout = {
  projectOpen: boolean;
  propertiesOpen: boolean;
  narrowDrawer: NarrowDrawer;
  previewPercent: number;
  focusSnapshot: Omit<CuttingRoomLayout, "focusSnapshot"> | null;
};

export type NarrowDrawer = "project" | "properties" | null;
export type CuttingRoomPanel = Exclude<NarrowDrawer, null>;

export const DEFAULT_CUTTING_ROOM_LAYOUT: CuttingRoomLayout = {
  projectOpen: true,
  propertiesOpen: true,
  narrowDrawer: null,
  previewPercent: 52,
  focusSnapshot: null,
};

export type CuttingRoomPanelWidths = {
  projectWidth: "208px" | "0px";
  propertiesWidth: "220px" | "0px";
};

export function panelWidths(layout: CuttingRoomLayout): CuttingRoomPanelWidths {
  return {
    projectWidth: layout.projectOpen ? "208px" : "0px",
    propertiesWidth: layout.propertiesOpen ? "220px" : "0px",
  };
}

/** Use host-delivered chrome when it is available; OS preference is only a fallback. */
export function resolveHostTheme(hostTheme: string | undefined, fallback: ThemeMode): ThemeMode {
  return hostTheme === "light" || hostTheme === "dark" ? hostTheme : fallback;
}

export type ThemeMode = "light" | "dark";

export const PREVIEW_PERCENT_MIN = 28;
export const PREVIEW_PERCENT_MAX = 78;
export const PREVIEW_PERCENT_KEYBOARD_STEP = 2;

export function clampPreviewPercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CUTTING_ROOM_LAYOUT.previewPercent;
  return Math.min(PREVIEW_PERCENT_MAX, Math.max(PREVIEW_PERCENT_MIN, Math.round(value)));
}

export function toggleProjectPanel(layout: CuttingRoomLayout): CuttingRoomLayout {
  return { ...layout, projectOpen: !layout.projectOpen };
}

export function togglePropertiesPanel(layout: CuttingRoomLayout): CuttingRoomLayout {
  return { ...layout, propertiesOpen: !layout.propertiesOpen };
}

export function isPanelOpen(layout: CuttingRoomLayout, panel: CuttingRoomPanel, isNarrowViewport: boolean): boolean {
  return isNarrowViewport ? layout.narrowDrawer === panel : panel === "project" ? layout.projectOpen : layout.propertiesOpen;
}

/** In narrow mode drawers are overlays and therefore mutually exclusive. */
export function togglePanelForViewport(
  layout: CuttingRoomLayout,
  panel: CuttingRoomPanel,
  isNarrowViewport: boolean,
): CuttingRoomLayout {
  if (layout.focusSnapshot) return layout;
  if (!isNarrowViewport) return panel === "project" ? toggleProjectPanel(layout) : togglePropertiesPanel(layout);
  return { ...layout, narrowDrawer: layout.narrowDrawer === panel ? null : panel };
}

export function closePanelForViewport(
  layout: CuttingRoomLayout,
  panel: CuttingRoomPanel,
  isNarrowViewport: boolean,
): CuttingRoomLayout {
  if (isNarrowViewport) return layout.narrowDrawer === panel ? { ...layout, narrowDrawer: null } : layout;
  if (panel === "project") return layout.projectOpen ? toggleProjectPanel(layout) : layout;
  return layout.propertiesOpen ? togglePropertiesPanel(layout) : layout;
}

export function clearNarrowDrawer(layout: CuttingRoomLayout): CuttingRoomLayout {
  return layout.narrowDrawer ? { ...layout, narrowDrawer: null } : layout;
}

export function setPreviewPercent(layout: CuttingRoomLayout, previewPercent: number): CuttingRoomLayout {
  return { ...layout, previewPercent: clampPreviewPercent(previewPercent) };
}

export function adjustPreviewPercent(layout: CuttingRoomLayout, delta: number): CuttingRoomLayout {
  return setPreviewPercent(layout, layout.previewPercent + delta);
}

export function enterFocus(layout: CuttingRoomLayout): CuttingRoomLayout {
  if (layout.focusSnapshot) return layout;
  return {
    ...layout,
    projectOpen: false,
    propertiesOpen: false,
    narrowDrawer: null,
    focusSnapshot: {
      projectOpen: layout.projectOpen,
      propertiesOpen: layout.propertiesOpen,
      narrowDrawer: layout.narrowDrawer,
      previewPercent: layout.previewPercent,
    },
  };
}

export function exitFocus(layout: CuttingRoomLayout): CuttingRoomLayout {
  if (!layout.focusSnapshot) return layout;
  return { ...layout.focusSnapshot, focusSnapshot: null };
}

export function toggleFocus(layout: CuttingRoomLayout): CuttingRoomLayout {
  return layout.focusSnapshot ? exitFocus(layout) : enterFocus(layout);
}
