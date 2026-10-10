import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import {
  createFullMacExecutionEnvironment,
  prepareDevelopmentExecutionEnvironment,
} from "../../electron/local-execution-environment";

test("Full Mac preserves installed absolute command paths without inheriting account credentials or hooks", () => {
  const installed = resolve("/fixture/installed/bin");
  const system = resolve("/fixture/system/bin");
  const parent = Object.freeze({
    PATH: [installed, "relative/bin", "", ".", system].join(delimiter),
    HOME: "/fixture/untrusted-parent-home",
    LANG: "untrusted-locale",
    GH_TOKEN: "synthetic-not-a-token",
    OPENAI_API_KEY: "synthetic-not-a-key",
    NODE_OPTIONS: "--require=untrusted-hook",
    BASH_ENV: "/fixture/untrusted-startup",
    ENV: "/fixture/untrusted-startup",
    DYLD_INSERT_LIBRARIES: "/fixture/untrusted-library",
  });
  expect(createFullMacExecutionEnvironment(parent, "/fixture/account-home")).toEqual({
    HOME: "/fixture/account-home",
    PATH: [installed, system].join(delimiter),
    LANG: "en_US.UTF-8",
  });
});

test("Full Mac uses the existing system fallback only when PATH is absent", () => {
  const fallback = createFullMacExecutionEnvironment({}, "/fixture/account-home");
  expect(fallback.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
  expect(createFullMacExecutionEnvironment({ PATH: "" }, "/fixture/account-home").PATH).toBe("");
});

test("Development captures one immutable real-HOME environment without parent PATH or startup hooks", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "local-development-env-")));
  try {
    const home = join(root, "home");
    const tools = join(root, "tools");
    const nodeDirectory = join(root, "node-bin");
    const cache = join(home, ".npm");
    mkdirSync(home); mkdirSync(tools); mkdirSync(nodeDirectory); mkdirSync(cache);
    const node = join(nodeDirectory, "node");
    writeFileSync(node, "fixture");
    const cacheLink = join(root, "cache-link");
    symlinkSync(cache, cacheLink);
    const prepared = prepareDevelopmentExecutionEnvironment({
      profileId: "developer", profileRevision: 2, protectedPolicyVersion: 4, home,
      environmentValues: { NPM_CONFIG_CACHE: cacheLink },
      executables: [
        { capabilityId: "node", executable: node, backend: "sandboxed" },
        { capabilityId: "device", executable: join(root, "adb"), backend: "brokered_host_service" },
      ],
    }, { trustedToolsBin: tools });
    expect(prepared.environment["HOME"]).toBe(realpathSync(home));
    expect(prepared.environment["NPM_CONFIG_CACHE"]).toBe(realpathSync(cache));
    expect(prepared.environment["PATH"]?.split(delimiter).slice(0, 2)).toEqual([realpathSync(tools), realpathSync(nodeDirectory)]);
    expect(prepared.environment["BASH_ENV"]).toBeUndefined();
    expect(prepared.environment["GH_TOKEN"]).toBeUndefined();
    expect(prepared.executableByCapability).toEqual({ node: realpathSync(node) });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.environment)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Development rejects unapproved environment values", () => {
  expect(() => prepareDevelopmentExecutionEnvironment({
    profileId: "developer", profileRevision: 2, protectedPolicyVersion: 1,
    home: "/fixture/home", environmentValues: { GH_TOKEN: "/fixture/token" }, executables: [],
  }, { trustedToolsBin: "/fixture/tools", canonicalize: (value) => value })).toThrow("LOCAL_EXECUTION_ENVIRONMENT_VALUE_DENIED");
});

