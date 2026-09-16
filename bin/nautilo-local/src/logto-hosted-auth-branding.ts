/**
 * D104 Phase 5 — reconcile Logto default-tenant hosted sign-in experience
 * with Nautilo brand tokens from `@nautilo/config` (colors + guidance CSS).
 *
 * M105 Phase B — version the hosted-auth brand block and strip legacy blocks
 * on merge, extend SIE patch with idempotent `passwordPolicy.rejects.pwned`.
 *
 * Logto OSS PATCH is partial-friendly for the fields we send; we never
 * replace `signIn` / `signUp` objects here. See `research/logto-integration-v1.md`.
 */
import {
  formatHostedAuthCssCustomPropertiesBlock,
  getLogtoHostedSignInColorPatch,
  NAUTILO_HOSTED_AUTH_COPY,
  NAUTILO_HOSTED_AUTH_CSS_DERIVED,
  NAUTILO_HOSTED_AUTH_CSS_PALETTE,
  NAUTILO_PRODUCT_NAME,
} from "@nautilo/config";

/**
 * Sentinel pair for the Nautilo-owned `customCss` block. When the version in
 * these markers changes, the next bootstrap replaces older blocks: legacy
 * pairs are removed in `stripNautiloHostedBrandingCss` before the new fragment
 * is appended.
 */
export const LOGTO_HOSTED_BRANDING_RULE_VERSION = "v5";
const NAUTILO_LOGTO_HOSTED_BRANDING_CSS_BEGIN =
  `/* nautilo-hosted-auth-branding:${LOGTO_HOSTED_BRANDING_RULE_VERSION} begin */`;
const NAUTILO_LOGTO_HOSTED_BRANDING_CSS_END =
  `/* nautilo-hosted-auth-branding:${LOGTO_HOSTED_BRANDING_RULE_VERSION} end */`;

/** Prior sentinel pairs only — keep in sync when bumping the canonical pair above. */
const LEGACY_NAUTILO_LOGTO_HOSTED_BRANDING_SENTINEL_PAIRS: ReadonlyArray<
  readonly [string, string]
> = [
  [
    "/* nautilo-hosted-auth-branding:v1 begin */",
    "/* nautilo-hosted-auth-branding:v1 end */",
  ],
  [
    "/* nautilo-hosted-auth-branding:v2 begin */",
    "/* nautilo-hosted-auth-branding:v2 end */",
  ],
  [
    "/* nautilo-hosted-auth-branding:v3 begin */",
    "/* nautilo-hosted-auth-branding:v3 end */",
  ],
  [
    "/* nautilo-hosted-auth-branding:v4 begin */",
    "/* nautilo-hosted-auth-branding:v4 end */",
  ],
];

function escapeForCssContent(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, "\\A ");
}

/**
 * Logto hosted UI uses CSS modules, so selectors intentionally target stable
 * shape/attribute hints instead of exact generated class names. This is the
 * Nautilo-owned block: make the hosted page feel first-party and remove Logto
 * product marks from the user-facing credential surface.
 */
