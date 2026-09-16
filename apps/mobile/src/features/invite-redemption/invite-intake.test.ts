/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { parseDeepLink } from "@/lib/deep-link";

import { InviteIntake, inviteRouteFromParams, type InviteRoute } from "./invite-intake";
import type { InviteHandoffInput } from "./invite-handoff";

const first = "https://alpha.example.test/redeem/inv_first";
const second = "nautilo://invite?server=https%3A%2F%2Fother.nautilo.dev&token=inv_second";

function harness() {
  const saved: InviteHandoffInput[] = [];
  const cleared: string[] = [];
  const routes: InviteRoute[] = [];
  const events: string[] = [];
  const intake = new InviteIntake({
    now: () => 1_000_000,
    createCeremonyId: (generation) => `ceremony-${generation}`,
    serverIdForUrl: (url) => `srv_${url.replace(/[^a-z0-9]/gi, "_")}`,
    save: async (input) => { events.push("save"); saved.push(input); },
    clear: async (serverId) => { events.push("clear"); cleared.push(serverId); },
    saveCallbackLocator: async () => { events.push("save-callback"); },
    clearCallbackLocator: async () => { events.push("clear-callback"); },
  });
  return {
    intake,
    saved,
    cleared,
    routes,
    events,
    navigate: (route: InviteRoute) => { events.push("navigate"); routes.push(route); },
  };
}

