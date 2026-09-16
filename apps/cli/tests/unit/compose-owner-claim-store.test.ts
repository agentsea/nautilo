import { describe, expect, test } from "bun:test";

import {
  composeOwnerClaimKeyringAccount,
  composeOwnerClaimControlFingerprint,
  KeyringComposeOwnerClaimStore,
} from "../../src/lib/compose-owner-claim-store.ts";

const claim = `inv_${"a".repeat(32)}`;
const identity = {
  profileName: "customer-prod",
  instanceId: "prod",
  mode: "claim",
  controlFingerprint: composeOwnerClaimControlFingerprint({
    transport: "remote",
    instanceId: "prod",
    projectName: "nautilo-prod",
    sshHost: "203.0.113.9",
    sshUser: "nautilo",
    sshPort: 22,
    remoteRoot: "/opt/nautilo-prod",
  }),
} as const;

class MemoryEntry {
  value: string | null = null;

  async getPassword(): Promise<string | null> {
    return this.value;
  }

  async setPassword(value: string): Promise<void> {
    this.value = value;
  }

  async deleteCredential(): Promise<boolean> {
    this.value = null;
    return true;
  }
}

describe("KeyringComposeOwnerClaimStore", () => {
  test("uses a stable opaque keychain account and control fingerprint", () => {
    expect(composeOwnerClaimKeyringAccount("customer-prod"))
      .toBe(composeOwnerClaimKeyringAccount("customer-prod"));
    expect(composeOwnerClaimKeyringAccount("customer-prod"))
      .not.toContain("customer-prod");
    const first = composeOwnerClaimControlFingerprint({
      transport: "remote",
      instanceId: "prod",
      projectName: "nautilo-prod",
      sshHost: "203.0.113.9",
      sshUser: "nautilo",
      sshPort: 22,
      remoteRoot: "/opt/nautilo-prod",
    });
    expect(first).toBe(identity.controlFingerprint);
    expect(composeOwnerClaimControlFingerprint({
      transport: "remote",
      instanceId: "prod",
      projectName: "nautilo-prod",
      sshHost: "203.0.113.10",
      sshUser: "nautilo",
      sshPort: 22,
      remoteRoot: "/opt/nautilo-prod",
    })).not.toBe(first);
    expect(composeOwnerClaimControlFingerprint({
      transport: "remote",
      instanceId: "prod",
      projectName: "nautilo-prod",
      sshHost: "203.0.113.9",
      sshUser: "nautilo",
      sshPort: 22,
      remoteRoot: "/opt/other-nautilo-prod",
    })).not.toBe(first);
  });

  test("reuses only an exact Compose profile, instance, control identity, and mode", async () => {
    const entry = new MemoryEntry();
    const store = new KeyringComposeOwnerClaimStore(entry);
    expect(await store.getOrCreate(identity, () => claim)).toBe(claim);
    expect(await store.getOrCreate(identity, () => {
      throw new Error("must reuse exact claim");
    })).toBe(claim);
    try {
      await store.getOrCreate({ ...identity, instanceId: "other" });
      throw new Error("expected custody failure");
    } catch (error) {
      expect(error).toHaveProperty("message", "Compose owner claim custody failed");
    }
  });

  test("fails closed when claim and seeded-config mode or result destination changes", async () => {
    const entry = new MemoryEntry();
    const store = new KeyringComposeOwnerClaimStore(entry);
    await store.getOrCreate(identity, () => claim);
    const configIdentity = {
      ...identity,
      mode: "owner-config" as const,
      seedResultPath: "/safe/owner-result.json",
    };
    try {
      await store.getOrCreate(configIdentity);
      throw new Error("expected claim/config custody mismatch");
    } catch (error) {
      expect(error).toHaveProperty("message", "Compose owner claim custody failed");
    }

    const configEntry = new MemoryEntry();
    const configStore = new KeyringComposeOwnerClaimStore(configEntry);
    await configStore.getOrCreate(configIdentity, () => claim);
    try {
      await configStore.getOrCreate({
        ...configIdentity,
        seedResultPath: "/safe/other-owner-result.json",
      });
      throw new Error("expected result path custody mismatch");
    } catch (error) {
      expect(error).toHaveProperty("message", "Compose owner claim custody failed");
    }
  });

  test("rotates and clears only the Compose-owned credential", async () => {
    const entry = new MemoryEntry();
    const store = new KeyringComposeOwnerClaimStore(entry);
    await store.getOrCreate(identity, () => claim);
    const rotated = `inv_${"b".repeat(32)}`;
    expect(await store.rotate(identity, () => rotated)).toBe(rotated);
    await store.clear();
    expect(entry.value).toBeNull();
  });
});