function buildNautiloHostedBrandingCssFragment(): string {
  const palette = NAUTILO_HOSTED_AUTH_CSS_PALETTE;
  const derived = NAUTILO_HOSTED_AUTH_CSS_DERIVED;
  const [viewGrad0, viewGrad1, viewGrad2] = palette.viewGradientStops;
  const [viewGradDark0, viewGradDark1, viewGradDark2] = palette.viewGradientStopsDark;
  const helpCopy = `${escapeForCssContent(NAUTILO_HOSTED_AUTH_COPY.tempPassword)}\\A\\A ${escapeForCssContent(NAUTILO_HOSTED_AUTH_COPY.forgotPassword)}`;
  return [
    NAUTILO_LOGTO_HOSTED_BRANDING_CSS_BEGIN,
    `#app,`,
    `#app * {`,
    `  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;`,
    `}`,
    ``,
    formatHostedAuthCssCustomPropertiesBlock(),
    ``,
    // The hosted form runs inside a browser/custom tab rather than React
    // Native. The visual viewport becomes shorter when a software keyboard is
    // shown, so the root must shrink and scroll instead of retaining Logto's
    // desktop-height centering and hiding the submit/recovery actions below it.
    `html,`,
    `body,`,
    `#app {`,
    `  min-height: 100%;`,
    `  height: auto !important;`,
    `}`,
    `body,`,
    `#app,`,
    `#app > div[class*='viewBox'],`,
    `#app div[class*='viewBox'] {`,
    `  overflow-y: auto !important;`,
    `  overscroll-behavior-y: contain;`,
    `}`,
    `#app > div[class*='viewBox'],`,
    `#app div[class*='viewBox'] {`,
    `  min-height: 100dvh !important;`,
    `  height: auto !important;`,
    `}`,
    ``,
    `#app > div[class*='viewBox'],`,
    `#app div[class*='viewBox'] {`,
    `  background: radial-gradient(circle at top left, ${palette.viewGradientStart}, transparent 32%),`,
    `    linear-gradient(135deg, ${viewGrad0} 0%, ${viewGrad1} 48%, ${viewGrad2} 100%) !important;`,
    `}`,
    ``,
    `#app main[class*='main'] {`,
    `  background: var(--nautilo-panel) !important;`,
    `  border: 1px solid var(--nautilo-border) !important;`,
    `  border-radius: 18px !important;`,
    `  box-shadow: 0 24px 80px ${derived.cardShadow} !important;`,
    `  padding: 38px 34px 30px !important;`,
    `}`,
    ``,
    `#app main[class*='main'] img[class*='logo'],`,
    `#app main[class*='main'] [class*='logo'] img {`,
    `  display: none !important;`,
    `}`,
    ``,
    `#app main[class*='main'] [class*='logo'],`,
    `#app main[class*='main'] [class*='brand'] {`,
    `  color: transparent !important;`,
    `  font-size: 0 !important;`,
    `}`,
    ``,
    `#app main[class*='main'] div[class*='wrapper']::before {`,
    `  display: block;`,
    `  margin: 0 auto 8px;`,
    `  color: var(--nautilo-text);`,
    `  content: "${escapeForCssContent(NAUTILO_PRODUCT_NAME)}";`,
    `  font-size: 32px;`,
    `  font-weight: 760;`,
    `  letter-spacing: -0.045em;`,
    `  line-height: 1;`,
    `  text-align: center;`,
    `}`,
    ``,
    `#app main[class*='main'] div[class*='wrapper'] > form::before {`,
    `  display: block;`,
    `  margin: -6px auto 24px;`,
    `  color: var(--nautilo-muted);`,
    `  content: "Private AI workspace";`,
    `  font-size: 13px;`,
    `  font-weight: 600;`,
    `  letter-spacing: 0.08em;`,
    `  text-align: center;`,
    `  text-transform: uppercase;`,
    `}`,
    ``,
    `#app main[class*='main'] h1,`,
    `#app main[class*='main'] h2,`,
    `#app main[class*='main'] [class*='title'] {`,
    `  color: var(--nautilo-text) !important;`,
    `}`,
    ``,
    `#app form div[class*='inputField'] > div,`,
    `#app input {`,
    `  border-color: ${palette.inputBorder} !important;`,
    `  border-radius: 10px !important;`,
    `}`,
    ``,
    `#app input:focus,`,
    `#app form div[class*='inputField']:focus-within > div {`,
    `  border-color: var(--nautilo-accent) !important;`,
    `  box-shadow: 0 0 0 3px ${derived.focusRingLight} !important;`,
    `  outline: none !important;`,
    `}`,
    ``,
    // Logto 1.38 renders a focusable clear (X) suffix after a populated
    // identifier input. In a browser it becomes the next sequential focus
    // target, so Tab stops there instead of advancing from username to
    // password. Custom CSS cannot assign tabindex=-1, so remove only the
    // identifier clear affordance from layout. The password visibility
    // suffix remains available because it uses autocomplete=current-password.
    `#app form div[class*='inputField']:has(input[autocomplete^='username']) button[class*='suffix'],`,
    `#app form div[class*='inputField']:has(input[autocomplete='email']) button[class*='suffix'],`,
    `#app form div[class*='inputField']:has(input[autocomplete='tel']) button[class*='suffix'] {`,
    `  display: none !important;`,
    `}`,
    ``,
    `#app button[type='submit'],`,
    `#app form button[type='button'] {`,
    `  background: linear-gradient(135deg, ${derived.buttonGradientStart} 0%, ${derived.buttonGradientEnd} 100%) !important;`,
    `  border: 0 !important;`,
    `  border-radius: 999px !important;`,
    `  box-shadow: 0 12px 26px ${derived.buttonShadow} !important;`,
    `  color: ${palette.onAccentButton} !important;`,
    `  font-weight: 720 !important;`,
    `}`,
    ``,
    `#app a,`,
    `#app button[class*='link'] {`,
    `  color: var(--nautilo-accent) !important;`,
    `}`,
    ``,
    `#app div[class*='createAccount'] {`,
    `  display: none !important;`,
    `}`,
    ``,
    `#app footer,`,
    `#app [class*='footer'],`,
    `#app [class*='powered'],`,
    `#app [class*='Powered'] {`,
    `  display: none !important;`,
    `}`,
    ``,
    // Logto 1.38+ ships a "signature guard" <style data-logto-signature-guard>
    // that re-asserts `display: block !important` on the doubled attribute
    // selector `[data-logto-signature-container="secured"][data-logto-signature-container="secured"]`
    // (specificity 0,2,0). Beat it with `#app` ID prefix → (1,2,0).
    `#app [data-logto-signature-container="secured"][data-logto-signature-container="secured"],`,
    `#app [data-logto-signature="secured"][data-logto-signature="secured"],`,
    `#app [data-logto-signature-text],`,
    `#app [data-logto-signature-icon] {`,
    `  display: none !important;`,
    `  visibility: hidden !important;`,
    `  opacity: 0 !important;`,
    `  height: 0 !important;`,
    `  width: 0 !important;`,
    `  pointer-events: none !important;`,
    `}`,
    ``,
    `#app main[class*='main']::after {`,
    `  display: block;`,
    `  box-sizing: border-box;`,
    `  margin: 18px auto 0;`,
    `  padding: 12px 14px;`,
    `  max-width: 28rem;`,
    `  border: 1px solid ${derived.helpBoxBorderLight};`,
    `  border-radius: 12px;`,
    `  background: ${derived.helpBoxBgLight};`,
    `  color: var(--nautilo-muted);`,
    `  font-size: 12px;`,
    `  line-height: 1.45;`,
    `  white-space: pre-wrap;`,
    `  text-align: left;`,
    `  content: "${helpCopy}";`,
    `}`,
    ``,
    // Height alone cannot identify a phone with its keyboard open: Electron's
    // fixed-height native sign-in window also has a sub-700px web viewport.
    // Limit compact treatment to touch-primary surfaces, while the base
    // scrollable layout continues to keep submit and recovery help reachable
    // everywhere.
    `@media (max-height: 700px) and (hover: none) and (pointer: coarse) {`,
    `  #app > div[class*='viewBox'],`,
    `  #app div[class*='viewBox'] {`,
    `    align-items: flex-start !important;`,
    `  }`,
    `  #app main[class*='main'] {`,
    `    margin: max(8px, env(safe-area-inset-top)) auto max(8px, env(safe-area-inset-bottom)) !important;`,
    `    padding: 20px 22px 18px !important;`,
    `  }`,
    `  #app main[class*='main'] div[class*='wrapper']::before {`,
    `    font-size: 26px;`,
    `  }`,
    `  #app main[class*='main'] div[class*='wrapper'] > form::before {`,
    `    margin-bottom: 14px;`,
    `  }`,
    `}`,
    ``,
    `@media (prefers-color-scheme: dark) {`,
    `  #app > div[class*='viewBox'],`,
    `  #app div[class*='viewBox'] {`,
    `    background: radial-gradient(circle at top left, ${palette.viewGradientStartDark}, transparent 32%),`,
    `      linear-gradient(135deg, ${viewGradDark0} 0%, ${viewGradDark1} 48%, ${viewGradDark2} 100%) !important;`,
    `  }`,
    `  #app main[class*='main'] {`,
    `    background: var(--nautilo-panel-dark) !important;`,
    `    border-color: ${derived.borderDark} !important;`,
    `  }`,
    `  #app main[class*='main'] div[class*='wrapper']::before,`,
    `  #app main[class*='main'] h1,`,
    `  #app main[class*='main'] h2,`,
    `  #app main[class*='main'] [class*='title'] {`,
    `    color: ${palette.textDark} !important;`,
    `  }`,
    `  #app main[class*='main'] div[class*='wrapper'] > form::before,`,
    `  #app main[class*='main']::after {`,
    `    color: ${palette.mutedDark} !important;`,
    `  }`,
    `  #app input {`,
    `    color: ${palette.textDark} !important;`,
    `  }`,
    `  #app main[class*='main']::after {`,
    `    border-color: ${derived.helpBoxBorderDark} !important;`,
    `    background: ${derived.helpBoxBgDark} !important;`,
    `  }`,
    `  #app input:focus,`,
    `  #app form div[class*='inputField']:focus-within > div {`,
    `    border-color: var(--nautilo-accent-2) !important;`,
    `    box-shadow: 0 0 0 3px ${derived.focusRingDark} !important;`,
    `  }`,
    `}`,
    NAUTILO_LOGTO_HOSTED_BRANDING_CSS_END,
    "",
  ].join("\n");
}

