import { expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { createManagedBolterConnectionFactory } from "../../electron/bolter-bridge/managed-connection";

const cipher = { isAvailable: () => true, seal: (text: string) => Promise.resolve(Buffer.from(text).reverse()),
  open: (bytes: Uint8Array) => Promise.resolve(Buffer.from(bytes).reverse().toString()) };
test("managed connection persists scoped local recovery metadata but cannot authenticate with unqualified production contract", async () => {
  const appDataDirectory = await mkdtemp(join(await realpath("/tmp"), "nb-managed-"));
  await chmod(appDataDirectory, 0o700);
  try {
    const config = { appDataDirectory, serverId: "synthetic-server", userId: "synthetic-human", cipher };
    const input = { connectionId: "synthetic-connection", generation: 1, homeHandle: "synthetic-home", isCurrent: () => true };
    const first = await createManagedBolterConnectionFactory(config)(input);
    const result = await first.connect(() => { throw new Error("Unqualified login must not run"); });
    expect(result.runtime).toBe(process.platform === "darwin" ? "qualification_required" : "unavailable");
    expect(result.authentication).toBe("required");
    expect(result.receiver).toBe("stopped");
    expect(await first.prepareSend()).toBeNull();
    await first.retire();
    const recovered = await createManagedBolterConnectionFactory(config)({ ...input, homeHandle: undefined, generation: 2 });
    expect((await recovered.check()).authentication).toBe("required");
    await recovered.retire();
    await Promise.resolve(expect(createManagedBolterConnectionFactory({ ...config, userId: "other-human" })({
      connectionId: input.connectionId, generation: 2, isCurrent: () => true,
    })).rejects.toThrow("unavailable"));
    await Promise.resolve(expect(createManagedBolterConnectionFactory(config)({ ...input, homeHandle: "different-home" })).rejects.toThrow("unavailable"));
  } finally { await rm(appDataDirectory, { recursive: true, force: true }); }
});
