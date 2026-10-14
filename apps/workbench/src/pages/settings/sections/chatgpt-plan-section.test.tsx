import { beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";
import { ChatGPTPlanSection } from "./chatgpt-plan-section";

beforeEach(() => { reapplyHappyDomGlobals(); cleanup(); });
function api(state: "connected" | "disconnected" = "connected", canEnroll = true) {
  return {
    listChatGPTAccounts: mock(async () => ({ enabled: true, canEnroll, accounts: [{ id: "synthetic-account", label: "Test account", registrationLabel: "synthetic", revision: 2, selected: true, state }] })),
    startChatGPTSignIn: mock(async () => ({ attemptId: "synthetic-attempt", authorizationUrl: "https://auth.openai.com/api/accounts/authorize?state=synthetic" })),
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
  expect(view.container.textContent).toContain("Switching to API-key/server funding can incur API charges");
  fireEvent.click(view.getByRole("button", { name: "See eligible models" }));
  await view.findByText("No eligible Nautilo models are available for this account.");
  expect(accountApi.selectChatGPTAccount).not.toHaveBeenCalled();
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
  fireEvent.click(view.getByRole("button", { name: "Switch to API-key/server funding" }));
  await waitFor(() => expect(accountApi.selectChatGPTAccount).toHaveBeenCalledWith(null));
  expect(accountApi.startChatGPTSignIn).not.toHaveBeenCalled();
});

test("a provider-rejected connection can reconnect even before its saved status changes", async () => {
  const accountApi = api(); const view = render(<ChatGPTPlanSection accountApi={accountApi} />);
  fireEvent.click(await view.findByRole("button", { name: "Reconnect" }));
  await waitFor(() => expect(accountApi.startChatGPTSignIn).toHaveBeenCalledWith("synthetic-account"));
  expect(accountApi.disconnectChatGPTAccount).not.toHaveBeenCalled();
  expect(accountApi.selectChatGPTAccount).not.toHaveBeenCalled();
  view.unmount();
});
