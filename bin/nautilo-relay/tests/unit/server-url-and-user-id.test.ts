import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __resetResolvedInstanceForTests } from "@nautilo/config";
import {
  normalizeRelayServerUrl,
  resolveRelayDataDir,
  resolveRelayServerUrl,
  resolveRelayUserHome,
} from "../../src/bootstrap";
import { resolveRelayEntrypointCommand } from "../../src/index";

function isolatedHomeEnv(
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const home = join(tmpdir(), `nautilo-relay-test-${randomUUID()}`);
  mkdirSync(join(home, ".nautilo"), { recursive: true });
  return {
    ...process.env,
    NAUTILO_INSTANCE_ID: undefined,
    HOME: home,
    USERPROFILE: home,
    ...extra,
  };
}

beforeEach(() => {
  __resetResolvedInstanceForTests();
});

afterEach(() => {
  __resetResolvedInstanceForTests();
});

describe("normalizeRelayServerUrl", () => {
  test("strips trailing slash", () => {
    expect(normalizeRelayServerUrl("http://127.0.0.1:3001/")).toBe("http://127.0.0.1:3001");
  });

  test("canonicalizes equivalent server origins for credential scoping", () => {
    expect(normalizeRelayServerUrl(" HTTPS://EXAMPLE.TEST:443/ ")).toBe("https://example.test");
  });
});

describe("resolveRelayServerUrl", () => {
  test("honors NAUTILO_SERVER_URL over defaults", () => {
    const env = isolatedHomeEnv({ NAUTILO_SERVER_URL: "http://custom:444/" });
    expect(resolveRelayServerUrl(env)).toBe("http://custom:444");
  });
});

describe("resolveRelayDataDir + resolveRelayUserHome", () => {
  test("data dir is ~/.nautilo under HOME", () => {
    const env = isolatedHomeEnv();
    const data = resolveRelayDataDir(env);
    expect(data).toBe(join(env["HOME"]!, ".nautilo"));
    expect(resolveRelayUserHome(data)).toBe(env["HOME"]!);
  });
});

describe("headless relay entrypoint", () => {
  test("recognizes pair in script and compiled-executable argv shapes", () => {
    expect(resolveRelayEntrypointCommand(["/opt/homebrew/bin/bun", "/app/src/index.ts", "pair"]))
      .toBe("pair");
    expect(resolveRelayEntrypointCommand(["/usr/local/bin/nautilo-relay", "pair"]))
      .toBe("pair");
    expect(resolveRelayEntrypointCommand([
      "/usr/local/bin/nautilo-relay",
      "pair",
      "--instance",
      "clone-1",
    ])).toBe("pair");
    expect(resolveRelayEntrypointCommand(["/usr/local/bin/nautilo-relay"])).toBeNull();
    expect(() => resolveRelayEntrypointCommand(["/usr/local/bin/nautilo-relay", "unknown"]))
      .toThrow("Usage");
  });

  test("index.ts does not embed the legacy @owner literal (single source in @nautilo/relay)", async () => {
    const indexUrl = new URL("../../src/index.ts", import.meta.url);
    const raw = await Bun.file(indexUrl).text();
    expect(raw).not.toContain("@owner@nautilo.local");
  });
});
