import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveNautiloTheme } from "../../../config/src/design-tokens";
import { DESIGN_THEME_ADAPTER, type DesignThemeMode } from "./theme-adapter";

const styles = readFileSync(join(import.meta.dir, "..", "styles.css"), "utf8");

function cssBlock(start: string, end?: string): string {
  const from = styles.indexOf(start);
  if (from === -1) throw new Error(`Missing CSS selector: ${start}`);
  const until = end === undefined ? styles.length : styles.indexOf(end, from);
  return styles.slice(from, until === -1 ? styles.length : until);
}

function expectModeCss(mode: DesignThemeMode, block: string): void {
  const theme = DESIGN_THEME_ADAPTER[mode];
  const declarations = [
    ["--design-surface-background", theme.surface.background], ["--design-surface-panel", theme.surface.panel],
    ["--design-surface-element", theme.surface.element], ["--design-surface-subtle", theme.surface.subtle],
    ["--design-text-foreground", theme.text.foreground], ["--design-text-muted", theme.text.muted],
    ["--design-text-dim", theme.text.dim], ["--design-text-on-primary", theme.text.onPrimary],
    ["--design-action-primary-bg", theme.action.primaryBg], ["--design-action-primary-hover", theme.action.primaryHover],
    ["--design-action-primary-muted", theme.action.primaryMuted], ["--design-border-default", theme.border.default],
    ["--design-border-interactive", theme.border.interactive], ["--design-status-error", theme.status.error],
    ["--design-status-warning", theme.status.warning], ["--design-status-success", theme.status.success],
    ["--design-status-info", theme.status.info],
  ] as const;
  for (const [cssName, value] of declarations) {
    expect(block).toContain(`${cssName}: ${value};`);
  }
}

describe("Design D254 theme adapter", () => {
  test("is an exact static mirror of canonical resolved semantic tokens", () => {
    for (const mode of ["light", "dark"] as const) {
      expect(resolveNautiloTheme(mode) as unknown).toMatchObject(DESIGN_THEME_ADAPTER[mode]);
    }
  });

  test("declares complete light and dark palettes inside the sandbox stylesheet", () => {
    expectModeCss("light", cssBlock(":root,", ":root[data-theme=\"dark\"]"));
    expectModeCss("dark", cssBlock(":root[data-theme=\"dark\"]", "/* A sandbox"));
    expect(styles).toContain(".design-app[data-theme=\"light\"]");
    expect(styles).toContain(".design-app[data-theme=\"dark\"]");
    expectModeCss("light", cssBlock(".design-app[data-theme=\"light\"]", ":root[data-theme=\"dark\"]"));
    expectModeCss("dark", cssBlock(".design-app[data-theme=\"dark\"]", "/* A sandbox"));
    expect(styles).toContain("@media (prefers-color-scheme: dark)");
    expectModeCss("dark", cssBlock("@media (prefers-color-scheme: dark)"));
  });

  test("application chrome consumes semantic variables instead of the retired slate palette", () => {
    for (const retiredLiteral of ["#f1f5f9", "#0f172a", "#2563eb", "#ffffff", "#e2e8f0"]) {
      expect(styles).not.toContain(retiredLiteral);
    }
    expect(styles).toContain("background: var(--design-surface-panel);");
    expect(styles).toContain("color: var(--design-text-foreground);");
    expect(styles).toContain("background: var(--design-action-primary-bg);");
    expect(styles).toContain(".design-receipt__actions button {\n  border: 1px solid var(--design-border-interactive);\n  border-radius: 5px;\n  background: var(--design-surface-background);");
    expect(styles).toContain(".design-field__input {\n  width: 100%;\n  border: 1px solid var(--design-border-default);\n  border-radius: 6px;\n  padding: 0.2rem 0.4rem;\n  font: inherit;\n  background: var(--design-surface-background);");
  });

  test("chrome rules contain no direct color literals after the generated adapter", () => {
    const chrome = cssBlock("html,\nbody");
    expect(chrome).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });
});
