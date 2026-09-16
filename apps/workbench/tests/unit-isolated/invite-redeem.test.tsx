import { act, StrictMode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { fireEvent } from "@testing-library/react";
import { ApiError } from "@nautilo/api-client/browser";
import {
  OWNER_CLAIM_TERMINAL_STORAGE_KEY,
  readOwnerClaimTerminalMarker,
} from "../../src/lib/owner-claim-terminal";

const apiStub = {
  previewInvite: mock(() => Promise.resolve(null)),
  prepareLogtoSignup: mock(() => Promise.resolve({ url: "", state: "", expiresAt: "" })),
  bindLogtoUser: mock(() => Promise.resolve({ ok: true })),
  completeInviteProfile: mock(() => Promise.resolve({ ok: true as const, recoveryCodes: [], landingRoomId: null })),
  previewOwnerClaim: mock(() => Promise.resolve(null)),
  prepareOwnerClaimAuth: mock(() => Promise.resolve({ continuation: "new-owner" as const, state: "opaque-state", handle: "operator" })),
  completeOwnerClaimProfile: mock(() => Promise.resolve({ ok: true as const, recoveryCodes: [], landingRoomId: null })),
  getSetupStatus: mock(() => Promise.resolve({ setupState: "ready" })),
};

const signInMock = mock(() => Promise.resolve());
const signOutMock = mock(() => Promise.resolve());
const refreshViewerMock = mock(() => Promise.resolve());
const authHarness = {
  state: "signed-out" as "unknown" | "signed-out" | "signing-in" | "signed-in",
  accessToken: null as string | null,
};

let happyWindow: Window;
let root: Root | null = null;
const priorGlobals: Record<string, unknown> = {};

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function ownerHandoff(input: Partial<Record<"claim" | "finish" | "state" | "handle" | "stage", string>> = {}): void {
  happyWindow.sessionStorage.setItem("nautilo.ownerClaimHandoff.v1", JSON.stringify({
    version: 1,
    claim: input.claim ?? `inv_${"a".repeat(32)}`,
    finish: input.finish ?? "guide",
    state: input.state ?? "",
    handle: input.handle ?? "",
    stage: input.stage ?? "preview",
    startedAt: new Date().toISOString(),
  }));
}

beforeAll(() => {
  happyWindow = new Window({ url: "https://nautilo.example.test/" });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  for (const key of ["window", "document", "navigator", "HTMLElement", "localStorage", "sessionStorage"] as const) {
    priorGlobals[key] = (globalThis as Record<string, unknown>)[key];
  }
  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
    localStorage: happyWindow.localStorage,
    sessionStorage: happyWindow.sessionStorage,
  });
  mock.module("../../src/lib/api", () => ({ apiClient: apiStub }));
  mock.module("../../src/hooks/use-auth", () => ({
    computeViewerOnWhoamiFailure: (previous: Record<string, unknown>) => ({ ...previous, staleWhoami: true }),
    computeViewerOnNullToken: () => ({ role: "guest", label: "Guest", userIdentity: null, sessionUserId: null, isVerified: false, staleWhoami: false }),
    useAuth: () => ({
      session: {
        state: authHarness.state,
        identity: undefined,
        signIn: signInMock,
        signOut: signOutMock,
        getAccessToken: mock(() => Promise.resolve(authHarness.accessToken)),
      },
      viewer: { role: "guest" as const, label: "Guest", userIdentity: null, sessionUserId: null, isVerified: false, staleWhoami: false },
      refreshViewer: refreshViewerMock,
    }),
    AuthProvider: ({ children }: { children: ReactNode }) => children,
  }));
});

beforeEach(() => {
  authHarness.state = "signed-out";
  authHarness.accessToken = null;
  for (const value of Object.values(apiStub)) value.mockClear();
  apiStub.previewInvite.mockImplementation(() => Promise.resolve(null));
  apiStub.previewOwnerClaim.mockImplementation(() => Promise.resolve(null));
  apiStub.prepareOwnerClaimAuth.mockImplementation(() => Promise.resolve({ continuation: "new-owner", state: "opaque-state", handle: "operator" }));
  apiStub.bindLogtoUser.mockImplementation(() => Promise.resolve({ ok: true }));
  apiStub.completeOwnerClaimProfile.mockImplementation(() => Promise.resolve({ ok: true, recoveryCodes: [], landingRoomId: null }));
  apiStub.getSetupStatus.mockImplementation(() => Promise.resolve({ setupState: "ready" }));
  signInMock.mockClear();
  signOutMock.mockClear();
  refreshViewerMock.mockClear();
  happyWindow.document.body.replaceChildren();
  happyWindow.sessionStorage.clear();
  happyWindow.localStorage.clear();
  delete globalThis.__NAUTILO_D508_OWNER_CLAIM_EVENT_SINK__;
  root = null;
});

afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  root = null;
});

afterAll(() => {
  for (const [key, value] of Object.entries(priorGlobals)) {
    if (value === undefined) delete (globalThis as Record<string, unknown>)[key];
    else (globalThis as Record<string, unknown>)[key] = value;
  }
  mock.restore();
});

