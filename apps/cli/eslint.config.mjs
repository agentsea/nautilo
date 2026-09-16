import rootConfig from "../../eslint.config.mjs";

/** CLI build/codegen scripts are not part of the tsconfig project. */
export default [{ ignores: ["scripts/**", "dist/**", "templates/**"] }, ...rootConfig];
