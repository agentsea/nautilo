import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveNautiloTheme } from "../../../config/src/design-tokens";
import {
  SHEETS_GRID_BACKGROUND,
  SHEETS_THEME_PALETTE,
  type SheetsThemeMode,
} from "./sheet-theme-palette";

const styles = readFileSync(join(import.meta.dir, "..", "styles.css"), "utf8");

function relativeLuminance(hex: string): number {
  const channels = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!channels) throw new Error(`Expected a six-digit hex color, got ${hex}`);
  const toLinear = (channel: string) => {
    const value = Number.parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * toLinear(channels[1])
    + 0.7152 * toLinear(channels[2])
    + 0.0722 * toLinear(channels[3]);
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)]
    .sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

function cssBlock(selector: string, nextSelector: string): string {
  const start = styles.indexOf(selector);
  if (start === -1) throw new Error(`Missing CSS selector: ${selector}`);
  const end = styles.indexOf(nextSelector, start);
  return styles.slice(start, end === -1 ? styles.length : end);
}

function expectPaletteCss(mode: SheetsThemeMode, block: string): void {
  const theme = SHEETS_THEME_PALETTE[mode];
  const declarations = [
    ["--sheets-border", theme.border.default],
    ["--sheets-border-strong", theme.border.strong],
    ["--sheets-surface", theme.surface.background],
    ["--sheets-surface-muted", theme.surface.panel],
    ["--sheets-surface-hover", theme.surface.element],
    ["--sheets-text", theme.text.foreground],
    ["--sheets-text-muted", theme.text.muted],
    ["--sheets-accent", theme.brand.accent],
    ["--sheets-focus", theme.action.primaryBg],
    ["--sheets-danger", theme.status.error],
    ["--sheets-grid-background", SHEETS_GRID_BACKGROUND[mode]],
  ] as const;
  for (const [name, value] of declarations) expect(block).toContain(`${name}: ${value};`);
}

describe("Sheets sandbox theme palette", () => {
  test("is an exact static mirror of Nautilo semantic light and dark tokens", () => {
    for (const mode of ["light", "dark"] as const) {
      expect(resolveNautiloTheme(mode) as unknown).toMatchObject(SHEETS_THEME_PALETTE[mode]);
    }
  });

  test("uses explicit shell themes and the matching Wafflebase canvas backgrounds", () => {
    const light = cssBlock(
      '.sheets-shell[data-sheets-theme="light"]',
      '.sheets-shell[data-sheets-theme="dark"]',
    );
    const dark = cssBlock('.sheets-shell[data-sheets-theme="dark"]', ".sheets-shell__header");
    expectPaletteCss("light", light);
    expectPaletteCss("dark", dark);
    expect(styles).toContain(".sheets-shell[data-sheets-theme=\"light\"] .sheets-shell__grid-host");
    expect(styles).toContain(".sheets-shell[data-sheets-theme=\"dark\"] .sheets-shell__grid-host");
    expect(styles).not.toContain("prefers-color-scheme");
  });

  test("keeps primary text, muted status, error status and action labels readable", () => {
    for (const mode of ["light", "dark"] as const) {
      const theme = SHEETS_THEME_PALETTE[mode];
      const pairs = [
        [theme.text.foreground, theme.surface.background],
        [theme.text.muted, theme.surface.background],
        [theme.status.error, theme.surface.background],
        [theme.text.onPrimary, theme.action.primaryBg],
      ] as const;
      for (const [foreground, background] of pairs) {
        expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
