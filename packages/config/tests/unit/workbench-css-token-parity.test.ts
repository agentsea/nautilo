import { describe, expect, test } from "bun:test";

import {
  NAUTILO_DESIGN_TOKENS,
  NAUTILO_HOSTED_AUTH_PRIMARY,
} from "../../src/design-tokens";
import {
  NAUTILO_BRAND_COLOR_PRIMARY_DARK,
  NAUTILO_BRAND_COLOR_PRIMARY_LIGHT,
} from "../../src/brand-tokens";

const INDEX_CSS_URL = new URL(
  "../../../../apps/workbench/src/index.css",
  import.meta.url,
);

function extractBlock(css: string, selector: ":root" | ".dark"): Map<string, string> {
  const escaped = selector.replace(".", "\\.");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`));
  if (!match) {
    throw new Error(`Could not find ${selector} token block in index.css`);
  }

  const vars = new Map<string, string>();
  for (const varMatch of match[1]!.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    const name = varMatch[1];
    const value = varMatch[2];
    if (name === undefined || value === undefined) {
      throw new Error(`Malformed CSS variable declaration in ${selector} block`);
    }
    vars.set(name, value.trim());
  }
  return vars;
}

function extractThemeAliases(css: string): Map<string, string> {
  const match = css.match(/@theme\s*\{([\s\S]*?)\n\}/);
  if (!match) {
    throw new Error("Could not find @theme block in index.css");
  }

  const aliases = new Map<string, string>();
  for (const aliasMatch of match[1]!.matchAll(/--color-([\w-]+):\s*var\(--([\w-]+)\);/g)) {
    const alias = aliasMatch[1];
    const value = aliasMatch[2];
    if (alias === undefined || value === undefined) {
      throw new Error("Malformed @theme color alias declaration");
    }
    aliases.set(alias, value);
  }
  return aliases;
}

// COLOR MIRROR CONTRACT guard. design-tokens.ts (semantic.*) and
// apps/workbench/src/index.css hold the colors as TWO hand-maintained
// copies; this test is the THIRD hand-maintained list reconciling them.
// Known limitation: the `expectations` array is a curated subset, so it
// catches a *mismatch* on listed keys but NOT a token an author forgot
// to add to all three places. Making it exhaustive/bidirectional (and
// ultimately generating index.css from the tokens) is a tracked
// follow-up; until then, add new colors to all three: tokens, CSS, here.
describe("Workbench CSS token parity", () => {
  test("raw light/dark CSS variables match the canonical semantic tokens", async () => {
    const css = await Bun.file(INDEX_CSS_URL).text();
    const light = extractBlock(css, ":root");
    const dark = extractBlock(css, ".dark");
    const tokens = NAUTILO_DESIGN_TOKENS.semantic;

    const expectations = [
      ["background", tokens.light.surface.background.$value, tokens.dark.surface.background.$value],
      ["background-panel", tokens.light.surface.panel.$value, tokens.dark.surface.panel.$value],
      ["background-element", tokens.light.surface.element.$value, tokens.dark.surface.element.$value],
      ["background-subtle", tokens.light.surface.subtle.$value, tokens.dark.surface.subtle.$value],
      ["background-overlay", tokens.light.surface.overlay.$value, tokens.dark.surface.overlay.$value],
      ["foreground", tokens.light.text.foreground.$value, tokens.dark.text.foreground.$value],
      ["foreground-muted", tokens.light.text.muted.$value, tokens.dark.text.muted.$value],
      ["foreground-dim", tokens.light.text.dim.$value, tokens.dark.text.dim.$value],
      ["foreground-disabled", tokens.light.text.disabled.$value, tokens.dark.text.disabled.$value],
      ["primary", tokens.light.action.primary.bg.$value, tokens.dark.action.primary.bg.$value],
      ["primary-hover", tokens.light.action.primary.hover.$value, tokens.dark.action.primary.hover.$value],
      ["primary-muted", tokens.light.action.primary.muted.$value, tokens.dark.action.primary.muted.$value],
      ["accent-brand", tokens.light.brand.accent.$value, tokens.dark.brand.accent.$value],
      ["accent-brand-hover", tokens.light.brand.accentHover.$value, tokens.dark.brand.accentHover.$value],
      ["border", tokens.light.border.default.$value, tokens.dark.border.default.$value],
      ["border-strong", tokens.light.border.strong.$value, tokens.dark.border.strong.$value],
      ["border-interactive", tokens.light.border.interactive.$value, tokens.dark.border.interactive.$value],
      ["error", tokens.light.status.error.$value, tokens.dark.status.error.$value],
      ["warning", tokens.light.status.warning.$value, tokens.dark.status.warning.$value],
      ["success", tokens.light.status.success.$value, tokens.dark.status.success.$value],
      ["info", tokens.light.status.info.$value, tokens.dark.status.info.$value],
    ] as const;

    for (const [name, expectedLight, expectedDark] of expectations) {
      expect(light.get(name), `:root --${name}`).toBe(expectedLight);
      expect(dark.get(name), `.dark --${name}`).toBe(expectedDark);
    }
  });

  test("@theme aliases include every token consumed by Tailwind classes", async () => {
    const css = await Bun.file(INDEX_CSS_URL).text();
    const aliases = extractThemeAliases(css);

    expect(aliases.get("background-subtle")).toBe("background-subtle");
    expect(aliases.get("error")).toBe("error");
    expect(aliases.has("danger")).toBe(false);
  });

  test("hosted-auth brand colors track the token source without flattening dark mode", () => {
    expect(NAUTILO_BRAND_COLOR_PRIMARY_LIGHT).toBe(NAUTILO_HOSTED_AUTH_PRIMARY.light);
    expect(NAUTILO_BRAND_COLOR_PRIMARY_DARK).toBe(NAUTILO_HOSTED_AUTH_PRIMARY.dark);
    expect(NAUTILO_BRAND_COLOR_PRIMARY_LIGHT).toBe("#c85040");
    expect(NAUTILO_BRAND_COLOR_PRIMARY_DARK).toBe("#82aaff");
  });
});
