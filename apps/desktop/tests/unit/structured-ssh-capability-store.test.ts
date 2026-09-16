import { describe, expect, test } from "bun:test";
import {
  parseSshCapability,
  parseSshCapabilityTools,
  SSH_CAPABILITY_STORE_VERSION,
  SSH_CAPABILITY_VERSION,
} from "../../electron/structured-ssh/contracts.ts";
import { SshCapabilityStore } from "../../electron/structured-ssh/capability-store.ts";

const now = () => new Date("2026-08-08T12:00:00.000Z");
const SERVER_A = "ssh-server-binding-aaaaaaaaaaaaaaaa";
const SERVER_B = "ssh-server-binding-bbbbbbbbbbbbbbbb";
const subject = {
  instanceId: "",
  userId: "user-1",
  agentId: "agent-1",
  relayId: "relay-1",
  desktopSessionId: "desktop-1",
};
const tools = { auth: true, exec: true, copyUpload: true, copyDownload: true };

function memoryStorage(initial: string | null = null) {
  let bytes = initial;
  let writes = 0;
  return {
    storage: {
      read: async () => bytes,
      writeAtomic: async (next: string) => { bytes = next; writes += 1; },
    },
    bytes: () => bytes,
    writes: () => writes,
  };
}

function makeStore(memory = memoryStorage(), serverBindingId = SERVER_A) {
  return {
    memory,
    store: new SshCapabilityStore({
      instanceId: subject.instanceId,
      serverBindingId,
      filePath: "/unused/structured-ssh-capability.json",
      storage: memory.storage,
      clock: now,
    }),
  };
}

