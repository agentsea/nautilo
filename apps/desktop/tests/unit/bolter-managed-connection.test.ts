import { expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { BOLTER_CLI_RELEASE } from "../../electron/bolter-bridge/production-contract";
import * as runtime from "../../electron/bolter-bridge/runtime";
import { BolterConnectionOwner } from "../../electron/bolter-bridge/connection-owner";
import type { BolterConnectionObservation } from "@nautilo/types";
import { createManagedBolterConnectionFactory } from "../../electron/bolter-bridge/managed-connection";

const cipher = { isAvailable: () => true, seal: (text: string) => Promise.resolve(Buffer.from(text).reverse()),
  open: (bytes: Uint8Array) => Promise.resolve(Buffer.from(bytes).reverse().toString()) };
test("managed connection persists scoped local recovery metadata but cannot authenticate with unqualified production contract", async () => {
  const appDataDirectory = await mkdtemp(join(await realpath("/tmp"), "nb-managed-"));
  await chmod(appDataDirectory, 0o700);
  try {
    const config = { appDataDirectory, serverId: "synthetic-server", userId: "synthetic-human", cipher, decoders: { version: BOLTER_CLI_RELEASE.version } };
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


for (const failedOutcome of ["blocked", "unavailable"] as const) {
test.skipIf(process.platform !== "darwin")(`managed ${failedOutcome} intake is observable and clears only after current successful drain`, async () => {
  const appDataDirectory = await mkdtemp(join(await realpath("/tmp"), "nb-managed-"));
  await chmod(appDataDirectory, 0o700);
  const selection = { origin: "https://bolter.chat", agentId: "synthetic-agent", cliSelector: "synthetic-agent" };
  const decoders = { version: BOLTER_CLI_RELEASE.version, discovery: (raw: unknown) => raw, identity: (raw: unknown) => raw,
    conversations: (raw: unknown) => raw, receiveItem: (raw: unknown) => raw, receipt: (raw: unknown) => raw, authLink: (text: string) => text };
  const observed: BolterConnectionObservation[] = [];
  let blocked = true;
  const spies = [
    spyOn(runtime, "provisionBolterRuntime").mockResolvedValue("/opt/nautilo/synthetic-bolter"),
    spyOn(BolterConnectionOwner.prototype, "confirmDiscoveredIdentity").mockResolvedValue({ status: "confirmed", identity: selection }),
    spyOn(BolterConnectionOwner.prototype, "confirmIdentity").mockResolvedValue({ status: "confirmed", identity: selection }),
    spyOn(BolterConnectionOwner.prototype, "startReceiver").mockResolvedValue(true),
    spyOn(BolterConnectionOwner.prototype, "flushInbox").mockImplementation(() => Promise.resolve(blocked ? failedOutcome : "accepted")),
  ];
  const identityDescriptor = Object.getOwnPropertyDescriptor(BolterConnectionOwner.prototype, "confirmedIdentity")!;
  let driver: Awaited<ReturnType<ReturnType<typeof createManagedBolterConnectionFactory>>> | undefined;
  try {
    Object.defineProperty(BolterConnectionOwner.prototype, "confirmedIdentity", { configurable: true, get: () => selection });
    driver = await createManagedBolterConnectionFactory({ appDataDirectory, serverId: "synthetic-server", userId: "synthetic-human", cipher,
      decoders, helper: { executable: "/opt/nautilo/synthetic-helper", attest: () => Promise.resolve(true) } })({
      connectionId: "synthetic-connection", generation: 1, homeHandle: "synthetic-home", isCurrent: () => true });
    await driver.start(() => Promise.resolve(true), value => { observed.push(value); });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(observed.at(-1)?.reason).toBe("receiver_unavailable");
    expect((await driver.check()).reason).toBe("receiver_unavailable");
    await driver.start(() => Promise.resolve(true), value => { observed.push(value); });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect((await driver.check()).reason).toBe("receiver_unavailable");
    expect(observed).toHaveLength(1);
    blocked = false;
    await driver.start(() => Promise.resolve(true), value => { observed.push(value); });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(observed.at(-1)?.reason).toBeUndefined();
    expect(observed).toHaveLength(2);
  } finally {
    await driver?.retire();
    Object.defineProperty(BolterConnectionOwner.prototype, "confirmedIdentity", identityDescriptor);
    for (const spy of spies) spy.mockRestore();
    await rm(appDataDirectory, { recursive: true, force: true });
  }
});
}
