import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ApiError } from "@nautilo/api-client/browser";
import { MemoryRouter } from "react-router-dom";

const account = {
  id: "11111111-1111-4111-8111-111111111111",
  service: "Notion",
  origin: "https://www.notion.so",
  label: "Notion",
  status: "connected" as const,
  lastVerifiedAt: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};
const loginResponse = { account, login: { liveViewUrl: "https://live.browser-use.com/?opaque", expiresAt: "2026-09-01T01:00:00.000Z" }, createdNewAccount: true };
const createConnectedWebAccount = mock(async () => loginResponse);
const finishConnectedWebAccount = mock(async () => account);
const reconnectConnectedWebAccount = mock(async () => ({ account, login: { liveViewUrl: "https://live.browser-use.com/?opaque", expiresAt: "2026-09-01T01:00:00.000Z" }, createdNewAccount: false }));
const openConnectedWebAccountPage = mock(async () => ({ account, login: { liveViewUrl: "https://live.browser-use.com/?opaque", expiresAt: "2026-09-01T01:00:00.000Z" }, createdNewAccount: false }));
const closeConnectedWebAccountPage = mock(async () => account);
const cancelConnectedWebAccountLogin = mock(async () => account);
const disconnectConnectedWebAccount = mock(async () => ({ account, websiteSessionWarning: "Disconnecting Nautilo does not sign you out of the website. Use the website's sign out other sessions control if needed." }));

mock.module("../../lib/api", () => ({ apiClient: { createConnectedWebAccount, finishConnectedWebAccount, reconnectConnectedWebAccount, openConnectedWebAccountPage, closeConnectedWebAccountPage, cancelConnectedWebAccountLogin, disconnectConnectedWebAccount } }));

const { ConnectedWebsiteJourney } = await import("./connected-website-journey");
const { requestWebsiteConnection } = await import("../../adapters/website-connection-intent");

beforeEach(() => {
  reapplyHappyDomGlobals();
  createConnectedWebAccount.mockClear();
  finishConnectedWebAccount.mockClear();
  reconnectConnectedWebAccount.mockClear();
  openConnectedWebAccountPage.mockClear();
  closeConnectedWebAccountPage.mockClear();
  cancelConnectedWebAccountLogin.mockClear();
  disconnectConnectedWebAccount.mockClear();
});
afterEach(() => cleanup());

