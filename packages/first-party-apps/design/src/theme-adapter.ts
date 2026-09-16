/**
 * Static Design-app mirror of D254's resolved semantic theme.
 *
 * First-party apps are bundled into a sandboxed iframe, so importing the config
 * package at runtime or inheriting Workbench CSS would make the chrome depend on
 * host implementation details. Keep this tiny copy package-local and let the
 * contract test compare it to `packages/config/src/design-tokens.ts`.
 */
export const DESIGN_THEME_ADAPTER = {
  light: {
    surface: { background: "#faf8f5", panel: "#f5f0eb", element: "#ece5dd", subtle: "#f5f0eb" },
    text: { foreground: "#1c1917", muted: "#57534e", dim: "#78716c", onPrimary: "#faf8f5" },
    action: { primaryBg: "#2d2a26", primaryHover: "#1a1816", primaryMuted: "rgba(45, 42, 38, 0.06)" },
    border: { default: "#d6d3d1", interactive: "#2d2a26" },
    status: { error: "#b33a3a", warning: "#9a6b1e", success: "#2d7a3e", info: "#5a8fa5" },
  },
  dark: {
    surface: { background: "#1a1b26", panel: "#1e2030", element: "#222436", subtle: "#1e2030" },
    text: { foreground: "#c8d3f5", muted: "#828bb8", dim: "#545c7e", onPrimary: "#1a1b26" },
    action: { primaryBg: "#82aaff", primaryHover: "#89b4fa", primaryMuted: "rgba(130, 170, 255, 0.12)" },
    border: { default: "#3b4261", interactive: "#82aaff" },
    status: { error: "#ff757f", warning: "#ffc777", success: "#c3e88d", info: "#82aaff" },
  },
} as const;

export type DesignThemeMode = keyof typeof DESIGN_THEME_ADAPTER;