describe("InviteRedeem (ordinary invitations only)", () => {
  test("turns Invite state-machine errors into recovery copy", async () => {
    const { humanizeApiError } = await import("../../src/routes/invite-redeem");
    expect(
      humanizeApiError(
        new ApiError(409, "target_room_unavailable"),
        "fallback",
      ),
    ).toContain("Room selected for this invite");
    expect(
      humanizeApiError(new ApiError(409, "used_up"), "fallback"),
    ).toContain("no uses left");
    expect(
      humanizeApiError(new ApiError(410, "revoked"), "fallback"),
    ).toContain("revoked");
    expect(
      humanizeApiError(new ApiError(409, "claim_reserved"), "fallback"),
    ).toContain("another sign-in");
  });

  test("validToken accepts inv_ tokens and rejects others", async () => {
    const { validToken } = await import("../../src/routes/invite-redeem");
    expect(validToken("inv_abc123")).toBe(true);
    expect(validToken("nope")).toBe(false);
    expect(validToken(undefined)).toBe(false);
  });

  test("SSR: malformed token shows malformed copy", async () => {
    const { InviteRedeem } = await import("../../src/routes/invite-redeem");
    const html = renderToStaticMarkup(<MemoryRouter initialEntries={["/invite/nope"]}><Routes><Route path="/invite/:token" element={<InviteRedeem />} /></Routes></MemoryRouter>);
    expect(html).toContain("This invite link looks malformed");
  });

  test("does not replay an ordinary invite preview while sign-in is in flight", async () => {
    authHarness.state = "signing-in";
    happyWindow.sessionStorage.setItem("nautilo.inviteRedeem", JSON.stringify({ version: 2, token: "inv_loop", state: "opaque-state", handle: "operator", stage: "awaiting-signup", startedAt: new Date().toISOString() }));
    const { InviteRedeem } = await import("../../src/routes/invite-redeem");
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.append(host);
    root = createRoot(host);
    await act(async () => { root?.render(<MemoryRouter initialEntries={["/invite/inv_loop"]}><Routes><Route path="/invite/:token" element={<InviteRedeem />} /></Routes></MemoryRouter>); });
    expect(apiStub.previewInvite).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Preparing sign-up");
  });

  test("continues to the exact Room returned by invite completion", async () => {
    const token = "inv_landing";
    authHarness.state = "signed-in";
    authHarness.accessToken = "access-token";
    happyWindow.sessionStorage.setItem("nautilo.inviteRedeem", JSON.stringify({
      version: 2,
      token,
      state: "opaque-state",
      handle: "visitor",
      stage: "profile",
      startedAt: new Date().toISOString(),
    }));
    apiStub.completeInviteProfile.mockImplementation(() => Promise.resolve({
      ok: true,
      recoveryCodes: ["recovery-code"],
      landingRoomId: "invited room",
    }));
    const { InviteRedeem } = await import("../../src/routes/invite-redeem");
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.append(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(
        <MemoryRouter initialEntries={[`/invite/${token}`]}>
          <Routes>
            <Route path="/invite/:token" element={<InviteRedeem />} />
            <Route path="/rooms/:roomId" element={<div data-testid="room-landing" />} />
          </Routes>
        </MemoryRouter>,
      );
      await settle();
    });

    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup({ document: happyWindow.document as unknown as Document });
    await user.type(host.querySelector("#invite-display-name")!, "Visitor");
    await user.type(host.querySelector("#invite-pin")!, "123456");
    await user.type(host.querySelector("#invite-pin2")!, "123456");
    await act(async () => {
      fireEvent.submit(host.querySelector("form")!);
      await settle();
    });
    expect(host.textContent).toContain("Welcome to Nautilo!");
    expect(refreshViewerMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(Array.from(host.querySelectorAll("button")).find(
        (button) => button.textContent === "Continue",
      )!);
      await settle();
    });
    expect(host.querySelector('[data-testid="room-landing"]')).not.toBeNull();
  });
});

