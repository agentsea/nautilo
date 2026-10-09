import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkstationShellHost } from "../../electron/workstation-shell-host";
import { WorkstationShellConsentStore } from "../../electron/workstation-shell-consent-store";

const roots: string[] = [];
const subject = {
  instanceId: "instance-1",
  userId: "user-1",
  relayId: "relay-1",
  serverOrigin: "https://nautilo.example",
  pairingFingerprint: "pairing-fingerprint-1",
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "nautilo-workstation-consent-"));
  roots.push(root);
  return root;
}

describe("workstation shell consent compatibility", () => {
  test("reads and revokes a historical durable receipt", async () => {
    const root = workspace();
    const store = new WorkstationShellConsentStore({
      instanceId: subject.instanceId,
      filePath: join(root, "consent.json"),
    });
    const identity = await stat(root);
    expect((await store.grant({
      subject,
      identity: { canonicalRoot: realpathSync(root), device: identity.dev, inode: identity.ino },
    })).ok).toBeTrue();
    const host = createWorkstationShellHost({ consentStore: store, resolveSubject: async () => subject });

    expect(await host.consentStatus(root)).toBe("durable");
    await host.revoke(root, subject);
    expect(await host.consentStatus(root)).toBe("none");
  });

  test("fails status closed for missing paths, identity changes, and store failures", async () => {
    const root = workspace();
    const store = new WorkstationShellConsentStore({
      instanceId: subject.instanceId,
      filePath: "/unused",
      storage: { read: async () => { throw new Error("unavailable"); }, writeAtomic: async () => undefined },
    });
    const host = createWorkstationShellHost({ consentStore: store, resolveSubject: async () => subject });
    expect(await host.consentStatus(join(root, "missing"))).toBe("none");
    expect(await host.consentStatus(root)).toBe("none");
    const unavailable = createWorkstationShellHost({ consentStore: store,
      resolveSubject: async () => { throw new Error("offline"); } });
    expect(await unavailable.consentStatus(root)).toBe("none");
  });

  test("replacement folders do not inherit a historical receipt", async () => {
    const parent = workspace();
    const root = join(parent, "project");
    mkdirSync(root);
    const identity = await stat(root);
    const store = new WorkstationShellConsentStore({
      instanceId: subject.instanceId,
      filePath: join(parent, "consent.json"),
    });
    expect((await store.grant({
      subject,
      identity: { canonicalRoot: realpathSync(root), device: identity.dev, inode: identity.ino },
    })).ok).toBeTrue();
    const host = createWorkstationShellHost({ consentStore: store, resolveSubject: async () => subject });
    expect(await host.consentStatus(root)).toBe("durable");

    const moved = join(parent, "old-project");
    renameSync(root, moved);
    mkdirSync(root);
    expect(await host.consentStatus(root)).toBe("none");
  });
});
