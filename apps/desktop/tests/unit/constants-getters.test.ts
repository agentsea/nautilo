import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetResolvedInstanceForTests } from "@nautilo/config";
import { resolveDevServerUrl } from "../../electron/constants";

describe("desktop dev URL getters (M071)", () => {
  let userHomeDir: string;
  const prevHome = process.env["HOME"];

  beforeEach(() => {
    __resetResolvedInstanceForTests();
    userHomeDir = join(tmpdir(), `desk-url-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(userHomeDir, ".nautilo"), { recursive: true });
    process.env["HOME"] = userHomeDir;
    process.env["NAUTILO_INSTANCE_ID"] = "";
  });

  afterEach(() => {
    __resetResolvedInstanceForTests();
    delete process.env["NAUTILO_PORT"];
    rmSync(userHomeDir, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
  });

  test("resolve dev server URL from resolveInstance defaults", () => {
    expect(resolveDevServerUrl()).toBe("http://127.0.0.1:3001");
  });

  test("NAUTILO_PORT shifts resolveDevServerUrl", () => {
    process.env["NAUTILO_PORT"] = "3011";
    __resetResolvedInstanceForTests();
    expect(resolveDevServerUrl()).toBe("http://127.0.0.1:3011");
  });
});
