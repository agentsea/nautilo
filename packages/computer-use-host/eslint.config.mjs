import rootConfig from "../../eslint.config.mjs";

/**
 * Host production typechecking is intentionally source-only. Its Bun parity
 * suites execute against fakes but are not part of the TypeScript project,
 * matching the existing Desktop test convention they were migrated from.
 */
export default [
  { ignores: ["dist/**", "tests/**"] },
  ...rootConfig,
];
