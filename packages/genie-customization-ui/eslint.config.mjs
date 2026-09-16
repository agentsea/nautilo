import reactHooks from "eslint-plugin-react-hooks";
import base from "../../eslint.config.mjs";

export default [
  ...base,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.flat.recommended.rules,
  },
];
