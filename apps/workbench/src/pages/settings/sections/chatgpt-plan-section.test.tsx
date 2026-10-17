import { beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";
import { ChatGPTPlanSection } from "./chatgpt-plan-section";

beforeEach(() => { reapplyHappyDomGlobals(); cleanup(); });
function api(state: "connected" | "disconnected" = "connected", canEnroll = true) {
  return {
    listChatGPTAccounts: mock(async () => ({ enabled: true, canEnroll, accounts: [{ id: "synthetic-account", label: "Test account", registrationLabel: "synthetic", revision: 2, selected: true, state }] })),
    startChatGPTSignIn: mock(async () => ({ attemptId: "synthetic-attempt", authorizationUrl: "https://auth.openai.com/api/accounts/authorize?state=synthetic" })),
    completeChatGPTSignIn: mock(async () => ({ status: "connected" as const })),
    chatGPTSignInStatus: mock(async () => ({ status: "pending" as const })),
    cancelChatGPTSignIn: mock(async () => ({ ok: true })),
    selectChatGPTAccount: mock(async (_id: string | null) => ({ ok: true })),
    listChatGPTModels: mock(async () => ({ models: [] as { id: string; name: string }[] })),
    disconnectChatGPTAccount: mock(async (_id: string, _revision: number) => ({ remoteRevocationConfirmed: false })),
  };
}
test("shows the subscription source and honest empty model discovery", async () => {
  const accountApi = api(); const view = render(<ChatGPTPlanSection accountApi={accountApi} />);
  await view.findByText("Used for OpenAI chats");
  expect(view.container.textContent).toContain("can be read by its operator");
  expect(view.container.textContent).toContain("currently funding eligible OpenAI chats");
  expect(view.queryByRole("button", { name: "Use for OpenAI chats" })).toBeNull();
  expect(view.getByRole("button", { name: "Add another ChatGPT account" })).toBeTruthy();
  expect(view.container.textContent).not.toContain("API charges may be incurred");
  fireEvent.click(view.getByRole("button", { name: "See eligible models" }));
  await view.findByText(/This list is informational and does not change funding or model selection/);
  expect(accountApi.selectChatGPTAccount).not.toHaveBeenCalled();
});
test("switching funding requires explicit confirmation and cancel preserves the subscription", async () => {
  const accountApi = api(); const view = render(<ChatGPTPlanSection accountApi={accountApi} />);
  fireEvent.click(await view.findByRole("button", { name: "Switch funding" }));
  await view.findByText("Switch to API-key/server funding?");
  expect(view.container.textContent).toContain("API charges may be incurred");
  expect(accountApi.selectChatGPTAccount).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole("button", { name: "Cancel" }));
  expect(view.queryByText("Switch to API-key/server funding?")).toBeNull();
  expect(accountApi.selectChatGPTAccount).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole("button", { name: "Switch funding" }));
  fireEvent.click(view.getByRole("button", { name: "Confirm switch to API-key/server funding" }));
  await waitFor(() => expect(accountApi.selectChatGPTAccount).toHaveBeenCalledWith(null));
});
test("disconnect pins the displayed revision and does not claim remote revocation", async () => {
  const accountApi = api(); const view = render(<ChatGPTPlanSection accountApi={accountApi} />);
  fireEvent.click(await view.findByRole("button", { name: "Disconnect" }));
  await view.findByText("Disconnected locally. Remote revocation was not confirmed; remove access in ChatGPT Settings.");
  expect(accountApi.disconnectChatGPTAccount).toHaveBeenCalledWith("synthetic-account", 2);
  expect(accountApi.selectChatGPTAccount).not.toHaveBeenCalled();
});
test("remote enrollment is disabled while explicit funding recovery remains available", async () => {
  const accountApi = api("disconnected", false); const view = render(<ChatGPTPlanSection accountApi={accountApi} />);
  const reconnect = await view.findByRole("button", { name: "Reconnect" });
  expect((reconnect as HTMLButtonElement).disabled).toBe(true);
  expect(view.container.textContent).toContain("OpenAI chats are paused until you reconnect");
  fireEvent.click(view.getByRole("button", { name: "Switch funding" }));
  expect(accountApi.selectChatGPTAccount).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole("button", { name: "Confirm switch to API-key/server funding" }));
  await waitFor(() => expect(accountApi.selectChatGPTAccount).toHaveBeenCalledWith(null));
  expect(accountApi.startChatGPTSignIn).not.toHaveBeenCalled();
});

