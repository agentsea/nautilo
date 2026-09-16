import {
  NAUTILO_DESIGN_TOKENS,
  NAUTILO_HOSTED_AUTH_PRIMARY,
} from "@nautilo/config/design-tokens";

const dark = NAUTILO_DESIGN_TOKENS.semantic.dark;

/**
 * Data-only colors for Electron raw-HTML pre-auth pages.
 *
 * Keep this module free of React, DOM, and shared CSS runtime dependencies:
 * these pages render before the Workbench bundle is available.
 */
export const ELECTRON_PRE_AUTH_INLINE_COLORS = {
  background: dark.surface.background.$value,
  foreground: dark.text.foreground.$value,
  foregroundMuted: dark.text.muted.$value,
  foregroundDim: dark.text.dim.$value,
  primary: NAUTILO_HOSTED_AUTH_PRIMARY.dark,
  onPrimary: dark.text.onPrimary.$value,
  borderSubtle: "rgba(200, 211, 245, 0.22)",
  hoverSubtle: "rgba(255, 255, 255, 0.06)",
  mono: "rgba(200, 211, 245, 0.88)",
} as const;
