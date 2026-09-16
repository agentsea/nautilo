import rootConfig from "../../eslint.config.mjs";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * Workbench tsconfig.json `include`s `src` and `exclude`s tests. Bundled
 * artifacts, scripts, and tests are ignored at the ESLint layer; bring
 * them under lint by widening tsconfig `include` first.
 *
 * Workbench is the ONLY React surface in the monorepo, so the
 * `react-hooks/*` rule plugin is loaded here, not in the root config
 * (loading it globally false-positives on non-React `use*`-prefixed helpers).
 */
export default [
  {
    ignores: [
      "dist/**",
      "public/**",
      "tests/**",
      "scripts/**",
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
    ],
  },
  ...rootConfig,
  {
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
