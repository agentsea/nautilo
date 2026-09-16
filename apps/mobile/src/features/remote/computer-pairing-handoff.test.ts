import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module("@/lib/api", () => ({
  normalizeServerUrl: (value: string) => value,
}));

const {
  acceptRemotePairingDeepLink,
  clearRemotePairingHandoff,
  subscribeRemotePairingHandoff,
  takeRemotePairingHandoff,
} = await import("./computer-pairing-handoff");

const challengeId = "7bcf2581-9341-489b-a98b-674c52dc7406";
const ceremonyContext = "11".repeat(32);
const secret = "one-time-verifier";
const link =
  `nautilo://remote/pair?challengeId=${challengeId}` +
  `&secret=${secret}&ceremonyContext=${ceremonyContext}`;

afterEach(clearRemotePairingHandoff);

describe("Remote pairing deep-link handoff", () => {
  test("navigation receives only a pathname and the secret is one-shot", () => {
    const navigations: string[] = [];

    expect(
      acceptRemotePairingDeepLink(link, (route) => navigations.push(route)),
    ).toBe(challengeId);
    expect(navigations).toEqual(["/(onboarding)/scan-computer-qr"]);
    expect(navigations.join("")).not.toContain(secret);
    expect(takeRemotePairingHandoff()).toEqual({
      challengeId,
      secret,
      ceremonyContext,
    });
    expect(takeRemotePairingHandoff()).toBeNull();
  });

  test("a navigation failure synchronously clears the staged secret", () => {
    expect(() =>
      acceptRemotePairingDeepLink(link, () => {
        throw new Error("navigation failed");
      }),
    ).toThrow("navigation failed");
    expect(takeRemotePairingHandoff()).toBeNull();
  });

  test("an open scanner receives a warm link without adding navigation state", () => {
    const received: unknown[] = [];
    const unsubscribe = subscribeRemotePairingHandoff(() => {
      received.push(takeRemotePairingHandoff());
    });
    const navigations: string[] = [];

    expect(
      acceptRemotePairingDeepLink(link, (route) => navigations.push(route)),
    ).toBe(challengeId);
    unsubscribe();

    expect(navigations).toEqual([]);
    expect(received).toEqual([{ challengeId, secret, ceremonyContext }]);
    expect(takeRemotePairingHandoff()).toBeNull();
  });
});