function stripOneSentinelBlock(
  css: string,
  begin: string,
  end: string,
): string {
  const start = css.indexOf(begin);
  const endIdx = css.indexOf(end);
  if (start === -1 || endIdx === -1 || endIdx < start) return css;
  const after = css.slice(endIdx + end.length);
  const before = css.slice(0, start);
  return `${before.trimEnd()}\n\n${after.trimStart()}`.trim();
}

export function stripNautiloHostedBrandingCss(css: string): string {
  let out = css;
  for (const [begin, end] of LEGACY_NAUTILO_LOGTO_HOSTED_BRANDING_SENTINEL_PAIRS) {
    out = stripOneSentinelBlock(out, begin, end);
  }
  return stripOneSentinelBlock(
    out,
    NAUTILO_LOGTO_HOSTED_BRANDING_CSS_BEGIN,
    NAUTILO_LOGTO_HOSTED_BRANDING_CSS_END,
  );
}

export function mergeNautiloHostedBrandingCustomCss(
  current: string | null | undefined,
): { merged: string; changed: boolean } {
  const fragment = buildNautiloHostedBrandingCssFragment();
  const base = stripNautiloHostedBrandingCss((current ?? "").trim());
  const without = base.length === 0 ? "" : `${base.trimEnd()}\n\n`;
  const merged = `${without}${fragment}`.trim();
  const unchanged = (current ?? "").trim() === merged;
  return { merged, changed: !unchanged };
}

