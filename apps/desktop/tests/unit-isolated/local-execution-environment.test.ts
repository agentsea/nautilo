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