describe("structured SSH local capability store", () => {
  test("stores one exact default-instance subject without target, identity, or folder authority", async () => {
    expect(parseSshCapabilityTools(tools)).toEqual(tools);
    expect(parseSshCapabilityTools({ ...tools, target: "not-allowed" })).toBeNull();

    const { store, memory } = makeStore();
    const enabled = await store.enable({ subject, expectedRevision: 0, tools });
    expect(enabled).toMatchObject({ ok: true, data: { capability: { version: SSH_CAPABILITY_VERSION, subject, enabled: true, tools }, revision: 1 } });
    const persisted = JSON.parse(memory.bytes() ?? "{}");
    expect(persisted).toMatchObject({ version: SSH_CAPABILITY_STORE_VERSION, instanceId: "", serverBindingId: SERVER_A, revision: 1 });
    expect(persisted.capabilities).toHaveLength(1);
    expect(Object.keys(persisted.capabilities[0]).sort()).toEqual(["enabled", "issuedAt", "subject", "tools", "updatedAt", "version"]);
    expect(JSON.stringify(persisted)).not.toMatch(/host|identity|fingerprint|folder|path|workstation/i);
  });

  test("enables, independently updates tools, disables, and records revocation", async () => {
    const { store, memory } = makeStore();
    const enabled = await store.enable({ subject, expectedRevision: 0, tools });
    if (!enabled.ok) throw new Error("enable failed");
    const updated = await store.update({ subject, expectedRevision: enabled.data.revision, tools: { ...tools, copyDownload: false } });
    expect(updated).toMatchObject({ ok: true, data: { capability: { enabled: true, tools: { copyDownload: false } }, revision: 2 } });
    if (!updated.ok) throw new Error("update failed");
    const disabled = await store.disable({ subject, expectedRevision: updated.data.revision });
    expect(disabled).toMatchObject({ ok: true, data: { capability: { enabled: false, disabledAt: now().toISOString() }, revision: 3 } });
    if (!disabled.ok) throw new Error("disable failed");
    const reenabled = await store.enable({ subject, expectedRevision: disabled.data.revision, tools: { ...tools, auth: false } });
    expect(reenabled).toMatchObject({ ok: true, data: { capability: { enabled: true, tools: { auth: false } }, revision: 4 } });
    if (reenabled.ok) expect(reenabled.data.capability).not.toHaveProperty("disabledAt");
    if (!reenabled.ok) throw new Error("reenable failed");
    const revoked = await store.revoke({ subject, expectedRevision: reenabled.data.revision });
    expect(revoked).toMatchObject({ ok: true, data: { capability: { enabled: false, revokedAt: now().toISOString() }, revision: 5 } });
    if (!revoked.ok) throw new Error("revoke failed");
    expect(await store.enable({ subject, expectedRevision: revoked.data.revision, tools }))
      .toMatchObject({ ok: true, data: { capability: { enabled: true, issuedAt: now().toISOString() }, revision: 6 } });
    const persisted = JSON.parse(memory.bytes() ?? "{}");
    expect(persisted.capabilities).toHaveLength(1);
    expect(persisted.capabilities[0]).not.toHaveProperty("disabledAt");
    expect(persisted.capabilities[0]).not.toHaveProperty("revokedAt");
  });

  test("refuses stale writes and keeps capability authority exact to each Human, Genie, relay, and Desktop session", async () => {
    const { store } = makeStore();
    const enabled = await store.enable({ subject, expectedRevision: 0, tools });
    if (!enabled.ok) throw new Error("enable failed");
    expect(await store.disable({ subject, expectedRevision: 0 }))
      .toMatchObject({ ok: false, code: "capability_revision_mismatch" });
    for (const mismatch of [
      { ...subject, userId: "user-2" },
      { ...subject, agentId: "agent-2" },
      { ...subject, relayId: "relay-2" },
      { ...subject, desktopSessionId: "desktop-2" },
    ]) {
      const { store: scopedStore } = makeStore();
      const base = await scopedStore.enable({ subject, expectedRevision: 0, tools });
      if (!base.ok) throw new Error("base enable failed");
      expect(await scopedStore.get(mismatch)).toMatchObject({ ok: true, data: { capability: null } });
      const enabledForMismatch = await scopedStore.enable({ subject: mismatch, expectedRevision: base.data.revision, tools });
      expect(enabledForMismatch).toMatchObject({ ok: true, data: { capability: { subject: mismatch }, revision: 2 } });
      expect(await scopedStore.get(subject)).toMatchObject({
        ok: true,
        data: { capability: mismatch.agentId !== subject.agentId ? { subject } : null },
      });
      expect(await scopedStore.update({ subject: mismatch, expectedRevision: enabledForMismatch.data.revision, tools: { ...tools, exec: false } }))
        .toMatchObject({ ok: true, data: { capability: { subject: mismatch, tools: { exec: false } } } });
    }
  });

  test("fails closed for corrupt bytes, server switches, and copied ids on another server", async () => {
    const corruptMemory = memoryStorage("not-json");
    const corrupt = makeStore(corruptMemory);
    expect(await corrupt.store.get(subject)).toMatchObject({ ok: false, code: "store_corrupt" });
    expect(await corrupt.store.enable({ subject, expectedRevision: 0, tools })).toMatchObject({ ok: false, code: "store_corrupt" });
    expect(corruptMemory.writes()).toBe(0);
    expect(corruptMemory.bytes()).toBe("not-json");

    const source = makeStore();
    const enabled = await source.store.enable({ subject, expectedRevision: 0, tools });
    if (!enabled.ok) throw new Error("enable failed");
    const switched = makeStore(memoryStorage(source.memory.bytes()), SERVER_B);
    expect(await switched.store.get(subject)).toMatchObject({ ok: false, code: "store_server_mismatch" });

    const invalidRecord = {
      version: SSH_CAPABILITY_VERSION,
      subject,
      enabled: true,
      tools,
      issuedAt: now().toISOString(),
      updatedAt: now().toISOString(),
      target: { host: "not-allowed" },
    };
    expect(parseSshCapability(invalidRecord)).toBeNull();
    expect(parseSshCapability({
      version: SSH_CAPABILITY_VERSION,
      subject,
      enabled: true,
      tools,
      issuedAt: now().toISOString(),
      updatedAt: now().toISOString(),
      disabledAt: now().toISOString(),
    })).toBeNull();
    expect(parseSshCapability({
      version: SSH_CAPABILITY_VERSION,
      subject,
      enabled: false,
      tools,
      issuedAt: now().toISOString(),
      updatedAt: now().toISOString(),
    })).toBeNull();
  });

  test("loads an existing capability envelope but never upgrades tuple-shaped records into authority", async () => {
    const existingEnvelope = JSON.stringify({
      version: SSH_CAPABILITY_STORE_VERSION,
      instanceId: subject.instanceId,
      serverBindingId: SERVER_A,
      revision: 7,
      capabilities: [{
        version: SSH_CAPABILITY_VERSION,
        subject,
        enabled: true,
        tools,
        issuedAt: "2026-08-08T11:00:00.000Z",
        updatedAt: "2026-08-08T12:00:00.000Z",
      }],
      updatedAt: "2026-08-08T12:00:00.000Z",
    });
    const compatible = makeStore(memoryStorage(existingEnvelope));
    expect(await compatible.store.get(subject)).toEqual({
      ok: true,
      data: {
        revision: 7,
        capability: {
          version: SSH_CAPABILITY_VERSION,
          subject,
          enabled: true,
          tools,
          issuedAt: "2026-08-08T11:00:00.000Z",
          updatedAt: "2026-08-08T12:00:00.000Z",
        },
      },
    });

    const tupleRecord = {
      version: 2,
      id: "ssh-grant-legacy-1",
      subject,
      target: { host: "legacy.example.test", port: 22, remoteUser: "deploy", hostKeyFingerprint: "SHA256:aaaaaaaa" },
      identity: { provider: "system-agent", publicKeyFingerprint: "SHA256:bbbbbbbb", localHandle: "agent-1" },
      operations: ["exec"],
      lifetime: "current-desktop-session",
      issuedAt: "2026-08-08T12:00:00.000Z",
    };
    const legacy = makeStore(memoryStorage(JSON.stringify({
      version: SSH_CAPABILITY_STORE_VERSION,
      instanceId: subject.instanceId,
      serverBindingId: SERVER_A,
      revision: 7,
      capabilities: [tupleRecord],
      updatedAt: "2026-08-08T12:00:00.000Z",
    })));
    expect(await legacy.store.get(subject)).toMatchObject({ ok: false, code: "store_corrupt" });
    expect(legacy.memory.writes()).toBe(0);
  });

  test("retains authority across restart only for the exact Human, Genie, relay, Desktop session, and server", async () => {
    const initial = makeStore();
    const enabled = await initial.store.enable({ subject, expectedRevision: 0, tools });
    if (!enabled.ok) throw new Error("enable failed");

    // Recreate the store from its own persisted bytes, as Electron does after
    // restart. This is deliberately not a hand-written compatible envelope.
    const restarted = makeStore(memoryStorage(initial.memory.bytes()));
    expect(await restarted.store.get(subject)).toMatchObject({
      ok: true,
      data: { revision: 1, capability: { enabled: true, subject, tools } },
    });

    for (const mismatch of [
      { ...subject, userId: "user-2" },
      { ...subject, agentId: "agent-2" },
      { ...subject, relayId: "relay-2" },
      { ...subject, desktopSessionId: "desktop-2" },
    ]) {
      expect(await restarted.store.get(mismatch)).toMatchObject({
        ok: true,
        data: { revision: 1, capability: null },
      });
    }
    const otherServer = makeStore(memoryStorage(initial.memory.bytes()), SERVER_B);
    expect(await otherServer.store.get(subject)).toMatchObject({ ok: false, code: "store_server_mismatch" });
  });

  test("keeps disabled and revoked capability state fail-closed after restart", async () => {
    const initial = makeStore();
    const enabled = await initial.store.enable({ subject, expectedRevision: 0, tools });
    if (!enabled.ok) throw new Error("enable failed");

    const afterFirstRestart = makeStore(memoryStorage(initial.memory.bytes()));
    const disabled = await afterFirstRestart.store.disable({ subject, expectedRevision: enabled.data.revision });
    if (!disabled.ok) throw new Error("disable failed");

    const afterDisableRestart = makeStore(memoryStorage(afterFirstRestart.memory.bytes()));
    expect(await afterDisableRestart.store.get(subject)).toMatchObject({
      ok: true,
      data: { revision: 2, capability: { enabled: false, disabledAt: now().toISOString() } },
    });

    const revoked = await afterDisableRestart.store.revoke({ subject, expectedRevision: disabled.data.revision });
    if (!revoked.ok) throw new Error("revoke failed");
    const afterRevokeRestart = makeStore(memoryStorage(afterDisableRestart.memory.bytes()));
    expect(await afterRevokeRestart.store.get(subject)).toMatchObject({
      ok: true,
      data: { revision: 3, capability: null },
    });
  });

  test("prunes stale relay and Desktop sessions on enablement", async () => {
    const { store, memory } = makeStore();
    const first = await store.enable({ subject, expectedRevision: 0, tools });
    if (!first.ok) throw new Error("first enable failed");
    const nextSession = { ...subject, relayId: "relay-2", desktopSessionId: "desktop-2" };
    const second = await store.enable({ subject: nextSession, expectedRevision: first.data.revision, tools });
    expect(second).toMatchObject({ ok: true, data: { capability: { subject: nextSession }, revision: 2 } });
    const persisted = JSON.parse(memory.bytes() ?? "{}");
    expect(persisted.capabilities).toHaveLength(1);
    expect(persisted.capabilities[0].subject).toEqual(nextSession);
  });

  test("lists only capabilities owned by the active Human, relay, and Desktop session", async () => {
    const { store } = makeStore();
    const first = await store.enable({ subject, expectedRevision: 0, tools });
    if (!first.ok) throw new Error("first enable failed");
    const otherAgent = { ...subject, agentId: "agent-2" };
    const second = await store.enable({ subject: otherAgent, expectedRevision: first.data.revision, tools: { ...tools, exec: false } });
    if (!second.ok) throw new Error("second enable failed");
    expect(await store.listForDesktopSession({
      instanceId: subject.instanceId,
      userId: subject.userId,
      relayId: subject.relayId,
      desktopSessionId: subject.desktopSessionId,
    })).toMatchObject({
      ok: true,
      data: {
        revision: 2,
        capabilities: [
          { subject, enabled: true },
          { subject: otherAgent, enabled: true, tools: { exec: false } },
        ],
      },
    });
    expect(await store.listForDesktopSession({
      instanceId: subject.instanceId,
      userId: subject.userId,
      relayId: "relay-other",
      desktopSessionId: subject.desktopSessionId,
    })).toMatchObject({ ok: true, data: { capabilities: [] } });
  });

  test("returns secret-free typed errors when persistence fails", async () => {
    const store = new SshCapabilityStore({
      instanceId: subject.instanceId,
      serverBindingId: SERVER_A,
      filePath: "/unused/structured-ssh-capability.json",
      clock: now,
      storage: {
        read: async () => null,
        writeAtomic: async () => { throw new Error("private /secret/path"); },
      },
    });
    expect(await store.enable({ subject, expectedRevision: 0, tools }))
      .toEqual({ ok: false, code: "store_unavailable", message: "structured SSH capability could not be persisted" });
  });

  test("serializes concurrent mutations so only one revision wins", async () => {
    const { store } = makeStore();
    const enabled = await store.enable({ subject, expectedRevision: 0, tools });
    if (!enabled.ok) throw new Error("enable failed");
    const [first, second] = await Promise.all([
      store.disable({ subject, expectedRevision: enabled.data.revision }),
      store.update({ subject, expectedRevision: enabled.data.revision, tools: { ...tools, exec: false } }),
    ]);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    expect([first, second].find((result) => !result.ok)).toMatchObject({ code: "capability_revision_mismatch" });
  });
});
