import rootConfig from "../../eslint.config.mjs";

/**
 * Desktop tsconfig.json only `include`s `electron/**`. Other dirs (scripts,
 * onboarding bundled renderer, first-run preload, tests outside the project)
 * are ignored to keep the type-aware parser happy; bring them under lint
 * by adding them to tsconfig `include` first.
 */
export default [
  { ignores: ["dist/**", "release/**", "vendor/**", "scripts/**", "onboarding/**", "first-run/**", "assets/**", "tests/**", "scratch/**", "electron/browser-control-provider.js"] },
  ...rootConfig,
];