describe("ConnectedWebsiteJourney", () => {
  test("the shell-mounted dispatcher starts catalogue and custom connections, then Done persists the profile", async () => {
    const view = render(<ConnectedWebsiteJourney />);
    await act(async () => { expect(requestWebsiteConnection({ kind: "catalogue", websiteId: "notion" })).toBeTrue(); });
    await waitFor(() => expect(createConnectedWebAccount).toHaveBeenCalledWith({ service: "Notion", origin: "https://www.notion.so", label: "Notion", createAnother: false }));
    const frame = view.getByTitle("Protected sign-in for Notion");
    expect(frame.getAttribute("src")).toContain("live.browser-use.com");
    expect(frame.getAttribute("allow")).toBe("autoplay; clipboard-read; clipboard-write; fullscreen");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    const done = view.getByRole("button", { name: "Done" }) as HTMLButtonElement;
    expect(done.disabled).toBeFalse();
    expect(done.classList.contains("text-[var(--on-primary)]")).toBeTrue();
    expect(done.classList.contains("text-primary-foreground")).toBeFalse();
    fireEvent.click(done);
    await waitFor(() => expect(finishConnectedWebAccount).toHaveBeenCalledWith(account.id));
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());

    await act(async () => { expect(requestWebsiteConnection({ kind: "custom", url: "" })).toBeTrue(); });
    fireEvent.input(view.getByLabelText("Website address"), { target: { value: "https://example.com/a" } });
    fireEvent.click(view.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(createConnectedWebAccount).toHaveBeenLastCalledWith({ service: "example.com", origin: "https://example.com/a", label: "example.com", createAnother: false }));
  });

  test("keeps the protected session open when Done is pressed before authentication completes", async () => {
    finishConnectedWebAccount.mockImplementationOnce(async () => {
      throw new ApiError(409, "connected_web_account_authentication_incomplete");
    });
    const view = render(<ConnectedWebsiteJourney />);

    await act(async () => { requestWebsiteConnection({ kind: "catalogue", websiteId: "notion" }); });
    await waitFor(() => expect(view.getByTitle("Protected sign-in for Notion")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Done" }));

    expect((await view.findByRole("alert")).textContent).toContain("Sign-in isn’t complete yet");
    expect(view.getByTitle("Protected sign-in for Notion")).toBeTruthy();
    expect(disconnectConnectedWebAccount).not.toHaveBeenCalled();
    expect(cancelConnectedWebAccountLogin).not.toHaveBeenCalled();
  });

  test("Cancel discards a new profile but preserves a reconnecting account", async () => {
    const view = render(<ConnectedWebsiteJourney />);
    await act(async () => { requestWebsiteConnection({ kind: "catalogue", websiteId: "notion" }); });
    await waitFor(() => expect(view.getByRole("button", { name: "Cancel website sign-in" })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Cancel website sign-in" }));
    await waitFor(() => expect(disconnectConnectedWebAccount).toHaveBeenCalledWith(account.id));
    expect(cancelConnectedWebAccountLogin).not.toHaveBeenCalled();

    await act(async () => { requestWebsiteConnection({ kind: "reconnect", accountId: account.id }); });
    await waitFor(() => expect(reconnectConnectedWebAccount).toHaveBeenCalledWith(account.id));
    fireEvent.click(view.getByRole("button", { name: "Cancel website sign-in" }));
    await waitFor(() => expect(cancelConnectedWebAccountLogin).toHaveBeenCalledWith(account.id));
  });

  test("opens and closes a protected page through the dedicated view lifecycle", async () => {
    const view = render(<ConnectedWebsiteJourney />);
    await act(async () => { expect(requestWebsiteConnection({ kind: "view", accountId: account.id, title: "Project board" })).toBeTrue(); });
    await waitFor(() => expect(openConnectedWebAccountPage).toHaveBeenCalledWith(account.id));
    const frame = view.getByTitle("Protected page for Project board");
    expect(frame.getAttribute("allow")).toBe("autoplay; clipboard-read; clipboard-write; fullscreen");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    fireEvent.click(view.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(closeConnectedWebAccountPage).toHaveBeenCalledWith(account.id));
    expect(finishConnectedWebAccount).not.toHaveBeenCalled();
  });

  test("shows immediate progress while a protected page is opening", async () => {
    let resolveOpen: ((value: Awaited<ReturnType<typeof openConnectedWebAccountPage>>) => void) | null = null;
    openConnectedWebAccountPage.mockImplementationOnce(() => new Promise((resolve) => { resolveOpen = resolve; }));
    const view = render(<ConnectedWebsiteJourney />);

    await act(async () => { requestWebsiteConnection({ kind: "view", accountId: account.id, title: "Project board" }); });
    expect(view.getByRole("heading", { name: "Opening Project board" })).toBeTruthy();
    expect(view.getByRole("status").textContent).toContain("can take a few moments");
    expect(view.getByRole("button", { name: "Cancel opening protected page" })).toBeTruthy();

    await act(async () => { resolveOpen?.({ account, login: loginResponse.login, createdNewAccount: false }); });
    await waitFor(() => expect(view.getByTitle("Protected page for Project board")).toBeTruthy());
  });

  test("shows opening progress instead of retry copy while sign-in starts", async () => {
    let resolveCreate: ((value: typeof loginResponse) => void) | null = null;
    createConnectedWebAccount.mockImplementationOnce(() => new Promise((resolve) => { resolveCreate = resolve; }));
    const view = render(<ConnectedWebsiteJourney />);

    await act(async () => { requestWebsiteConnection({ kind: "catalogue", websiteId: "notion" }); });
    expect(view.getByRole("heading", { name: "Opening Notion" })).toBeTruthy();
    expect(view.getByRole("status").textContent).toContain("protected sign-in window");
    expect(view.container.textContent).not.toContain("connection has not changed");

    await act(async () => { resolveCreate?.(loginResponse); });
    await waitFor(() => expect(view.getByTitle("Protected sign-in for Notion")).toBeTruthy());
  });

  test("keeps a failed launch coherent and never renders a raw server error", async () => {
    createConnectedWebAccount.mockImplementationOnce(async () => { throw new Error("provider token: should never be shown"); });
    const view = render(<ConnectedWebsiteJourney />);
    await act(async () => { requestWebsiteConnection({ kind: "catalogue", websiteId: "notion" }); });
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("couldn’t open a protected sign-in window"));
    expect(view.container.textContent).not.toContain("provider token");
    expect(view.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(view.queryByLabelText("Website address")).toBeNull();
  });

  test("turns missing Browser Use setup into a clear non-retryable path", async () => {
    createConnectedWebAccount.mockImplementationOnce(async () => {
      throw new ApiError(503, "browser_use_api_key_required");
    });
    const view = render(<MemoryRouter><ConnectedWebsiteJourney /></MemoryRouter>);

    await act(async () => { requestWebsiteConnection({ kind: "catalogue", websiteId: "notion" }); });
    expect(await view.findByRole("heading", { name: "Browser Use setup required" })).toBeTruthy();
    expect(view.getByRole("status").textContent).toContain("Browser Use API key required");
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.getByText(/simply ask your Genie to use the website/)).toBeTruthy();
    expect(view.getByRole("link", { name: "Open API settings" }).getAttribute("href")).toBe("/admin#provider-credentials");
    expect(view.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  test("stops a browser created after the shell unmounts", async () => {
    let resolveLaunch: ((value: typeof loginResponse) => void) | null = null;
    createConnectedWebAccount.mockImplementationOnce(() => new Promise<typeof loginResponse>((resolve) => { resolveLaunch = resolve; }));
    const view = render(<ConnectedWebsiteJourney />);
    await act(async () => { requestWebsiteConnection({ kind: "catalogue", websiteId: "notion" }); });
    await waitFor(() => expect(createConnectedWebAccount).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => { resolveLaunch?.(loginResponse); });
    await waitFor(() => expect(disconnectConnectedWebAccount).toHaveBeenCalledWith(account.id));
  });

  test("reports Done or Cancel exactly through the transient sign-in continuation", async () => {
    const done = mock(() => undefined);
    const view = render(<ConnectedWebsiteJourney />);
    await act(async () => { requestWebsiteConnection({ kind: "catalogue", websiteId: "notion", onFinished: done }); });
    await waitFor(() => expect(view.getByRole("button", { name: "Done" })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(done).toHaveBeenCalledWith("done"));
    expect(done).toHaveBeenCalledTimes(1);

    const cancelled = mock(() => undefined);
    await act(async () => { requestWebsiteConnection({ kind: "reconnect", accountId: account.id, onFinished: cancelled }); });
    await waitFor(() => expect(view.getByRole("button", { name: "Cancel website sign-in" })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Cancel website sign-in" }));
    await waitFor(() => expect(cancelled).toHaveBeenCalledWith("cancelled"));
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
});
