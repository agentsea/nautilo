import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { connectionSectionForHash } from "./connections-sections";

const requestWebsiteConnection = mock(() => true);
const setWebsiteConnectionIntentDispatcher = mock(() => {});
const listConnectedWebAccounts = mock(async () => ({ accounts: [], providerSetupStatus: "ready" as const }));
const disconnectConnectedWebAccount = mock(async () => undefined);
mock.module("../../adapters/website-connection-intent", () => ({ requestWebsiteConnection, setWebsiteConnectionIntentDispatcher }));
mock.module("../../lib/api", () => ({ apiClient: { listConnectedWebAccounts, disconnectConnectedWebAccount } }));

const { WebsiteAccountCatalogueSection } = await import("./website-account-catalogue-section");

beforeEach(() => {
  reapplyHappyDomGlobals();
  requestWebsiteConnection.mockClear();
  listConnectedWebAccounts.mockClear();
  listConnectedWebAccounts.mockImplementation(async () => ({ accounts: [], providerSetupStatus: "ready" as const }));
  disconnectConnectedWebAccount.mockClear();
  window.confirm = () => true;
});
afterEach(() => cleanup());

describe("WebsiteAccountCatalogueSection", () => {
  test("keeps every website visible and shows one API settings notice when Browser Use is not configured", async () => {
    listConnectedWebAccounts.mockImplementation(async () => ({ accounts: [], providerSetupStatus: "api_key_required" as const }));
    const view = render(<MemoryRouter><WebsiteAccountCatalogueSection /></MemoryRouter>);

    expect(await view.findByText(/Browser Use API key required/)).toBeTruthy();
    expect(view.getByRole("link", { name: "Open API settings" }).getAttribute("href")).toBe("/admin#provider-credentials");
    expect(view.getByText("Browse with your Genie")).toBeTruthy();
    expect(view.getByText(/Nautilo uses Browser Use for protected website sessions/)).toBeTruthy();
    expect(view.getByText(/simply ask your Genie to use it/)).toBeTruthy();
    const notion = view.getByTestId("website-catalogue-notion") as HTMLButtonElement;
    expect(notion.disabled).toBeTrue();
    expect(view.getByTestId("website-catalogue-bluesky")).toBeTruthy();
    expect(view.getAllByText(/Browser Use API key required/)).toHaveLength(1);
    expect((view.getByRole("button", { name: "Connect website" }) as HTMLButtonElement).disabled).toBeTrue();
    fireEvent.click(notion);
    expect(requestWebsiteConnection).not.toHaveBeenCalled();
  });

  test("projects presets as connect intents without claiming account state", async () => {
    const view = render(<MemoryRouter><WebsiteAccountCatalogueSection /></MemoryRouter>);
    await waitFor(() => expect(listConnectedWebAccounts).toHaveBeenCalled());
    expect(view.getByTestId("website-catalogue-notion")).toBeTruthy();
    expect(view.getByTestId("website-catalogue-bluesky")).toBeTruthy();
    expect(view.getByText("Connect another website")).toBeTruthy();
    expect(view.container.textContent).not.toContain("Connected");
    expect(connectionSectionForHash("#websites")).toBe("websites");

    fireEvent.click(view.getByTestId("website-catalogue-notion"));
    expect(requestWebsiteConnection).toHaveBeenCalledWith({ kind: "catalogue", websiteId: "notion" });
  });

  test("searches accessibly, reports an empty result, and submits a custom URL from the keyboard", async () => {
    const view = render(<MemoryRouter><WebsiteAccountCatalogueSection /></MemoryRouter>);
    await waitFor(() => expect(listConnectedWebAccounts).toHaveBeenCalled());
    const search = view.getByRole("textbox", { name: "Search websites" });
    fireEvent.input(search, { target: { value: "twitter" } });
    expect(view.getByTestId("website-catalogue-x")).toBeTruthy();

    const customUrl = view.getByRole("textbox", { name: "Connect another website" });
    const presetGrid = view.getByRole("list", { name: "Website presets" });
    expect(customUrl.closest("form")?.nextElementSibling).toBe(presetGrid);

    fireEvent.input(search, { target: { value: "nothing" } });
    expect(view.getByRole("status").textContent).toBe("No websites match that search.");

    fireEvent.input(customUrl, { target: { value: "https://example.com" } });
    fireEvent.submit(customUrl.closest("form")!);
    expect(requestWebsiteConnection).toHaveBeenLastCalledWith({ kind: "custom", url: "https://example.com" });
  });

  test("does not emit an invalid custom URL intent", async () => {
    const view = render(<MemoryRouter><WebsiteAccountCatalogueSection /></MemoryRouter>);
    await waitFor(() => expect(listConnectedWebAccounts).toHaveBeenCalled());
    fireEvent.input(view.getByRole("textbox", { name: "Connect another website" }), { target: { value: "example.com" } });
    fireEvent.click(view.getByRole("button", { name: "Connect website" }));
    expect(view.getByRole("alert").textContent).toContain("http or https");
    expect(requestWebsiteConnection).not.toHaveBeenCalled();
  });

  test("summarizes multiple accounts on one highlighted tile and manages them in the side window", async () => {
    const connected = {
      id: "11111111-1111-4111-8111-111111111111",
      service: "Bluesky",
      origin: "https://bsky.app",
      label: "Bluesky",
      status: "connected" as const,
      lastVerifiedAt: null,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    const second = {
      ...connected,
      id: "22222222-2222-4222-8222-222222222222",
      createdAt: "2026-09-01T01:00:00.000Z",
      updatedAt: "2026-09-01T01:00:00.000Z",
    };
    listConnectedWebAccounts.mockImplementation(async () => ({ accounts: [connected, second], providerSetupStatus: "ready" as const }));
    const view = render(<MemoryRouter><WebsiteAccountCatalogueSection /></MemoryRouter>);

    const tile = await view.findByRole("button", { name: "Bluesky, 2 connected" });
    expect(tile.getAttribute("data-connection-count")).toBe("2");
    expect(view.getAllByTestId("website-catalogue-bluesky")).toHaveLength(1);
    fireEvent.click(tile);

    expect(view.getByLabelText("Bluesky connected accounts")).toBeTruthy();
    expect(view.getByRole("button", { name: "Disconnect Bluesky 1" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Disconnect Bluesky 2" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Connect another account" }));
    expect(requestWebsiteConnection).toHaveBeenLastCalledWith({
      kind: "catalogue",
      websiteId: "bluesky",
      createAnother: true,
    });
  });

  test("keeps recovery and disconnect actions inside the selected website side window", async () => {
    const account = {
      id: "33333333-3333-4333-8333-333333333333",
      service: "Bluesky",
      origin: "https://bsky.app",
      label: "Bluesky",
      status: "attention_needed" as const,
      lastVerifiedAt: null,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    listConnectedWebAccounts.mockImplementation(async () => ({ accounts: [account], providerSetupStatus: "ready" as const }));
    const view = render(<MemoryRouter><WebsiteAccountCatalogueSection /></MemoryRouter>);
    fireEvent.click(await view.findByRole("button", { name: "Bluesky, Attention needed" }));

    fireEvent.click(view.getByRole("button", { name: "Continue sign-in Bluesky" }));
    expect(requestWebsiteConnection).toHaveBeenLastCalledWith({ kind: "reconnect", accountId: account.id });
    fireEvent.click(view.getByRole("button", { name: "Disconnect Bluesky" }));
    await waitFor(() => expect(disconnectConnectedWebAccount).toHaveBeenCalledWith(account.id));
  });
});

test("busy accounts keep Disconnect actionable and prevent duplicate requests only while submitting", async () => {
  const account = { id: "33333333-3333-4333-8333-333333333333", service: "Bluesky", origin: "https://bsky.app", label: "Bluesky", status: "busy" as const,
    lastVerifiedAt: null, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" };
  listConnectedWebAccounts.mockImplementation(async () => ({ accounts: [account], providerSetupStatus: "ready" as const }));
  let finish!: () => void;
  disconnectConnectedWebAccount.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const view = render(<MemoryRouter><WebsiteAccountCatalogueSection /></MemoryRouter>);
  fireEvent.click(await view.findByTestId("website-catalogue-bluesky"));
  const disconnect = await view.findByRole("button", { name: "Disconnect Bluesky" }) as HTMLButtonElement;
  expect(disconnect.disabled).toBe(false);
  fireEvent.click(disconnect);
  await waitFor(() => expect(disconnectConnectedWebAccount).toHaveBeenCalledWith(account.id));
  expect(disconnect.disabled).toBe(true);
  finish();
  await waitFor(() => expect(disconnect.disabled).toBe(false));
});
