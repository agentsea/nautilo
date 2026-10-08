import { expect, test } from "bun:test";
import { delimiter, resolve } from "node:path";
import { createFullMacExecutionEnvironment } from "../../electron/local-execution-environment";

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
