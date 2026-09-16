import { describe, expect, test } from "bun:test";
import * as path from "node:path";

import {
  parseWorkstationProfile,
  WORKSTATION_PROFILE_SCHEMA_VERSION,
  type WorkstationProfile,
} from "@nautilo/workstation-profiles";

import { WorkstationProfileStore } from "../../electron/workstation-profiles/store";
import type { WorkstationProfileStorage } from "../../electron/workstation-profiles/storage";

const INSTANCE = "desktop-profile-store-test";
const OTHER_INSTANCE = "desktop-profile-store-other";
const NOW = new Date("2026-07-12T12:00:00.000Z");
const PARENT_ROOT = path.join(path.sep, "Users", "test", "workspace");

function rootRule(p: string, access: readonly string[]) {
  return { path: p, access };
}

function profileRecord(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: WORKSTATION_PROFILE_SCHEMA_VERSION,
    id,
    revision: 1,
    name: "Developer Workstation",
    roots: [rootRule(PARENT_ROOT, ["read", "create_modify", "delete", "execute"])],
    discoveryProviders: ["bun", "homebrew"],
    environmentKeys: ["BUN_INSTALL", "JAVA_HOME"],
    executableRules: [
      {
        id: "exec-bun",
        executable: path.join(path.sep, "Users", "test", ".bun", "bin", "bun"),
        argv: ["install", "run"],
        backend: "sandboxed",
      },
    ],
    network: { mode: "host", allow: [] },
    capabilities: ["background_processes", "mcp_hosts"],
    toolchainCapabilities: [
      {
        id: "cap-bun",
        kind: "toolchain",
        discoveredFrom: "fixed_argv",
        executable: path.join(path.sep, "Users", "test", ".bun", "bin", "bun"),
        roots: [rootRule(path.join(path.sep, "Users", "test", ".bun"), ["read", "create_modify"])],
        environmentKeys: ["BUN_INSTALL"],
        backend: "sandboxed",
        operations: ["run"],
      },
    ],
    protectedPolicyVersion: 1,
    createdAt: "2026-07-12T11:00:00.000Z",
    updatedAt: "2026-07-12T11:30:00.000Z",
    ...overrides,
  };
}

function validProfile(id: string, overrides: Record<string, unknown> = {}): WorkstationProfile {
  const parsed = parseWorkstationProfile(profileRecord(id, overrides), { now: NOW });
  if (!parsed.ok) {
    throw new Error(`fixture profile rejected: ${parsed.error.code}`);
  }
  return parsed.profile;
}

function createInMemoryStorage(): {
  storage: WorkstationProfileStorage;
  setBytes: (bytes: string | null) => void;
  getBytes: () => string | null;
} {
  let bytes: string | null = null;
  return {
    storage: {
      async read() {
        return bytes;
      },
      async writeAtomic(next: string) {
        bytes = next;
      },
    },
    setBytes: (next) => {
      bytes = next;
    },
    getBytes: () => bytes,
  };
}

function createStore(
  instanceId: string = INSTANCE,
  storage: WorkstationProfileStorage,
  clock: () => Date = () => new Date(NOW),
): WorkstationProfileStore {
  return new WorkstationProfileStore({
    instanceId,
    filePath: "/unused/in-memory",
    storage,
    clock,
  });
}

