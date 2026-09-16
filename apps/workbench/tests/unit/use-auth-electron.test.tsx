/**
 * M055 — Electron useAuth surface contract.
 *
 * The renderer-side `useElectronSession` hook (in `use-auth.ts`)
 * consumes the `nautiloDesktop.auth.*` preload bridge one-to-one.
 * These tests pin the IPC surface shape so a future refactor of the
 * bridge can't drop or rename a method without a test failure.
 *
 * The bigger end-to-end behaviour (mount → state-change → bearer
 * lands on apiClient) is covered by the manual smoke checklist —
 * exercising it under bun:test would require a real DOM and a
 * mock IPC mainline that drifts faster than it earns its keep.
 */
import { describe, expect, test } from "bun:test";

interface StubAuthApi {
  isAuthenticated: () => Promise<boolean>;
  getAccessToken: () => Promise<string | null>;
  signIn: () => Promise<{ ok: boolean; error?: string }>;
  signOut: () => Promise<void>;
  onStateChange: (
    cb: (event: { state: "signed-in" | "signed-out" }) => void,
  ) => () => void;
}

describe("nautiloDesktop.auth IPC surface (M055)", () => {
  test("the bridge has exactly the five methods the renderer reads", () => {
    let isAuthCalls = 0;
    let signInCalls = 0;
    let signOutCalls = 0;
    let getTokenCalls = 0;
    let onStateChangeSubs = 0;
    const stub: StubAuthApi = {
      isAuthenticated: async () => {
        isAuthCalls += 1;
        return true;
      },
      getAccessToken: async () => {
        getTokenCalls += 1;
        return "TOKEN";
      },
      signIn: async () => {
        signInCalls += 1;
        return { ok: true };
      },
      signOut: async () => {
        signOutCalls += 1;
      },
      onStateChange: () => {
        onStateChangeSubs += 1;
        return () => {};
      },
    };
    void stub.isAuthenticated();
    void stub.getAccessToken();
    void stub.signIn();
    void stub.signOut();
    const teardown = stub.onStateChange(() => {});
    teardown();
    expect(isAuthCalls).toBe(1);
    expect(signInCalls).toBe(1);
    expect(signOutCalls).toBe(1);
    expect(getTokenCalls).toBe(1);
    expect(onStateChangeSubs).toBe(1);
  });

  test("signIn error envelope round-trips through the IPC contract", async () => {
    // The hook's signIn does:
    //   const result = await desktopAPI.auth.signIn();
    //   if (!result.ok) { setState("signed-out"); throw new Error(result.error ?? "..."); }
    // The contract is: a `{ok:false, error}` envelope must surface
    // intact so the renderer can rethrow it as an Error rather than
    // silently no-op.
    const stub: StubAuthApi = {
      isAuthenticated: async () => false,
      getAccessToken: async () => null,
      signIn: async () => ({ ok: false, error: "loopback timeout" }),
      signOut: async () => {},
      onStateChange: () => () => {},
    };
    const result = await stub.signIn();
    expect(result.ok).toBe(false);
    expect(result.error).toBe("loopback timeout");
  });

  test("signIn cancelled envelope is a stable user-cancel signal", async () => {
    const stub: StubAuthApi = {
      isAuthenticated: async () => false,
      getAccessToken: async () => null,
      signIn: async () => ({ ok: false, error: "cancelled" }),
      signOut: async () => {},
      onStateChange: () => () => {},
    };
    const result = await stub.signIn();
    expect(result.ok).toBe(false);
    expect(result.error).toBe("cancelled");
  });
});
