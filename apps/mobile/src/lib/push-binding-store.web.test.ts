import { expect, test } from "bun:test";

import { loadPushBinding } from "./push-binding-store.web";

test("Mobile Web cannot load or manufacture native push-binding custody", async () => {
  expect(await loadPushBinding("srv_current_origin")).toBeNull();
  const source = await Bun.file(new URL("./push-binding-store.web.ts", import.meta.url)).text();
  expect(source).not.toContain("expo-secure-store");
  expect(source).not.toContain("expo-crypto");
  expect(source).not.toContain("createPushBinding");
  expect(source).not.toContain("revokeProof:");
});