describe("WorkstationProfileStore — create / list / get", () => {
  test("create persists a strict profile and bumps the store envelope revision", async () => {
    const { storage, getBytes } = createInMemoryStorage();
    const store = createStore(INSTANCE, storage);

    const created = await store.create({ profile: validProfile("profile-1") });
    expect(created).toMatchObject({
      ok: true,
      data: { profile: { id: "profile-1", revision: 1 }, revision: 1 },
    });

    const listed = await store.list();
    expect(listed).toMatchObject({ ok: true, data: { revision: 1 } });
    if (listed.ok) {
      expect(listed.data.profiles.map((p) => p.id)).toEqual(["profile-1"]);
    }

    const got = await store.get({ profileId: "profile-1" });
    expect(got).toMatchObject({ ok: true, data: { profile: { id: "profile-1" } } });

    // Bytes are persisted as a strict envelope owned by this instance.
    const raw = getBytes();
    expect(raw).not.toBeNull();
    if (raw !== null) {
      const envelope = JSON.parse(raw) as Record<string, unknown>;
      expect(envelope["version"]).toBe(1);
      expect(envelope["instanceId"]).toBe(INSTANCE);
      expect(envelope["revision"]).toBe(1);
      expect(Array.isArray(envelope["profiles"])).toBe(true);
    }
  });

  test("default-instance profiles remain readable after persistence", async () => {
    const { storage } = createInMemoryStorage();
    const store = createStore("", storage);

    await store.create({ profile: validProfile("profile-default") });

    const listed = await store.list();
    expect(listed).toMatchObject({
      ok: true,
      data: { revision: 1, profiles: [{ id: "profile-default" }] },
    });
  });

  test("list on an empty store returns an empty profile list and revision 0", async () => {
    const { storage } = createInMemoryStorage();
    const store = createStore(INSTANCE, storage);
    const listed = await store.list();
    expect(listed).toMatchObject({ ok: true, data: { profiles: [], revision: 0 } });
  });

  test("get of an unknown profile id returns profile_not_found", async () => {
    const { storage } = createInMemoryStorage();
    const store = createStore(INSTANCE, storage);
    const got = await store.get({ profileId: "ghost" });
    expect(got).toMatchObject({ ok: false, code: "profile_not_found" });
  });

  test("create rejects a duplicate profile id", async () => {
    const { storage } = createInMemoryStorage();
    const store = createStore(INSTANCE, storage);
    await store.create({ profile: validProfile("profile-1") });
    const second = await store.create({ profile: validProfile("profile-1") });
    expect(second).toMatchObject({ ok: false, code: "invalid_profile" });
  });

  test("create rejects an invalid profile payload fail-closed", async () => {
    const { storage, getBytes } = createInMemoryStorage();
    const store = createStore(INSTANCE, storage);
    const bad = { ...profileRecord("profile-bad"), revision: 0 };
    const created = await store.create({ profile: bad as unknown as WorkstationProfile });
    expect(created).toMatchObject({ ok: false, code: "invalid_profile" });
    // Nothing persisted.
    expect(getBytes()).toBeNull();
  });
});

describe("WorkstationProfileStore — update with optimistic concurrency", () => {
  test("update with the correct expectedRevision increments the profile revision by exactly one", async () => {
    const { storage } = createInMemoryStorage();
    const store = createStore(INSTANCE, storage);

    await store.create({ profile: validProfile("profile-1") });
    const next = validProfile("profile-1", {
      revision: 2,
      name: "Developer Workstation v2",
      updatedAt: "2026-07-12T12:30:00.000Z",
    });
    const updated = await store.update({
      profileId: "profile-1",
      expectedRevision: 1,
      profile: next,
    });
    expect(updated).toMatchObject({
      ok: true,
      data: { profile: { id: "profile-1", revision: 2, name: "Developer Workstation v2" } },
    });

    const got = await store.get({ profileId: "profile-1" });
    expect(got).toMatchObject({ ok: true, data: { profile: { revision: 2 } } });
  });

  test("update bumps the store envelope revision separately from the profile revision", async () => {
    const { storage } = createInMemoryStorage();
    const store = createStore(INSTANCE, storage);

    await store.create({ profile: validProfile("profile-1") });
    const afterCreate = await store.list();
    expect(afterCreate.ok && afterCreate.data.revision).toBe(1);

    await store.update({
      profileId: "profile-1",
      expectedRevision: 1,
      profile: validProfile("profile-1", { revision: 2, updatedAt: "2026-07-12T12:30:00.000Z" }),
    });
    const afterUpdate = await store.list();
    // Envelope revision bumped to 2 while the profile revision is 2 — same
    // value here but tracked in independent dimensions.
    expect(afterUpdate.ok && afterUpdate.data.revision).toBe(2);
    expect(afterUpdate.ok && afterUpdate.data.profiles[0]?.revision).toBe(2);
  });

  test("update with a stale expectedRevision returns a stable conflict code and does not mutate", async () => {
    const { storage } = createInMemoryStorage();
    const store = createStore(INSTANCE, storage);
    await store.create({ profile: validProfile("profile-1") });
    await store.update({
      profileId: "profile-1",
      expectedRevision: 1,
      profile: validProfile("profile-1", { revision: 2, updatedAt: "2026-07-12T12:30:00.000Z" }),
    });

    const stale = await store.update({
      profileId: "profile-1",
      expectedRevision: 1,
      profile: validProfile("profile-1", { revision: 2, updatedAt: "2026-07-12T12:45:00.000Z" }),
    });
    expect(stale).toMatchObject({ ok: false, code: "profile_revision_conflict" });

    const got = await store.get({ profileId: "profile-1" });
    expect(got).toMatchObject({ ok: true, data: { profile: { revision: 2 } } });
  });

  test("update rejects a payload whose revision does not increment by exactly one", async () => {
    const { storage } = createInMemoryStorage();
    const store = createStore(INSTANCE, storage);
    await store.create({ profile: validProfile("profile-1") });

    const skip = await store.update({
      profileId: "profile-1",
      expectedRevision: 1,
      profile: validProfile("profile-1", { revision: 3, updatedAt: "2026-07-12T12:30:00.000Z" }),
    });
    expect(skip).toMatchObject({ ok: false, code: "invalid_profile" });
  });

  test("update rejects a payload whose id does not match the target", async () => {
    const { storage } = createInMemoryStorage();
    const store = createStore(INSTANCE, storage);
    await store.create({ profile: validProfile("profile-1") });

    const mismatched = await store.update({
      profileId: "profile-1",
      expectedRevision: 1,
      profile: validProfile("profile-other", { revision: 2, updatedAt: "2026-07-12T12:30:00.000Z" }),
    });
    expect(mismatched).toMatchObject({ ok: false, code: "profile_id_mismatch" });
  });

  test("update of an unknown profile id returns profile_not_found", async () => {
    const { storage } = createInMemoryStorage();
    const store = createStore(INSTANCE, storage);
    const res = await store.update({
      profileId: "ghost",
      expectedRevision: 1,
      profile: validProfile("ghost", { revision: 2, updatedAt: "2026-07-12T12:30:00.000Z" }),
    });
    expect(res).toMatchObject({ ok: false, code: "profile_not_found" });
  });
});

