import { describe, expect, test } from "bun:test";
import { parsePersonalProviderCustody } from "@nautilo/operator-secrets";

import {
  KeyringRailwayLaunchSecretStore,
  RAILWAY_GENERATED_SECRET_SLOTS,
  type RailwayLaunchSecretKeyringEntry,
} from "../../src/lib/railway-launch-secret-store.ts";

class MemoryEntry implements RailwayLaunchSecretKeyringEntry {
  value: string | null = null;
  writes = 0;
  failAfterNextWrite = false;
  corruptAfterNextWrite = false;

  getPassword(): Promise<string | null> {
    return Promise.resolve(this.value);
  }

  setPassword(password: string): Promise<void> {
    this.value = this.corruptAfterNextWrite ? "{}" : password;
    this.corruptAfterNextWrite = false;
    this.writes += 1;
    if (this.failAfterNextWrite) {
      this.failAfterNextWrite = false;
      return Promise.reject(new Error("response lost"));
    }
    return Promise.resolve();
  }

  deleteCredential(): Promise<boolean> {
    const existed = this.value !== null;
    this.value = null;
    return Promise.resolve(existed);
  }
}

const binding = { launchId: "launch-1", releaseId: "release-1", projectId: "project-1",
  environmentId: "environment-1", serviceId: "bootstrap-service-1", domainId: "bootstrap-domain-1" };
const output: Parameters<KeyringRailwayLaunchSecretStore["storeBootstrapOutputs"]>[1] = {
  "logto-workbench-app-id": "workbench-id", "logto-tui-app-id": "tui-id", "logto-tui-loopback-app-id": "loopback-id",
  "logto-desktop-app-id": "desktop-id", "logto-mobile-app-id": "mobile-id", "logto-mobile-web-app-id": "mobile-web-id",
  "logto-m2m-app-id": "m2m-id",
  "logto-m2m-app-secret": "m2m-secret-value", "logto-resource": "resource-value",
};

