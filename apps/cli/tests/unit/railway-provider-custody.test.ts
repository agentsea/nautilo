import { describe, expect, test } from "bun:test";

import { createRailwayDeploymentDriverState } from "../../src/lib/railway-deployment-runner.ts";
import {
  KeyringRailwayProviderCustodyStore,
  providerCustodyHasExactly,
  providerCustodyMayBeErased,
  type RailwayProviderCustody,
  type RailwayProviderCustodyKeyringEntry,
} from "../../src/lib/railway-provider-custody.ts";

class MemoryEntry implements RailwayProviderCustodyKeyringEntry {
  value: string | null = null;
  writes = 0;
  deletes = 0;
  failAfterNextWrite = false;

  getPassword(): Promise<string | null> {
    return Promise.resolve(this.value);
  }

  setPassword(password: string): Promise<void> {
    this.value = password;
    this.writes += 1;
    if (this.failAfterNextWrite) {
      this.failAfterNextWrite = false;
      return Promise.reject(new Error("response lost"));
    }
    return Promise.resolve();
  }

  deleteCredential(): Promise<boolean> {
    this.deletes += 1;
    const existed = this.value !== null;
    this.value = null;
    return Promise.resolve(existed);
  }
}

const openRouter = `sk-or-v1-${"o".repeat(40)}`;
const tavily = `tvly-${"t".repeat(20)}`;

function request(providers: RailwayProviderCustody = new Map([["openrouter" as const, openRouter]])) {
  return { launchId: "launch-1", releaseId: "release-1", providers };
}

