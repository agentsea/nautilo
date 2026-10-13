import { beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

const browser = new Window({ url: "https://alpha.example.test/mobile/" });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
});

let navigationState: { key: string } | undefined;
const navigations: unknown[] = [];
mock.module("expo-router", () => ({
  router: { replace: (target: unknown) => { navigations.push(target); } },
  useRootNavigationState: () => navigationState,
}));

const {
  captureWebCryptoAdmissionNavigationResume,
  CryptoAdmissionNavigationResume,
} = await import("./crypto-admission-navigation-resume.web");
const { CryptoAdmissionNavigationResumeProvider } = await import(
  "./crypto-admission-navigation-resume-context"
);

const origin = "https://alpha.example.test";
const task = "b487068d-9720-4f0f-a7a0-e84d9e4bff54";

beforeEach(() => {
  navigationState = undefined;
  navigations.length = 0;
});

test("captures only an exact safe sign-in return or current protected route", () => {
  expect(captureWebCryptoAdmissionNavigationResume(
    "scope-a",
    `${origin}/mobile/sign-in?returnTo=${encodeURIComponent(`/mobile/tasks/${task}`)}`,
    origin,
  )).toEqual({ admissionKey: "scope-a", destination: `/tasks/${task}` });
  expect(captureWebCryptoAdmissionNavigationResume(
    "scope-a",
    `${origin}/mobile/tasks/${task}`,
    origin,
  )).toEqual({ admissionKey: "scope-a", destination: `/tasks/${task}` });

  for (const href of [
    `${origin}/mobile/sign-in`,
    `${origin}/mobile/sign-in?returnTo=${encodeURIComponent(`/mobile/tasks/${task}`)}&returnTo=${encodeURIComponent("/mobile/settings")}`,
    `${origin}/mobile/sign-in?returnTo=${encodeURIComponent(`/mobile/tasks/${task}`)}&verification=incomplete`,
    `${origin}/mobile/sign-in?returnTo=${encodeURIComponent("https://evil.example/mobile/settings")}`,
    `${origin}/mobile/sign-in?returnTo=${encodeURIComponent(`/mobile/tasks/${task}?token=secret`)}`,
    `https://evil.example/mobile/tasks/${task}`,
    `${origin}/mobile/tasks/not-a-uuid`,
    `${origin}/mobile/tasks/%2e%2e/settings`,
    `${origin}/mobile/tasks/${task}?token=secret`,
    `${origin}/mobile/tasks/${task}#secret`,
    `${origin}/mobile/callback`,
    `${origin}/mobile`,
  ]) {
    expect(captureWebCryptoAdmissionNavigationResume("scope-a", href, origin)).toBeNull();
  }
});

test("waits for the root navigator, rechecks scope, and consumes once", async () => {
  const intent = { admissionKey: "scope-a", destination: `/tasks/${task}` };
  const consumed: unknown[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = async (ready: boolean, admissionKey = "scope-a") => {
    await act(async () => {
      root.render(createElement(
        CryptoAdmissionNavigationResumeProvider,
        {
          binding: {
            admissionKey,
            intent,
            onConsumed: (value) => { consumed.push(value); },
          },
          children: createElement(CryptoAdmissionNavigationResume, { ready }),
        },
      ));
      await Promise.resolve();
    });
  };
  try {
    await render(false);
    expect(navigations).toEqual([]);
    expect(consumed).toEqual([]);

    navigationState = { key: "root-ready" };
    await render(false);
    expect(navigations).toEqual([]);
    expect(consumed).toEqual([]);

    await render(true, "scope-b");
    expect(navigations).toEqual([]);
    expect(consumed).toEqual([]);

    await render(true);
    expect(navigations).toEqual([`/tasks/${task}`]);
    expect(consumed).toEqual([intent]);

    await render(true);
    expect(navigations).toEqual([`/tasks/${task}`]);
    expect(consumed).toEqual([intent]);
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
  }
});
