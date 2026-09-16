import { describe, expect, test } from "bun:test";

import {
  formatSemanticSetupPaletteCssBlock,
  NAUTILO_BRAND_ACCENT,
  NAUTILO_DESIGN_TOKENS,
  NAUTILO_HOSTED_AUTH_PRIMARY,
  NAUTILO_ONBOARDING_PALETTE_DARK,
  NAUTILO_ONBOARDING_PALETTE_LIGHT,
  NAUTILO_PRE_AUTH_LAYOUT_TOKENS,
  NAUTILO_THEME_MODES,
  formatOnboardingPaletteCssBlock,
} from "../../src/design-tokens";

describe("design tokens", () => {
  test("models light and dark themes explicitly", () => {
    expect(NAUTILO_THEME_MODES).toEqual(["light", "dark"]);
    expect(NAUTILO_DESIGN_TOKENS.semantic.light.surface.background.$value).toBe(
      "#faf8f5",
    );
    expect(NAUTILO_DESIGN_TOKENS.semantic.dark.surface.background.$value).toBe(
      "#1a1b26",
    );
  });

  test("locks brand accent and hosted-auth primary decisions", () => {
    expect(NAUTILO_BRAND_ACCENT).toEqual({
      light: "#c85040",
      dark: "#ff966c",
    });
    expect(NAUTILO_HOSTED_AUTH_PRIMARY).toEqual({
      light: "#c85040",
      dark: "#82aaff",
    });

    // Dark hosted auth intentionally follows Workbench primary blue, not
    // brand accent salmon. This catches accidental token flattening.
    expect(NAUTILO_HOSTED_AUTH_PRIMARY.dark).not.toBe(NAUTILO_BRAND_ACCENT.dark);
  });

  test("includes the background-subtle semantic token for Workbench parity", () => {
    expect(NAUTILO_DESIGN_TOKENS.semantic.light.surface.subtle.$value).toBe(
      "#f5f0eb",
    );
    expect(NAUTILO_DESIGN_TOKENS.semantic.dark.surface.subtle.$value).toBe(
      "#1e2030",
    );
  });

  test("keeps preAuth component tokens layout-only", () => {
    expect(NAUTILO_PRE_AUTH_LAYOUT_TOKENS).toEqual({
      wordmark: {
        fontSize: { $type: "dimension", $value: 11 },
        letterSpacing: { $type: "dimension", $value: 5 },
        fontWeight: { $type: "fontWeight", $value: 600 },
      },
      headline: {
        fontSize: { $type: "dimension", $value: 30 },
        letterSpacing: { $type: "dimension", $value: -0.5 },
        fontWeight: { $type: "fontWeight", $value: 600 },
      },
      subtitle: {
        fontSize: { $type: "dimension", $value: 15 },
      },
      button: {
        fontSize: { $type: "dimension", $value: 14 },
        fontWeight: { $type: "fontWeight", $value: 600 },
        paddingBlock: { $type: "dimension", $value: 12 },
        paddingInline: { $type: "dimension", $value: 28 },
        radius: { $type: "dimension", $value: 8 },
      },
      content: {
        maxWidth: { $type: "dimension", $value: 440 },
      },
      gap: {
        wordmarkToHeadline: { $type: "dimension", $value: 16 },
        headlineToSubtitle: { $type: "dimension", $value: 8 },
        subtitleToContent: { $type: "dimension", $value: 28 },
      },
      scrim: {
        opacity: { $type: "number", $value: 0.5 },
      },
    });

    expect(JSON.stringify(NAUTILO_PRE_AUTH_LAYOUT_TOKENS)).not.toContain("#");
  });

  test("token source stays data-only", async () => {
    const source = await Bun.file(
      new URL("../../src/design-tokens.ts", import.meta.url),
    ).text();

    expect(source).not.toMatch(/^import\s/m);
    expect(source).not.toContain("from \"react\"");
    expect(source).not.toContain("from \"electron\"");
    expect(source).not.toContain("from \"node:");
  });

  test("onboarding adapter preserves index.html palette values", () => {
    expect(NAUTILO_ONBOARDING_PALETTE_DARK).toMatchObject({
      "--bg": "#0a0d16",
      "--bg-panel": "#13182a",
      "--bg-panel-hover": "#1a2140",
      "--border": "#2c355a",
      "--border-active": "#a78bfa",
      "--text": "#e4e8f5",
      "--text-muted": "#8892b0",
      "--accent": "#a78bfa",
      "--accent-hover": "#c4b5fd",
      "--success": "#34d399",
      "--warning": "#fbbf24",
      "--error": "#f87171",
      "--on-accent": "#0a0d16",
      "--radius-sm": "6px",
      "--radius-md": "10px",
      "--radius-lg": "16px",
    });
    expect(NAUTILO_ONBOARDING_PALETTE_LIGHT).toMatchObject({
      "--bg": "#fafbff",
      "--bg-panel": "#ffffff",
      "--accent": "#7c3aed",
      "--on-accent": "#ffffff",
    });
  });

  test("formatOnboardingPaletteCssBlock emits :root vars and light media override", () => {
    const block = formatOnboardingPaletteCssBlock();
    expect(block).toContain(":root {");
    expect(block).toContain("color-scheme: light dark");
    expect(block).toContain("--accent: #a78bfa;");
    expect(block).toContain("@media (prefers-color-scheme: light)");
    expect(block).toContain("--accent: #7c3aed;");
    expect(block).not.toContain("from \"react\"");
  });

  test("semantic setup adapter emits only canonical light and dark theme values", () => {
    const block = formatSemanticSetupPaletteCssBlock();
    expect(block).toContain("--bg: #1a1b26;");
    expect(block).toContain("--bg-panel: #1e2030;");
    expect(block).toContain("--accent: #82aaff;");
    expect(block).toContain("@media (prefers-color-scheme: light)");
    expect(block).toContain("--bg: #faf8f5;");
    expect(block).toContain("--accent: #2d2a26;");
    expect(block).not.toContain("#0f1420");
    expect(block).not.toContain("#7aa2f7");
  });
});
