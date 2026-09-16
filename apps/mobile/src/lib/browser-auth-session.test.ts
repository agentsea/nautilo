import { describe, expect, test } from "bun:test";

import type { MobileWebAuthBootstrap } from "./browser-auth-contract";
import {
  mapLogtoEndSessionEndpointForMobileWeb,
  MobileWebAuthSession,
  MobileWebCallbackError,
  type MobileWebLogtoSessionClient,
} from "./browser-auth-session";

const origin = "https://alpha.example.test";
const bootstrap: MobileWebAuthBootstrap = {
  logto: { endpoint: "https://auth.example", appId: "mobile-web" },
  resource: "https://api.nautilo.local",
  redirectUri: `${origin}/mobile/callback`,
  postLogoutRedirectUri: `${origin}/mobile`,
};

function harness(input: Readonly<{
  href?: string;
  redirected?: boolean;
  authenticated?: boolean;
  pendingPostRedirectUri?: string | null;
  accessTokenResults?: readonly (string | Error)[];
}> = {}) {
  const calls: Array<readonly [string, unknown?]> = [];
  let tokenCalls = 0;
  const client: MobileWebLogtoSessionClient = {
    isAuthenticated: () => Promise.resolve(input.authenticated ?? false),
    isSignInRedirected: (url) => {
      calls.push(["isSignInRedirected", url]);
      return Promise.resolve(input.redirected ?? false);
    },
    handleSignInCallback: (url) => {
      calls.push(["handleSignInCallback", url]);
      return Promise.resolve();
    },
    signIn: (options) => {
      calls.push(["signIn", options]);
      return Promise.resolve();
    },
    signOut: (url) => {
      calls.push(["signOut", url]);
      return Promise.resolve();
    },
    clearAccessToken: () => {
      calls.push(["clearAccessToken"]);
      return Promise.resolve();
    },
    clearAllTokens: () => {
      calls.push(["clearAllTokens"]);
      return Promise.resolve();
    },
    getAccessToken: () => {
      tokenCalls += 1;
      const result = input.accessTokenResults?.[tokenCalls - 1] ?? "access-token";
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
    getPendingPostRedirectUri: () => Promise.resolve(input.pendingPostRedirectUri ?? null),
  };
  const session = new MobileWebAuthSession({
    client,
    bootstrap,
    location: { href: input.href ?? `${origin}/mobile`, origin },
    history: { replaceState: (_data, _unused, url) => calls.push(["replaceState", String(url)]) },
  });
  return { calls, session, tokenCalls: () => tokenCalls };
}

describe("Mobile Web auth session", () => {
  test("captures and scrubs an owned callback before exchange", async () => {
    const href = `${origin}/mobile/callback?code=secret&state=opaque`;
    const subject = harness({ href, redirected: true });
    expect(await subject.session.initialize()).toBe("callback-complete");
    expect(subject.calls).toEqual([
      ["replaceState", `${origin}/mobile`],
      ["isSignInRedirected", href],
      ["handleSignInCallback", href],
    ]);
  });

  test("scrubs replayed callbacks and fails with a content-safe code", async () => {
    const subject = harness({ href: `${origin}/mobile/callback?code=secret`, redirected: false });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun rejects matcher
    await expect(subject.session.initialize()).rejects.toEqual(
      new MobileWebCallbackError("callback-session-missing"),
    );
    expect(subject.calls[0]).toEqual(["replaceState", `${origin}/mobile`]);
  });

  test("retains only the sanitized SDK-owned return path for callback recovery", async () => {
    const safe = harness({
      href: `${origin}/mobile/callback?error=access_denied&state=opaque`,
      redirected: false,
      pendingPostRedirectUri: `${origin}/mobile/chat/room-1?messageId=42`,
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matcher typing
    await expect(safe.session.initialize()).rejects.toEqual(
      new MobileWebCallbackError("callback-session-missing", "/mobile/chat/room-1?messageId=42"),
    );

    const unsafe = harness({
      href: `${origin}/mobile/callback?error=access_denied&state=opaque`,
      redirected: false,
      pendingPostRedirectUri: "https://evil.example/mobile/chat/room-1?code=secret",
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matcher typing
    await expect(unsafe.session.initialize()).rejects.toEqual(
      new MobileWebCallbackError("callback-session-missing", "/mobile"),
    );
  });

  test("passes only a sanitized same-origin post-login route", async () => {
    const subject = harness();
    await subject.session.signIn("https://evil.example/mobile?code=secret");
    expect(subject.calls[0]?.[0]).toBe("signIn");
    expect(subject.calls[0]?.[1]).toMatchObject({
      redirectUri: `${origin}/mobile/callback`,
      postRedirectUri: `${origin}/mobile`,
    });
  });

  test("coalesces simultaneous token refresh callers within the tab", async () => {
    const subject = harness({ authenticated: true });
    expect(await Promise.all([
      subject.session.getAccessToken(),
      subject.session.getAccessToken(),
      subject.session.getAccessToken(),
    ])).toEqual(["access-token", "access-token", "access-token"]);
    expect(subject.tokenCalls()).toBe(1);
  });

  test("coalesces forced refresh and clears the cached access token once", async () => {
    const subject = harness({ authenticated: true });
    expect(await Promise.all([
      subject.session.getAccessToken({ forceRefresh: true }),
      subject.session.getAccessToken({ forceRefresh: true }),
    ])).toEqual(["access-token", "access-token"]);
    expect(subject.calls.filter(([name]) => name === "clearAccessToken")).toHaveLength(1);
    expect(subject.tokenCalls()).toBe(1);
  });

  test("releases the refresh latch after failure so a later request can recover", async () => {
    const subject = harness({
      authenticated: true,
      accessTokenResults: [new Error("refresh unavailable"), "recovered-token"],
    });
    expect(await Promise.all([
      subject.session.getAccessToken({ forceRefresh: true }),
      subject.session.getAccessToken({ forceRefresh: true }),
    ])).toEqual([null, null]);
    expect(subject.tokenCalls()).toBe(1);

    expect(await subject.session.getAccessToken({ forceRefresh: true })).toBe("recovered-token");
    expect(subject.tokenCalls()).toBe(2);
  });

  test("uses the registered Mobile root for logout", async () => {
    const subject = harness();
    await subject.session.signOut();
    expect(subject.calls).toEqual([["signOut", `${origin}/mobile`]]);
  });

  test("maps the Logto OSS discovery endpoint without changing other URLs", () => {
    expect(mapLogtoEndSessionEndpointForMobileWeb("https://auth.example/oidc/end_session"))
      .toBe("https://auth.example/oidc/session/end");
    expect(mapLogtoEndSessionEndpointForMobileWeb("https://auth.example/oidc/session/end"))
      .toBe("https://auth.example/oidc/session/end");
  });
});
