/**
 * ISSUE-D149 — `composeAuthIdentityOrThrow` uses descriptor `serverUrl`,
 * not `resolveInstance().server.url`.
 *
 * Isolated runner: `mock.module("@nautilo/config")` cannot be undone in Bun
 * and can poison other desktop unit tests that import the real config module.
 * Keep this file outside `tests/unit/` so package test:unit runs it in a
 * separate `bun test` process.
 *
 * Uses `mock.module(...)` + dynamic `await import(...)` so the electron
 * shim and the @nautilo/config mocks land BEFORE the SUT module's static
 * `import { app } from "electron"` executes. Static-import variant fails
 * with `SyntaxError: Export named 'app' not found in module electron`.
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("electron", () => ({
  app: {
    getPath: () => "/tmp/nautilo-electron-test-userdata",
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (plainText: string) => Buffer.from(plainText, "utf8"),
    decryptString: (buffer: Buffer) => buffer.toString("utf8"),
  },
}));

mock.module("@nautilo/config", () => ({
  parseNautiloInstanceId: () => "",
  resolveInstance: () => ({
    instanceId: "from-local-instance-json",
    server: { url: "http://127.0.0.1:3000" },
  }),
  resolveNautiloRootDir: () => "/tmp/nautilo-auth-test-root",
}));

let composeAuthIdentityOrThrow: typeof import("../../electron/auth/token-store-electron").composeAuthIdentityOrThrow;
let registerDesktopAuthIdentityDescriptor: typeof import("../../electron/auth/token-store-electron").registerDesktopAuthIdentityDescriptor;

beforeAll(async () => {
  const mod = await import("../../electron/auth/token-store-electron");
  composeAuthIdentityOrThrow = mod.composeAuthIdentityOrThrow;
  registerDesktopAuthIdentityDescriptor = mod.registerDesktopAuthIdentityDescriptor;
});

describe("composeAuthIdentityOrThrow (D149 descriptor serverUrl)", () => {
  beforeEach(() => {
    registerDesktopAuthIdentityDescriptor(() => ({
      serverUrl: "http://10.0.0.7:3001",
      logtoEndpoint: "https://logto.example/",
      clientAppId: "app-desktop-1",
    }));
  });

  test("uses descriptor serverUrl, not resolveInstance().server.url", () => {
    const id = composeAuthIdentityOrThrow();
    expect(id.serverUrl).toBe("http://10.0.0.7:3001");
    expect(id.instanceId).toBe("from-local-instance-json");
    expect(id.logtoEndpoint).toBe("https://logto.example");
    expect(id.workbenchAppId).toBe("app-desktop-1");
  });

  test("strips trailing slash on descriptor serverUrl", () => {
    registerDesktopAuthIdentityDescriptor(() => ({
      serverUrl: "http://10.0.0.7:3001///",
      logtoEndpoint: "https://logto.example/",
      clientAppId: "app-desktop-1",
    }));
    const id = composeAuthIdentityOrThrow();
    expect(id.serverUrl).toBe("http://10.0.0.7:3001");
  });

  test("throws when descriptor serverUrl is empty after trim", () => {
    registerDesktopAuthIdentityDescriptor(() => ({
      serverUrl: "   ",
      logtoEndpoint: "https://logto.example/",
      clientAppId: "app-desktop-1",
    }));
    expect(() => composeAuthIdentityOrThrow()).toThrow(
      "descriptor returned empty serverUrl; refusing to scope the auth bundle",
    );
  });
});
