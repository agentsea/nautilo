// D381 — mobile design tokens. Colors come from the SHARED source
// (@nautilo/config/design-tokens → resolveNautiloTheme) so the app matches
// the workbench brand (light "Manga Minimal" / dark "Tokyonight Moon") from
// one source of truth. Spacing / radii / typography are mobile-side scales
// (the workbench doesn't tokenize these yet — it uses Tailwind utilities).
import {
  resolveNautiloTheme,
  type NautiloResolvedTheme,
  type NautiloThemeMode,
} from "@nautilo/config/design-tokens";

/** 4pt spacing scale. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radii = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
} as const;

/** Type scale (RN TextStyle fragments). Font family = system UI (matches workbench body stack). */
export const typography = {
  title: { fontSize: 28, fontWeight: "700" as const, lineHeight: 34 },
  heading: { fontSize: 22, fontWeight: "700" as const, lineHeight: 28 },
  subheading: { fontSize: 17, fontWeight: "600" as const, lineHeight: 22 },
  body: { fontSize: 16, fontWeight: "400" as const, lineHeight: 22 },
  bodyStrong: { fontSize: 16, fontWeight: "600" as const, lineHeight: 22 },
  label: { fontSize: 14, fontWeight: "600" as const, lineHeight: 18 },
  caption: { fontSize: 12, fontWeight: "500" as const, lineHeight: 16 },
} as const;

export interface AppTheme {
  mode: NautiloThemeMode;
  /** Resolved semantic colors (surface/text/action/brand/border/status). */
  color: NautiloResolvedTheme;
  spacing: typeof spacing;
  radii: typeof radii;
  typography: typeof typography;
}

/** Build the full theme for a mode (shared colors + mobile scale). */
export function buildAppTheme(mode: NautiloThemeMode): AppTheme {
  return { mode, color: resolveNautiloTheme(mode), spacing, radii, typography };
}
