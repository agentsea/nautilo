import { describe, expect, test } from "bun:test";
import {
  createCanvasLayout,
  closeNarrowDrawer,
  enterFullCanvas,
  exitFullCanvas,
  toggleCanvasPanel,
} from "./canvas-layout";

describe("canvas layout presentation state", () => {
  test("desktop supporting panels toggle independently", () => {
    let layout = createCanvasLayout();
    layout = toggleCanvasPanel(layout, "layers", false);
    expect(layout.layersVisible).toBe(false);
    expect(layout.inspectorVisible).toBe(true);
    layout = toggleCanvasPanel(layout, "inspector", false);
    expect(layout.layersVisible).toBe(false);
    expect(layout.inspectorVisible).toBe(false);
  });

  test("narrow layout exposes at most one drawer", () => {
    let layout = createCanvasLayout();
    layout = toggleCanvasPanel(layout, "layers", true);
    expect(layout.narrowDrawer).toBe("layers");
    layout = toggleCanvasPanel(layout, "inspector", true);
    expect(layout.narrowDrawer).toBe("inspector");
    layout = toggleCanvasPanel(layout, "inspector", true);
    expect(layout.narrowDrawer).toBeNull();
  });

  test("Escape can close a narrow drawer without changing panel visibility", () => {
    const layout = toggleCanvasPanel(createCanvasLayout(), "layers", true);
    expect(closeNarrowDrawer(layout)).toMatchObject({ narrowDrawer: null, layersVisible: true, inspectorVisible: true });
  });

  test("full canvas restores the exact pre-entry supporting-surface state", () => {
    let layout = createCanvasLayout();
    layout = toggleCanvasPanel(layout, "layers", false);
    const full = enterFullCanvas(layout);
    expect(full).toMatchObject({ fullCanvas: true, layersVisible: false, inspectorVisible: false, narrowDrawer: null });
    expect(exitFullCanvas(full)).toMatchObject({ fullCanvas: false, layersVisible: false, inspectorVisible: true });
  });
});
