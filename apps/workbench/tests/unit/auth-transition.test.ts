import { describe, expect, test } from "bun:test";
import {
  classifyCredentialTransitionReason,
  classifyViewerTransitionReason,
  isAuthTransitionDetail,
  latchCredentialToken,
  shouldIgnoreCredentialOnlyTransition,
  viewerIdentityKey,
} from "../../src/lib/auth-transition";

describe("auth-transition helpers (M214)", () => {
  test("viewerIdentityKey combines session user and instance", () => {
    expect(
      viewerIdentityKey({ sessionUserId: "user-1", instanceId: "inst-a" }),
    ).toBe("user-1:inst-a");
    expect(viewerIdentityKey({ sessionUserId: "user-1" })).toBe("user-1");
    expect(viewerIdentityKey({ sessionUserId: null })).toBeNull();
  });

  test("classifyCredentialTransitionReason", () => {
    expect(
      classifyCredentialTransitionReason({ hadToken: false, hasToken: true, recovered: false }),
    ).toBe("signed-in");
    expect(
      classifyCredentialTransitionReason({ hadToken: true, hasToken: false, recovered: false }),
    ).toBe("signed-out");
    expect(
      classifyCredentialTransitionReason({ hadToken: true, hasToken: true, recovered: false }),
    ).toBe("credential-refreshed");
    expect(
      classifyCredentialTransitionReason({ hadToken: false, hasToken: true, recovered: true }),
    ).toBe("recovered");
  });

  test("classifyViewerTransitionReason", () => {
    expect(
      classifyViewerTransitionReason({
        previousKey: null,
        nextKey: "user-1:inst-a",
        previousInstanceId: null,
        nextInstanceId: "inst-a",
        signedOut: false,
        signedIn: true,
      }),
    ).toBe("signed-in");
    expect(
      classifyViewerTransitionReason({
        previousKey: "user-1:inst-a",
        nextKey: null,
        previousInstanceId: "inst-a",
        nextInstanceId: null,
        signedOut: true,
        signedIn: false,
      }),
    ).toBe("signed-out");
    expect(
      classifyViewerTransitionReason({
        previousKey: "user-1:inst-a",
        nextKey: "user-2:inst-a",
        previousInstanceId: "inst-a",
        nextInstanceId: "inst-a",
        signedOut: false,
        signedIn: false,
      }),
    ).toBe("user-switched");
    expect(
      classifyViewerTransitionReason({
        previousKey: "user-1:inst-a",
        nextKey: "user-1:inst-b",
        previousInstanceId: "inst-a",
        nextInstanceId: "inst-b",
        signedOut: false,
        signedIn: false,
      }),
    ).toBe("instance-switched");
  });

  test("shouldIgnoreCredentialOnlyTransition ignores same-viewer silent refresh", () => {
    expect(
      shouldIgnoreCredentialOnlyTransition(3, {
        credentialGeneration: 4,
        viewerGeneration: 3,
        reason: "credential-refreshed",
      }),
    ).toBe(true);
    expect(
      shouldIgnoreCredentialOnlyTransition(3, {
        credentialGeneration: 4,
        viewerGeneration: 4,
        reason: "credential-refreshed",
      }),
    ).toBe(false);
    expect(
      shouldIgnoreCredentialOnlyTransition(null, {
        credentialGeneration: 1,
        viewerGeneration: 1,
        reason: "credential-refreshed",
      }),
    ).toBe(false);
  });

  test("isAuthTransitionDetail validates allowed reasons only", () => {
    expect(
      isAuthTransitionDetail({
        credentialGeneration: 1,
        viewerGeneration: 2,
        reason: "signed-in",
      }),
    ).toBe(true);
    expect(
      isAuthTransitionDetail({
        credentialGeneration: 1,
        viewerGeneration: 2,
        reason: "token-rotated",
      }),
    ).toBe(false);
  });

  test("viewer-check token acquisition latches a refresh and publishes exactly one transition", () => {
    let effectiveToken: string | null = "old-token";
    let credentialGeneration = 7;
    const transitions: Array<{
      credentialGeneration: number;
      viewerGeneration: number;
      reason: string;
    }> = [];
    const setToken = (token: string | null): void => {
      const normalized = token && token.length > 0 ? token : null;
      if (normalized !== effectiveToken) {
        effectiveToken = normalized;
        credentialGeneration += 1;
      }
    };

    const refreshed = latchCredentialToken({
      acquiredToken: "new-token",
      previousToken: "old-token",
      recovered: false,
      viewerGeneration: 4,
      setToken,
      getCredentialGeneration: () => credentialGeneration,
      publish: (detail) => transitions.push(detail),
    });

    expect(refreshed.changed).toBe(true);
    expect(refreshed.credentialGeneration).toBe(8);
    expect(refreshed.reason).toBe("credential-refreshed");
    expect(transitions).toEqual([
      {
        credentialGeneration: 8,
        viewerGeneration: 4,
        reason: "credential-refreshed",
      },
    ]);

    const relatched = latchCredentialToken({
      acquiredToken: "new-token",
      previousToken: "new-token",
      recovered: false,
      viewerGeneration: 4,
      setToken,
      getCredentialGeneration: () => credentialGeneration,
      publish: (detail) => transitions.push(detail),
    });

    expect(relatched.changed).toBe(false);
    expect(transitions).toHaveLength(1);
  });
});
