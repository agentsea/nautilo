import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CUTTING_ROOM_LAYOUT,
  PREVIEW_PERCENT_KEYBOARD_STEP,
  PREVIEW_PERCENT_MAX,
  PREVIEW_PERCENT_MIN,
  adjustPreviewPercent,
  clampPreviewPercent,
  closePanelForViewport,
  enterFocus,
  exitFocus,
  setPreviewPercent,
  toggleFocus,
  togglePanelForViewport,
  toggleProjectPanel,
  togglePropertiesPanel,
} from "./cutting-room-layout";

describe("cutting room presentation layout", () => {
  test("clamps a resizable preview split to a usable range", () => {
    expect(clampPreviewPercent(2)).toBe(28);
    expect(clampPreviewPercent(99)).toBe(78);
    expect(setPreviewPercent(DEFAULT_CUTTING_ROOM_LAYOUT, 51.7).previewPercent).toBe(52);
  });

  test("adjusts the keyboard split in bounded steps", () => {
    expect(adjustPreviewPercent(DEFAULT_CUTTING_ROOM_LAYOUT, PREVIEW_PERCENT_KEYBOARD_STEP).previewPercent).toBe(54);
    expect(adjustPreviewPercent(setPreviewPercent(DEFAULT_CUTTING_ROOM_LAYOUT, PREVIEW_PERCENT_MIN), -PREVIEW_PERCENT_KEYBOARD_STEP).previewPercent).toBe(PREVIEW_PERCENT_MIN);
    expect(adjustPreviewPercent(setPreviewPercent(DEFAULT_CUTTING_ROOM_LAYOUT, PREVIEW_PERCENT_MAX), PREVIEW_PERCENT_KEYBOARD_STEP).previewPercent).toBe(PREVIEW_PERCENT_MAX);
  });

  test("focus snapshots and restores the exact prior panel layout", () => {
    const prior = setPreviewPercent(
      togglePropertiesPanel(toggleProjectPanel(DEFAULT_CUTTING_ROOM_LAYOUT)),
      63,
    );
    const focused = enterFocus(prior);
    expect(focused).toMatchObject({ projectOpen: false, propertiesOpen: false, previewPercent: 63 });
    expect(exitFocus(focused)).toEqual({ ...prior, focusSnapshot: null });
    expect(toggleFocus(toggleFocus(prior))).toEqual({ ...prior, focusSnapshot: null });
  });

  test("narrow drawers are mutually exclusive without changing desktop choices", () => {
    const desktopHidden = { ...DEFAULT_CUTTING_ROOM_LAYOUT, projectOpen: false, propertiesOpen: false };
    const narrowProject = togglePanelForViewport(desktopHidden, "project", true);
    const narrowProperties = togglePanelForViewport(narrowProject, "properties", true);
    expect(narrowProject).toMatchObject({ projectOpen: false, propertiesOpen: false, narrowDrawer: "project" });
    expect(narrowProperties.narrowDrawer).toBe("properties");
    expect(closePanelForViewport(narrowProperties, "project", true)).toBe(narrowProperties);
    expect(closePanelForViewport(narrowProperties, "properties", true).narrowDrawer).toBeNull();
    expect(togglePanelForViewport(togglePanelForViewport(desktopHidden, "project", false), "properties", false)).toMatchObject({ projectOpen: true, propertiesOpen: true });
  });

  test("focus restores an exact narrow drawer snapshot", () => {
    const narrowProperties = togglePanelForViewport(DEFAULT_CUTTING_ROOM_LAYOUT, "properties", true);
    expect(exitFocus(enterFocus(narrowProperties))).toEqual({ ...narrowProperties, focusSnapshot: null });
  });
});
