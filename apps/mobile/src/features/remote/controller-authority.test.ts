import { describe, expect, test } from "bun:test";
import {
  loadRemoteControllerAuthority,
  retainRemoteControllerAuthority,
  type ControllerAuthorityStorage,
} from "./controller-authority";

function memoryStorage(): ControllerAuthorityStorage {
  const values = new Map<string, string>();
  return {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => { values.set(key, value); },
  };
}

const response = {
  ok: true as const,
  installationId: "11111111-1111-4111-8111-111111111111",
  controllerInstallationId: "22222222-2222-4222-8222-222222222222",
  bindingId: "33333333-3333-4333-8333-333333333333",
  installationGeneration: 2,
  serverInstanceId: "44444444-4444-4444-8444-444444444444",
  serverBindingGeneration: 3,
};

describe("paired mobile controller authority", () => {
  test("retains only server and installation proof context", async () => {
    const storage = memoryStorage();
    await retainRemoteControllerAuthority("srv_one", response, storage);
    expect(await loadRemoteControllerAuthority("srv_one", storage)).toEqual({
      installationId: response.installationId,
      controllerInstallationId: response.controllerInstallationId,
      installationGeneration: 2,
      serverInstanceId: response.serverInstanceId,
      serverBindingGeneration: 3,
    });
  });

  test("fails closed on missing, malformed, or cross-server state", async () => {
    const storage = memoryStorage();
    await storage.setItem("nautilo.remote.controller.authority.srv_bad", "{}");
    expect(await loadRemoteControllerAuthority("srv_bad", storage)).toBeNull();
    expect(await loadRemoteControllerAuthority("srv_other", storage)).toBeNull();
    let rejected: unknown;
    try {
      await loadRemoteControllerAuthority("bad/server", storage);
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).message).toBe("invalid paired-computer server id");
  });
});
