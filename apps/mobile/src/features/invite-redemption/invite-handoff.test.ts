/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { inviteCallbackRecovery } from "./invite-callback-recovery";

import {
  INVITE_HANDOFF_VERSION,
  MAX_INVITE_HANDOFF_TTL_MS,
  InviteHandoffError,
  clearInviteCallbackLocator,
  clearInviteHandoff,
  createInviteHandoffRecord,
  inviteHandoffKey,
  loadInviteCallbackLocator,
  loadInviteHandoff,
  peekInviteHandoffStage,
  parseInviteHandoff,
  saveInviteCallbackLocator,
  saveInviteHandoff,
  serializeInviteHandoff,
  settleInviteHandoff,
  type InviteHandoffInput,
  type InviteHandoffStorage,
} from "./invite-handoff";

const now = 1_000_000;
const server = { serverId: "srv_invites_example", serverUrl: "https://invites.example.test" };

function input(overrides: Partial<InviteHandoffInput> = {}): InviteHandoffInput {
  return {
    ...server,
    inviteToken: "inv_abc-123_DEF",
    prepareState: "opaque-prepare-state",
    handle: "marina_7",
    stage: "external-auth",
    startedAt: now,
    inviteExpiresAt: null,
    ...overrides,
  };
}

class MemorySecureStore implements InviteHandoffStorage {
  readonly values = new Map<string, string>();
  setCalls = 0;
  getCalls = 0;
  deleteCalls = 0;

  async setItemAsync(key: string, value: string): Promise<void> {
    this.setCalls += 1;
    this.values.set(key, value);
  }

  async getItemAsync(key: string): Promise<string | null> {
    this.getCalls += 1;
    return this.values.get(key) ?? null;
  }

  async deleteItemAsync(key: string): Promise<void> {
    this.deleteCalls += 1;
    this.values.delete(key);
  }
}

