import { expect, test } from "bun:test";

import { loadOrCreateControllerInstallation } from "./controller-installation.web";

test("Mobile Web cannot mint controller installation authority", async () => {
  expect(loadOrCreateControllerInstallation("srv_current_origin")).rejects.toThrow(
    "requires the installed Mobile app",
  );
  const source = await Bun.file(new URL("./controller-installation.web.ts", import.meta.url)).text();
  expect(source).not.toContain("expo-secure-store");
  expect(source).not.toContain("expo-crypto");
  expect(source).not.toContain("ed25519");
  expect(source).not.toContain("privateKey");
});
