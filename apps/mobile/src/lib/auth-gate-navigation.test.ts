import { expect, test } from "bun:test";

import {
  failedMobileWebSignInPath,
  mobileWebRouterDestination,
  validatedMobileWebSignInReturnPath,
  webAuthGateNavigationTarget,
} from "./auth-gate-navigation-contract";

const origin = "https://alpha.example.test";

test("carries one safe protected Mobile route into the sign-in screen", () => {
  expect(webAuthGateNavigationTarget(
    "/(onboarding)/sign-in",
    `${origin}/mobile/chat/room-1?messageId=42`,
    origin,
  )).toEqual({
    pathname: "/(onboarding)/sign-in",
    params: { returnTo: "/mobile/chat/room-1?messageId=42" },
  });
  expect(webAuthGateNavigationTarget(
    "/(onboarding)/add-server",
    `${origin}/mobile/chat/room-1`,
    origin,
  )).toBe("/(onboarding)/add-server");
});

test("does not create sign-in loops or preserve rejected browser locations", () => {
  for (const href of [
    `${origin}/mobile`,
    `${origin}/mobile/sign-in?returnTo=/mobile/chat/room-1`,
    `${origin}/mobile/add-server`,
    `${origin}/mobile/callback?code=secret`,
    `${origin}/mobile/chat/room-1#state=secret`,
    "https://evil.example/mobile/chat/room-1",
  ]) {
    expect(webAuthGateNavigationTarget("/(onboarding)/sign-in", href, origin))
      .toBe("/(onboarding)/sign-in");
  }
});

test("validates the visible return parameter and derives its in-app route", () => {
  const safe = validatedMobileWebSignInReturnPath("/mobile/files/artifact/a-1?mode=read", origin);
  expect(safe).toBe("/mobile/files/artifact/a-1?mode=read");
  expect(mobileWebRouterDestination(safe!)).toBe("/files/artifact/a-1?mode=read");
  expect(validatedMobileWebSignInReturnPath("https://evil.example/mobile", origin)).toBeNull();
  expect(validatedMobileWebSignInReturnPath("/mobile/chat/r?code=secret", origin)).toBeNull();
  expect(validatedMobileWebSignInReturnPath("/mobile/sign-in", origin)).toBeNull();
  expect(validatedMobileWebSignInReturnPath("/mobile/add-server", origin)).toBeNull();
  expect(validatedMobileWebSignInReturnPath("/mobile/callback", origin)).toBeNull();
  expect(validatedMobileWebSignInReturnPath("/mobile/chat/r#anchor", origin)).toBeNull();
  expect(validatedMobileWebSignInReturnPath(["/mobile/chat/a", "/mobile/chat/b"], origin)).toBeNull();
  const task = "b487068d-9720-4f0f-a7a0-e84d9e4bff54";
  expect(validatedMobileWebSignInReturnPath(`/mobile/tasks/${task}`, origin)).toBe(`/mobile/tasks/${task}`);
  expect(mobileWebRouterDestination(`/mobile/tasks/${task}`)).toBe(`/tasks/${task}`);
  const room = "6f1b16fb-b1a6-46c8-a3ca-690c4d87931b";
  expect(validatedMobileWebSignInReturnPath(`/mobile/tasks/${task}?originRoomId=${room}`, origin))
    .toBe(`/mobile/tasks/${task}?originRoomId=${room}`);
  for (const value of [
    "/mobile/tasks/not-a-uuid",
    `/mobile/tasks/${task}/extra`,
    `/mobile/tasks/${task}?originRoomId=room`,
    `/mobile/tasks/${task}?originRoomId=${room}&originRoomId=${room}`,
    `/mobile/tasks/${task}?originRoomId=${room}&extra=1`,
    `/mobile/tasks/${task}?token=secret`,
    "/mobile/tasks/%2e%2e/chat/room",
  ]) expect(validatedMobileWebSignInReturnPath(value, origin)).toBeNull();
});

test("failed callback recovery keeps only a visible safe return destination", () => {
  expect(failedMobileWebSignInPath("/mobile/chat/room-1?messageId=42"))
    .toBe("/mobile/sign-in?verification=incomplete&returnTo=%2Fmobile%2Fchat%2Froom-1%3FmessageId%3D42");
  expect(failedMobileWebSignInPath(null))
    .toBe("/mobile/sign-in?verification=incomplete");
  expect(failedMobileWebSignInPath("/mobile/sign-in"))
    .toBe("/mobile/sign-in?verification=incomplete");
  expect(failedMobileWebSignInPath("/mobile/add-server"))
    .toBe("/mobile/sign-in?verification=incomplete");
  expect(failedMobileWebSignInPath("https://evil.example/mobile/chat/room-1"))
    .toBe("/mobile/sign-in?verification=incomplete");
});
