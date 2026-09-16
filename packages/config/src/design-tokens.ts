type TokenType = "color" | "dimension" | "fontWeight" | "number";

type DesignToken<TValue, TType extends TokenType> = {
  $type: TType;
  $value: TValue;
  $description?: string;
};

const color = (
  value: `#${string}` | `rgba(${string})`,
  description?: string,
): DesignToken<typeof value, "color"> => ({
  $type: "color",
  $value: value,
  ...(description ? { $description: description } : {}),
});

const dimension = (
  value: number,
  description?: string,
): DesignToken<number, "dimension"> => ({
  $type: "dimension",
  $value: value,
  ...(description ? { $description: description } : {}),
});

const fontWeight = (
  value: number,
  description?: string,
): DesignToken<number, "fontWeight"> => ({
  $type: "fontWeight",
  $value: value,
  ...(description ? { $description: description } : {}),
});

const numberToken = (
  value: number,
  description?: string,
): DesignToken<number, "number"> => ({
  $type: "number",
  $value: value,
  ...(description ? { $description: description } : {}),
});

export const NAUTILO_THEME_MODES = ["light", "dark"] as const;
export type NautiloThemeMode = (typeof NAUTILO_THEME_MODES)[number];

/**
 * Canonical design tokens (DTCG-shaped).
 *
 * ⚠️ COLOR MIRROR CONTRACT (read before editing any color):
 * The `semantic.*` colors below are HAND-MIRRORED into
 * `apps/workbench/src/index.css` (`:root` / `.dark`). They are NOT
 * code-generated from this file — there is no build step that emits CSS
 * from these tokens. The two copies are reconciled ONLY by
 * `packages/config/tests/unit/workbench-css-token-parity.test.ts`.
 * Therefore: changing a color here does NOT change the workbench until
 * you also edit index.css (and the parity test's expectations) in the
 * same commit; otherwise the parity test fails (by design).
 *
 * LAYOUT tokens (`component.preAuth.*`) are different: PreAuthShell and
 * the Electron pre-auth helper import them at runtime, so those ARE
 * genuinely single-source. Making the COLOR path generated (true
 * single-source) is a tracked follow-up, not done here.
 *
 * A `primitive` tier was intentionally removed (it was unconsumed and
 * duplicated these values, which misleads). If a real
 * primitive→semantic reference hierarchy is wanted, that is a deliberate
 * follow-up, not an opportunistic edit.
 */
export const NAUTILO_DESIGN_TOKENS = {
  semantic: {
    light: {
      surface: {
        background: color("#faf8f5"),
        panel: color("#f5f0eb"),
        element: color("#ece5dd"),
        subtle: color("#f5f0eb", "Subtle hover/tint surface"),
        overlay: color("rgba(250, 248, 245, 0.85)"),
      },
      text: {
        foreground: color("#1c1917"),
        muted: color("#57534e"),
        dim: color("#78716c"),
        disabled: color("#a8a29e"),
        onPrimary: color("#faf8f5"),
      },
      action: {
        primary: {
          bg: color("#2d2a26"),
          hover: color("#1a1816"),
          muted: color("rgba(45, 42, 38, 0.06)"),
        },
      },
      brand: {
        accent: color("#c85040"),
        accentHover: color("#d4624e"),
      },
      hostedAuth: {
        primary: color("#c85040"),
      },
      border: {
        default: color("#d6d3d1"),
        strong: color("#c4bfb8"),
        interactive: color("#2d2a26"),
      },
      status: {
        error: color("#b33a3a"),
        warning: color("#9a6b1e"),
        success: color("#2d7a3e"),
        info: color("#5a8fa5"),
      },
    },
    dark: {
      surface: {
        background: color("#1a1b26"),
        panel: color("#1e2030"),
        element: color("#222436"),
        subtle: color("#1e2030", "Subtle hover/tint surface"),
        overlay: color("rgba(26, 27, 38, 0.85)"),
      },
      text: {
        foreground: color("#c8d3f5"),
        muted: color("#828bb8"),
        dim: color("#545c7e"),
        disabled: color("#3b4261"),
        onPrimary: color("#1a1b26"),
      },
      action: {
        primary: {
          bg: color("#82aaff"),
          hover: color("#89b4fa"),
          muted: color("rgba(130, 170, 255, 0.12)"),
        },
      },
      brand: {
        accent: color("#ff966c"),
        accentHover: color("#ffa882"),
      },
      hostedAuth: {
        primary: color(
          "#82aaff",
          "Dark hosted auth intentionally follows dark primary, not brand accent",
        ),
      },
      border: {
        default: color("#3b4261"),
        strong: color("#545c7e"),
        interactive: color("#82aaff"),
      },
      status: {
        error: color("#ff757f"),
        warning: color("#ffc777"),
        success: color("#c3e88d"),
        info: color("#82aaff"),
      },
    },
  },
  component: {
    preAuth: {
      wordmark: {
        fontSize: dimension(11),
        letterSpacing: dimension(5),
        fontWeight: fontWeight(600),
      },
      headline: {
        fontSize: dimension(30),
        letterSpacing: dimension(-0.5),
        fontWeight: fontWeight(600),
      },
      subtitle: {
        fontSize: dimension(15),
      },
      button: {
        fontSize: dimension(14),
        fontWeight: fontWeight(600),
        paddingBlock: dimension(12),
        paddingInline: dimension(28),
        radius: dimension(8),
      },
      content: {
        maxWidth: dimension(440),
      },
      gap: {
        wordmarkToHeadline: dimension(16),
        headlineToSubtitle: dimension(8),
        subtitleToContent: dimension(28),
      },
      scrim: {
        opacity: numberToken(0.5),
      },
    },
  },
} as const;