describe("invite handoff custody", () => {
  test("caps TTL at 30 minutes and honors an earlier invite expiry", () => {
    expect(createInviteHandoffRecord(input(), now).expiresAt).toBe(now + MAX_INVITE_HANDOFF_TTL_MS);
    expect(createInviteHandoffRecord(input({ inviteExpiresAt: now + 60_000 }), now).expiresAt).toBe(now + 60_000);
    expect(() => createInviteHandoffRecord(input({ inviteExpiresAt: now }), now)).toThrow(InviteHandoffError);
  });

  test("writes then reads back and validates the exact per-server record", async () => {
    const storage = new MemorySecureStore();
    const saved = await saveInviteHandoff(input(), { storage, now });
    expect(storage.setCalls).toBe(1);
    expect(storage.getCalls).toBe(1);
    expect(await loadInviteHandoff(server, { storage, now })).toEqual(saved);
  });

  test("callback stage peek returns only the safe phase, never custody fields", async () => {
    const storage = new MemorySecureStore();
    await saveInviteHandoff(input({ stage: "profile", prepareState: null }), { storage, now });
    const observed = await peekInviteHandoffStage(server, { storage, now });
    expect(observed).toBe("profile");
    expect(JSON.stringify(observed)).not.toContain("inv_abc");
    expect(JSON.stringify(observed)).not.toContain("opaque-prepare-state");
  });

  test("cold callback correlation resumes only a bounded token-free exact route and clears after settlement", async () => {
    const storage = new MemorySecureStore();
    const locator = {
      serverId: server.serverId,
      serverUrl: server.serverUrl,
      generation: "7",
      ceremonyId: "ceremony-7",
    };
    await saveInviteCallbackLocator(locator, storage);
    expect(await loadInviteCallbackLocator(storage)).toEqual(locator);
    const serialized = storage.values.get("nautilo.invite-callback-locator.v1") ?? "";
    expect(serialized).not.toContain("inv_abc");
    expect(serialized).not.toContain("opaque-prepare-state");
    await clearInviteCallbackLocator(locator, storage);
    expect(await loadInviteCallbackLocator(storage)).toBeNull();
  });

  test("a cold callback cross-checks its exact locator against the keyed handoff before restore", async () => {
    const storage = new MemorySecureStore();
    const locator = { serverId: server.serverId, serverUrl: server.serverUrl, generation: "7", ceremonyId: "ceremony-7" };
    await saveInviteHandoff(input({ stage: "profile", prepareState: null }), { storage, now });
    await saveInviteCallbackLocator(locator, storage);
    const coldLocator = await loadInviteCallbackLocator(storage);
    const stage = coldLocator ? await peekInviteHandoffStage({ serverId: coldLocator.serverId, serverUrl: coldLocator.serverUrl }, { storage, now }) : null;
    if (!coldLocator) throw new Error("expected persisted callback locator");
    const coldRoute = { pathname: "/(onboarding)/invite" as const, params: coldLocator };
    expect(inviteCallbackRecovery(coldRoute, stage)).toEqual({ kind: "restore", route: coldRoute });
    await clearInviteHandoff(server.serverId, storage);
    expect(await peekInviteHandoffStage(server, { storage, now })).toBeNull();
  });

  test("cold callback correlation rejects malformed bytes and cannot clear a newer ceremony", async () => {
    const storage = new MemorySecureStore();
    const oldLocator = { serverId: server.serverId, serverUrl: server.serverUrl, generation: "7", ceremonyId: "ceremony-7" };
    const newLocator = { ...oldLocator, generation: "8", ceremonyId: "ceremony-8" };
    await saveInviteCallbackLocator(newLocator, storage);
    await clearInviteCallbackLocator(oldLocator, storage);
    expect(await loadInviteCallbackLocator(storage)).toEqual(newLocator);
    storage.values.set("nautilo.invite-callback-locator.v1", JSON.stringify({ ...newLocator, inviteToken: "inv_abc-123_DEF" }));
    expect(await loadInviteCallbackLocator(storage)).toBeNull();
    expect(storage.values.has("nautilo.invite-callback-locator.v1")).toBe(false);
  });

  test("rejects and erases corrupt, versioned, stage, and cross-server records", async () => {
    const key = inviteHandoffKey(server.serverId)!;
    const badPayloads = [
      "not json",
      JSON.stringify({ version: INVITE_HANDOFF_VERSION + 1 }),
      JSON.stringify({
        ...createInviteHandoffRecord(input(), now),
        stage: "unknown-stage",
      }),
      JSON.stringify({
        ...createInviteHandoffRecord(input(), now),
        inviteToken: { toString: () => "inv_abc-123_DEF" },
      }),
      JSON.stringify({
        ...createInviteHandoffRecord(input(), now),
        serverUrl: "https://other.example.test",
      }),
    ];
    for (const raw of badPayloads) {
      const storage = new MemorySecureStore();
      storage.values.set(key, raw);
      expect(await loadInviteHandoff(server, { storage, now })).toBeNull();
      expect(storage.values.has(key)).toBe(false);
    }
  });

  test("rejects expired bytes, unsafe key identities, and non-normalized server URLs", async () => {
    const storage = new MemorySecureStore();
    const key = inviteHandoffKey(server.serverId)!;
    storage.values.set(key, serializeInviteHandoff(createInviteHandoffRecord(input(), now)));
    expect(await loadInviteHandoff(server, { storage, now: now + MAX_INVITE_HANDOFF_TTL_MS })).toBeNull();
    expect(storage.values.has(key)).toBe(false);
    expect(inviteHandoffKey("srv/unsafe")).toBeNull();
    expect(() => createInviteHandoffRecord(input({ serverUrl: "https://invites.example.test/" }), now)).toThrow(InviteHandoffError);
  });

  test("does not serialize credentials, profile values, recovery material, or arbitrary input", () => {
    const record = createInviteHandoffRecord(input(), now);
    const serialized = serializeInviteHandoff({
      ...record,
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      pin: "123456",
      displayName: "Marina",
      recoveryCodes: ["recovery-secret"],
      navigation: { next: "/rooms/1" },
    } as typeof record);
    expect(serialized).not.toContain("access-secret");
    expect(serialized).not.toContain("refresh-secret");
    expect(serialized).not.toContain("123456");
    expect(serialized).not.toContain("Marina");
    expect(serialized).not.toContain("recovery-secret");
    expect(serialized).not.toContain("navigation");
    expect(Object.keys(JSON.parse(serialized) as object).sort()).toEqual([
      "expiresAt", "handle", "inviteToken", "prepareState", "serverId", "serverUrl", "stage", "startedAt", "version",
    ]);
  });

  test("fails closed and erases when SecureStore acknowledges a write but cannot read back the same record", async () => {
    const storage = new MemorySecureStore();
    storage.getItemAsync = async () => "{\"version\":999}";
    let failure: unknown;
    try {
      await saveInviteHandoff(input(), { storage, now });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(InviteHandoffError);
    expect((failure as Error).message).toContain("verification");
    expect(storage.values.has(inviteHandoffKey(server.serverId)!)).toBe(false);
    expect(storage.deleteCalls).toBe(1);
  });

  test("clears every terminal outcome and retains the minimal record only for retryable network failure", async () => {
    const terminalReasons = ["success", "terminal-failure", "server-mismatch", "expiry", "cancelled"] as const;
    for (const reason of terminalReasons) {
      const storage = new MemorySecureStore();
      await saveInviteHandoff(input(), { storage, now });
      expect(await settleInviteHandoff(server.serverId, reason, storage)).toBe("cleared");
      expect(storage.values.size).toBe(0);
    }
    const storage = new MemorySecureStore();
    await saveInviteHandoff(input(), { storage, now });
    expect(await settleInviteHandoff(server.serverId, "retryable-network", storage)).toBe("retained");
    expect(storage.values.size).toBe(1);
  });

  test("keeps stage-specific custody minimal and parser rejects extra fields", () => {
    expect(createInviteHandoffRecord(input({ stage: "profile", prepareState: null }), now).prepareState).toBeNull();
    expect(() => createInviteHandoffRecord(input({ stage: "profile" }), now)).toThrow(InviteHandoffError);
    const raw = serializeInviteHandoff(createInviteHandoffRecord(input(), now));
    expect(parseInviteHandoff(raw, server, now)).not.toBeNull();
    expect(parseInviteHandoff(raw.slice(0, -1) + ',"accessToken":"nope"}', server, now)).toBeNull();
  });
});
