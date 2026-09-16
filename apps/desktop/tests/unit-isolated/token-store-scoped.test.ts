/**
 * M161 Phase 2.1 — server-scoped token-store entry points.
 *
 * Asserts `saveTokensFor` / `loadTokensFor` / `clearTokensFor` persist
 * two servers' bundles to distinct filenames and neither leaks into
 * the other, and that `clearTokensFor(A)` does not affect
 * `loadTokensFor(B)`. The renderer never supplies an auth scope URL;
 * the `…For` variants canonicalize the caller-supplied server URL
 * (via the single-source `canonicalServerScope`) before deriving the
 * on-disk path.
 *
 * Isolated runner: `mock.module("@nautilo/config")` cannot be undone in
 * Bun and can poison other desktop unit tests that import the real
 * config module. Keep this file outside `tests/unit/` so package
 * test:unit runs it in a separate `bun test` process. Mirrors the
 * `token-store-electron.test.ts` pattern.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

let authRoot = "/tmp/nautilo-auth-test-root";

mock.module("@nautilo/config", () => ({
  parseNautiloInstanceId: () => "",
  resolveInstance: () => ({
    instanceId: "from-local-instance-json",
    server: { url: "http://127.0.0.1:3000" },
  }),
  resolveNautiloRootDir: () => authRoot,
}));

let saveTokensFor: typeof import("../../electron/auth/token-store-electron").saveTokensFor;
let loadTokensFor: typeof import("../../electron/auth/token-store-electron").loadTokensFor;
let clearTokensFor: typeof import("../../electron/auth/token-store-electron").clearTokensFor;
let registerDesktopAuthIdentityDescriptor: typeof import("../../electron/auth/token-store-electron").registerDesktopAuthIdentityDescriptor;
let createIdentityBoundTokenStore: typeof import("../../electron/auth/token-store-electron").createIdentityBoundTokenStore;
let serverUrlScope: typeof import("../../electron/auth/token-store").serverUrlScope;

let tmpRoot: string;

beforeAll(async () => {
  const mod = await import("../../electron/auth/token-store-electron");
  saveTokensFor = mod.saveTokensFor;
  loadTokensFor = mod.loadTokensFor;
  clearTokensFor = mod.clearTokensFor;
  registerDesktopAuthIdentityDescriptor = mod.registerDesktopAuthIdentityDescriptor;
  createIdentityBoundTokenStore = mod.createIdentityBoundTokenStore;
  serverUrlScope = (await import("../../electron/auth/token-store")).serverUrlScope;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nautilo-scoped-test-"));
  authRoot = tmpRoot;
});

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const SERVER_A = "http://a.example:3000";
const SERVER_B = "http://b.example:3000";

const BUNDLE_A = {
  access_token: "at-a",
  refresh_token: "rt-a",
  id_token: "it-a",
  expires_in: 3600,
  refreshed_at: 1_700_000_000_000,
};

const BUNDLE_B = {
  access_token: "at-b",
  refresh_token: "rt-b",
  id_token: "it-b",
  expires_in: 3600,
  refreshed_at: 1_700_000_000_001,
};

describe("saveTokensFor / loadTokensFor / clearTokensFor (M161 Phase 2.1)", () => {
  beforeEach(() => {
    // Single global descriptor (active session's Logto config). The
    // `…For` variants override `serverUrl` with the caller argument;
    // the Logto endpoint/app id come from this descriptor.
    registerDesktopAuthIdentityDescriptor(() => ({
      serverUrl: SERVER_A,
      logtoEndpoint: "https://logto.example/",
      clientAppId: "app-desktop-1",
    }));
    // Clean the auth dir between tests so each test starts empty.
    for (const entry of fs.readdirSync(tmpRoot)) {
      try {
        fs.unlinkSync(path.join(tmpRoot, entry));
      } catch {
        /* ignore */
      }
    }
  });

  test("two servers persist to distinct keyed filenames", () => {
    saveTokensFor(SERVER_A, BUNDLE_A);
    saveTokensFor(SERVER_B, BUNDLE_B);
    const scopeA = serverUrlScope(SERVER_A);
    const scopeB = serverUrlScope(SERVER_B);
    expect(scopeA).not.toBe(scopeB);
    expect(
      fs.existsSync(path.join(tmpRoot, `desktop-auth-${scopeA}.json`)),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(tmpRoot, `desktop-auth-${scopeB}.json`)),
    ).toBe(true);
  });

  test("loadTokensFor returns each server's own bundle (no cross-leak)", () => {
    saveTokensFor(SERVER_A, BUNDLE_A);
    saveTokensFor(SERVER_B, BUNDLE_B);
    expect(loadTokensFor(SERVER_A)).toEqual(BUNDLE_A);
    expect(loadTokensFor(SERVER_B)).toEqual(BUNDLE_B);
    expect(loadTokensFor(SERVER_A)?.access_token).toBe("at-a");
    expect(loadTokensFor(SERVER_B)?.access_token).toBe("at-b");
  });

  test("clearTokensFor(A) does not affect loadTokensFor(B)", () => {
    saveTokensFor(SERVER_A, BUNDLE_A);
    saveTokensFor(SERVER_B, BUNDLE_B);
    clearTokensFor(SERVER_A);
    expect(loadTokensFor(SERVER_A)).toBeNull();
    // B is untouched.
    expect(loadTokensFor(SERVER_B)).toEqual(BUNDLE_B);
    const scopeA = serverUrlScope(SERVER_A);
    const scopeB = serverUrlScope(SERVER_B);
    expect(
      fs.existsSync(path.join(tmpRoot, `desktop-auth-${scopeA}.json`)),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(tmpRoot, `desktop-auth-${scopeB}.json`)),
    ).toBe(true);
  });

  test("canonicalizes the URL before path derivation (trailing slash + case)", () => {
    saveTokensFor(`${SERVER_A}/`, BUNDLE_A);
    // A trailing-slash variant must hit the same slot.
    expect(loadTokensFor(SERVER_A)).toEqual(BUNDLE_A);
    // A mixed-case host canonicalizes to the same slot.
    saveTokensFor("HTTP://A.EXAMPLE:3000", BUNDLE_A);
    expect(loadTokensFor(SERVER_A)).toEqual(BUNDLE_A);
  });

  test("loadTokensFor returns null for a server with no bundle", () => {
    expect(loadTokensFor(SERVER_A)).toBeNull();
    expect(loadTokensFor(SERVER_B)).toBeNull();
  });

  test("saveTokensFor for A then loadTokensFor for B cannot read A's bundle", () => {
    saveTokensFor(SERVER_A, BUNDLE_A);
    // B has no bundle; loading B must not return A's bundle.
    expect(loadTokensFor(SERVER_B)).toBeNull();
  });

  test("dynamic descriptor keeps URL and Logto config from the same active session", () => {
    let active = {
      serverUrl: SERVER_A,
      logtoEndpoint: "https://logto-a.example",
      clientAppId: "desktop-a",
    };
    registerDesktopAuthIdentityDescriptor(() => active);
    saveTokensFor(SERVER_A, BUNDLE_A);

    active = {
      serverUrl: SERVER_B,
      logtoEndpoint: "https://logto-b.example",
      clientAppId: "desktop-b",
    };
    saveTokensFor(SERVER_B, BUNDLE_B);
    expect(loadTokensFor(SERVER_B)).toEqual(BUNDLE_B);

    active = {
      serverUrl: SERVER_A,
      logtoEndpoint: "https://logto-a.example",
      clientAppId: "desktop-a",
    };
    expect(loadTokensFor(SERVER_A)).toEqual(BUNDLE_A);
  });
});