test("a provider-rejected connection can reconnect even before its saved status changes", async () => {
  const accountApi = { ...api(), chatGPTSignInStatus: mock(async () => ({ status: "connected" as const })) };
  const view = render(<ChatGPTPlanSection accountApi={accountApi} />);
  fireEvent.click(await view.findByRole("button", { name: "Reconnect" }));
  await waitFor(() => expect(accountApi.startChatGPTSignIn).toHaveBeenCalledWith("synthetic-account"));
  await view.findByText("ChatGPT reconnected. Your account selection is unchanged.");
  expect(accountApi.disconnectChatGPTAccount).not.toHaveBeenCalled();
  expect(accountApi.selectChatGPTAccount).not.toHaveBeenCalled();
  view.unmount();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function switchViewer() {
  act(() => window.dispatchEvent(new window.CustomEvent("nautilo:auth-changed", { detail: {
    credentialGeneration: 2, viewerGeneration: 2, reason: "user-switched",
  } })));
}
test("late account lists cannot repopulate a different Human's settings", async () => {
  const accountApi = api();
  const old = deferred<Awaited<ReturnType<typeof accountApi.listChatGPTAccounts>>>();
  accountApi.listChatGPTAccounts.mockImplementationOnce(() => old.promise);
  const view = render(<ChatGPTPlanSection accountApi={accountApi} />);
  switchViewer();
  await view.findByText("Test account");
  old.resolve({ enabled: true, canEnroll: true, accounts: [{ id: "old", label: "Old Human account", registrationLabel: "old", revision: 1, selected: true, state: "connected" }] });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(view.queryByText("Old Human account")).toBeNull();
  view.unmount();
});
test("late model and disconnect results cannot mutate a replacement account view", async () => {
  const accountApi = api();
  const models = deferred<{ models: { id: string; name: string }[] }>();
  accountApi.listChatGPTModels.mockImplementationOnce(() => models.promise);
  const view = render(<ChatGPTPlanSection accountApi={accountApi} />);
  fireEvent.click(await view.findByRole("button", { name: "See eligible models" }));
  switchViewer();
  await view.findByText("Test account");
  models.resolve({ models: [{ id: "old-model", name: "Old Human model" }] });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(view.container.textContent).not.toContain("Old Human model");
  const disconnect = deferred<{ remoteRevocationConfirmed: boolean }>();
  accountApi.disconnectChatGPTAccount.mockImplementationOnce(() => disconnect.promise);
  fireEvent.click(view.getByRole("button", { name: "Disconnect" }));
  switchViewer();
  await view.findByText("Test account");
  const count = accountApi.listChatGPTAccounts.mock.calls.length;
  disconnect.resolve({ remoteRevocationConfirmed: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(accountApi.listChatGPTAccounts.mock.calls.length).toBe(count);
  expect(view.queryByText("Disconnected from ChatGPT.")).toBeNull();
  view.unmount();
});
test("abandoned sign-in never cancels through the replacement Human's API session", async () => {
  const accountApi = api(); const start = deferred<Awaited<ReturnType<typeof accountApi.startChatGPTSignIn>>>();
  accountApi.startChatGPTSignIn.mockImplementationOnce(() => start.promise);
  const view = render(<ChatGPTPlanSection accountApi={accountApi} />);
  fireEvent.click(await view.findByRole("button", { name: "Add another ChatGPT account" }));
  switchViewer(); await view.findByText("Test account");
  start.resolve({ attemptId: "old", authorizationUrl: "https://auth.openai.com/api/accounts/authorize?state=old" });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(view.queryByText("Waiting for browser sign-in…")).toBeNull();
  expect(accountApi.cancelChatGPTSignIn).not.toHaveBeenCalled();
  view.unmount();
});
test("Desktop hands off only the callback and leaves account selection explicit", async () => {
  const accountApi = api();
  accountApi.listChatGPTAccounts.mockImplementation(async () => ({ enabled: true, canEnroll: false, canEnrollWithDesktop: true, accounts: [] }));
  const callback = deferred<string>();
  const desktopBridge = { prepare: mock(async () => ({ listenerId: "listener", port: 32123 })),
    receive: mock(() => callback.promise), cancel: mock(async () => {}) };
  const view = render(<ChatGPTPlanSection accountApi={accountApi} desktopBridge={desktopBridge} />);
  await waitFor(() => expect((view.getByRole("button", { name: "Continue with ChatGPT" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(view.getByRole("button", { name: "Continue with ChatGPT" }));
  await waitFor(() => expect(desktopBridge.receive).toHaveBeenCalled());
  expect(accountApi.startChatGPTSignIn).toHaveBeenCalledWith(undefined, 32123);
  callback.resolve("http://127.0.0.1:32123/auth/callback?state=synthetic&code=synthetic");
  await view.findByText("ChatGPT connected. Choose this account for your OpenAI chats, then choose a model.");
  expect(accountApi.completeChatGPTSignIn).toHaveBeenCalledWith("synthetic-attempt", "http://127.0.0.1:32123/auth/callback?state=synthetic&code=synthetic");
  expect(accountApi.selectChatGPTAccount).not.toHaveBeenCalled();
  view.unmount();
});
