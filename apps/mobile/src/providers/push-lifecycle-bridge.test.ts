/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { pushLifecycleBridgeKey } from "@/lib/push-lifecycle-bridge-key";

describe("D468 push lifecycle bridge key", () => {
  const registry = [{ id: "srv_one", serverUrl: "https://one.test" }];

  test("retries after the verified owner is persisted, not merely during unverified hydration", () => {
    const unverified = pushLifecycleBridgeKey({
      registry,
      activeServerId: "srv_one",
      authStatus: "signed-in",
      viewerState: "cached",
      verifiedUserId: null,
    });
    const verified = pushLifecycleBridgeKey({
      registry,
      activeServerId: "srv_one",
      authStatus: "signed-in",
      viewerState: "verified",
      verifiedUserId: "human-one",
    });
    expect(verified).not.toBe(unverified);
  });

  test("retries for explicit sign-out and membership removal so badge reconciliation can clear safely", () => {
    const signedIn = pushLifecycleBridgeKey({
      registry,
      activeServerId: "srv_one",
      authStatus: "signed-in",
      viewerState: "verified",
      verifiedUserId: "human-one",
    });
    const signedOut = pushLifecycleBridgeKey({
      registry,
      activeServerId: "srv_one",
      authStatus: "signed-out",
      viewerState: "none",
      verifiedUserId: null,
    });
    const removed = pushLifecycleBridgeKey({
      registry: [],
      activeServerId: null,
      authStatus: "signed-out",
      viewerState: "none",
      verifiedUserId: null,
    });
    expect(signedOut).not.toBe(signedIn);
    expect(removed).not.toBe(signedOut);
  });
});
