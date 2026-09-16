/**
 * M055 — loopback server.
 *
 * Critical security tests: the server MUST bind only to 127.0.0.1.
 * If `0.0.0.0` ever creeps back in, an attacker on the LAN could
 * race the legitimate code-exchange.
 */
import { describe, expect, test } from "bun:test";
import { startLoopbackServer } from "../../../electron/auth/loopback-server";

describe("startLoopbackServer", () => {
  test("binds to 127.0.0.1 only — the real security invariant", async () => {
    const handle = await startLoopbackServer({ timeoutMs: 1_000 });
    try {
      // Direct assertion: server.address().address. If a regression
      // ever flipped the bind to "0.0.0.0" the auth code would be
      // exposed to anyone on the LAN; this is the load-bearing
      // invariant for the whole loopback flow.
      expect(handle.address).toBe("127.0.0.1");
      const ok = await fetch(
        `http://127.0.0.1:${handle.port}/anything`,
        { method: "GET" },
      );
      expect(ok.status).toBe(404);
    } finally {
      handle.shutdown();
      await handle.awaitCallback.catch(() => {
        /* shutdown caused reject */
      });
    }
  });

  test("/callback?code=X&state=Y resolves the awaitCallback promise", async () => {
    const handle = await startLoopbackServer({ timeoutMs: 1_000 });
    try {
      void fetch(
        `http://127.0.0.1:${handle.port}/callback?code=abc&state=xyz`,
      );
      const result = await handle.awaitCallback;
      expect(result).toEqual({ code: "abc", state: "xyz" });
    } finally {
      handle.shutdown();
    }
  });

  test("/callback?error=foo rejects with descriptive error", async () => {
    const handle = await startLoopbackServer({ timeoutMs: 1_000 });
    try {
      void fetch(
        `http://127.0.0.1:${handle.port}/callback?error=access_denied`,
      );
      let threw: Error | null = null;
      try {
        await handle.awaitCallback;
      } catch (err) {
        threw = err as Error;
      }
      expect(threw).not.toBeNull();
      expect(threw?.message).toContain("access_denied");
    } finally {
      handle.shutdown();
    }
  });

  test("missing code or state rejects", async () => {
    const handle = await startLoopbackServer({ timeoutMs: 1_000 });
    try {
      void fetch(`http://127.0.0.1:${handle.port}/callback?code=onlycode`);
      let threw: Error | null = null;
      try {
        await handle.awaitCallback;
      } catch (err) {
        threw = err as Error;
      }
      expect(threw?.message).toMatch(/missing code or state/i);
    } finally {
      handle.shutdown();
    }
  });

  test("paths other than /callback respond 404 without resolving", async () => {
    const handle = await startLoopbackServer({ timeoutMs: 1_000 });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/etc/passwd`);
      expect(res.status).toBe(404);
      // Now drive a real callback to ensure the server is still up.
      void fetch(
        `http://127.0.0.1:${handle.port}/callback?code=c&state=s`,
      );
      const result = await handle.awaitCallback;
      expect(result.code).toBe("c");
    } finally {
      handle.shutdown();
    }
  });

  test("times out when no callback arrives", async () => {
    const handle = await startLoopbackServer({ timeoutMs: 50 });
    let threw: Error | null = null;
    try {
      await handle.awaitCallback;
    } catch (err) {
      threw = err as Error;
    }
    expect(threw?.message).toMatch(/timeout/i);
    handle.shutdown();
  });
});