describe("identity-bound token capability (D514)", () => {
  beforeEach(() => {
    for (const entry of fs.readdirSync(tmpRoot)) fs.unlinkSync(path.join(tmpRoot, entry));
  });

  const capability = (routingServerUrl: string, logtoEndpoint: string, clientAppId: string) =>
    createIdentityBoundTokenStore({ routingServerUrl, logtoEndpoint, clientAppId });

  test("health-derived B identity selects only B's record", () => {
    const a = capability(SERVER_A, "https://logto-a.example", "desktop-a");
    const b = capability(SERVER_B, "https://logto-b.example", "desktop-b");
    a.save(BUNDLE_A);
    b.save(BUNDLE_B);
    expect(a.load()).toEqual(BUNDLE_A);
    expect(b.load()).toEqual(BUNDLE_B);
    b.clear();
    expect(a.load()).toEqual(BUNDLE_A);
    expect(b.load()).toBeNull();
  });

  test("same URL with replaced Logto identity cannot address old credentials", () => {
    const oldIdentity = capability(SERVER_B, "https://old-logto.example", "desktop-old");
    oldIdentity.save(BUNDLE_A);
    const healthIdentity = capability(SERVER_B, "https://new-logto.example", "desktop-new");
    expect(healthIdentity.load()).toBeNull();
    healthIdentity.clear();
    expect(oldIdentity.load()).toEqual(BUNDLE_A);
  });

  test("marker-authorized exact retirement deletes a same-route corrupt or mismatched slot", () => {
    const oldIdentity = capability(SERVER_B, "https://old-logto.example", "desktop-old");
    oldIdentity.save(BUNDLE_A);
    const replacement = capability(SERVER_B, "https://new-logto.example", "desktop-new");
    replacement.retireExact();
    expect(oldIdentity.load()).toBeNull();
    replacement.retireExact();
  });

  test("malformed explicit scope fails before filesystem I/O", () => {
    const before = fs.readdirSync(tmpRoot);
    expect(() => capability("not a URL", "https://logto.example", "desktop-b")).toThrow();
    expect(() => capability(SERVER_B, "file:///tmp/logto", "desktop-b")).toThrow();
    expect(() => capability(SERVER_B, "https://logto.example", "  ")).toThrow();
    expect(fs.readdirSync(tmpRoot)).toEqual(before);
  });
});
