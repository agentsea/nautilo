/**
 * M097 — Stale bearer detection for `/api/auth/whoami` (200 + guest/stranger shape).
 */
import { describe, expect, test } from "bun:test";
import type { WhoamiResponse } from "@nautilo/types";
import {
  computeStaleBearerSignOutAction,
  detectStaleWhoamiResponse,
} from "../../src/hooks/use-auth-stale-detection";

const staleGuestWhoami: Partial<WhoamiResponse> = {
  actorRole: "guest",
  sessionUserId: null,
};

const validOwnerWhoami: Partial<WhoamiResponse> = {
  actorRole: "owner",
  sessionUserId: "550e8400-e29b-41d4-a716-446655440000",
  actorLabel: "Owner",
};

describe("detectStaleWhoamiResponse (M097)", () => {
  test("non-empty token + guest + null sessionUserId → stale", () => {
    expect(detectStaleWhoamiResponse("abc", staleGuestWhoami)).toBe(true);
  });

  test("non-empty token + stranger + null sessionUserId → stale", () => {
    expect(
      detectStaleWhoamiResponse("abc", {
        actorRole: "stranger",
        sessionUserId: null,
      }),
    ).toBe(true);
  });

  test("second poll semantics: detection alone does not encode ref guard", () => {
    expect(detectStaleWhoamiResponse("tok", staleGuestWhoami)).toBe(true);
    expect(detectStaleWhoamiResponse("tok", staleGuestWhoami)).toBe(true);
  });

  test("non-empty token + owner + session → not stale", () => {
    expect(detectStaleWhoamiResponse("abc", validOwnerWhoami)).toBe(false);
  });

  test("empty / null token → never stale", () => {
    expect(detectStaleWhoamiResponse(null, staleGuestWhoami)).toBe(false);
    expect(detectStaleWhoamiResponse(undefined, staleGuestWhoami)).toBe(false);
    expect(detectStaleWhoamiResponse("", staleGuestWhoami)).toBe(false);
  });

  test("guest with sessionUserId set → not stale", () => {
    expect(
      detectStaleWhoamiResponse("abc", {
        actorRole: "guest",
        sessionUserId: "550e8400-e29b-41d4-a716-446655440000",
      }),
    ).toBe(false);
  });

  test("unknown actorRole normalizes to guest; null session → stale", () => {
    expect(
      detectStaleWhoamiResponse("abc", {
        actorRole: "nope" as WhoamiResponse["actorRole"],
        sessionUserId: null,
      }),
    ).toBe(true);
  });
});

describe("computeStaleBearerSignOutAction (M097 ref guard)", () => {
  test("stale whoami with token, guard false → signOut once", () => {
    const a = computeStaleBearerSignOutAction({
      nonEmptyToken: true,
      whoami: staleGuestWhoami,
      staleSignOutAlreadyTriggered: false,
    });
    expect(a.shouldSignOut).toBe(true);
    expect(a.nextStaleSignOutTriggered).toBe(true);
  });

  test("same stale response with guard true → no second signOut", () => {
    const a = computeStaleBearerSignOutAction({
      nonEmptyToken: true,
      whoami: staleGuestWhoami,
      staleSignOutAlreadyTriggered: true,
    });
    expect(a.shouldSignOut).toBe(false);
    expect(a.nextStaleSignOutTriggered).toBe(true);
  });

  test("valid owner whoami → no signOut; guard clears", () => {
    const a = computeStaleBearerSignOutAction({
      nonEmptyToken: true,
      whoami: validOwnerWhoami,
      staleSignOutAlreadyTriggered: true,
    });
    expect(a.shouldSignOut).toBe(false);
    expect(a.nextStaleSignOutTriggered).toBe(false);
  });

  test("no token path → no signOut; guard off", () => {
    const a = computeStaleBearerSignOutAction({
      nonEmptyToken: false,
      whoami: staleGuestWhoami,
      staleSignOutAlreadyTriggered: true,
    });
    expect(a.shouldSignOut).toBe(false);
    expect(a.nextStaleSignOutTriggered).toBe(false);
  });

  test("after guard reset (auth-changed), stale again → signOut fires again", () => {
    let guard = false;
    const first = computeStaleBearerSignOutAction({
      nonEmptyToken: true,
      whoami: staleGuestWhoami,
      staleSignOutAlreadyTriggered: guard,
    });
    expect(first.shouldSignOut).toBe(true);
    guard = first.nextStaleSignOutTriggered;

    const second = computeStaleBearerSignOutAction({
      nonEmptyToken: true,
      whoami: staleGuestWhoami,
      staleSignOutAlreadyTriggered: guard,
    });
    expect(second.shouldSignOut).toBe(false);

    guard = false;
    const third = computeStaleBearerSignOutAction({
      nonEmptyToken: true,
      whoami: staleGuestWhoami,
      staleSignOutAlreadyTriggered: guard,
    });
    expect(third.shouldSignOut).toBe(true);
  });
});
