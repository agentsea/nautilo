/** D514 — exact-B auth/onboarding gates stay outside Electron and active state. */
import { beforeAll, describe, expect, mock, test } from "bun:test";

mock.module("../../electron/auth/pkce", () => ({
  generatePkcePair: () => ({ codeVerifier: "verifier", codeChallenge: "challenge" }),
  generateState: () => "state-b",
}));

type Gate = typeof import("../../electron/candidate-cold-boot-gates");
let gates: Gate;

beforeAll(async () => {
  gates = await import("../../electron/candidate-cold-boot-gates");
});

const candidate = {
  routingServerUrl: "https://b.nautilo.test/base",
  canonicalOrigin: "https://b.nautilo.test",
  registryScope: "candidate-scope-b",
  partition: "candidate:d514-b",
} as const;
const logto = { endpoint: "https://logto.b.test", appId: "app-b", resource: "https://b.nautilo.test/api" } as const;
const freshBundle = {
  access_token: "b-access", refresh_token: "b-refresh", id_token: "b-id",
  expires_in: 3600, refreshed_at: Date.now(),
};

function response(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function input(overrides: Partial<Parameters<Gate["runCandidateColdBootGates"]>[0]> = {}) {
  return {
    context: "known-identity-committed-resume" as const,
    candidate,
    logto,
    setupStatus: null,
    profile: { kind: "observed" as const, exists: true, onboardingCompleted: true },
    signal: new AbortController().signal,
    ...overrides,
  };
}

function replacementInput(overrides: Partial<Parameters<Gate["runCandidateColdBootGates"]>[0]> = {}) {
  return { ...input(overrides), context: "accepted-identity-replacement" as const };
}

function ports(stored: typeof freshBundle | null, overrides: Partial<Parameters<Gate["runCandidateColdBootGates"]>[1]> = {}) {
  let current = stored;
  const calls: string[] = [];
  const saved: Array<{ descriptor: string; bundle: typeof freshBundle }> = [];
  const cleared: string[] = [];
  const result = {
    calls, saved, cleared,
    ports: {
      fetch: async () => response({ access_token: "fresh-b", refresh_token: "rotated-b", id_token: "id-b", expires_in: 3600 }),
      loadTokensFor: (descriptor: string) => {
        calls.push(`load:${descriptor}`);
        return current;
      },
      saveTokensFor: (descriptor: string, bundle: typeof freshBundle) => {
        calls.push(`save:${descriptor}`);
        current = bundle;
        saved.push({ descriptor, bundle });
      },
      clearTokensFor: (descriptor: string) => {
        calls.push(`clear:${descriptor}`);
        current = null;
        cleared.push(descriptor);
      },
      startLoopback: async () => ({
        port: 4444, address: "127.0.0.1", awaitCallback: Promise.resolve({ code: "code-b", state: "state-b" }), shutdown: () => calls.push("shutdown"),
      }),
      openAuthSurface: async ({ partition }: { partition: string }) => {
        calls.push(`auth:${partition}`);
        return { closeAuthSurface: () => calls.push("close-auth") };
      },
      showOnboarding: async ({ routingServerUrl, canonicalOrigin, partition, getBearer }: {
        routingServerUrl: string; canonicalOrigin: string; partition: string; getBearer: () => Promise<string | null>;
      }) => {
        calls.push(`onboarding:${routingServerUrl}|${canonicalOrigin}|${partition}|${await getBearer()}`);
      },
      ...overrides,
    },
  };
  return result;
}

describe("D514 candidate cold-boot gates", () => {
  test("uses a non-expiring B credential without auth, fetch, or A state", async () => {
    const fixture = ports(freshBundle);
    expect((await gates.runCandidateColdBootGates(input(), fixture.ports)).ok).toBe(true);
    expect(fixture.calls).toEqual(["load:https://b.nautilo.test/base"]);
    expect(fixture.saved).toEqual([]);
  });

  test("refreshes expiring credentials through exact B load/save/clear closures", async () => {
    const expiring = { ...freshBundle, refreshed_at: 0, expires_in: 1 };
    const fixture = ports(expiring);
    expect((await gates.runCandidateColdBootGates(input(), fixture.ports)).ok).toBe(true);
    expect(fixture.calls).toEqual([
      "load:https://b.nautilo.test/base", "load:https://b.nautilo.test/base", "save:https://b.nautilo.test/base",
    ]);
    expect(fixture.saved[0]?.descriptor).toBe(candidate.routingServerUrl);
    expect(fixture.saved[0]?.bundle.access_token).toBe("fresh-b");
    expect(fixture.cleared).toEqual([]);
  });

  test("a failed B refresh clears B then signs into B's ephemeral partition", async () => {
    const expiring = { ...freshBundle, refreshed_at: 0, expires_in: 1 };
    const fixture = ports(expiring, { fetch: async (_url: string | URL | Request, init?: RequestInit) =>
      String(init?.body).includes("refresh_token")
        ? response({}, 401)
        : response({ access_token: "signed-b", refresh_token: "signed-refresh", id_token: "signed-id", expires_in: 3600 }),
    });
    expect((await gates.runCandidateColdBootGates(input({ profile: { kind: "observed", exists: false, onboardingCompleted: false } }), fixture.ports)).ok).toBe(true);
    expect(fixture.cleared).toEqual([candidate.routingServerUrl]);
    expect(fixture.calls).toContain("auth:candidate:d514-b");
    expect(fixture.saved.every(({ descriptor }) => descriptor === candidate.routingServerUrl)).toBe(true);
  });

  test("signed-out B signs in and stores only under B", async () => {
    const fixture = ports(null);
    expect((await gates.runCandidateColdBootGates(input({ profile: { kind: "observed", exists: false, onboardingCompleted: false } }), fixture.ports)).ok).toBe(true);
    expect(fixture.calls).toContain("auth:candidate:d514-b");
    expect(fixture.saved).toHaveLength(1);
    expect(fixture.saved[0]?.descriptor).toBe(candidate.routingServerUrl);
  });

  test("signed-out B without an onboarding requirement releases to ordinary Workbench sign-in", async () => {
    const fixture = ports(null);
    const result = await gates.runCandidateColdBootGates(input(), fixture.ports);
    expect(result).toEqual({ ok: true, signedIn: false, onboarding: false });
    expect(fixture.calls).toEqual(["load:https://b.nautilo.test/base"]);
  });

  test("accepted identity replacement starts signed out without touching A's scoped token", async () => {
    const fixture = ports(freshBundle, {
      loadTokensFor: () => { throw new Error("A token read is forbidden"); },
    });
    expect(await gates.runCandidateColdBootGates(replacementInput(), fixture.ports))
      .toEqual({ ok: true, signedIn: false, onboarding: false });
    expect(fixture.calls).toEqual([]);
    expect(fixture.cleared).toEqual([]);
  });

  test("accepted identity replacement saves and later refreshes only its fresh sign-in bundle", async () => {
    const fixture = ports(freshBundle, {
      loadTokensFor: () => { throw new Error("A token read is forbidden"); },
      fetch: async (_url: string | URL | Request, init?: RequestInit) =>
        String(init?.body).includes("refresh_token")
          ? response({ access_token: "refreshed-b", refresh_token: "refreshed-r", id_token: "refreshed-id", expires_in: 3600 })
          : response({ access_token: "signed-b", refresh_token: "signed-r", id_token: "signed-id", expires_in: 1 }),
      showOnboarding: async ({ getBearer }: { getBearer: () => Promise<string | null> }) => {
        expect(await getBearer()).toBe("refreshed-b");
      },
    });
    expect((await gates.runCandidateColdBootGates(
      replacementInput({ profile: { kind: "observed", exists: false, onboardingCompleted: false } }), fixture.ports,
    )).ok).toBe(true);
    expect(fixture.calls.some((call) => call.startsWith("load:"))).toBe(false);
    expect(fixture.saved).toHaveLength(2);
    expect(fixture.cleared).toEqual([]);
  });

  test("replacement sign-in failure cannot clear an untouched A token store", async () => {
    const fixture = ports(freshBundle, {
      loadTokensFor: () => { throw new Error("A token read is forbidden"); },
      startLoopback: async () => { throw new Error("cancelled"); },
    });
    expect((await gates.runCandidateColdBootGates(
      replacementInput({ profile: { kind: "observed", exists: false, onboardingCompleted: false } }), fixture.ports,
    )).ok).toBe(false);
    expect(fixture.cleared).toEqual([]);
  });

  test("replacement cancellation cannot clear an untouched A token store", async () => {
    const controller = new AbortController();
    controller.abort();
    const fixture = ports(freshBundle, {
      loadTokensFor: () => { throw new Error("A token read is forbidden"); },
    });
    expect((await gates.runCandidateColdBootGates(
      replacementInput({ signal: controller.signal }), fixture.ports,
    )).ok).toBe(false);
    expect(fixture.cleared).toEqual([]);
  });

  test("onboarding receives the routed base, canonical B, ephemeral partition, and B-only bearer", async () => {
    const fixture = ports(freshBundle);
    const args = input({ profile: { kind: "observed", exists: false, onboardingCompleted: false } });
    expect((await gates.runCandidateColdBootGates(args, fixture.ports)).ok).toBe(true);
    expect(fixture.calls).toContain("onboarding:https://b.nautilo.test/base|https://b.nautilo.test|candidate:d514-b|b-access");
  });

  test("setup and profile decisions retain the existing helper semantics", async () => {
    const skipped = ports(freshBundle);
    await gates.runCandidateColdBootGates(input({ setupStatus: { setupState: "fresh-unclaimed" } as never, profile: { kind: "observed", exists: false, onboardingCompleted: false } }), skipped.ports);
    expect(skipped.calls.some((call) => call.startsWith("onboarding:"))).toBe(false);

    const forced = ports(freshBundle);
    await gates.runCandidateColdBootGates(input({ forceOnboarding: true }), forced.ports);
    expect(forced.calls.some((call) => call.startsWith("onboarding:"))).toBe(true);

    const unavailable = ports(freshBundle);
    await gates.runCandidateColdBootGates(input({ profile: { kind: "unavailable" } }), unavailable.ports);
    expect(unavailable.calls.some((call) => call.startsWith("onboarding:"))).toBe(false);
  });

  test("each wizard bearer request re-loads exact B and final signed-in truth follows a later failed refresh", async () => {
    let reads = 0;
    const fixture = ports(freshBundle, {
      loadTokensFor: () => reads++ === 0
        ? freshBundle
        : { ...freshBundle, refreshed_at: 0, expires_in: 1 },
      fetch: async () => response({}, 401),
      showOnboarding: async ({ getBearer }: { getBearer: () => Promise<string | null> }) => {
        expect(await getBearer()).toBeNull();
      },
    });
    const result = await gates.runCandidateColdBootGates(
      input({ profile: { kind: "observed", exists: false, onboardingCompleted: false } }),
      fixture.ports,
    );
    expect(result).toEqual({ ok: true, signedIn: false, onboarding: true });
    expect(fixture.cleared).toEqual([candidate.routingServerUrl]);
  });

  test("invalid route, origin, credentials, opaque route, and persistent partition fail before every side effect", async () => {
    const invalid = [
      { ...candidate, routingServerUrl: "not a URL" },
      { ...candidate, canonicalOrigin: "https://other.nautilo.test" },
      { ...candidate, routingServerUrl: "https://user:pass@b.nautilo.test/base" },
      { ...candidate, routingServerUrl: "https://b.nautilo.test/base?secret=x" },
      { ...candidate, partition: "persist:active-b" },
      { ...candidate, partition: "" },
    ];
    for (const badCandidate of invalid) {
      const fixture = ports(freshBundle);
      expect((await gates.runCandidateColdBootGates(input({ candidate: badCandidate }), fixture.ports)).ok).toBe(false);
      expect(fixture.calls).toEqual([]);
    }
    for (const badLogto of [
      { ...logto, endpoint: "https://user:pass@logto.b.test" },
      { ...logto, endpoint: "https://logto.b.test/?query=1" },
      { ...logto, appId: "" },
      { ...logto, resource: "" },
    ]) {
      const fixture = ports(freshBundle);
      expect((await gates.runCandidateColdBootGates(input({ logto: badLogto }), fixture.ports)).ok).toBe(false);
      expect(fixture.calls).toEqual([]);
    }
  });

  test("abort before work has no side effects; abort during sign-in closes the B surface and stops its loopback", async () => {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    const before = ports(null);
    expect((await gates.runCandidateColdBootGates(input({ signal: alreadyAborted.signal }), before.ports)).ok).toBe(false);
    expect(before.calls).toEqual([]);

    const controller = new AbortController();
    let rejectCallback!: (reason: Error) => void;
    const during = ports(null, {
      startLoopback: async () => {
        const awaitCallback = new Promise<never>((_, reject) => { rejectCallback = reject; });
        void awaitCallback.catch(() => {});
        return { port: 4444, address: "127.0.0.1", awaitCallback, shutdown: () => rejectCallback(new Error("cancelled")) };
      },
    });
    const running = gates.runCandidateColdBootGates(input({ signal: controller.signal, profile: { kind: "observed", exists: false, onboardingCompleted: false } }), during.ports);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    expect((await running).ok).toBe(false);
    expect(during.calls).toContain("close-auth");
  });

  test("a Human auth-window close shuts down the loopback and rejects without onboarding", async () => {
    let closeByHuman!: () => void;
    let shutdowns = 0;
    let rejectCallback!: (reason: Error) => void;
    const fixture = ports(null, {
      startLoopback: async () => ({
        port: 4444,
        address: "127.0.0.1",
        awaitCallback: new Promise((_, reject) => { rejectCallback = reject; }),
        shutdown: () => { shutdowns += 1; rejectCallback(new Error("human-cancelled")); },
      }),
      openAuthSurface: async ({ partition, onClosedByUser }: { partition: string; onClosedByUser: () => void }) => {
        fixture.calls.push(`auth:${partition}`);
        closeByHuman = onClosedByUser;
        return { closeAuthSurface: () => fixture.calls.push("close-auth") };
      },
    });
    const running = gates.runCandidateColdBootGates(
      input({ profile: { kind: "observed", exists: false, onboardingCompleted: false } }),
      fixture.ports,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    closeByHuman();
    expect(await running).toEqual({ ok: false, signedIn: false, onboarding: false });
    expect(shutdowns).toBe(1);
    expect(fixture.calls).toContain("close-auth");
    expect(fixture.calls.some((call) => call.startsWith("onboarding:"))).toBe(false);
  });

  test("abort while loopback startup is pending shuts down its eventual handle exactly once", async () => {
    const controller = new AbortController();
    let resolveStart!: (handle: {
      port: number;
      address: string;
      awaitCallback: Promise<never>;
      shutdown: () => void;
    }) => void;
    let shutdowns = 0;
    const pendingStart = new Promise<Parameters<typeof resolveStart>[0]>((resolve) => {
      resolveStart = resolve;
    });
    const fixture = ports(null, { startLoopback: () => pendingStart });
    const running = gates.runCandidateColdBootGates(
      input({
        signal: controller.signal,
        profile: { kind: "observed", exists: false, onboardingCompleted: false },
      }),
      fixture.ports,
    );
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    const awaitCallback = new Promise<never>(() => {});
    resolveStart({
      port: 4444,
      address: "127.0.0.1",
      awaitCallback,
      shutdown: () => { shutdowns += 1; },
    });
    expect(await running).toEqual({ ok: false, signedIn: false, onboarding: false });
    expect(shutdowns).toBe(1);
    expect(fixture.calls).not.toContain("close-auth");
  });

  test("abort while onboarding is open reaches its B-scoped signal and cannot complete late", async () => {
    const controller = new AbortController();
    let sawSignal = false;
    const fixture = ports(freshBundle, {
      showOnboarding: ({ signal }: { signal: AbortSignal }) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          sawSignal = true;
          reject(new Error("cancelled"));
        }, { once: true });
      }),
    });
    const running = gates.runCandidateColdBootGates(
      input({ signal: controller.signal, profile: { kind: "observed", exists: false, onboardingCompleted: false } }),
      fixture.ports,
    );
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    expect(await running).toEqual({ ok: false, signedIn: false, onboarding: false });
    expect(sawSignal).toBe(true);
  });

  test("the gate has no active-server escape hatch", () => {
    const source = require("node:fs").readFileSync(new URL("../../electron/candidate-cold-boot-gates.ts", import.meta.url), "utf8");
    for (const forbidden of ["serverSessions", "resolvedServerUrl", "logtoConfig", "loadTokens(", "saveTokens(", "clearTokens(", "handleSignIn", "getValidAccessToken", "useAnyway"]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).toContain("routingServerUrl");
    expect(source).toContain("canonicalOrigin");
  });
});
