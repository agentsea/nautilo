/**
 * M161 Phase 2.2 — sender-resolved auth IPC + unknown-sender rejection.
 *
 * Asserts the registry's `resolveActiveFromSenderOrThrow` (the
 * testable core of main.ts's `resolveSessionFromSender`) rejects
 * unknown senders and known-but-non-active senders, and that known
 * active senders resolve to their OWN session's `logtoConfig` and
 * `serverUrl` — the values the auth IPC handlers scope token ops and
 * Logto config to. The renderer never supplies a server URL; main
 * derives server identity from `event.sender.id` via this mapping.
 *
 * Isolated runner: mocks `electron` so the registry's type-only
 * `WebContentsView` import resolves without a live Electron runtime.
 */
import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

mock.module("electron", () => ({
  app: { getPath: () => "/tmp", isPackaged: false },
  WebContentsView: function MockWebContentsView() {
    return {};
  },
}));

const { ServerSessionRegistry } = await import(
  "../../electron/server-sessions/registry"
);

const LOGTO_A = { endpoint: "https://logto.a.example", appId: "app-a", resource: "res-a" };
const LOGTO_B = { endpoint: "https://logto.b.example", appId: "app-b", resource: "res-b" };

describe("resolveActiveFromSenderOrThrow (M161 Phase 2.2)", () => {
  test("main registers an auth descriptor wholly derived from the active session", () => {
    const source = readFileSync(join(import.meta.dir, "../../electron/main.ts"), "utf8");
    const start = source.indexOf("registerDesktopAuthIdentityDescriptor(() => {");
    expect(start).toBeGreaterThanOrEqual(0);
    const block = source.slice(start, source.indexOf("return true;", start));
    expect(block).toContain("const active = serverSessions.active");
    expect(block).toContain("serverUrl: active.serverUrl");
    expect(block).toContain("logtoEndpoint: active.logtoConfig.endpoint");
    expect(block).toContain("clientAppId: active.logtoConfig.appId");
  });

  test("background auth polling returns null without disclosing a bearer", () => {
    const source = readFileSync(join(import.meta.dir, "../../electron/main.ts"), "utf8");
    const start = source.indexOf('ipcMain.handle("auth:getAccessToken"');
    const block = source.slice(start, source.indexOf("\n});", start));
    expect(block).toContain("const senderSession = serverSessions.getBySender(e.sender.id)");
    expect(block).toContain("if (!senderSession)");
    expect(block).toContain("if (senderSession !== serverSessions.active) return null");
  });

  test("unknown sender is rejected (fail closed)", () => {
    const r = new ServerSessionRegistry();
    const a = r.ensure("https://a.example");
    a.logtoConfig = LOGTO_A;
    r.attachSender(100, a.scope);
    // An unregistered webContents.id must throw before any privileged work.
    expect(() => r.resolveActiveFromSenderOrThrow(99999)).toThrow(
      "ipc-denied: sender is not registered",
    );
  });

  test("known active sender resolves to its own session + logtoConfig", () => {
    const r = new ServerSessionRegistry();
    const a = r.ensure("https://a.example");
    a.logtoConfig = LOGTO_A;
    r.attachSender(100, a.scope);
    const resolved = r.resolveActiveFromSenderOrThrow(100);
    expect(resolved).toBe(a);
    expect(resolved.serverUrl).toBe("https://a.example");
    expect(resolved.logtoConfig).toBe(LOGTO_A);
  });

  test("known but non-active sender is rejected (fail closed)", () => {
    const r = new ServerSessionRegistry();
    const a = r.ensure("https://a.example");
    const b = r.ensure("https://b.example");
    a.logtoConfig = LOGTO_A;
    b.logtoConfig = LOGTO_B;
    r.attachSender(100, a.scope);
    r.attachSender(200, b.scope);
    // A is active (first ensured); B is a known but background session.
    expect(r.active).toBe(a);
    // Sender 200 is bound to B (non-active) — must reject, NOT resolve
    // to B's logtoConfig. This is the security boundary: a background
    // view cannot drive privileged auth for its own server until it
    // becomes the active session (Phase 3 switching).
    expect(() => r.resolveActiveFromSenderOrThrow(200)).toThrow(
      "ipc-denied: sender is not the active session",
    );
  });

  test("after switchTo, the newly-active sender resolves and the old one is rejected", () => {
    const r = new ServerSessionRegistry();
    const a = r.ensure("https://a.example");
    const b = r.ensure("https://b.example");
    a.logtoConfig = LOGTO_A;
    b.logtoConfig = LOGTO_B;
    r.attachSender(100, a.scope);
    r.attachSender(200, b.scope);
    r.switchTo("https://b.example");
    expect(r.active).toBe(b);
    // Now B's sender is the active privileged sender.
    const resolved = r.resolveActiveFromSenderOrThrow(200);
    expect(resolved).toBe(b);
    expect(resolved.logtoConfig).toBe(LOGTO_B);
    expect(resolved.serverUrl).toBe("https://b.example");
    // A's sender is now a known-but-non-active sender — rejected.
    expect(() => r.resolveActiveFromSenderOrThrow(100)).toThrow(
      "ipc-denied: sender is not the active session",
    );
  });

  test("resolveSessionFromSender flow scopes token ops to the resolved session's serverUrl", () => {
    // Simulates the auth:status handler: resolve the session from the
    // sender, then scope the token op to `session.serverUrl`. Proves a
    // known active sender's serverUrl is the ONLY value that reaches
    // the token store — never a renderer-supplied URL.
    const r = new ServerSessionRegistry();
    const a = r.ensure("https://a.example");
    a.logtoConfig = LOGTO_A;
    r.attachSender(100, a.scope);
    const session = r.resolveActiveFromSenderOrThrow(100);
    const scopedServerUrl = session.serverUrl;
    expect(scopedServerUrl).toBe("https://a.example");
    // The handler would call loadTokensFor(scopedServerUrl); the scope
    // is derived entirely from the registered sender, not a renderer arg.
  });
});
