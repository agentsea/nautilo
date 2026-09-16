/**
 * Minimal valid LOGTO_* block for config-guard cross-key tests (M072).
 */
export const FULL_LOGTO_PROCESS_ENV: NodeJS.ProcessEnv = {
  LOGTO_ENDPOINT: "http://localhost:3301",
  LOGTO_ISSUER: "http://localhost:3301/oidc",
  LOGTO_JWKS_URI: "http://localhost:3301/oidc/jwks",
  LOGTO_RESOURCE: "https://api.nautilo.local",
  LOGTO_WORKBENCH_APP_ID: "wb",
  LOGTO_TUI_APP_ID: "tui",
  LOGTO_TUI_LOOPBACK_APP_ID: "test-tui-loopback-app-id",
  LOGTO_M2M_APP_ID: "m2m",
  LOGTO_M2M_APP_SECRET: "secret",
  LOGTO_DESKTOP_APP_ID: "desktop",
  LOGTO_MOBILE_APP_ID: "mobile",
  LOGTO_MOBILE_WEB_APP_ID: "mobile-web",
};
