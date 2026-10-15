/// <reference types="bun-types" />
import { expect, test } from "bun:test";
import { createChatGPTAccountsController, type ChatGPTAccount } from "./chatgpt-accounts-controller";
const scope = { serverId: "one", userId: "human", actorId: "actor" };
const account: ChatGPTAccount = { id: "account", label: "Account", registrationLabel: "1234", revision: 1, selected: true, state: "connected" };
function fixture(enabled = true, row = account) {
  const writes: string[] = [];
  const controller = createChatGPTAccountsController(() => ({
    listChatGPTAccounts: async () => ({ enabled, canEnroll: false, accounts: [row] }),
    listChatGPTModels: async () => ({ models: [{ id: "model", name: "Eligible model" }] }),
    selectChatGPTAccount: async id => { writes.push(`select:${id}`); return { ok: true }; },
    disconnectChatGPTAccount: async (id, revision) => { writes.push(`disconnect:${id}:${revision}`); return { remoteRevocationConfirmed: true }; },
  }));
  controller.setScope(scope);
  return { controller, writes };
}
test("linked accounts expose eligible models and explicit selection", async () => {
  const { controller, writes } = fixture();
  await controller.load();
  expect(controller.data.getState().data?.models.account).toEqual([{ id: "model", name: "Eligible model" }]);
  await controller.select(account);
  await controller.select(null);
  expect(writes).toEqual(["select:account", "select:null"]);
});
test("disabled policy permits disconnect but never a funding selection", async () => {
  const { controller, writes } = fixture(false);
  await controller.load();
  await controller.select(account);
  await controller.select(null);
  await controller.disconnect(account);
  expect(writes).toEqual(["disconnect:account:1"]);
});
test("pending registration and stale revision cannot become selected", async () => {
  const { controller, writes } = fixture(true, { ...account, state: "reconnect_required", pendingRegistration: true });
  await controller.load();
  await controller.select(account);
  await controller.disconnect({ ...account, revision: 2 });
  expect(writes).toEqual([]);
});
test("switching Human or server discards an in-flight account response", async () => {
  let resolve!: (value: { enabled: boolean; canEnroll: boolean; accounts: ChatGPTAccount[] }) => void;
  const controller = createChatGPTAccountsController(() => ({
    listChatGPTAccounts: () => new Promise(done => { resolve = done; }),
    listChatGPTModels: async () => ({ models: [] }),
    selectChatGPTAccount: async () => ({ ok: true }),
    disconnectChatGPTAccount: async () => ({ remoteRevocationConfirmed: true }),
  }));
  controller.setScope(scope);
  const pending = controller.load();
  await Promise.resolve();
  controller.setScope({ ...scope, userId: "other" });
  resolve({ enabled: true, canEnroll: false, accounts: [account] });
  expect((await pending).status).toBe("ignored");
  expect(controller.data.getState().data).toBeNull();
});
