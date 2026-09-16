import { describe, expect, test } from "bun:test";

const source = await Bun.file(new URL("../../app/callback.tsx", import.meta.url)).text();

describe("native auth callback route", () => {
  test("ordinary sign-in never exposes invite sign-up recovery", () => {
    const ordinaryCallback = source.slice(
      source.indexOf("if (!route)"),
      source.indexOf('setCallbackKind("invite")'),
    );

    expect(ordinaryCallback).toContain('pathname: "/(onboarding)/sign-in"');
    expect(ordinaryCallback).toContain('verification: "incomplete"');
    expect(ordinaryCallback).not.toContain("setInviteUnavailable");
    expect(source).toContain('callbackKind === "invite" ? "Completing secure sign-up…" : "Completing sign-in…"');
  });

  test("a completed ordinary callback leaves the transport route", () => {
    expect(source).toContain('status === "signed-in" && callbackKind === "ordinary"');
    expect(source).toContain('router.replace("/(drawer)/(tabs)")');
  });
});
