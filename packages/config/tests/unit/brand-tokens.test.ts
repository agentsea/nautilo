import { describe, test, expect } from "bun:test";
import {
  NAUTILO_BRAND_COLOR_PRIMARY_DARK,
  NAUTILO_BRAND_COLOR_PRIMARY_LIGHT,
  NAUTILO_HOSTED_AUTH_CSS_CUSTOM_PROPERTIES,
  NAUTILO_HOSTED_AUTH_CSS_DERIVED,
  NAUTILO_HOSTED_AUTH_CSS_PALETTE,
  formatHostedAuthCssCustomPropertiesBlock,
  getLogtoHostedSignInColorPatch,
  hexToRgba,
} from "../../src/brand-tokens";
import {
  NAUTILO_BRAND_ACCENT,
  NAUTILO_HOSTED_AUTH_PRIMARY,
} from "../../src/design-tokens";

const HEX = /^#[\da-f]{3}([\da-f]{3})?$/i;

describe("brand-tokens", () => {
  test("Logto color patch uses valid hex and enables dark mode", () => {
    const { color } = getLogtoHostedSignInColorPatch();
    expect(color.primaryColor).toMatch(HEX);
    expect(color.darkPrimaryColor).toMatch(HEX);
    expect(color.primaryColor).toBe(NAUTILO_BRAND_COLOR_PRIMARY_LIGHT);
    expect(color.darkPrimaryColor).toBe(NAUTILO_BRAND_COLOR_PRIMARY_DARK);
    expect(color.primaryColor).toBe(NAUTILO_HOSTED_AUTH_PRIMARY.light);
    expect(color.darkPrimaryColor).toBe(NAUTILO_HOSTED_AUTH_PRIMARY.dark);
    expect(color.isDarkModeEnabled).toBe(true);
  });

  test("hosted-auth CSS palette accents derive from NAUTILO_HOSTED_AUTH_PRIMARY", () => {
    expect(NAUTILO_HOSTED_AUTH_CSS_PALETTE.accent).toBe("#c85040");
    expect(NAUTILO_HOSTED_AUTH_CSS_PALETTE.accentDark).toBe("#82aaff");
    expect(NAUTILO_HOSTED_AUTH_PRIMARY.light).toBe("#c85040");
    expect(NAUTILO_HOSTED_AUTH_PRIMARY.dark).toBe("#82aaff");
    expect(NAUTILO_HOSTED_AUTH_CSS_CUSTOM_PROPERTIES["--nautilo-accent"]).toBe(
      "#c85040",
    );
    expect(NAUTILO_HOSTED_AUTH_CSS_CUSTOM_PROPERTIES["--nautilo-accent-2"]).toBe(
      "#82aaff",
    );
    expect(NAUTILO_HOSTED_AUTH_CSS_DERIVED.borderLight).toBe(
      hexToRgba("#c85040", 0.28),
    );
    expect(NAUTILO_HOSTED_AUTH_CSS_DERIVED.borderDark).toBe(
      hexToRgba("#82aaff", 0.28),
    );
  });

  test("dark hosted-auth primary stays blue and is not brand accent salmon", () => {
    expect(NAUTILO_HOSTED_AUTH_PRIMARY.dark).toBe("#82aaff");
    expect(NAUTILO_HOSTED_AUTH_CSS_PALETTE.accentDark).toBe("#82aaff");
    expect(NAUTILO_HOSTED_AUTH_CSS_PALETTE.accentDark).not.toBe(
      NAUTILO_BRAND_ACCENT.dark,
    );
  });

  test("formatHostedAuthCssCustomPropertiesBlock emits #app custom properties", () => {
    const block = formatHostedAuthCssCustomPropertiesBlock();
    expect(block).toContain("#app {");
    expect(block).toContain("--nautilo-accent: #c85040;");
    expect(block).toContain("--nautilo-accent-2: #82aaff;");
    expect(block).toContain(
      `--nautilo-border: ${NAUTILO_HOSTED_AUTH_CSS_DERIVED.borderLight};`,
    );
  });

  test("brand-tokens source stays data-only", async () => {
    const source = await Bun.file(
      new URL("../../src/brand-tokens.ts", import.meta.url),
    ).text();

    expect(source).not.toContain("from \"react\"");
    expect(source).not.toContain("from \"electron\"");
    expect(source).not.toContain("from \"node:");
  });
});