describe("WorkstationProfileStore — instance ownership + fail-closed", () => {
  test("never overwrites a profile store belonging to another instance", async () => {
    const { storage, setBytes, getBytes } = createInMemoryStorage();
    // Seed bytes owned by another instance.
    setBytes(
      JSON.stringify({
        version: 1,
        instanceId: OTHER_INSTANCE,
        revision: 0,
        profiles: [profileRecord("foreign")],
        updatedAt: "2026-07-12T12:00:00.000Z",
      }) + "\n",
    );
    const store = createStore(INSTANCE, storage);

    const listed = await store.list();
    expect(listed).toMatchObject({ ok: false, code: "store_instance_mismatch" });

    const created = await store.create({ profile: validProfile("profile-1") });
    expect(created).toMatchObject({ ok: false, code: "store_instance_mismatch" });

    // The foreign bytes are untouched — never overwritten.
    const raw = getBytes();
    expect(raw).not.toBeNull();
    if (raw !== null) {
      const envelope = JSON.parse(raw) as Record<string, unknown>;
      expect(envelope["instanceId"]).toBe(OTHER_INSTANCE);
    }
  });

  test("corrupt JSON fails closed with store_corrupt and is not overwritten", async () => {
    const { storage, setBytes, getBytes } = createInMemoryStorage();
    setBytes("{ not json");
    const store = createStore(INSTANCE, storage);
    const listed = await store.list();
    expect(listed).toMatchObject({ ok: false, code: "store_corrupt" });
    expect(getBytes()).toBe("{ not json");
  });

  test("a future envelope version fails closed with store_corrupt", async () => {
    const { storage, setBytes } = createInMemoryStorage();
    setBytes(
      JSON.stringify({
        version: 99,
        instanceId: INSTANCE,
        revision: 0,
        profiles: [],
        updatedAt: "2026-07-12T12:00:00.000Z",
      }) + "\n",
    );
    const store = createStore(INSTANCE, storage);
    const listed = await store.list();
    expect(listed).toMatchObject({ ok: false, code: "store_corrupt" });
  });

  test("a profile that drifted from the strict schema fails closed with store_corrupt", async () => {
    const { storage, setBytes } = createInMemoryStorage();
    setBytes(
      JSON.stringify({
        version: 1,
        instanceId: INSTANCE,
        revision: 0,
        profiles: [profileRecord("profile-drift", { revision: 0 })],
        updatedAt: "2026-07-12T12:00:00.000Z",
      }) + "\n",
    );
    const store = createStore(INSTANCE, storage);
    const listed = await store.list();
    expect(listed).toMatchObject({ ok: false, code: "store_corrupt" });
  });
});

describe("WorkstationProfileStore — revision monotonicity", () => {
  test("store envelope revision is monotonic across create and update", async () => {
    const { storage } = createInMemoryStorage();
    const store = createStore(INSTANCE, storage);

    const r0 = await store.list();
    await store.create({ profile: validProfile("profile-a") });
    const r1 = await store.list();
    await store.create({ profile: validProfile("profile-b") });
    const r2 = await store.list();
    await store.update({
      profileId: "profile-a",
      expectedRevision: 1,
      profile: validProfile("profile-a", { revision: 2, updatedAt: "2026-07-12T12:30:00.000Z" }),
    });
    const r3 = await store.list();

    expect(r0.ok && r0.data.revision).toBe(0);
    expect(r1.ok && r1.data.revision).toBeGreaterThan(r0.ok ? r0.data.revision : -1);
    expect(r2.ok && r2.data.revision).toBeGreaterThan(r1.ok ? r1.data.revision : -1);
    expect(r3.ok && r3.data.revision).toBeGreaterThan(r2.ok ? r2.data.revision : -1);
  });
});
