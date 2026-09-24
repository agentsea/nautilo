import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";
import sharp from "sharp";

import { parseBrowserVisualGroundingOutput } from "../../../apps/desktop/electron/browser-visual-observation.ts";
import { browserVisualObservationFromRelay } from "../../../packages/agent/src/graph/browser-visual-observation.ts";

const helperPath = path.resolve(import.meta.dir, "../../../apps/desktop/vendor/browser-visual-grounding/nautilo-browser-visual-grounding");
const fixturesDirectory = path.join(import.meta.dir, "synthetic-layouts");
const nativeTest = test.skipIf(process.platform !== "darwin" || !existsSync(helperPath));

async function extract(name: string) {
  const imagePath = path.join(fixturesDirectory, name);
  const metadata = await sharp(imagePath).metadata();
  if (!metadata.width || !metadata.height) throw new Error(`missing dimensions for ${name}`);
  const stdout = execFileSync(helperPath, ["--recognition", "hybrid", imagePath], { encoding: "utf8" });
  return parseBrowserVisualGroundingOutput(stdout, imagePath, {
    width: metadata.width,
    height: metadata.height,
  });
}

describe("synthetic browser visual layouts through Apple Vision", () => {
  nativeTest("distinguishes labelled cells from flat blank interiors in a 4 by 4 grid", async () => {
    const extraction = await extract("grid-4x4-occupancy.png");
    const group = extraction.layouts.filter(({ groupId }) => groupId === "grid-1");
    expect(group).toHaveLength(16);
    const observation = browserVisualObservationFromRelay({
      version: 1,
      pageUrl: "https://synthetic.invalid/layout",
      browserSessionId: "synthetic-browser",
      observationId: "synthetic-grid-4x4",
      image: { width: 1_000, height: 800 },
      viewport: { cssWidth: 500, cssHeight: 400, dpr: 2 },
      keyboardFocus: "page",
      extraction,
    });
    const cells = observation.visual.targets.filter((target) => target.layout?.groupId === "grid-1");
    expect(cells.filter((target) => target.name === "visually blank").length).toBeGreaterThanOrEqual(12);
    // Apple's OCR can miss standalone synthetic digits, but their visible
    // contrast must never be described as a blank cell.
    expect(cells.some((target) => target.name !== "visually blank"
      && target.layout?.row === 2 && target.layout.column === 4)).toBe(true);
    expect(cells.some((target) => target.name !== "visually blank"
      && target.layout?.row === 3 && target.layout.column === 3)).toBe(true);
    expect(observation.snapshot).toContain('keyboard_focus "page"');
    expect(observation.snapshot).toContain('grid item "visually blank"');
  });

  nativeTest("finds a 3 by 5 grid from screenshot pixels", async () => {
    const extraction = await extract("grid-3x5.png");
    const group = extraction.layouts.filter(({ groupId }) => groupId === "grid-1");
    expect(group).toHaveLength(15);
    expect(group[0]).toMatchObject({ kind: "grid", rows: 3, columns: 5, itemCount: 15 });
    const observation = browserVisualObservationFromRelay({
      version: 1,
      pageUrl: "https://synthetic.invalid/layout",
      browserSessionId: "synthetic-browser",
      observationId: "synthetic-grid-3x5",
      image: { width: 1_200, height: 800 },
      viewport: { cssWidth: 600, cssHeight: 400, dpr: 2 },
      extraction,
    });
    expect(observation.snapshot).toContain('visual_group "grid-1" [kind=grid, rows=3, columns=5, items=15]');
    expect(observation.snapshot).toContain("group=grid-1, row=3, column=5");
    expect(observation.snapshot).not.toMatch(/(?:image_)?[xy]=\d+/u);
  });

  nativeTest("finds a differently scaled 2 by 3 grid", async () => {
    const extraction = await extract("grid-2x3-scaled.png");
    const group = extraction.layouts.filter(({ groupId }) => groupId === "grid-1");
    expect(group).toHaveLength(6);
    expect(group[0]).toMatchObject({ kind: "grid", rows: 2, columns: 3, itemCount: 6 });
    expect(extraction.cropRequestCount).toBeGreaterThan(0);
    expect(extraction.text.some(({ text }) => text === "A")).toBe(true);
  });

  nativeTest("keeps a toolbar row separate from a vertical list", async () => {
    const extraction = await extract("row-and-column.png");
    expect(extraction.layouts.filter(({ kind }) => kind === "row")).toHaveLength(5);
    expect(extraction.layouts.filter(({ kind }) => kind === "column")).toHaveLength(4);
  });
});