describe("OwnerClaimRedeem (dedicated `/claim` route)", () => {
  test("normalizes a pre-D508 handoff and older preview response into the same new-owner machine", async () => {
    happyWindow.sessionStorage.setItem("nautilo.ownerClaimHandoff.v1", JSON.stringify({
      version: 1,
      claim: `inv_${"a".repeat(32)}`,
      state: "",
      handle: "",
      stage: "preview",
      startedAt: new Date().toISOString(),
      // Pre-D508 handoffs have no finish field.
    }));
    apiStub.previewOwnerClaim.mockImplementation(() => Promise.resolve({
      kind: "claim",
      inviterHandle: "operator",
      expiresAt: null,
      usesRemaining: 1,
      // Older servers have no continuation field.
    }));
    const { readOwnerClaimHandoff } = await import("../../src/lib/owner-claim-handoff");
    const { OwnerClaimRedeem } = await import("../../src/routes/owner-claim-redeem");
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.append(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(
        <MemoryRouter initialEntries={["/claim"]}>
          <Routes><Route path="/claim" element={<OwnerClaimRedeem />} /></Routes>
        </MemoryRouter>,
      );
      await settle();
    });

    expect(readOwnerClaimHandoff()?.finish).toBe("guide");
    expect(apiStub.previewOwnerClaim).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Set up your Nautilo server");
    expect(host.querySelector("#owner-claim-handle")).not.toBeNull();
  });

  test("survives a real StrictMode effect remount without disposing or duplicating its coordinator", async () => {
    const traces: Array<{ commandKind: string; result: string }> = [];
    globalThis.__NAUTILO_D508_OWNER_CLAIM_EVENT_SINK__ = (event) => traces.push(event);
    ownerHandoff();
    apiStub.previewOwnerClaim.mockImplementation(() => Promise.resolve({
      kind: "claim",
      inviterHandle: "operator",
      expiresAt: null,
      usesRemaining: 1,
      continuation: "new-owner",
    }));
    const { OwnerClaimRedeem } = await import("../../src/routes/owner-claim-redeem");
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.append(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(
        <StrictMode>
          <MemoryRouter initialEntries={["/claim"]}>
            <Routes><Route path="/claim" element={<OwnerClaimRedeem />} /></Routes>
          </MemoryRouter>
        </StrictMode>,
      );
      await settle();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await settle();
    });

    expect(apiStub.previewOwnerClaim).toHaveBeenCalledTimes(1);
    expect(traces.map((event) => `${event.commandKind}:${event.result}`)).toEqual([
      "preview-claim:started",
      "preview-claim:succeeded",
    ]);
    expect(host.textContent).toContain("Set up your Nautilo server");
  });

  test("uses a pre-render qualification callback only for redacted coordinator traces", async () => {
    const traces: unknown[] = [];
    globalThis.__NAUTILO_D508_OWNER_CLAIM_EVENT_SINK__ = (event) => traces.push(event);
    ownerHandoff();
    apiStub.previewOwnerClaim.mockImplementation(() => Promise.resolve({ kind: "claim", inviterHandle: "operator", expiresAt: null, usesRemaining: 1, continuation: "new-owner" }));
    const { OwnerClaimRedeem } = await import("../../src/routes/owner-claim-redeem");
    const host = happyWindow.document.createElement("div"); happyWindow.document.body.append(host); root = createRoot(host);
    await act(async () => { root?.render(<MemoryRouter initialEntries={["/claim"]}><Routes><Route path="/claim" element={<OwnerClaimRedeem />} /></Routes></MemoryRouter>); await settle(); });

    expect(traces).toContainEqual(expect.objectContaining({ commandKind: "preview-claim", result: "started" }));
    expect(traces).toContainEqual(expect.objectContaining({ commandKind: "preview-claim", result: "succeeded" }));
    expect(Object.keys(traces[0] as object).sort()).toEqual(["commandKind", "navigationIntent", "operationId", "phase", "result"]);
  });

  test("keeps `/claim` structurally independent from the ordinary invite wizard", async () => {
    const [app, bootstrap, entry, terminal, ownerRoute, ordinaryInvite] = await Promise.all([
      Bun.file(new URL("../../src/app.tsx", import.meta.url)).text(),
      Bun.file(new URL("../../src/bootstrap.tsx", import.meta.url)).text(),
      Bun.file(new URL("../../src/lib/owner-claim-entry.ts", import.meta.url)).text(),
      Bun.file(new URL("../../src/lib/owner-claim-terminal.ts", import.meta.url)).text(),
      Bun.file(new URL("../../src/routes/owner-claim-redeem.tsx", import.meta.url)).text(),
      Bun.file(new URL("../../src/routes/invite-redeem.tsx", import.meta.url)).text(),
    ]);
    expect(app).toContain('from "./routes/owner-claim-redeem"');
    expect(bootstrap).toContain('from "./lib/owner-claim-entry"');
    expect(bootstrap).not.toContain('from "./routes/owner-claim-redeem"');
    expect(entry).not.toMatch(/from\s+[^\n]*(?:react|api|use-auth)/);
    expect(terminal).not.toMatch(/from\s+["'][^"']*(?:api|auth|handoff|react)/);
    expect(terminal).not.toContain("localStorage");
    expect(ownerRoute).not.toContain("InviteRedeem");
    expect(ordinaryInvite).not.toContain("OwnerClaimRedeem");
    expect(ordinaryInvite).not.toContain("previewOwnerClaim");
  });

  test("does no owner I/O while auth is unknown, then previews only after auth resolves", async () => {
    ownerHandoff();
    authHarness.state = "unknown";
    apiStub.previewOwnerClaim.mockImplementation(() => Promise.resolve({ kind: "claim", inviterHandle: "operator", expiresAt: null, usesRemaining: 1, continuation: "new-owner" }));
    const { OwnerClaimRedeem } = await import("../../src/routes/owner-claim-redeem");
    const host = happyWindow.document.createElement("div"); happyWindow.document.body.append(host); root = createRoot(host);
    const render = () => <MemoryRouter initialEntries={["/claim"]}><Routes><Route path="/claim" element={<OwnerClaimRedeem />} /></Routes></MemoryRouter>;
    await act(async () => { root?.render(render()); await settle(); });
    expect(apiStub.previewOwnerClaim).not.toHaveBeenCalled();
    authHarness.state = "signed-out";
    await act(async () => { root?.render(render()); await settle(); });
    expect(apiStub.previewOwnerClaim).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Set up your Nautilo server");
  });

  test("a signed-in reissued resume claim prepares then binds without another Logto launch or handle entry", async () => {
    ownerHandoff();
    authHarness.state = "signed-in";
    authHarness.accessToken = "access-token";
    apiStub.previewOwnerClaim.mockImplementation(() => Promise.resolve({ kind: "claim", inviterHandle: "operator", expiresAt: null, usesRemaining: 1, continuation: "resume-owner" }));
    apiStub.prepareOwnerClaimAuth.mockImplementation(() => Promise.resolve({ continuation: "resume-owner", state: "fresh-prepared-state", handle: "operator" }));
    const { OwnerClaimRedeem } = await import("../../src/routes/owner-claim-redeem");
    const host = happyWindow.document.createElement("div"); happyWindow.document.body.append(host); root = createRoot(host);
    await act(async () => { root?.render(<MemoryRouter initialEntries={["/claim"]}><Routes><Route path="/claim" element={<OwnerClaimRedeem />} /></Routes></MemoryRouter>); await settle(); });

    expect(apiStub.previewOwnerClaim).toHaveBeenCalledTimes(1);
    expect(apiStub.prepareOwnerClaimAuth).toHaveBeenCalledWith({ claim: `inv_${"a".repeat(32)}` });
    expect(apiStub.bindLogtoUser).toHaveBeenCalledWith({ state: "fresh-prepared-state" });
    expect(signInMock).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Create the first owner");
    expect(host.querySelector("#owner-claim-handle")).toBeNull();
  });

  test("an authoritative 410 preview clears revoked custody and leaves controller reissue recovery visible after refresh", async () => {
    ownerHandoff();
    apiStub.previewOwnerClaim.mockImplementation(() => Promise.reject(new ApiError(410, "used_up")));
    const { OwnerClaimRedeem } = await import("../../src/routes/owner-claim-redeem");
    const render = () => <MemoryRouter initialEntries={["/claim"]}><Routes><Route path="/claim" element={<OwnerClaimRedeem />} /></Routes></MemoryRouter>;
    const host = happyWindow.document.createElement("div"); happyWindow.document.body.append(host); root = createRoot(host);
    await act(async () => { root?.render(render()); await settle(); });

    expect(happyWindow.sessionStorage.getItem("nautilo.ownerClaimHandoff.v1")).toBeNull();
    expect(host.textContent).toContain("Resume the Nautilo deployment to issue a fresh link.");

    await act(async () => { root?.unmount(); }); root = null;
    happyWindow.document.body.replaceChildren();
    const refreshedHost = happyWindow.document.createElement("div"); happyWindow.document.body.append(refreshedHost); root = createRoot(refreshedHost);
    await act(async () => { root?.render(render()); await settle(); });
    expect(apiStub.previewOwnerClaim).toHaveBeenCalledTimes(1);
    expect(refreshedHost.textContent).toContain("Resume the Nautilo deployment to issue a fresh link.");
  });

  test("a stale authoritative preview cannot clear a newer replacement handoff", async () => {
    let rejectPreview!: (reason: unknown) => void;
    const firstPreview = new Promise<never>((_resolve, reject) => { rejectPreview = reject; });
    const replacementClaim = `inv_${"b".repeat(32)}`;
    ownerHandoff();
    apiStub.previewOwnerClaim
      .mockImplementationOnce(() => firstPreview)
      .mockImplementationOnce(() => Promise.resolve({ kind: "claim", inviterHandle: "operator", expiresAt: null, usesRemaining: 1, continuation: "new-owner" }));
    const { OwnerClaimRedeem } = await import("../../src/routes/owner-claim-redeem");
    const render = () => <MemoryRouter initialEntries={["/claim"]}><Routes><Route path="/claim" element={<OwnerClaimRedeem />} /></Routes></MemoryRouter>;
    const host = happyWindow.document.createElement("div"); happyWindow.document.body.append(host); root = createRoot(host);
    await act(async () => { root?.render(render()); await settle(); });
    expect(apiStub.previewOwnerClaim).toHaveBeenCalledTimes(1);

    ownerHandoff({ claim: replacementClaim });
    await act(async () => { rejectPreview(new ApiError(410, "used_up")); await settle(); });
    expect(happyWindow.sessionStorage.getItem("nautilo.ownerClaimHandoff.v1")).toContain(replacementClaim);

    await act(async () => { root?.unmount(); }); root = null;
    happyWindow.document.body.replaceChildren();
    const replacementHost = happyWindow.document.createElement("div"); happyWindow.document.body.append(replacementHost); root = createRoot(replacementHost);
    await act(async () => { root?.render(render()); await settle(); });
    expect(apiStub.previewOwnerClaim).toHaveBeenCalledTimes(2);
    expect(replacementHost.textContent).toContain("Set up your Nautilo server");
  });

  test("a held stale prepare-resume cannot overwrite a newer replacement handoff", async () => {
    let resolvePrepare!: (value: { continuation: "resume-owner"; state: string; handle: string }) => void;
    const heldPrepare = new Promise<{ continuation: "resume-owner"; state: string; handle: string }>((resolve) => { resolvePrepare = resolve; });
    const replacementClaim = `inv_${"b".repeat(32)}`;
    ownerHandoff();
    authHarness.state = "signed-in";
    authHarness.accessToken = "access-token";
    apiStub.previewOwnerClaim.mockImplementation(() => Promise.resolve({ kind: "claim", inviterHandle: "operator", expiresAt: null, usesRemaining: 1, continuation: "resume-owner" }));
    apiStub.prepareOwnerClaimAuth.mockImplementation(() => heldPrepare);
    const { OwnerClaimRedeem } = await import("../../src/routes/owner-claim-redeem");
    const host = happyWindow.document.createElement("div"); happyWindow.document.body.append(host); root = createRoot(host);
    await act(async () => { root?.render(<MemoryRouter initialEntries={["/claim"]}><Routes><Route path="/claim" element={<OwnerClaimRedeem />} /></Routes></MemoryRouter>); await settle(); });
    expect(apiStub.prepareOwnerClaimAuth).toHaveBeenCalledTimes(1);

    ownerHandoff({ claim: replacementClaim });
    await act(async () => { resolvePrepare({ continuation: "resume-owner", state: "stale-prepared-state", handle: "operator" }); await settle(); });
    const replacement = happyWindow.sessionStorage.getItem("nautilo.ownerClaimHandoff.v1");
    expect(replacement).toContain(replacementClaim);
    expect(replacement).not.toContain("stale-prepared-state");
    expect(apiStub.bindLogtoUser).not.toHaveBeenCalled();
  });

  test("an API-normalized authoritative 404 preview also clears revoked custody", async () => {
    ownerHandoff();
    // previewOwnerClaim normalizes the authoritative 404 contract to null.
    apiStub.previewOwnerClaim.mockImplementation(() => Promise.resolve(null));
    const { OwnerClaimRedeem } = await import("../../src/routes/owner-claim-redeem");
    const host = happyWindow.document.createElement("div"); happyWindow.document.body.append(host); root = createRoot(host);
    await act(async () => { root?.render(<MemoryRouter initialEntries={["/claim"]}><Routes><Route path="/claim" element={<OwnerClaimRedeem />} /></Routes></MemoryRouter>); await settle(); });

    expect(happyWindow.sessionStorage.getItem("nautilo.ownerClaimHandoff.v1")).toBeNull();
    expect(host.textContent).toContain("Resume the Nautilo deployment to issue a fresh link.");
  });

  test("a generic preview failure retains custody for an explicit retry", async () => {
    ownerHandoff();
    apiStub.previewOwnerClaim.mockImplementation(() => Promise.reject(new Error("transport unavailable")));
    const { OwnerClaimRedeem } = await import("../../src/routes/owner-claim-redeem");
    const host = happyWindow.document.createElement("div"); happyWindow.document.body.append(host); root = createRoot(host);
    await act(async () => { root?.render(<MemoryRouter initialEntries={["/claim"]}><Routes><Route path="/claim" element={<OwnerClaimRedeem />} /></Routes></MemoryRouter>); await settle(); });

    expect(happyWindow.sessionStorage.getItem("nautilo.ownerClaimHandoff.v1")).not.toBeNull();
    expect(host.textContent).toContain("Nautilo could not complete that step. Try again; the server remains authoritative.");
  });

  test("a malformed preview response fails closed into visible recovery without clearing custody", async () => {
    ownerHandoff();
    apiStub.previewOwnerClaim.mockImplementation(() => Promise.reject(new Error("malformed owner preview response")));
    const { OwnerClaimRedeem } = await import("../../src/routes/owner-claim-redeem");
    const host = happyWindow.document.createElement("div"); happyWindow.document.body.append(host); root = createRoot(host);
    await act(async () => { root?.render(<MemoryRouter initialEntries={["/claim"]}><Routes><Route path="/claim" element={<OwnerClaimRedeem />} /></Routes></MemoryRouter>); await settle(); });

    expect(apiStub.previewOwnerClaim).toHaveBeenCalledTimes(1);
    expect(happyWindow.sessionStorage.getItem("nautilo.ownerClaimHandoff.v1")).not.toBeNull();
    expect(host.textContent).toContain("Nautilo could not complete that step. Try again; the server remains authoritative.");
    expect(host.textContent).toContain("Check setup link");
    expect(host.querySelector("#owner-claim-handle")).toBeNull();
  });

  test("hard-refresh signed-in profile revalidates its subject without a preview race", async () => {
    ownerHandoff({ state: "opaque-state", handle: "operator", stage: "profile" });
    authHarness.state = "signed-in";
    authHarness.accessToken = "access-token";
    const { OwnerClaimRedeem } = await import("../../src/routes/owner-claim-redeem");
    const host = happyWindow.document.createElement("div"); happyWindow.document.body.append(host); root = createRoot(host);
    await act(async () => { root?.render(<MemoryRouter initialEntries={["/claim"]}><Routes><Route path="/claim" element={<OwnerClaimRedeem />} /></Routes></MemoryRouter>); await settle(); });
    expect(apiStub.previewOwnerClaim).not.toHaveBeenCalled();
    expect(apiStub.bindLogtoUser).toHaveBeenCalledTimes(1);
    expect(apiStub.bindLogtoUser).toHaveBeenCalledWith({ state: "opaque-state" });
    expect(host.textContent).toContain("Create the first owner");
    expect(host.textContent).not.toContain("Set up your Nautilo server");
  });

  test("signed-in profile can switch accounts without submitting the profile", async () => {
    ownerHandoff({ state: "opaque-state", handle: "operator", stage: "profile" });
    authHarness.state = "signed-in";
    authHarness.accessToken = "access-token";
    const { OwnerClaimRedeem } = await import("../../src/routes/owner-claim-redeem");
    const host = happyWindow.document.createElement("div"); happyWindow.document.body.append(host); root = createRoot(host);
    await act(async () => { root?.render(<MemoryRouter initialEntries={["/claim"]}><Routes><Route path="/claim" element={<OwnerClaimRedeem />} /></Routes></MemoryRouter>); await settle(); });

    const switchAccount = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Sign out and continue");
    if (!switchAccount) throw new Error("signed-in profile account-switch action did not render");
    expect(switchAccount.type).toBe("button");
    await act(async () => { fireEvent.click(switchAccount); await settle(); });

    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(signOutMock).toHaveBeenCalledWith("/claim");
    expect(apiStub.completeOwnerClaimProfile).not.toHaveBeenCalled();
  });

  test("a wrong signed-in subject cannot open a persisted profile checkpoint", async () => {
    ownerHandoff({ state: "opaque-state", handle: "operator", stage: "profile" });
    authHarness.state = "signed-in";
    authHarness.accessToken = "access-token";
    const reserved = new ApiError(409, "claim_reserved") as ApiError & { code: string };
    reserved.code = "claim_reserved";
    apiStub.bindLogtoUser.mockImplementation(() => Promise.reject(reserved));
    const { OwnerClaimRedeem } = await import("../../src/routes/owner-claim-redeem");
    const host = happyWindow.document.createElement("div"); happyWindow.document.body.append(host); root = createRoot(host);
    await act(async () => { root?.render(<MemoryRouter initialEntries={["/claim"]}><Routes><Route path="/claim" element={<OwnerClaimRedeem />} /></Routes></MemoryRouter>); await settle(); });

    expect(apiStub.bindLogtoUser).toHaveBeenCalledWith({ state: "opaque-state" });
    expect(host.textContent).toContain("reserved by a different account");
    expect(host.querySelector("#owner-claim-display-name")).toBeNull();
  });

  test("callback auth progression preserves a bind 409 as wrong-account recovery", async () => {
    ownerHandoff({ state: "opaque-state", handle: "operator", stage: "awaiting-bind" });
    const handleMismatch = new ApiError(409, "handle_mismatch") as ApiError & { code: string };
    handleMismatch.code = "handle_mismatch";
    apiStub.bindLogtoUser.mockImplementation(() => Promise.reject(handleMismatch));
    const { OwnerClaimRedeem } = await import("../../src/routes/owner-claim-redeem");
    const host = happyWindow.document.createElement("div"); happyWindow.document.body.append(host); root = createRoot(host);
    const render = () => <MemoryRouter initialEntries={["/claim"]}><Routes><Route path="/claim" element={<OwnerClaimRedeem />} /></Routes></MemoryRouter>;

    authHarness.state = "signing-in";
    await act(async () => { root?.render(render()); await settle(); });
    authHarness.accessToken = "access-token";
    authHarness.state = "signed-in";
    await act(async () => { root?.render(render()); await settle(); });

    expect(apiStub.bindLogtoUser).toHaveBeenCalledTimes(1);
    expect(apiStub.bindLogtoUser).toHaveBeenCalledWith({ state: "opaque-state" });
    expect(host.textContent).toContain("This server was reserved by a different account.");
    expect(host.querySelector("#owner-claim-display-name")).toBeNull();
  });

  test("a hydrated awaiting-bind checkpoint offers signed-out owner resume without binding", async () => {
    ownerHandoff({ state: "opaque-state", handle: "operator", stage: "awaiting-bind" });
    authHarness.state = "unknown";
    const { OwnerClaimRedeem } = await import("../../src/routes/owner-claim-redeem");
    const host = happyWindow.document.createElement("div"); happyWindow.document.body.append(host); root = createRoot(host);
    const render = () => <MemoryRouter initialEntries={["/claim"]}><Routes><Route path="/claim" element={<OwnerClaimRedeem />} /></Routes></MemoryRouter>;
    await act(async () => { root?.render(render()); await settle(); });

    authHarness.state = "signed-out";
    await act(async () => { root?.render(render()); await settle(); });
    expect(host.textContent).toContain("Sign in to finish setup");
    expect(host.querySelector("#owner-claim-handle")).toBeNull();
    expect(apiStub.previewOwnerClaim).not.toHaveBeenCalled();
    expect(apiStub.prepareOwnerClaimAuth).not.toHaveBeenCalled();
    expect(apiStub.bindLogtoUser).not.toHaveBeenCalled();
  });

  test("a hydrated awaiting-signup checkpoint restores handle entry without owner I/O", async () => {
    ownerHandoff({ state: "opaque-state", handle: "operator", stage: "awaiting-signup" });
    authHarness.state = "unknown";
    const { OwnerClaimRedeem } = await import("../../src/routes/owner-claim-redeem");
    const host = happyWindow.document.createElement("div"); happyWindow.document.body.append(host); root = createRoot(host);
    const render = () => <MemoryRouter initialEntries={["/claim"]}><Routes><Route path="/claim" element={<OwnerClaimRedeem />} /></Routes></MemoryRouter>;
    await act(async () => { root?.render(render()); await settle(); });

    authHarness.state = "signed-out";
    await act(async () => { root?.render(render()); await settle(); });
    expect(host.textContent).toContain("Set up your Nautilo server");
    expect(host.querySelector<HTMLInputElement>("#owner-claim-handle")?.value).toBe("operator");
    expect(apiStub.previewOwnerClaim).not.toHaveBeenCalled();
    expect(apiStub.prepareOwnerClaimAuth).not.toHaveBeenCalled();
    expect(apiStub.bindLogtoUser).not.toHaveBeenCalled();
  });

  test("an unrelated bind 409 stays generic recovery, not reserved-account copy", async () => {
    ownerHandoff({ state: "opaque-state", handle: "operator", stage: "profile" });
    authHarness.state = "signed-in";
    authHarness.accessToken = "access-token";
    const handleTaken = new ApiError(409, "handle_taken") as ApiError & { code: string };
    handleTaken.code = "handle_taken";
    apiStub.bindLogtoUser.mockImplementation(() => Promise.reject(handleTaken));
    const { OwnerClaimRedeem } = await import("../../src/routes/owner-claim-redeem");
    const host = happyWindow.document.createElement("div"); happyWindow.document.body.append(host); root = createRoot(host);
    await act(async () => { root?.render(<MemoryRouter initialEntries={["/claim"]}><Routes><Route path="/claim" element={<OwnerClaimRedeem />} /></Routes></MemoryRouter>); await settle(); });

    expect(host.textContent).toContain("Nautilo could not complete that step. Try again; the server remains authoritative.");
    expect(host.textContent).not.toContain("This server was reserved by a different account.");
  });

  test("signed-out profile keeps the explicit sign-in recovery", async () => {
    ownerHandoff({ state: "opaque-state", handle: "operator", stage: "profile" });
    authHarness.state = "signed-out";
    const { OwnerClaimRedeem } = await import("../../src/routes/owner-claim-redeem");
    const host = happyWindow.document.createElement("div"); happyWindow.document.body.append(host); root = createRoot(host);
    await act(async () => { root?.render(<MemoryRouter initialEntries={["/claim"]}><Routes><Route path="/claim" element={<OwnerClaimRedeem />} /></Routes></MemoryRouter>); await settle(); });

    expect(host.textContent).toContain("Sign in to finish setup");
    expect(host.textContent).not.toContain("Sign out and continue");
    expect(apiStub.bindLogtoUser).not.toHaveBeenCalled();
  });

  test("unresolved profile auth stays pending instead of offering a rejected sign-in action", async () => {
    ownerHandoff({ state: "opaque-state", handle: "operator", stage: "profile" });
    authHarness.state = "unknown";
    const { OwnerClaimRedeem } = await import("../../src/routes/owner-claim-redeem");
    const host = happyWindow.document.createElement("div"); happyWindow.document.body.append(host); root = createRoot(host);
    const render = () => <MemoryRouter initialEntries={["/claim"]}><Routes><Route path="/claim" element={<OwnerClaimRedeem />} /></Routes></MemoryRouter>;
    await act(async () => { root?.render(render()); await settle(); });
    expect(host.textContent).toContain("Preparing account setup…");
    expect(host.textContent).not.toContain("Sign in to finish setup");
    expect(apiStub.bindLogtoUser).not.toHaveBeenCalled();

    authHarness.state = "signing-in";
    await act(async () => { root?.render(render()); await settle(); });
    expect(host.textContent).toContain("Preparing account setup…");
    expect(host.textContent).not.toContain("Sign in to finish setup");
    expect(apiStub.bindLogtoUser).not.toHaveBeenCalled();
  });

  test("a hard refresh after completion truthfully restores the chosen product destination without codes", async () => {
    happyWindow.sessionStorage.setItem(OWNER_CLAIM_TERMINAL_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, finish: "product" }));
    const { OwnerClaimRedeem } = await import("../../src/routes/owner-claim-redeem");
    const host = happyWindow.document.createElement("div"); happyWindow.document.body.append(host); root = createRoot(host);
    await act(async () => {
      root?.render(<MemoryRouter initialEntries={["/claim"]}><Routes>
        <Route path="/claim" element={<OwnerClaimRedeem />} />
        <Route path="/" element={<p>PRODUCT DESTINATION</p>} />
      </Routes></MemoryRouter>);
      await settle();
    });

    expect(host.textContent).toContain("server setup is confirmed");
    expect(host.textContent).toContain("Account security");
    const continueButton = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Open Nautilo");
    if (!continueButton) throw new Error("product terminal continuation did not render");
    await act(async () => { fireEvent.click(continueButton); await settle(); });
    expect(host.textContent).toContain("PRODUCT DESTINATION");
    expect(readOwnerClaimTerminalMarker()).toBeNull();
  });

  test("a hard refresh after completion preserves the guide destination and an absent marker remains recoverable", async () => {
    happyWindow.sessionStorage.setItem(OWNER_CLAIM_TERMINAL_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, finish: "guide" }));
    const { OwnerClaimRedeem } = await import("../../src/routes/owner-claim-redeem");
    const host = happyWindow.document.createElement("div"); happyWindow.document.body.append(host); root = createRoot(host);
    await act(async () => {
      root?.render(<MemoryRouter initialEntries={["/claim"]}><Routes>
        <Route path="/claim" element={<OwnerClaimRedeem />} />
        <Route path="/help/server" element={<p>GUIDE DESTINATION</p>} />
      </Routes></MemoryRouter>);
      await settle();
    });
    const continueButton = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Open server guide");
    if (!continueButton) throw new Error("guide terminal continuation did not render");
    await act(async () => { fireEvent.click(continueButton); await settle(); });
    expect(host.textContent).toContain("GUIDE DESTINATION");
    expect(readOwnerClaimTerminalMarker()).toBeNull();

    await act(async () => { root?.unmount(); }); root = null;
    happyWindow.document.body.replaceChildren();
    const recoveryHost = happyWindow.document.createElement("div"); happyWindow.document.body.append(recoveryHost); root = createRoot(recoveryHost);
    await act(async () => { root?.render(<MemoryRouter initialEntries={["/claim"]}><Routes><Route path="/claim" element={<OwnerClaimRedeem />} /></Routes></MemoryRouter>); await settle(); });
    expect(recoveryHost.textContent).toContain("Finish claiming this server");
  });

  test("wrong-account claim reservation offers a real account-switch recovery", async () => {
    ownerHandoff({ state: "opaque-state", handle: "operator", stage: "awaiting-bind" });
    authHarness.state = "signed-in";
    authHarness.accessToken = "access-token";
    const reserved = new ApiError(409, "claim_reserved") as ApiError & { code: string };
    reserved.code = "claim_reserved";
    apiStub.bindLogtoUser.mockImplementation(() => Promise.reject(reserved));
    const { OwnerClaimRedeem } = await import("../../src/routes/owner-claim-redeem");
    const host = happyWindow.document.createElement("div"); happyWindow.document.body.append(host); root = createRoot(host);
    await act(async () => { root?.render(<MemoryRouter initialEntries={["/claim"]}><Routes><Route path="/claim" element={<OwnerClaimRedeem />} /></Routes></MemoryRouter>); await settle(); });
    expect(host.textContent).toContain("reserved by a different account");
    const retry = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Sign in to continue");
    if (!retry) throw new Error("reservation recovery did not render");
    await act(async () => { fireEvent.click(retry); await settle(); });
    expect(host.textContent).toContain("Switch account to finish setup");
    const switchAccount = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Sign out and continue");
    if (!switchAccount) throw new Error("account-switch action did not render");
    await act(async () => { fireEvent.click(switchAccount); await settle(); });
    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(signOutMock).toHaveBeenCalledWith("/claim");
  });

  test("a lost bind response retries the idempotent bind contract and reaches profile", async () => {
    ownerHandoff({ state: "opaque-state", handle: "operator", stage: "awaiting-bind" });
    authHarness.state = "signed-in";
    authHarness.accessToken = "access-token";
    const ambiguousWrite = new ApiError(0, "ambiguous write");
    ambiguousWrite.name = "OwnerClaimAmbiguousWriteError";
    apiStub.bindLogtoUser.mockImplementationOnce(() => Promise.reject(ambiguousWrite));
    apiStub.bindLogtoUser.mockImplementationOnce(() => Promise.resolve({ ok: true }));
    const { OwnerClaimRedeem } = await import("../../src/routes/owner-claim-redeem");
    const host = happyWindow.document.createElement("div"); happyWindow.document.body.append(host); root = createRoot(host);
    await act(async () => { root?.render(<MemoryRouter initialEntries={["/claim"]}><Routes><Route path="/claim" element={<OwnerClaimRedeem />} /></Routes></MemoryRouter>); await settle(); });
    expect(apiStub.bindLogtoUser).toHaveBeenCalledTimes(2);
    expect(apiStub.getSetupStatus).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Create the first owner");
  });

  test("preserves product finish through profile completion and reaches the product only after recovery acknowledgement", async () => {
    ownerHandoff({ finish: "product", state: "opaque-state", handle: "operator", stage: "profile" });
    authHarness.state = "signed-in";
    authHarness.accessToken = "access-token";
    apiStub.completeOwnerClaimProfile.mockImplementation(() => Promise.resolve({ ok: true, recoveryCodes: ["owner-code"], landingRoomId: null }));
    const { OwnerClaimRedeem } = await import("../../src/routes/owner-claim-redeem");
    const host = happyWindow.document.createElement("div"); happyWindow.document.body.append(host); root = createRoot(host);
    await act(async () => { root?.render(<MemoryRouter initialEntries={["/claim"]}><Routes><Route path="/claim" element={<OwnerClaimRedeem />} /><Route path="/" element={<p>PRODUCT DESTINATION</p>} /></Routes></MemoryRouter>); await settle(); });
    const displayName = host.querySelector<HTMLInputElement>("#owner-claim-display-name");
    const pin = host.querySelector<HTMLInputElement>("#owner-claim-pin");
    const confirm = host.querySelector<HTMLInputElement>("#owner-claim-pin-confirm");
    const form = host.querySelector("form");
    if (!displayName || !pin || !confirm || !form) throw new Error("profile form did not render");
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup({ document: happyWindow.document as unknown as Document });
    await user.type(displayName, "Operator");
    await user.type(pin, "123456");
    await user.type(confirm, "123456");
    await act(async () => { fireEvent.submit(form); await settle(); });
    expect(apiStub.completeOwnerClaimProfile).toHaveBeenCalledWith({ claim: `inv_${"a".repeat(32)}`, displayName: "Operator", pin: "123456" });
    expect(host.textContent).toContain("owner-code");
    expect(readOwnerClaimTerminalMarker()).toEqual({ schemaVersion: 1, finish: "product" });
    const continueButton = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Open Nautilo");
    if (!continueButton) throw new Error("recovery acknowledgement did not render");
    await act(async () => { fireEvent.click(continueButton); await settle(); });
    expect(host.textContent).toContain("PRODUCT DESTINATION");
    expect(readOwnerClaimTerminalMarker()).toBeNull();
  });

  test("a lost completion result reobserves instead of regenerating recovery codes", async () => {
    ownerHandoff({ finish: "product", state: "opaque-state", handle: "operator", stage: "profile" });
    authHarness.state = "signed-in";
    authHarness.accessToken = "access-token";
    const ambiguousWrite = new ApiError(0, "ambiguous write");
    ambiguousWrite.name = "OwnerClaimAmbiguousWriteError";
    apiStub.completeOwnerClaimProfile.mockImplementation(() => Promise.reject(ambiguousWrite));
    const { OwnerClaimRedeem } = await import("../../src/routes/owner-claim-redeem");
    const host = happyWindow.document.createElement("div"); happyWindow.document.body.append(host); root = createRoot(host);
    await act(async () => { root?.render(<MemoryRouter initialEntries={["/claim"]}><Routes><Route path="/claim" element={<OwnerClaimRedeem />} /></Routes></MemoryRouter>); await settle(); });
    const form = host.querySelector("form"); const displayName = host.querySelector<HTMLInputElement>("#owner-claim-display-name"); const pin = host.querySelector<HTMLInputElement>("#owner-claim-pin"); const confirm = host.querySelector<HTMLInputElement>("#owner-claim-pin-confirm");
    if (!form || !displayName || !pin || !confirm) throw new Error("profile form did not render");
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup({ document: happyWindow.document as unknown as Document });
    await user.type(displayName, "Operator");
    await user.type(pin, "123456");
    await user.type(confirm, "123456");
    await act(async () => { fireEvent.submit(form); await settle(); });
    expect(apiStub.getSetupStatus).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("server setup is confirmed");
    expect(host.textContent).toContain("Open Nautilo");
    expect(happyWindow.sessionStorage.getItem("nautilo.ownerClaimHandoff.v1")).toBeNull();
    expect(readOwnerClaimTerminalMarker()).toEqual({ schemaVersion: 1, finish: "product" });
    expect("regenerateRecoveryCodes" in apiStub).toBe(false);
  });
});
