import { act, type ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";

let callbackSucceeded: (() => void) | undefined;
let callbackError: Error | null = null;
let scrubCallbackUrl = true;
const priorGlobals: Record<string, unknown> = {};
let happyWindow: Window;
let root: Root | null = null;

beforeAll(async () => {
  happyWindow = new Window({ url: "http://localhost:3201/auth/callback?code=opaque&state=opaque" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "sessionStorage"] as const) {
    priorGlobals[key] = (globalThis as Record<string, unknown>)[key];
  }
  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
    sessionStorage: happyWindow.sessionStorage,
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mock.module("@logto/react", () => ({
    // This suite runs beside bootstrap and owner-route suites in one Bun
    // process. Keep the mock import-complete for `use-auth`, which imports
    // these Logto exports even though the callback route itself needs only
    // `useHandleSignInCallback`.
    LogtoProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
    Prompt: { Login: "login", Consent: "consent" },
    useLogto: () => ({ isAuthenticated: false, isLoading: false }),
    useHandleSignInCallback: (onSuccess: () => void) => {
      callbackSucceeded = onSuccess;
      // This is the real ordering that regressed in the browser: Logto has
      // removed the code and reports loading complete before its success
      // continuation runs.
      if (scrubCallbackUrl) happyWindow.history.replaceState(null, "", "/auth/callback");
      return { isLoading: false, error: callbackError };
    },
  }));
});

beforeEach(() => {
  callbackSucceeded = undefined;
  callbackError = null;
  scrubCallbackUrl = true;
  happyWindow.history.replaceState(null, "", "/auth/callback?code=opaque&state=opaque");
  happyWindow.sessionStorage.clear();
  happyWindow.document.body.replaceChildren();
  root = null;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
});

afterAll(async () => {
  for (const [key, value] of Object.entries(priorGlobals)) {
    if (value === undefined) delete (globalThis as Record<string, unknown>)[key];
    else (globalThis as Record<string, unknown>)[key] = value;
  }
  mock.restore();
});

describe("SignInCallback", () => {
  test("does not race a scrubbed real callback to root before the owner continuation", async () => {
    const { writeOwnerClaimHandoff } = await import("../../src/lib/owner-claim-handoff");
    expect(writeOwnerClaimHandoff({
      version: 1,
      claim: `inv_${"a".repeat(32)}`,
      finish: "guide",
      state: "opaque-state",
      handle: "d508_owner",
      stage: "awaiting-signup",
      startedAt: new Date().toISOString(),
    })).toBe(true);
    const { SignInCallback } = await import("../../src/routes/auth-callback");
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <MemoryRouter initialEntries={["/auth/callback?code=opaque&state=opaque"]}>
          <Routes>
            <Route path="/auth/callback" element={<SignInCallback />} />
            <Route path="/claim" element={<p>owner claim continuation</p>} />
            <Route path="/" element={<p>product root</p>} />
          </Routes>
        </MemoryRouter>,
      );
    });

    expect(host.textContent).toContain("Completing sign-in");
    expect(host.textContent).not.toContain("product root");
    await act(async () => callbackSucceeded?.());
    expect(host.textContent).toContain("owner claim continuation");
    expect(host.textContent).not.toContain("product root");
  });

  test("keeps an owner callback error recoverable and sends Back to the exact claim continuation", async () => {
    callbackError = new Error("callback exchange rejected");
    scrubCallbackUrl = false;
    const { writeOwnerClaimHandoff } = await import("../../src/lib/owner-claim-handoff");
    expect(writeOwnerClaimHandoff({
      version: 1,
      claim: `inv_${"b".repeat(32)}`,
      finish: "product",
      state: "opaque-state",
      handle: "d508_owner",
      stage: "profile",
      startedAt: new Date().toISOString(),
    })).toBe(true);
    const { SignInCallback } = await import("../../src/routes/auth-callback");
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <MemoryRouter initialEntries={["/auth/callback?error=access_denied&state=opaque"]}>
          <Routes>
            <Route path="/auth/callback" element={<SignInCallback />} />
            <Route path="/claim" element={<p>recover owner claim</p>} />
            <Route path="/" element={<p>product root</p>} />
          </Routes>
        </MemoryRouter>,
      );
    });

    expect(host.textContent).toContain("Sign-in failed");
    expect(host.textContent).toContain("Back to sign in");
    expect(host.textContent).not.toContain("product root");
    const back = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Back to sign in");
    if (!back) throw new Error("callback recovery action did not render");
    await act(async () => back.click());
    expect(host.textContent).toContain("recover owner claim");
    expect(host.textContent).not.toContain("product root");
  });
});
