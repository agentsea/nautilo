import { expect, test } from "bun:test";

import {
  InviteHandoffError,
  loadInviteCallbackLocator,
  loadInviteHandoff,
  saveInviteHandoff,
} from "./invite-handoff.web";

test("Mobile Web never emulates native invite bearer custody", async () => {
  expect(await loadInviteCallbackLocator()).toBeNull();
  expect(await loadInviteHandoff({ serverId: "srv_origin", serverUrl: "https://nautilo.test" })).toBeNull();
  expect(saveInviteHandoff({} as never)).rejects.toBeInstanceOf(InviteHandoffError);
  const source = await Bun.file(new URL("./invite-handoff.web.ts", import.meta.url)).text();
  expect(source).not.toContain("expo-secure-store");
  expect(source).not.toContain("window.localStorage");
  expect(source).not.toContain("window.sessionStorage");
  expect(source).not.toContain("storage.setItemAsync");
});