export type NautiloDesignTokens = typeof NAUTILO_DESIGN_TOKENS;

export const NAUTILO_BRAND_ACCENT = {
  light: NAUTILO_DESIGN_TOKENS.semantic.light.brand.accent.$value,
  dark: NAUTILO_DESIGN_TOKENS.semantic.dark.brand.accent.$value,
} as const;

export const NAUTILO_HOSTED_AUTH_PRIMARY = {
  light: NAUTILO_DESIGN_TOKENS.semantic.light.hostedAuth.primary.$value,
  dark: NAUTILO_DESIGN_TOKENS.semantic.dark.hostedAuth.primary.$value,
} as const;

export const NAUTILO_PRE_AUTH_LAYOUT_TOKENS =
  NAUTILO_DESIGN_TOKENS.component.preAuth;

/**
 * Flat, renderer-agnostic resolution of the semantic color tokens for one
 * theme mode. This is the portable bridge for non-CSS consumers (React
 * Native `StyleSheet` / a mobile ThemeProvider): the workbench keeps its
 * hand-mirrored CSS, but RN can't run CSS custom properties, so it consumes
 * these resolved hex/rgba strings directly from the SAME token source.
 *
 * Additive + pure (no CSS emission) — does not affect the workbench mirror
 * or the parity test. See design-tokens audit (2026-07-06).
 */
export interface NautiloResolvedTheme {
  mode: NautiloThemeMode;
  surface: {
    background: string;
    panel: string;
    element: string;
    subtle: string;
    overlay: string;
  };
  text: {
    foreground: string;
    muted: string;
    dim: string;
    disabled: string;
    onPrimary: string;
  };
  action: { primaryBg: string; primaryHover: string; primaryMuted: string };
  brand: { accent: string; accentHover: string };
  border: { default: string; strong: string; interactive: string };
  status: { error: string; warning: string; success: string; info: string };
}

/** Resolve the semantic palette for a mode into flat hex/rgba strings (RN-safe). */
export function resolveNautiloTheme(mode: NautiloThemeMode): NautiloResolvedTheme {
  const s = NAUTILO_DESIGN_TOKENS.semantic[mode];
  return {
    mode,
    surface: {
      background: s.surface.background.$value,
      panel: s.surface.panel.$value,
      element: s.surface.element.$value,
      subtle: s.surface.subtle.$value,
      overlay: s.surface.overlay.$value,
    },
    text: {
      foreground: s.text.foreground.$value,
      muted: s.text.muted.$value,
      dim: s.text.dim.$value,
      disabled: s.text.disabled.$value,
      onPrimary: s.text.onPrimary.$value,
    },
    action: {
      primaryBg: s.action.primary.bg.$value,
      primaryHover: s.action.primary.hover.$value,
      primaryMuted: s.action.primary.muted.$value,
    },
    brand: {
      accent: s.brand.accent.$value,
      accentHover: s.brand.accentHover.$value,
    },
    border: {
      default: s.border.default.$value,
      strong: s.border.strong.$value,
      interactive: s.border.interactive.$value,
    },
    status: {
      error: s.status.error.$value,
      warning: s.status.warning.$value,
      success: s.status.success.$value,
      info: s.status.info.$value,
    },
  };
}

