/**
 * Static sandbox mirror of Nautilo's semantic theme tokens.
 *
 * The spreadsheet runs in an iframe, so it cannot inherit Workbench CSS or
 * import the config package at runtime. Keep this deliberately small mirror
 * beside the shell and verify it against `resolveNautiloTheme` in the contract
 * test.
 */
export const SHEETS_THEME_PALETTE = {
  light: {
    surface: { background: "#faf8f5", panel: "#f5f0eb", element: "#ece5dd", subtle: "#f5f0eb" },
    text: { foreground: "#1c1917", muted: "#57534e", dim: "#78716c", onPrimary: "#faf8f5" },
    action: { primaryBg: "#2d2a26", primaryHover: "#1a1816", primaryMuted: "rgba(45, 42, 38, 0.06)" },
    brand: { accent: "#c85040", accentHover: "#d4624e" },
    border: { default: "#d6d3d1", strong: "#c4bfb8", interactive: "#2d2a26" },
    status: { error: "#b33a3a", warning: "#9a6b1e", success: "#2d7a3e", info: "#5a8fa5" },
  },
  dark: {
    surface: { background: "#1a1b26", panel: "#1e2030", element: "#222436", subtle: "#1e2030" },
    text: { foreground: "#c8d3f5", muted: "#828bb8", dim: "#545c7e", onPrimary: "#1a1b26" },
    action: { primaryBg: "#82aaff", primaryHover: "#89b4fa", primaryMuted: "rgba(130, 170, 255, 0.12)" },
    brand: { accent: "#ff966c", accentHover: "#ffa882" },
    border: { default: "#3b4261", strong: "#545c7e", interactive: "#82aaff" },
    status: { error: "#ff757f", warning: "#ffc777", success: "#c3e88d", info: "#82aaff" },
  },
} as const;

export type SheetsThemeMode = keyof typeof SHEETS_THEME_PALETTE;

/** The embedded Wafflebase grid has its own fixed light and dark canvases. */
export const SHEETS_GRID_BACKGROUND: Record<SheetsThemeMode, string> = {
  light: "#ffffff",
  dark: "#1e1e1e",
};