function colorEqual(
  cur: Record<string, unknown> | undefined,
  desired: {
    primaryColor: string;
    isDarkModeEnabled: boolean;
    darkPrimaryColor: string;
  },
): boolean {
  if (!cur) return false;
  return (
    cur["primaryColor"] === desired.primaryColor &&
    cur["darkPrimaryColor"] === desired.darkPrimaryColor &&
    cur["isDarkModeEnabled"] === desired.isDarkModeEnabled
  );
}

/**
 * Optional caller-supplied inputs for {@link computeLogtoHostedBrandingReconcilePatch}.
 * Kept as a separate object so the writer stays pure (no env reads inside).
 */
export interface LogtoBrandingReconcileOptions {
  /**
   * M105 Phase B follow-up — when set, becomes
   * `signInExperience.unknownSessionRedirectUrl`. Logto redirects users who
   * hit `/sign-in` outside an OAuth flow here instead of rendering the
   * "Session not found" 404 page. Resolve from `resolveInstance().workbench.url`
   * at the caller (bootstrap-logto). When omitted, the field is left untouched.
   */
  unknownSessionRedirectUrl?: string;
  /**
   * Existing installations normally reconcile Nautilo's password-policy
   * default as well. Populated-clone mode sets this false: it may refresh the
   * app-owned visual block and local redirect projection, but must preserve
   * the source instance's security policy.
   */
  includePasswordPolicy?: boolean;
}

/**
 * Pure: given GET /api/sign-in-exp JSON, return a minimal PATCH body and
 * whether anything would change.
 */
export function computeLogtoHostedBrandingReconcilePatch(
  current: Record<string, unknown>,
  options: LogtoBrandingReconcileOptions = {},
): { patch: Record<string, unknown>; changed: boolean } {
  const patch: Record<string, unknown> = {};
  let changed = false;

  const desiredColor = getLogtoHostedSignInColorPatch().color;
  const curColor = current["color"] as Record<string, unknown> | undefined;
  if (!colorEqual(curColor, desiredColor)) {
    patch["color"] = desiredColor;
    changed = true;
  }

  const { merged, changed: cssChanged } = mergeNautiloHostedBrandingCustomCss(
    current["customCss"] as string | null | undefined,
  );
  if (cssChanged) {
    patch["customCss"] = merged;
    changed = true;
  }

  const currentPasswordPolicy = current["passwordPolicy"] as
    | Record<string, unknown>
    | undefined;
  const currentRejects = currentPasswordPolicy?.["rejects"] as
    | Record<string, unknown>
    | undefined;
  if (
    options.includePasswordPolicy !== false &&
    currentRejects?.["pwned"] !== false
  ) {
    patch["passwordPolicy"] = {
      ...(currentPasswordPolicy ?? {}),
      rejects: {
        ...(currentRejects ?? {}),
        pwned: false,
      },
    };
    changed = true;
  }

  if (options.unknownSessionRedirectUrl !== undefined) {
    const desired = options.unknownSessionRedirectUrl;
    if (current["unknownSessionRedirectUrl"] !== desired) {
      patch["unknownSessionRedirectUrl"] = desired;
      changed = true;
    }
  }

  return { patch, changed };
}