describe("Railway provider custody", () => {
  test("retains newly supported provider keys across restart without changing custody format", async () => {
    const entry = new MemoryEntry();
    const providers: RailwayProviderCustody = new Map([
      ["openai", `sk-${"o".repeat(40)}`],
      ["anthropic", `sk-ant-${"a".repeat(40)}`],
      ["browser-use", `bu_${"b".repeat(40)}`],
    ]);
    await new KeyringRailwayProviderCustodyStore(entry).writeOrConfirm(request(providers));
    const resumed = await new KeyringRailwayProviderCustodyStore(entry).load({ launchId: "launch-1", releaseId: "release-1" });
    expect(resumed).toEqual(providers);
    expect(entry.writes).toBe(1);
  });
  test("writes once, confirms by re-read, and survives a crash/resume retry without source files", async () => {
    const entry = new MemoryEntry();
    const firstStore = new KeyringRailwayProviderCustodyStore(entry);
    const first = await firstStore.writeOrConfirm(request());

    const resumedStore = new KeyringRailwayProviderCustodyStore(entry);
    const resumed = await resumedStore.load({ launchId: "launch-1", releaseId: "release-1" });
    const retried = await resumedStore.writeOrConfirm(request());

    expect(entry.writes).toBe(1);
    expect(resumed).toEqual(first);
    expect(retried).toEqual(first);
    expect(JSON.stringify([...first])).not.toContain("provider-config");
  });

  test("rejects malformed, cross-launch, invalid-provider, and conflicting envelopes without exposing values", async () => {
    const entry = new MemoryEntry();
    const store = new KeyringRailwayProviderCustodyStore(entry);
    await store.writeOrConfirm(request());
    expect(store.writeOrConfirm(request(new Map([["openrouter", `sk-or-v1-${"x".repeat(40)}`]]))))
      .rejects.toThrow("Railway provider custody failed");
    expect(entry.writes).toBe(1);
    expect(() => store.assertCompatible(
      new Map([["openrouter", openRouter]]),
      new Map([["openrouter", `sk-or-v1-${"x".repeat(40)}`]]),
    )).toThrow("Railway provider custody failed");

    entry.value = JSON.stringify({
      formatVersion: 1,
      launchId: "launch-2",
      releaseId: "release-1",
      providers: { openrouter: openRouter },
    });
    expect(store.load({ launchId: "launch-1", releaseId: "release-1" }))
      .rejects.toThrow("Railway provider custody failed");

    entry.value = JSON.stringify({
      formatVersion: 1,
      launchId: "launch-1",
      releaseId: "release-1",
      providers: { tavily: "not-a-tavily-key" },
    });
    expect(store.load({ launchId: "launch-1", releaseId: "release-1" }))
      .rejects.toThrow("Railway provider custody failed");
    expect(new KeyringRailwayProviderCustodyStore(entry).load({ launchId: "launch-1", releaseId: "release-1" }))
      .rejects.toThrow("Railway provider custody failed");
  });

  test("retains custody through pending/failure stages and permits erasure only after durable runtime projection", async () => {
    for (const stage of [undefined, "databases", "logto-bootstrap", "not-a-stage"]) {
      expect(providerCustodyMayBeErased(stage)).toBe(false);
    }
    expect(providerCustodyMayBeErased("server-ready")).toBe(false);
    expect(providerCustodyMayBeErased("complete")).toBe(false);

    const entry = new MemoryEntry();
    const store = new KeyringRailwayProviderCustodyStore(entry);
    await store.writeOrConfirm(request(new Map([
      ["openrouter", openRouter],
      ["tavily", tavily],
    ])));
    const retained = await store.load({ launchId: "launch-1", releaseId: "release-1" });
    expect(retained).toBeDefined();
    expect(providerCustodyHasExactly(retained!, ["openrouter", "tavily"])).toBe(true);
    expect(providerCustodyHasExactly(retained!, ["openrouter"])).toBe(false);

    await store.clear();
    expect(entry.deletes).toBe(1);
    expect(await store.load({ launchId: "launch-1", releaseId: "release-1" })).toBeUndefined();
  });

  test("never writes provider values or source paths into the durable Railway launch state", () => {
    const state = createRailwayDeploymentDriverState({
      launchId: "00000000-0000-4000-8000-000000000001",
      releaseId: "release-1",
      providers: ["openrouter", "tavily"],
      target: { workspaceId: "workspace-1", projectName: "nautilo-1", environmentName: "production" },
      now: "2026-08-07T00:00:00.000Z",
    });
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain(openRouter);
    expect(serialized).not.toContain(tavily);
    expect(serialized).not.toContain("railway-provider-custody");
    expect(serialized).not.toContain("providers.toml");
  });

  test("copies exact active provider custody to a promoted launch without clearing its source", async () => {
    const sourceEntry = new MemoryEntry(); const targetEntry = new MemoryEntry();
    const source = new KeyringRailwayProviderCustodyStore(sourceEntry); const target = new KeyringRailwayProviderCustodyStore(targetEntry);
    await source.writeOrConfirm(request());
    await source.promoteTo({ source: { launchId: "launch-1", releaseId: "release-1" },
      target: { launchId: "launch-2", releaseId: "release-2" }, targetStore: target });
    const writes = targetEntry.writes;
    await source.promoteTo({ source: { launchId: "launch-1", releaseId: "release-1" },
      target: { launchId: "launch-2", releaseId: "release-2" }, targetStore: target });
    expect(targetEntry.writes).toBe(writes);
    expect(await target.load({ launchId: "launch-2", releaseId: "release-2" })).toEqual(request().providers);
    expect(await source.load({ launchId: "launch-1", releaseId: "release-1" })).toEqual(request().providers);
    const mismatchedEntry = new MemoryEntry(); const mismatched = new KeyringRailwayProviderCustodyStore(mismatchedEntry);
    await mismatched.writeOrConfirm({ launchId: "launch-3", releaseId: "release-3",
      providers: new Map([["openrouter", `sk-or-v1-${"x".repeat(40)}`]]) });
    expect(source.promoteTo({ source: { launchId: "launch-1", releaseId: "release-1" },
      target: { launchId: "launch-3", releaseId: "release-3" }, targetStore: mismatched })).rejects.toThrow();
  });

  test("replays an in-place provider release rebind after a committed keyring response loss", async () => {
    const entry = new MemoryEntry(); const store = new KeyringRailwayProviderCustodyStore(entry);
    await store.writeOrConfirm(request());
    entry.failAfterNextWrite = true;
    let failed = false;
    try {
      await store.promoteTo({ source: { launchId: "launch-1", releaseId: "release-1" },
        target: { launchId: "launch-1", releaseId: "release-2" }, targetStore: store });
    } catch { failed = true; }
    expect(failed).toBe(true);
    const writes = entry.writes;
    await store.promoteTo({ source: { launchId: "launch-1", releaseId: "release-1" },
      target: { launchId: "launch-1", releaseId: "release-2" }, targetStore: store });
    expect(entry.writes).toBe(writes);
    expect(await store.load({ launchId: "launch-1", releaseId: "release-2" })).toEqual(request().providers);
  });
});
