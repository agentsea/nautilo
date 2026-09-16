import { describe, expect, test } from "bun:test";

import { authGateDestination, isDeadSessionResponse, shouldHandleAuthDead, signedInLandingDestination } from "./session-expiry";

const rootLayoutSource = await Bun.file(
  new URL("../app/_layout.tsx", import.meta.url),
).text();

describe("mobile session expiry", () => {
  test("classifies only canonical bearer/session failures as dead sessions", () => {
    for (const error of ["Authentication required", "authentication_required", "Unauthorized", "missing_bearer", "invalid_token", "Sign in to list devices"]) {
      expect(isDeadSessionResponse({ url: "https://n.test/api/config/models", method: "GET", error, retryAttempted: false }))
        .toBe(true);
    }
  });

  test("keeps proof, ticket, and unknown 401 failures in their focused flows", () => {
    for (const error of [
      "Current PIN is incorrect",
      "Invalid PIN",
      "Invalid recovery code",
      "invalid_credentials",
      "Current password is incorrect",
      "Identity re-verification failed.",
      "fresh_reauth_required",
      "invalid_pending_authorization",
      "ticket_expired",
      null,
    ]) {
      expect(isDeadSessionResponse({ url: "https://n.test/api/auth/pin", method: "POST", error, retryAttempted: false }))
        .toBe(false);
    }
  });

  test("routes every protected root to the selected server sign-in", () => {
    for (const rootSegment of ["(drawer)", "chat", "files", "memory", "settings", undefined]) {
      expect(authGateDestination({
        serversLoading: false,
        authStatus: "signed-out",
        hasActiveServer: true,
        rootSegment,
      })).toBe("/(onboarding)/sign-in");
    }
  });

  test("waits for hydration and never displaces onboarding or OAuth callback", () => {
    expect(authGateDestination({ serversLoading: true, authStatus: "signed-out", hasActiveServer: true, rootSegment: "chat" })).toBeNull();
    expect(authGateDestination({ serversLoading: false, authStatus: "loading", hasActiveServer: true, rootSegment: "chat" })).toBeNull();
    expect(authGateDestination({ serversLoading: false, authStatus: "signed-out", hasActiveServer: true, rootSegment: "(onboarding)" })).toBeNull();
    expect(authGateDestination({ serversLoading: false, authStatus: "signed-out", hasActiveServer: true, rootSegment: "callback" })).toBeNull();
  });

  test("routes a hydrated server-less app to add-server", () => {
    expect(authGateDestination({ serversLoading: false, authStatus: "signed-out", hasActiveServer: false, rootSegment: "chat" }))
      .toBe("/(onboarding)/add-server");
    expect(authGateDestination({ serversLoading: false, authStatus: "signed-out", hasActiveServer: false, rootSegment: "(onboarding)" }))
      .toBeNull();
  });

  test("leaves a stale sign-in route once the persisted session verifies", () => {
    expect(signedInLandingDestination("loading")).toBeNull();
    expect(signedInLandingDestination("signed-out")).toBeNull();
    expect(signedInLandingDestination("signed-in")).toBe("/(drawer)/(tabs)");
  });

  test("keeps the root navigator mounted while navigating to sign-in", () => {
    expect(rootLayoutSource).toContain("router.replace(authGateNavigationTarget(authGate.destination))");
    expect(rootLayoutSource).toContain('<Stack screenOptions={{ headerShown: false }}>');
    expect(rootLayoutSource).not.toContain("return <Redirect");
    expect(rootLayoutSource).not.toContain("return <SessionLoadingBoundary");
  });

  test("handles only the active server and collapses concurrent auth-dead signals", () => {
    expect(shouldHandleAuthDead({ activeServerId: "server-a", rejectedServerId: "server-a", authStatus: "signed-in" })).toBe(true);
    expect(shouldHandleAuthDead({ activeServerId: "server-b", rejectedServerId: "server-a", authStatus: "signed-in" })).toBe(false);
    expect(shouldHandleAuthDead({ activeServerId: "server-a", rejectedServerId: "server-a", authStatus: "loading" })).toBe(false);
    expect(shouldHandleAuthDead({ activeServerId: "server-a", rejectedServerId: "server-a", authStatus: "signed-out" })).toBe(false);
  });
});