describe("invite intake", () => {
  test("accepts full HTTPS and custom locators through the same persisted route contract", async () => {
    const h = harness();
    const https = await h.intake.acceptParsed(parseDeepLink(first), "manual", h.navigate);
    expect(https).toMatchObject({ kind: "accepted", route: { params: { serverUrl: "https://alpha.example.test", generation: "1" } } });
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]).toMatchObject({ serverUrl: "https://alpha.example.test", inviteToken: "inv_first", stage: "preview", prepareState: null, handle: null });
    const httpsRoute = (https as Extract<typeof https, { kind: "accepted" }>).route.params;
    expect(Object.keys(httpsRoute).sort()).toEqual(["ceremonyId", "generation", "serverId", "serverUrl"]);
    expect(JSON.stringify(httpsRoute)).not.toContain("inv_first");
    expect(h.events).toEqual(["save", "save-callback", "navigate"]);

    const custom = await h.intake.acceptParsed(parseDeepLink(second), "qr", h.navigate);
    expect(custom).toMatchObject({ kind: "accepted", route: { params: { serverUrl: "https://other.nautilo.dev", generation: "2" } } });
    expect(h.saved).toHaveLength(2);
    expect(h.cleared).toEqual(["srv_https___alpha_example_test"]);
    expect(JSON.stringify(h.routes)).not.toContain("inv_second");
  });

  test("exposes only active route correlation for callback recovery, never the bearer", async () => {
    const h = harness();
    expect(h.intake.activeRoute()).toBeNull();
    const accepted = await h.intake.acceptParsed(parseDeepLink(first), "deep-link", h.navigate);
    if (accepted.kind !== "accepted") throw new Error("expected accepted invite");
    expect(h.intake.activeRoute()).toEqual(accepted.route);
    expect(JSON.stringify(h.intake.activeRoute())).not.toContain("inv_first");
  });

  test("rejects token-only and invalid input without custody writes or navigation", async () => {
    const h = harness();
    const tokenOnly = await h.intake.acceptParsed(parseDeepLink("nautilo://invite?token=inv_secret"), "manual", h.navigate);
    const invalid = await h.intake.acceptParsed(parseDeepLink("not an invite"), "qr", h.navigate);
    expect(tokenOnly).toMatchObject({ kind: "invalid" });
    expect(invalid).toMatchObject({ kind: "invalid" });
    expect(h.saved).toHaveLength(0);
    expect(h.cleared).toHaveLength(0);
    expect(h.routes).toHaveLength(0);
  });

  test("dedupes cold and warm delivery of the same locator", async () => {
    const h = harness();
    const cold = h.intake.acceptParsed(parseDeepLink(first), "deep-link", h.navigate);
    const warm = h.intake.acceptParsed(parseDeepLink(first), "deep-link", h.navigate);
    expect((await cold).kind).toBe("accepted");
    expect(await warm).toEqual({ kind: "duplicate" });
    expect(h.saved).toHaveLength(1);
    expect(h.routes).toHaveLength(1);
  });

  test("a newer locator clears the older handoff and fences its pending navigation", async () => {
    const h = harness();
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    let firstSave = true;
    const intake = new InviteIntake({
      now: () => 1_000_000,
      createCeremonyId: (generation) => `ceremony-${generation}`,
      serverIdForUrl: (url) => `srv_${url.replace(/[^a-z0-9]/gi, "_")}`,
      save: async (input) => {
        h.saved.push(input);
        if (firstSave) {
          firstSave = false;
          markFirstStarted();
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
        }
      },
      clear: async (serverId) => { h.cleared.push(serverId); },
      saveCallbackLocator: async () => undefined,
      clearCallbackLocator: async () => undefined,
    });
    const old = intake.acceptParsed(parseDeepLink(first), "deep-link", h.navigate);
    await firstStarted;
    const oldRef = { generation: 1, serverId: "srv_https___alpha_example_test", ceremonyId: "ceremony-1" };
    expect(intake.ceremonyOwnership(oldRef)).toBe(true);
    const newer = intake.acceptParsed(parseDeepLink(second), "qr", h.navigate);
    await Promise.resolve();
    // This flips before the queued old write is released or either intake
    // navigates. A still-mounted old route must now fence every mutation.
    expect(intake.ceremonyOwnership(oldRef)).toBe(false);
    expect(intake.ceremonyOwnership({ generation: 2, serverId: "srv_https___other_nautilo_dev", ceremonyId: "ceremony-2" })).toBe(true);
    releaseFirst();
    expect(await old).toEqual({ kind: "duplicate" });
    expect((await newer).kind).toBe("accepted");
    expect(h.cleared).toEqual(["srv_https___alpha_example_test"]);
    expect(h.routes).toHaveLength(1);
    expect(h.routes[0]?.params.serverUrl).toBe("https://other.nautilo.dev");
    expect(JSON.stringify(h.routes)).not.toContain("inv_first");
  });

  test("reports untracked only when this process has no active intake record", () => {
    const h = harness();
    expect(h.intake.ceremonyOwnership({ generation: 9, serverId: "srv_restored", ceremonyId: "restored" })).toBeNull();
  });

  test("propagates a failed owned cleanup so the screen can remain fail-closed and retry", async () => {
    let cleanupAttempts = 0;
    const intake = new InviteIntake({
      now: () => 1_000_000,
      createCeremonyId: () => "ceremony-1",
      serverIdForUrl: () => "srv_fixture",
      save: async () => undefined,
      clear: async () => {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) throw new Error("secure storage unavailable");
      },
      saveCallbackLocator: async () => undefined,
      clearCallbackLocator: async () => undefined,
    });
    const accepted = await intake.acceptParsed(parseDeepLink(first), "manual", () => undefined);
    expect(accepted.kind).toBe("accepted");
    const ref = { generation: 1, serverId: "srv_fixture", ceremonyId: "ceremony-1" };
    let cleanupError: unknown = null;
    try {
      await intake.settle(ref, "terminal-failure");
    } catch (error) {
      cleanupError = error;
    }
    expect(cleanupError).toBeInstanceOf(Error);
    expect((cleanupError as Error).message).toBe("secure storage unavailable");
    expect(intake.ceremonyOwnership(ref)).toBe(true);
    expect(await intake.settle(ref, "terminal-failure")).toBe("cleared");
    expect(intake.ceremonyOwnership(ref)).toBeNull();
  });

  test("terminal settlement releases ownership so the same locator can be accepted again, while retryable work retains it", async () => {
    const h = harness();
    const accepted = await h.intake.acceptParsed(parseDeepLink(first), "manual", h.navigate);
    if (accepted.kind !== "accepted") throw new Error("expected accepted intake");
    const ref = {
      generation: Number(accepted.route.params.generation),
      serverId: accepted.route.params.serverId,
      ceremonyId: accepted.route.params.ceremonyId,
    };
    expect(await h.intake.settle(ref, "retryable-network")).toBe("retained");
    expect(h.intake.ceremonyOwnership(ref)).toBe(true);
    expect(await h.intake.acceptParsed(parseDeepLink(first), "manual", h.navigate)).toEqual({ kind: "duplicate" });

    expect(await h.intake.settle(ref, "terminal-failure")).toBe("cleared");
    expect(h.intake.ceremonyOwnership(ref)).toBeNull();
    expect((await h.intake.acceptParsed(parseDeepLink(first), "manual", h.navigate)).kind).toBe("accepted");
  });

  test("persistence failure never navigates or retains the active ceremony", async () => {
    const h = harness();
    const intake = new InviteIntake({
      now: () => 1_000_000,
      createCeremonyId: () => "ceremony-1",
      serverIdForUrl: () => "srv_fixture",
      save: async () => { throw new Error("secure store unavailable"); },
      clear: async () => undefined,
      saveCallbackLocator: async () => undefined,
      clearCallbackLocator: async () => undefined,
    });
    expect(await intake.acceptParsed(parseDeepLink(first), "manual", h.navigate)).toEqual({
      kind: "persistence-failed",
      message: "We couldn’t safely save this invite. Try again.",
    });
    expect(h.routes).toHaveLength(0);
  });

  test("accepts only safe bounded route params and never a token field", () => {
    const route = inviteRouteFromParams({
      serverUrl: "https://alpha.example.test",
      serverId: "srv_alpha",
      generation: "4",
      ceremonyId: "ceremony-4",
    });
    expect(route).toEqual({ serverUrl: "https://alpha.example.test", serverId: "srv_alpha", generation: "4", ceremonyId: "ceremony-4" });
    expect(Object.keys(route ?? {}).sort()).toEqual(["ceremonyId", "generation", "serverId", "serverUrl"]);
    expect(inviteRouteFromParams({ serverUrl: "https://alpha.example.test", serverId: "srv_alpha", generation: "0", ceremonyId: "ceremony" })).toBeNull();
    expect(inviteRouteFromParams({ serverUrl: "https://alpha.example.test/path", serverId: "srv_alpha", generation: "1", ceremonyId: "ceremony" })).toBeNull();
  });
});
