import rootConfig from "../../eslint.config.mjs";

/** Standalone CJS probe subprocess — not part of the TS project service. */
export default [{ ignores: ["src/host-bundle-probe.cjs"] }, ...rootConfig];
