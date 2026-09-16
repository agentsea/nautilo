import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { captureExactSlideTemplateDraft, fitSlideSize, isSupportedSlidesImageType } from "./slides-surface";
import { createSlideDocument } from "./slide-document";
import { SLIDES_THEME_PALETTE } from "./slide-theme-palette";

const styles = readFileSync(join(import.meta.dir, "..", "styles.css"), "utf8");

function luminance(hex: string): number {
  const channels = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!channels) throw new Error(`Expected a six-digit hex color, got ${hex}`);
  const linear = (channel: string): number => {
    const value = Number.parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(channels[1]) + 0.7152 * linear(channels[2]) + 0.0722 * linear(channels[3]);
}

function contrast(foreground: string, background: string): number {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function mix(foreground: string, background: string, amount: number): string {
  const channels = (hex: string) => hex.match(/[0-9a-f]{2}/gi)!.map((value) => Number.parseInt(value, 16));
  const [fr, fg, fb] = channels(foreground);
  const [br, bg, bb] = channels(background);
  return `#${[fr * amount + br * (1 - amount), fg * amount + bg * (1 - amount), fb * amount + bb * (1 - amount)]
    .map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
}

describe("native slides surface helpers", () => {
  test("fits widescreen and imported aspect ratios without distortion", () => {
    expect(fitSlideSize(1000, 600, 1080)).toEqual({ width: 1000, height: 562 });
    expect(fitSlideSize(1000, 600, 1440)).toEqual({ width: 800, height: 600 });
  });

  test("accepts only self-contained raster formats supported by the surface", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
      expect(isSupportedSlidesImageType(type)).toBe(true);
    }
    expect(isSupportedSlidesImageType("image/svg+xml")).toBe(false);
    expect(isSupportedSlidesImageType("text/html")).toBe(false);
  });

  test("captures the exact active draft without mutating its source", () => {
    const source = createSlideDocument();
    const slideId = source.slides[0].id;
    const title = source.slides[0].elements.find((element) => element.type === "text");
    if (!title) throw new Error("expected title text");
    title.data.blocks[0].inlines[0].text = "Uncommitted title draft";
    const before = structuredClone(source);
    let snapshotReads = 0;
    const captured = captureExactSlideTemplateDraft({
      slideId,
      isDraftExact: () => true,
      getDraftSnapshot: () => { snapshotReads += 1; return structuredClone(source); },
    });
    expect(snapshotReads).toBe(1);
    expect(captured.slides).toHaveLength(1);
    expect(JSON.stringify(captured)).toContain("Uncommitted title draft");
    expect(source).toEqual(before);
    expect(() => captureExactSlideTemplateDraft({
      slideId,
      isDraftExact: () => false,
      getDraftSnapshot: () => { throw new Error("inexact drafts must not be read"); },
    })).toThrow("images to finish loading");
  });

  test("keeps Ivory and Tokyo primary action labels readable", () => {
    for (const theme of Object.values(SLIDES_THEME_PALETTE)) {
      expect(contrast(theme.text.onPrimary, theme.action.primaryBg)).toBeGreaterThanOrEqual(4.5);
      for (const value of [
        theme.surface.background,
        theme.surface.panel,
        theme.surface.element,
        theme.text.foreground,
        theme.text.muted,
        theme.text.onPrimary,
        theme.action.primaryBg,
        theme.action.primaryHover,
        theme.action.primaryMuted,
        theme.border.default,
      ]) expect(styles).toContain(value);
    }
  });

  test("keeps active-control text readable over the exact Nautilo brand tint", () => {
    const brand = { light: "#c85040", dark: "#ff966c" } as const;
    for (const mode of ["light", "dark"] as const) {
      const theme = SLIDES_THEME_PALETTE[mode];
      const tintedPanel = mix(brand[mode], theme.surface.panel, 0.12);
      expect(contrast(theme.action.primaryBg, tintedPanel)).toBeGreaterThanOrEqual(4.5);
      expect(styles).toContain(`--ps-brand: ${brand[mode]}`);
    }
    expect(styles).toContain(".ps-button--active { border-color:");
    expect(styles).toContain("color: var(--ps-accent);");
  });
});
