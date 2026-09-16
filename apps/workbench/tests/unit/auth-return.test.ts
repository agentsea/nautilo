import { afterEach, describe, expect, test } from "bun:test";
import {
  AUTH_RETURN_STORAGE_KEY,
  authCallbackStartedWithCode,
  authReturnDestinationForLocation,
  captureAuthReturn,
  consumeAuthReturnPath,
  resolveAuthCallbackErrorDestination,
  resolveAuthCallbackDestination,
} from "../../src/lib/auth-return";

function makeStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
    removeItem(key: string) { values.delete(key); },
  } as Storage;
}

describe("auth return", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "sessionStorage");
  });

  test("captures only exact code-owned protected destinations and consumes them once", () => {
    const storage = makeStorage();
    Object.defineProperty(globalThis, "sessionStorage", { value: storage, configurable: true });

    expect(captureAuthReturn({ pathname: "/help/server" })).toBe("server-guide");
    expect(consumeAuthReturnPath()).toBe("/help/server");
    expect(consumeAuthReturnPath()).toBeNull();
    expect(storage.getItem(AUTH_RETURN_STORAGE_KEY)).toBeNull();
    expect(captureAuthReturn({ pathname: "/help/server", hash: "#https://evil.example" })).toBe("server-guide");
    expect(captureAuthReturn({ pathname: "/rooms/anything" })).toBeNull();
    expect(storage.getItem(AUTH_RETURN_STORAGE_KEY)).toBeNull();
  });

  test("uses exact known hashes and rejects arbitrary callback destinations", () => {
    expect(authReturnDestinationForLocation({ pathname: "/admin", hash: "#invites" })).toBe("invite-team");
    expect(authReturnDestinationForLocation({ pathname: "/settings", hash: "#security" })).toBe("settings-security");
    expect(authReturnDestinationForLocation({ pathname: "/admin", hash: "#other" })).toBeNull();
    expect(authReturnDestinationForLocation({ pathname: "https://evil.example" })).toBeNull();
  });

  test("restores the exact Security destination after ordinary sign-in", () => {
    const storage = makeStorage();
    Object.defineProperty(globalThis, "sessionStorage", { value: storage, configurable: true });
    expect(captureAuthReturn({ pathname: "/settings", hash: "#security" })).toBe("settings-security");
    expect(resolveAuthCallbackDestination({})).toBe("/settings#security");
  });

  test("owner and invite continuations take callback precedence without consuming normal return", () => {
    const storage = makeStorage();
    Object.defineProperty(globalThis, "sessionStorage", { value: storage, configurable: true });
    captureAuthReturn({ pathname: "/settings", hash: "#keys" });

    expect(resolveAuthCallbackDestination({ ownerClaimStage: "awaiting-bind" })).toBe("/claim");
    expect(consumeAuthReturnPath()).toBe("/admin#provider-credentials");

    captureAuthReturn({ pathname: "/settings", hash: "#keys" });
    expect(resolveAuthCallbackDestination({ ownerClaimStage: "profile" })).toBe("/claim");
    expect(consumeAuthReturnPath()).toBe("/admin#provider-credentials");

    captureAuthReturn({ pathname: "/help/server" });
    expect(resolveAuthCallbackDestination({
      ordinaryInvite: { token: "inv_abc", stage: "awaiting-signup" },
    })).toBe("/invite/inv_abc");
    expect(consumeAuthReturnPath()).toBe("/help/server");
  });

  test("callback-error Back keeps the same owner/invite precedence without consuming normal return", () => {
    const storage = makeStorage();
    Object.defineProperty(globalThis, "sessionStorage", { value: storage, configurable: true });
    captureAuthReturn({ pathname: "/settings", hash: "#keys" });

    expect(resolveAuthCallbackErrorDestination({ ownerClaimStage: "profile" })).toBe("/claim");
    expect(consumeAuthReturnPath()).toBe("/admin#provider-credentials");

    captureAuthReturn({ pathname: "/help/server" });
    expect(resolveAuthCallbackErrorDestination({
      ordinaryInvite: { token: "inv_abc", stage: "awaiting-signup" },
    })).toBe("/invite/inv_abc");
    expect(consumeAuthReturnPath()).toBe("/help/server");
  });

  test("ordinary callback consumes the stored exact return and otherwise falls back to product root", () => {
    const storage = makeStorage();
    Object.defineProperty(globalThis, "sessionStorage", { value: storage, configurable: true });
    captureAuthReturn({ pathname: "/admin", hash: "#server" });
    expect(resolveAuthCallbackDestination({})).toBe("/admin#server");
    expect(resolveAuthCallbackDestination({})).toBe("/");
  });

  test("pins real callback intent before Logto scrubs the live query", () => {
    expect(authCallbackStartedWithCode("?code=opaque&state=opaque")).toBe(true);
    expect(authCallbackStartedWithCode("?code=&state=opaque")).toBe(false);
    expect(authCallbackStartedWithCode("")).toBe(false);
    expect(authCallbackStartedWithCode("?state=orphaned")).toBe(false);
  });
});
