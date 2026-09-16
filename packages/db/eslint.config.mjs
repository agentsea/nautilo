import rootConfig from "../../eslint.config.mjs";

/** Ignore one-off Bun maintenance scripts and local ESLint implementation files. */
export default [{ ignores: ["scripts/**", "eslint/"] }, ...rootConfig];
