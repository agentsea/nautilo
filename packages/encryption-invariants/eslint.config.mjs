import rootConfig from "../../eslint.config.mjs";

/** Ignore generated mutation sandboxes and reports, including interrupted runs. */
export default [
  { ignores: [".stryker-tmp/**", "reports/**"] },
  ...rootConfig,
];