test("trusted Development projects the native user environment and keeps installed PATH precedence", () => {
  const prepared = prepareDevelopmentExecutionEnvironment({
    profileId: "developer",
    profileRevision: 3,
    protectedPolicyVersion: 1,
    home: "/fixture/home",
    environmentValues: {},
    userEnvironment: true,
    userEnvironmentWritablePaths: ["/opt/homebrew", "/fixture/home/.cache"],
    executables: [],
  }, {
    trustedToolsBin: "/fixture/bundled-tools",
    canonicalize: (value) => value,
    nativeEnvironment: {
      HOME: "/untrusted/shell-home",
      PATH: "/fixture/user-bin:/usr/bin",
      GH_CONFIG_DIR: "/fixture/home/.config/gh",
      GH_TOKEN: "synthetic-user-export",
      SSH_AUTH_SOCK: "/fixture/agent.sock",
      XDG_RUNTIME_DIR: "/fixture/runtime",
      ELECTRON_INTERNAL_SECRET: "must-not-project",
      NODE_OPTIONS: "--require=/fixture/electron-hook",
    },
  });

  expect(prepared.environment).toMatchObject({
    HOME: "/fixture/home",
    GH_CONFIG_DIR: "/fixture/home/.config/gh",
    GH_TOKEN: "synthetic-user-export",
    SSH_AUTH_SOCK: "/fixture/agent.sock",
    XDG_RUNTIME_DIR: "/fixture/runtime",
  });
  expect(prepared.environment["PATH"]?.split(delimiter).slice(0, 3)).toEqual([
    "/fixture/user-bin",
    "/usr/bin",
    "/fixture/bundled-tools",
  ]);
  expect(prepared.environment["ELECTRON_INTERNAL_SECRET"]).toBeUndefined();
  expect(prepared.environment["NODE_OPTIONS"]).toBeUndefined();
  expect(prepared.userEnvironment).toBe(true);
  expect(prepared.userEnvironmentWritablePaths).toEqual([
    "/opt/homebrew",
    "/fixture/home/.cache",
  ]);
  expect(Object.isFrozen(prepared.userEnvironmentWritablePaths)).toBe(true);
});

test("trusted Development fails explicitly when login-shell capture is absent", () => {
  expect(() => prepareDevelopmentExecutionEnvironment({
    profileId: "developer",
    profileRevision: 3,
    protectedPolicyVersion: 1,
    home: "/fixture/home",
    environmentValues: {},
    userEnvironment: true,
    executables: [],
  }, {
    trustedToolsBin: "/fixture/tools",
    canonicalize: (value) => value,
    nativeEnvironment: { PATH: "/usr/bin" },
  })).toThrow("LOCAL_EXECUTION_NATIVE_ENVIRONMENT_REQUIRED");
});

test("legacy Development ignores user-environment inputs without explicit capability", () => {
  const prepared = prepareDevelopmentExecutionEnvironment({
    profileId: "developer",
    profileRevision: 2,
    protectedPolicyVersion: 1,
    home: "/fixture/home",
    environmentValues: {},
    userEnvironmentWritablePaths: ["/opt/homebrew"],
    executables: [],
  }, {
    trustedToolsBin: "/fixture/tools",
    canonicalize: (value) => value,
    nativeEnvironment: { HOME: "/fixture/home", GH_TOKEN: "must-not-project" },
  });
  expect(prepared.environment["GH_TOKEN"]).toBeUndefined();
  expect(prepared.userEnvironment).toBeUndefined();
  expect(prepared.userEnvironmentWritablePaths).toBeUndefined();
});

test("native runtime paths admit owned custom temp and runtime directories without exposing Linux host tmp", async () => {
  const { developmentRuntimeWritablePaths } = await import("../../electron/local-execution-environment");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "development-runtime-paths-")));
  try {
    const temp = join(root, "temp"); const runtime = join(root, "runtime"); const regular = join(root, "not-a-socket");
    mkdirSync(temp); mkdirSync(runtime); writeFileSync(regular, "fixture");
    expect(developmentRuntimeWritablePaths({ TMPDIR: temp, XDG_RUNTIME_DIR: runtime, SSH_AUTH_SOCK: regular }, "linux")).toEqual([temp, runtime]);
    const hostTmp = realpathSync("/tmp");
    // On Linux /tmp is canonical; on macOS it is /private/tmp, which is not
    // Linux's private mount. Either must never cause a grant of filesystem root.
    expect(developmentRuntimeWritablePaths({ TMPDIR: "/", XDG_RUNTIME_DIR: "relative/path" }, "linux")).toEqual([]);
    if (hostTmp === "/tmp") expect(developmentRuntimeWritablePaths({ TMPDIR: "/tmp" }, "linux")).toEqual([]);
    expect(developmentRuntimeWritablePaths({ TMPDIR: join(root, "missing") })).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
