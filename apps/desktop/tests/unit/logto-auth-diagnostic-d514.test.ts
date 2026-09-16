import { describe, expect, test } from "bun:test";
import { reprobeLogtoAuthDiagnostic } from "../../electron/logto-auth-diagnostic";
import type { ActiveAuthority } from "../../electron/pending-connection";

const authority = (scope: string, attempt = "attempt-a", fingerprint = "fingerprint-a"): ActiveAuthority => ({
  scope,
  revision: `revision-${attempt}`,
  connectionAttemptId: attempt,
  serverFingerprint: fingerprint,
});

const response = (url: string, fingerprint = "fingerprint-a") => ({
  ok: true,
  url,
  json: async () => ({
    status: "ok",
    serverIdentity: fingerprint,
    logtoEndpoint: "https://auth.example.com",
    logtoDesktopAppId: "desktop",
    logtoResource: "https://api.example.com",
  }),
}) as Response;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("D514 Logto diagnostic authority fence", () => {
  test("applies a same-origin response with the exact trusted active fingerprint", async () => {
    const session = { id: "A" };
    const urls: string[] = [];
    const applied: unknown[] = [];
    const result = await reprobeLogtoAuthDiagnostic({
      timeoutMs: 5_000,
      fetch: (async (url) => {
        urls.push(String(url));
        return response("https://a.example.com/base/health");
      }) as typeof fetch,
      current: () => ({
        session,
        routingServerUrl: "https://a.example.com/base",
        authority: authority("https://a.example.com"),
      }),
      apply: (captured, body) => {
        applied.push(captured, body);
        return true;
      },
    });
    expect(result).toBe(true);
    expect(urls).toEqual(["https://a.example.com/base/health"]);
    expect(applied[0]).toBe(session);
    expect(applied).toHaveLength(2);
  });

  test("wrong fingerprint and redirected health never apply", async () => {
    for (const candidate of [
      response("https://a.example.com/health", "fingerprint-b"),
      response("https://redirect.example.com/health"),
    ]) {
      let applied = 0;
      expect(await reprobeLogtoAuthDiagnostic({
        timeoutMs: 5_000,
        fetch: (async () => candidate) as typeof fetch,
        current: () => ({
          session: { id: "A" },
          routingServerUrl: "https://a.example.com",
          authority: authority("https://a.example.com"),
        }),
        apply: () => { applied += 1; return true; },
      })).toBe(false);
      expect(applied).toBe(0);
    }
  });

  test("a late A response cannot apply after active authority changes to B", async () => {
    const waiting = deferred<Response>();
    const sessionA = { id: "A" };
    const sessionB = { id: "B" };
    let current = {
      session: sessionA,
      routingServerUrl: "https://a.example.com",
      authority: authority("https://a.example.com"),
    };
    let applied = 0;
    const probe = reprobeLogtoAuthDiagnostic({
      timeoutMs: 5_000,
      fetch: (() => waiting.promise) as typeof fetch,
      current: () => current,
      apply: () => { applied += 1; return true; },
    });
    current = {
      session: sessionB,
      routingServerUrl: "https://b.example.com",
      authority: authority("https://b.example.com", "attempt-b", "fingerprint-b"),
    };
    waiting.resolve(response("https://a.example.com/health"));
    expect(await probe).toBe(false);
    expect(applied).toBe(0);
  });

  test("missing trust and aborted diagnostics fail without applying", async () => {
    let applied = 0;
    let fetched = 0;
    const base = {
      session: { id: "A" },
      routingServerUrl: "https://a.example.com",
      authority: authority("https://a.example.com"),
    };
    expect(await reprobeLogtoAuthDiagnostic({
      timeoutMs: 1,
      fetch: (async () => { fetched += 1; return response("https://a.example.com/health"); }) as typeof fetch,
      current: () => ({
        ...base,
        authority: { ...base.authority, serverFingerprint: null },
      }),
      apply: () => { applied += 1; return true; },
    })).toBe(false);
    expect(fetched).toBe(0);
    expect(await reprobeLogtoAuthDiagnostic({
      timeoutMs: 1,
      fetch: (async () => { throw new DOMException("aborted", "AbortError"); }) as typeof fetch,
      current: () => base,
      apply: () => { applied += 1; return true; },
    })).toBe(false);
    expect(applied).toBe(0);
  });

  test("port throws before, during, or after fetch fail closed", async () => {
    const snapshot = {
      session: { id: "A" },
      routingServerUrl: "https://a.example.com",
      authority: authority("https://a.example.com"),
    };
    const runs = [
      {
        current: () => { throw new Error("first-current"); },
        fetch: (async () => response("https://a.example.com/health")) as typeof fetch,
        apply: () => true,
      },
      (() => {
        let reads = 0;
        return {
          current: () => { if (++reads === 2) throw new Error("second-current"); return snapshot; },
          fetch: (async () => response("https://a.example.com/health")) as typeof fetch,
          apply: () => true,
        };
      })(),
      {
        current: () => snapshot,
        fetch: (async () => { throw new Error("fetch"); }) as typeof fetch,
        apply: () => true,
      },
      {
        current: () => snapshot,
        fetch: (async () => response("https://a.example.com/health")) as typeof fetch,
        apply: () => { throw new Error("apply"); },
      },
    ];
    for (const ports of runs) {
      expect(await reprobeLogtoAuthDiagnostic({ timeoutMs: 5_000, ...ports })).toBe(false);
    }
  });
});