/**
 * Electron onboarding wizard palette (D233 gateway adapter).
 *
 * Preserves the cinematic purple palette from `apps/desktop/onboarding/index.html`.
 * This is intentionally separate from Workbench semantic colors — onboarding is a
 * gateway surface, not a Workbench color migration.
 */
export const NAUTILO_ONBOARDING_CSS_VAR_NAMES = [
  "--bg",
  "--bg-panel",
  "--bg-panel-hover",
  "--border",
  "--border-active",
  "--text",
  "--text-muted",
  "--accent",
  "--accent-hover",
  "--success",
  "--warning",
  "--error",
  "--on-accent",
  "--radius-sm",
  "--radius-md",
  "--radius-lg",
] as const;

export type NautiloOnboardingCssVarName =
  (typeof NAUTILO_ONBOARDING_CSS_VAR_NAMES)[number];

export type NautiloOnboardingCssVars = Record<NautiloOnboardingCssVarName, string>;

/** Dark palette (default `:root` + prefers-color-scheme: dark). */
export const NAUTILO_ONBOARDING_PALETTE_DARK: NautiloOnboardingCssVars = {
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
};

/** Light palette (`@media (prefers-color-scheme: light)` overrides). */
export const NAUTILO_ONBOARDING_PALETTE_LIGHT: NautiloOnboardingCssVars = {
  "--bg": "#fafbff",
  "--bg-panel": "#ffffff",
  "--bg-panel-hover": "#f0f2fa",
  "--border": "#d0d6ea",
  "--border-active": "#7c3aed",
  "--text": "#1a1d33",
  "--text-muted": "#5b6887",
  "--accent": "#7c3aed",
  "--accent-hover": "#6d28d9",
  "--success": "#059669",
  "--warning": "#d97706",
  "--error": "#dc2626",
  "--on-accent": "#ffffff",
  "--radius-sm": "6px",
  "--radius-md": "10px",
  "--radius-lg": "16px",
};

function formatCssCustomPropertyDeclarations(vars: Readonly<Record<string, string>>): string {
  return Object.entries(vars)
    .map(([name, value]) => `      ${name}: ${value};`)
    .join("\n");
}

/**
 * Standalone desktop setup palette backed by the canonical semantic themes.
 * The setup HTML uses short legacy variable names, but owns no color values.
 */
export function formatSemanticSetupPaletteCssBlock(): string {
  const variables = (mode: NautiloThemeMode): Readonly<Record<string, string>> => {
    const theme = resolveNautiloTheme(mode);
    return {
      "--bg": theme.surface.background,
      "--bg-panel": theme.surface.panel,
      "--bg-panel-hover": theme.surface.element,
      "--border": theme.border.default,
      "--border-active": theme.border.interactive,
      "--text": theme.text.foreground,
      "--text-muted": theme.text.muted,
      "--accent": theme.action.primaryBg,
      "--accent-hover": theme.action.primaryHover,
      "--success": theme.status.success,
      "--warning": theme.status.warning,
      "--error": theme.status.error,
      "--on-accent": theme.text.onPrimary,
    };
  };
  return [
    ":root {",
    "      color-scheme: light dark;",
    formatCssCustomPropertyDeclarations(variables("dark")),
    "    }",
    "",
    "    @media (prefers-color-scheme: light) {",
    "      :root {",
    formatCssCustomPropertyDeclarations(variables("light")),
    "      }",
    "    }",
  ].join("\n");
}

/**
 * Build-time / raw-HTML helper: onboarding `:root` variable block matching
 * `apps/desktop/onboarding/index.html` (dark default + light media override).
 */
export function formatOnboardingPaletteCssBlock(): string {
  return [
    ":root {",
    "      color-scheme: light dark;",
    "",
    "      /* Dark palette (default + @media (prefers-color-scheme: dark)). */",
    formatCssCustomPropertyDeclarations(NAUTILO_ONBOARDING_PALETTE_DARK),
    "    }",
    "",
    "    @media (prefers-color-scheme: light) {",
    "      :root {",
    formatCssCustomPropertyDeclarations(NAUTILO_ONBOARDING_PALETTE_LIGHT),
    "      }",
    "    }",
  ].join("\n");
}