describe("Railway launch secret custody", () => {
  test("stores exact template-generated values once and recovers a committed response loss", async () => {
    const entry = new MemoryEntry();
    const store = new KeyringRailwayLaunchSecretStore(entry);
    const templateSlots = RAILWAY_GENERATED_SECRET_SLOTS.filter((slot) => slot !== "nautilo-personal-provider-custody");
    const secrets = new Map(templateSlots.map((slot) => [slot, `template-${slot}`.padEnd(48, "x")]));
    entry.failAfterNextWrite = true;
    expect(store.storeGeneratedSecrets({ launchId: "launch-1", releaseId: "release-1", secrets })).rejects.toThrow();
    const writes = entry.writes;
    await store.storeGeneratedSecrets({ launchId: "launch-1", releaseId: "release-1", secrets });
    expect(entry.writes).toBe(writes);
    const loaded = await store.load({ launchId: "launch-1", releaseId: "release-1" });
    expect([...secrets].every(([slot, value]) => loaded?.get(slot) === value)).toBe(true);
    expect(() => parsePersonalProviderCustody(loaded?.get("nautilo-personal-provider-custody"))).not.toThrow();
    const changed = new Map(secrets); changed.set(templateSlots[0]!, "different".padEnd(48, "x"));
    expect(store.storeGeneratedSecrets({ launchId: "launch-1", releaseId: "release-1", secrets: changed })).rejects.toThrow();
    expect(Object.hasOwn(JSON.parse(entry.value!) as Record<string, unknown>, "bootstrap")).toBe(false);
  });

  test("creates a complete OS-keyring envelope once and returns it on resume", async () => {
    const entry = new MemoryEntry();
    const store = new KeyringRailwayLaunchSecretStore(entry);
    const first = await store.getOrCreate({ launchId: "launch-1", releaseId: "release-1" });
    const resumed = await store.getOrCreate({ launchId: "launch-1", releaseId: "release-1" });

    expect(entry.writes).toBe(1);
    expect([...first.keys()]).toEqual([...RAILWAY_GENERATED_SECRET_SLOTS]);
    expect([...resumed]).toEqual([...first]);
    expect([...first.values()].every((value) => value.length >= 32)).toBe(true);
  });

  test("creates distinct personal-provider custody for independent launches", async () => {
    const firstStore = new KeyringRailwayLaunchSecretStore(new MemoryEntry());
    const secondStore = new KeyringRailwayLaunchSecretStore(new MemoryEntry());
    const first = parsePersonalProviderCustody((await firstStore.getOrCreate({
      launchId: "launch-1", releaseId: "release-1",
    })).get("nautilo-personal-provider-custody"));
    const second = parsePersonalProviderCustody((await secondStore.getOrCreate({
      launchId: "launch-2", releaseId: "release-1",
    })).get("nautilo-personal-provider-custody"));
    expect(second.keyId).not.toBe(first.keyId);
    expect(second.keyHex).not.toBe(first.keyHex);
  });

  test("refuses cross-launch reuse, malformed envelopes, and clears after teardown", async () => {
    const entry = new MemoryEntry();
    const store = new KeyringRailwayLaunchSecretStore(entry);
    await store.getOrCreate({ launchId: "launch-1", releaseId: "release-1" });
    expect(store.getOrCreate({ launchId: "launch-2", releaseId: "release-1" })).rejects.toThrow(
      "Railway launch secret custody failed",
    );
    await store.clear();
    expect(entry.value).toBeNull();

    entry.value = JSON.stringify({ formatVersion: 1, launchId: "launch-1" });
    expect(store.getOrCreate({ launchId: "launch-1", releaseId: "release-1" })).rejects.toThrow(
      "Railway launch secret custody failed",
    );
  });

  test("upgrades V1 custody atomically and exact-replays the bound nine-key bootstrap output", async () => {
    const entry = new MemoryEntry(); const store = new KeyringRailwayLaunchSecretStore(entry);
    await store.getOrCreate({ launchId: binding.launchId, releaseId: binding.releaseId });
    const v2 = JSON.parse(entry.value!) as Record<string, unknown>; v2["formatVersion"] = 1; delete v2["bootstrap"];
    delete (v2["secrets"] as Record<string, unknown>)["nautilo-personal-provider-custody"];
    entry.value = JSON.stringify(v2); const before = entry.writes;
    expect(await store.loadBootstrapOutputs(binding)).toBeUndefined();
    await store.storeBootstrapOutputs(binding, output);
    expect(entry.writes).toBe(before + 1);
    expect(await store.loadBootstrapOutputs(binding)).toEqual(output);
    await store.storeBootstrapOutputs(binding, output);
    expect(entry.writes).toBe(before + 1);
  });

  test("reads exact legacy V1/V2 envelopes and upgrades only through explicit live authority", async () => {
    const entry = new MemoryEntry();
    const legacySecrets = Object.fromEntries(RAILWAY_GENERATED_SECRET_SLOTS
      .filter((slot) => slot !== "nautilo-personal-provider-custody")
      .map((slot) => [slot, `legacy-${slot}`.padEnd(48, "x")]));
    entry.value = JSON.stringify({ formatVersion: 2, launchId: "launch-1", releaseId: "release-1", secrets: legacySecrets });
    const store = new KeyringRailwayLaunchSecretStore(entry);

    const before = await store.load({ launchId: "launch-1", releaseId: "release-1" });
    expect(before?.has("nautilo-personal-provider-custody")).toBe(false);
    const canonical = JSON.stringify({
      formatVersion: 1,
      keyId: "00000000-0000-4000-8000-000000000001",
      keyHex: "ab".repeat(32),
    });
    const upgraded = await store.upgradePersonalProviderCustody({
      launchId: "launch-1",
      releaseId: "release-1",
      authority: { inspect: async () => ({ outcome: "canonical-custody", serializedCustody: canonical }) },
    });
    expect(upgraded.get("nautilo-personal-provider-custody")).toBe(canonical);
    expect(entry.writes).toBe(1);
    await store.upgradePersonalProviderCustody({
      launchId: "launch-1",
      releaseId: "release-1",
      authority: { inspect: async () => { throw new Error("must not inspect after commit"); } },
    });
    expect(entry.writes).toBe(1);
  });

  test("fails closed when legacy upgrade evidence is blocked or canonical custody is malformed", async () => {
    const legacy = () => JSON.stringify({
      formatVersion: 1,
      launchId: "launch-1",
      releaseId: "release-1",
      secrets: Object.fromEntries(RAILWAY_GENERATED_SECRET_SLOTS
        .filter((slot) => slot !== "nautilo-personal-provider-custody")
        .map((slot) => [slot, `legacy-${slot}`.padEnd(48, "x")])),
    });
    for (const inspection of [
      { outcome: "blocked" as const },
      { outcome: "canonical-custody" as const, serializedCustody: "malformed" },
    ]) {
      const entry = new MemoryEntry(); entry.value = legacy();
      const store = new KeyringRailwayLaunchSecretStore(entry);
      expect(store.upgradePersonalProviderCustody({
        launchId: "launch-1", releaseId: "release-1",
        authority: { inspect: async () => inspection },
      })).rejects.toThrow("Railway launch secret custody failed");
      expect(entry.writes).toBe(0);
      expect(entry.value).toBe(legacy());
    }
  });

  test("commits one generated custody after proven empty authority and recovers a lost response", async () => {
    const entry = new MemoryEntry();
    entry.value = JSON.stringify({
      formatVersion: 1, launchId: "launch-1", releaseId: "release-1",
      secrets: Object.fromEntries(RAILWAY_GENERATED_SECRET_SLOTS
        .filter((slot) => slot !== "nautilo-personal-provider-custody")
        .map((slot) => [slot, `legacy-${slot}`.padEnd(48, "x")])),
    });
    const store = new KeyringRailwayLaunchSecretStore(entry);
    entry.failAfterNextWrite = true;
    expect(store.upgradePersonalProviderCustody({
      launchId: "launch-1", releaseId: "release-1",
      authority: { inspect: async () => ({ outcome: "proven-no-existing-authority" }) },
    })).rejects.toThrow("response lost");
    const committed = JSON.parse(entry.value) as { secrets: Record<string, string> };
    const custody = committed.secrets["nautilo-personal-provider-custody"];
    expect(() => parsePersonalProviderCustody(custody)).not.toThrow();
    const writes = entry.writes;
    const resumed = await store.upgradePersonalProviderCustody({
      launchId: "launch-1", releaseId: "release-1",
      authority: { inspect: async () => { throw new Error("must not re-inspect"); } },
    });
    expect(resumed.get("nautilo-personal-provider-custody")).toBe(custody);
    expect(entry.writes).toBe(writes);
  });

  test("rejects cross-target replay, output mismatch, extra keys, and failed replacement confirmation", async () => {
    const entry = new MemoryEntry(); const store = new KeyringRailwayLaunchSecretStore(entry);
    await store.getOrCreate({ launchId: binding.launchId, releaseId: binding.releaseId });
    await store.storeBootstrapOutputs(binding, output);
    expect(store.loadBootstrapOutputs({ ...binding, serviceId: "other-service" })).rejects.toThrow();
    expect(store.storeBootstrapOutputs(binding, { ...output, "logto-resource": "other" })).rejects.toThrow();
    expect(store.storeBootstrapOutputs(binding, { ...output, extra: "forbidden" } as never)).rejects.toThrow();

    const corrupted = new MemoryEntry(); const corruptedStore = new KeyringRailwayLaunchSecretStore(corrupted);
    await corruptedStore.getOrCreate({ launchId: binding.launchId, releaseId: binding.releaseId });
    corrupted.corruptAfterNextWrite = true;
    expect(corruptedStore.storeBootstrapOutputs(binding, output)).rejects.toThrow("Railway launch secret custody failed");
  });

  test("recovers an exact committed bootstrap-output write after its keyring response is lost", async () => {
    const entry = new MemoryEntry(); const store = new KeyringRailwayLaunchSecretStore(entry);
    await store.getOrCreate({ launchId: binding.launchId, releaseId: binding.releaseId });
    entry.failAfterNextWrite = true;
    let failed = false;
    try { await store.storeBootstrapOutputs(binding, output); } catch { failed = true; }
    expect(failed).toBe(true);
    const committedWrites = entry.writes;
    await store.storeBootstrapOutputs(binding, output);
    expect(entry.writes).toBe(committedWrites);
    expect(await store.loadBootstrapOutputs(binding)).toEqual(output);
  });

  test("rejects an over-budget exact-key output before replacing credential custody", async () => {
    const entry = new MemoryEntry(); const store = new KeyringRailwayLaunchSecretStore(entry);
    await store.getOrCreate({ launchId: binding.launchId, releaseId: binding.releaseId });
    const before = entry.value; const writes = entry.writes;
    const oversized = Object.fromEntries(Object.keys(output).map((key) => [key, "x".repeat(2048)]));
    let failed = false;
    try { await store.storeBootstrapOutputs(binding, oversized as unknown as typeof output); } catch { failed = true; }
    expect(failed).toBe(true);
    expect(entry.writes).toBe(writes);
    expect(entry.value).toBe(before);
  });

  test("copies and rebinds exact V2 custody before promotion and exact-replays after response loss", async () => {
    const sourceEntry = new MemoryEntry(); const targetEntry = new MemoryEntry();
    const source = new KeyringRailwayLaunchSecretStore(sourceEntry); const target = new KeyringRailwayLaunchSecretStore(targetEntry);
    await source.getOrCreate({ launchId: binding.launchId, releaseId: binding.releaseId });
    await source.storeBootstrapOutputs(binding, output);
    const targetBinding = { ...binding, launchId: "launch-2", releaseId: "release-2", projectId: "project-2",
      environmentId: "environment-2", serviceId: "service-2", domainId: "domain-2" };
    targetEntry.failAfterNextWrite = true;
    let failed = false;
    try { await source.promoteTo({ source: binding, target: targetBinding, targetStore: target }); } catch { failed = true; }
    expect(failed).toBe(true);
    const writes = targetEntry.writes;
    await source.promoteTo({ source: binding, target: targetBinding, targetStore: target });
    expect(targetEntry.writes).toBe(writes);
    expect(await target.loadBootstrapOutputs(targetBinding)).toEqual(output);
    expect(await source.loadBootstrapOutputs(binding)).toEqual(output);
    expect(await target.load({ launchId: targetBinding.launchId, releaseId: targetBinding.releaseId }))
      .toEqual(await source.load({ launchId: binding.launchId, releaseId: binding.releaseId }));

    const mismatchedEntry = new MemoryEntry(); const mismatched = new KeyringRailwayLaunchSecretStore(mismatchedEntry);
    await mismatched.getOrCreate({ launchId: targetBinding.launchId, releaseId: targetBinding.releaseId });
    await mismatched.storeBootstrapOutputs(targetBinding, { ...output, "logto-resource": "mismatch" });
    expect(source.promoteTo({ source: binding, target: targetBinding, targetStore: mismatched })).rejects.toThrow();
  });

  test("replays an in-place release rebind after the committed keyring write response is lost", async () => {
    const entry = new MemoryEntry(); const store = new KeyringRailwayLaunchSecretStore(entry);
    await store.getOrCreate({ launchId: binding.launchId, releaseId: binding.releaseId });
    await store.storeBootstrapOutputs(binding, output);
    const targetBinding = { ...binding, releaseId: "release-2" };
    entry.failAfterNextWrite = true;
    let failed = false;
    try { await store.promoteTo({ source: binding, target: targetBinding, targetStore: store }); } catch { failed = true; }
    expect(failed).toBe(true);
    const writes = entry.writes;
    await store.promoteTo({ source: binding, target: targetBinding, targetStore: store });
    expect(entry.writes).toBe(writes);
    expect(await store.loadBootstrapOutputs(targetBinding)).toEqual(output);
  });
});
