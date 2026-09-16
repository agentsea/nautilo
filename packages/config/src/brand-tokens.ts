/**
 * Canonical Nautilo brand values for surfaces that cannot read Workbench CSS
 * (Logto hosted sign-in, CLI banners, docs generators, etc.).
 *
 * Keep this file data-only — no Logto types, no CSS file I/O. Per-surface
 * code maps these tokens into vendor APIs (`customCss`, Tailwind, …).
 *
 * Color sources: `design-tokens.ts` — light hosted auth follows
 * `brand.accent.light`; dark hosted auth intentionally follows
 * `hostedAuth.primary.dark` (Workbench `.dark --primary`, Tokyonight blue)
 * rather than `brand.accent.dark` (salmon).
 */

import {
  NAUTILO_DESIGN_TOKENS,
  NAUTILO_HOSTED_AUTH_PRIMARY,
} from "./design-tokens";

const lightSemantic = NAUTILO_DESIGN_TOKENS.semantic.light;
const darkSemantic = NAUTILO_DESIGN_TOKENS.semantic.dark;

/** Hosted-auth primaries are always hex (see `hostedAuth.primary` in design tokens). */
const hostedAuthPrimaryLight =
  NAUTILO_HOSTED_AUTH_PRIMARY.light as `#${string}`;
const hostedAuthPrimaryDark =
  NAUTILO_HOSTED_AUTH_PRIMARY.dark as `#${string}`;

type HexColor = `#${string}`;

function parseHexRgb(hex: HexColor): { r: number; g: number; b: number } {
  const normalized = hex.slice(1);
  const expanded =
    normalized.length === 3
      ? normalized
          .split("")
          .map((ch) => ch + ch)
          .join("")
      : normalized;
  return {
    r: Number.parseInt(expanded.slice(0, 2), 16),
    g: Number.parseInt(expanded.slice(2, 4), 16),
    b: Number.parseInt(expanded.slice(4, 6), 16),
  };
}

