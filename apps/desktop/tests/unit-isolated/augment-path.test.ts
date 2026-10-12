import { expect, test } from "bun:test";

import { cleanLoginShellCaptureEnvironment } from "../../electron/augment-path";

test("login-shell capture starts from an explicit OS/user baseline", () => {
  const baseline = cleanLoginShellCaptureEnvironment("/bin/zsh", {
    PATH: "/fixture/electron-bin",
    SSH_AUTH_SOCK: "/fixture/agent.sock",
    XDG_RUNTIME_DIR: "/fixture/runtime",
    XDG_CONFIG_HOME: "/fixture/config",
    ELECTRON_INTERNAL_SECRET: "must-not-inherit",
    NAUTILO_GATEWAY_API_KEY: "must-not-inherit",
    GH_TOKEN: "must-be-produced-by-shell-instead",
    NODE_OPTIONS: "--require=/fixture/electron-hook",
  });

  expect(baseline).toMatchObject({
    SHELL: "/bin/zsh",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    SSH_AUTH_SOCK: "/fixture/agent.sock",
    XDG_RUNTIME_DIR: "/fixture/runtime",
    XDG_CONFIG_HOME: "/fixture/config",
  });
  expect(baseline["ELECTRON_INTERNAL_SECRET"]).toBeUndefined();
  expect(baseline["NAUTILO_GATEWAY_API_KEY"]).toBeUndefined();
  expect(baseline["GH_TOKEN"]).toBeUndefined();
  expect(baseline["NODE_OPTIONS"]).toBeUndefined();
});
