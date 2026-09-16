/** Static sandbox mirror of Nautilo's Ivory and Tokyo semantic theme tokens.
 * The presentation iframe cannot inherit Workbench variables at runtime.
 */
export const SLIDES_THEME_PALETTE = {
  light: {
    surface: { background: "#faf8f5", panel: "#f5f0eb", element: "#ece5dd" },
    text: { foreground: "#1c1917", muted: "#57534e", onPrimary: "#faf8f5" },
    action: { primaryBg: "#2d2a26", primaryHover: "#1a1816", primaryMuted: "rgba(45, 42, 38, 0.06)" },
    border: { default: "#d6d3d1" },
  },
  dark: {
    surface: { background: "#1a1b26", panel: "#1e2030", element: "#222436" },
    text: { foreground: "#c8d3f5", muted: "#828bb8", onPrimary: "#1a1b26" },
    action: { primaryBg: "#82aaff", primaryHover: "#89b4fa", primaryMuted: "rgba(130, 170, 255, 0.12)" },
    border: { default: "#3b4261" },
  },
} as const;