/** Pure helper: `#rrggbb` → `rgba(r, g, b, a)` for hosted-auth translucency. */
export function hexToRgba(hex: HexColor, alpha: number): string {
  const { r, g, b } = parseHexRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function darkenHex(hex: HexColor, amount: number): HexColor {
  const { r, g, b } = parseHexRgb(hex);
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  const toHex = (n: number) => clamp(n).toString(16).padStart(2, "0");
  return `#${toHex(r * (1 - amount))}${toHex(g * (1 - amount))}${toHex(b * (1 - amount))}` as HexColor;
}

/**
 * Logto hosted sign-in custom-CSS palette (D104 gateway adapter).
 *
 * Accent colors track `NAUTILO_HOSTED_AUTH_PRIMARY` (light terracotta /
 * dark primary blue). Surfaces and copy colors use semantic light/dark text
 * where they align; shell chrome values preserve the existing hosted gradient.
 */
export const NAUTILO_HOSTED_AUTH_CSS_PALETTE = {
  shellBg: lightSemantic.surface.background.$value,
  shellBgDark: darkSemantic.surface.background.$value,
  panel: "#f8f5ed",
  panelDark: "#171a22",
  text: lightSemantic.text.foreground.$value,
  muted: lightSemantic.text.muted.$value,
  textDark: "#f7f3ea",
  mutedDark: "#aeb6c9",
  accent: hostedAuthPrimaryLight,
  accentDark: hostedAuthPrimaryDark,
  onAccentButton: "#fff7ed",
  inputBorder: hexToRgba("#16181d", 0.16),
  viewGradientStart: hexToRgba(hostedAuthPrimaryLight, 0.10),
  viewGradientStartDark: hexToRgba(hostedAuthPrimaryLight, 0.22),
  viewGradientStops: [
    lightSemantic.surface.background.$value,
    lightSemantic.surface.panel.$value,
    lightSemantic.surface.element.$value,
  ] as const,
  viewGradientStopsDark: ["#0f1117", "#191b24", "#111319"] as const,
} as const;

/** Token-derived rgba strings for hosted-auth CSS (borders, focus rings, help box). */
export const NAUTILO_HOSTED_AUTH_CSS_DERIVED = {
  borderLight: hexToRgba(hostedAuthPrimaryLight, 0.28),
  borderDark: hexToRgba(hostedAuthPrimaryDark, 0.28),
  focusRingLight: hexToRgba(hostedAuthPrimaryLight, 0.14),
  focusRingDark: hexToRgba(hostedAuthPrimaryDark, 0.16),
  helpBoxBorderLight: hexToRgba(hostedAuthPrimaryLight, 0.18),
  helpBoxBgLight: hexToRgba(hostedAuthPrimaryLight, 0.08),
  helpBoxBorderDark: hexToRgba(hostedAuthPrimaryDark, 0.22),
  helpBoxBgDark: hexToRgba(hostedAuthPrimaryDark, 0.06),
  buttonShadow: hexToRgba(hostedAuthPrimaryLight, 0.28),
  buttonGradientStart: hostedAuthPrimaryLight,
  buttonGradientEnd: darkenHex(hostedAuthPrimaryLight, 0.18),
  cardShadow: "rgba(0, 0, 0, 0.42)",
} as const;

export const NAUTILO_HOSTED_AUTH_CSS_CUSTOM_PROPERTIES = {
  "--nautilo-bg": NAUTILO_HOSTED_AUTH_CSS_PALETTE.shellBg,
  "--nautilo-panel": NAUTILO_HOSTED_AUTH_CSS_PALETTE.panel,
  "--nautilo-panel-dark": NAUTILO_HOSTED_AUTH_CSS_PALETTE.panelDark,
  "--nautilo-border": NAUTILO_HOSTED_AUTH_CSS_DERIVED.borderLight,
  "--nautilo-accent": NAUTILO_HOSTED_AUTH_CSS_PALETTE.accent,
  "--nautilo-accent-2": NAUTILO_HOSTED_AUTH_CSS_PALETTE.accentDark,
  "--nautilo-text": NAUTILO_HOSTED_AUTH_CSS_PALETTE.text,
  "--nautilo-muted": NAUTILO_HOSTED_AUTH_CSS_PALETTE.muted,
} as const;

function formatHostedAuthCustomPropertyDeclarations(
  vars: Record<string, string>,
): string {
  return Object.entries(vars)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n");
}

/** `#app { --nautilo-*: … }` block for Logto customCss merge. */
export function formatHostedAuthCssCustomPropertiesBlock(): string {
  return [
    "#app {",
    formatHostedAuthCustomPropertyDeclarations(
      NAUTILO_HOSTED_AUTH_CSS_CUSTOM_PROPERTIES,
    ),
    "}",
  ].join("\n");
}

export const NAUTILO_PRODUCT_NAME = "Nautilo";

/** Logto `color.primaryColor` — Workbench light accent brand (terracotta). */
export const NAUTILO_BRAND_COLOR_PRIMARY_LIGHT =
  NAUTILO_HOSTED_AUTH_PRIMARY.light;

/** Logto `color.darkPrimaryColor` — Workbench dark theme primary (blue). */
export const NAUTILO_BRAND_COLOR_PRIMARY_DARK =
  NAUTILO_HOSTED_AUTH_PRIMARY.dark;

/**
 * Copy for Logto hosted flows (D104). Self-hosted / OSS: no email password reset.
 */
export const NAUTILO_HOSTED_AUTH_COPY = {
  tempPassword:
    "Using a temporary migration password? Sign in once, then change it in Nautilo Settings → Account security.",
  forgotPassword:
    "Forgot your password? This self-hosted instance does not send email resets. Use recovery codes on the same machine as your Nautilo server, or ask your local operator.",
} as const;

/** Logto PATCH `color` object fragment (default-tenant sign-in experience). */
export function getLogtoHostedSignInColorPatch(): {
  color: {
    primaryColor: string;
    isDarkModeEnabled: boolean;
    darkPrimaryColor: string;
  };
} {
  return {
    color: {
      primaryColor: NAUTILO_BRAND_COLOR_PRIMARY_LIGHT,
      isDarkModeEnabled: true,
      darkPrimaryColor: NAUTILO_BRAND_COLOR_PRIMARY_DARK,
    },
  };
}
