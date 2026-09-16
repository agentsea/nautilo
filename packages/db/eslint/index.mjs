import { m212NoAdhocPoolConstruction } from "./m212-no-adhoc-pool-construction.mjs";

/** @type {import("eslint").ESLint.Plugin} */
export default {
  meta: { name: "@nautilo/db" },
  rules: {
    "m212-no-adhoc-pool-construction": m212NoAdhocPoolConstruction,
  },
};
