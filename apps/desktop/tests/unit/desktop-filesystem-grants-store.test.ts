import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { DesktopFilesystemGrant } from "@nautilo/desktop-filesystem-grants";
import { DesktopFilesystemGrantStore } from "../../electron/desktop-filesystem-grants/store";

const INSTANCE = "desktop-test";
const USER_A = "user-a";
const USER_B = "user-b";
const INITIAL_TIME = new Date("2026-07-12T12:00:00.000Z");

function grant(id: string, userId = USER_A, overrides: Partial<DesktopFilesystemGrant> = {}): DesktopFilesystemGrant {
  return {
    schemaVersion: 1,
    id,
    canonicalRoot: "/Users/test/workspace",
    access: ["read"],
    origin: "user_picker",
    lifetime: "durable",
    subject: {
      userId,
      instanceId: INSTANCE,
      relayId: "relay-desktop",
      agentScope: "agent-a",
    },
    createdBy: "operator",
    createdAt: "2026-07-12T11:00:00.000Z",
    policyVersion: 1,
    ...overrides,
  };
}

async function withStore(
  run: (context: {
    filePath: string;
    store: DesktopFilesystemGrantStore;
    setTime: (next: Date) => void;
  }) => Promise<void>,
): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-filesystem-grants-"));
  const filePath = path.join(directory, "grants.json");
  let now = new Date(INITIAL_TIME);
  const store = new DesktopFilesystemGrantStore({
    instanceId: INSTANCE,
    filePath,
    clock: () => new Date(now),
  });
  try {
    await run({ filePath, store, setTime: (next) => (now = new Date(next)) });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

describe("DesktopFilesystemGrantStore", () => {
  test("creates an empty store and persists a strict envelope", async () => {
    await withStore(async ({ filePath, store }) => {
      const created = await store.create({ userId: USER_A, grant: grant("grant-1") });
      expect(created).toMatchObject({ ok: true, data: { revision: 1 } });

      const envelope = JSON.parse(await fs.readFile(filePath, "utf8"));
      expect(envelope).toEqual({
        version: 1,
        instanceId: INSTANCE,
        revision: 1,
        grants: [grant("grant-1")],
        updatedAt: INITIAL_TIME.toISOString(),
      });
    });
  });

  test("migrates existing grants from the historical filename once, then restarts from the renamed store", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-filesystem-grants-migration-"));
    const filePath = path.join(directory, "desktop-filesystem-grants.json");
    const legacyFilePath = path.join(directory, "workstation-grants.json");
    const legacyEnvelope = {
      version: 1,
      instanceId: INSTANCE,
      revision: 4,
      grants: [grant("survives-rename")],
      updatedAt: INITIAL_TIME.toISOString(),
    };
    await fs.writeFile(legacyFilePath, `${JSON.stringify(legacyEnvelope)}\n`);
    try {
      const migrated = new DesktopFilesystemGrantStore({
        instanceId: INSTANCE,
        filePath,
        legacyFilePath,
        clock: () => new Date(INITIAL_TIME),
      });
      expect(await migrated.list({ userId: USER_A })).toMatchObject({
        ok: true,
        data: { revision: 4, grants: [{ grant: { id: "survives-rename" } }] },
      });
      expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual(legacyEnvelope);
      await expect(fs.readFile(legacyFilePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const restarted = new DesktopFilesystemGrantStore({
        instanceId: INSTANCE,
        filePath,
        legacyFilePath,
        clock: () => new Date(INITIAL_TIME),
      });
      expect(await restarted.list({ userId: USER_A })).toMatchObject({
        ok: true,
        data: { revision: 4, grants: [{ grant: { id: "survives-rename" } }] },
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test("prefers the renamed store and never imports a legacy filename when both exist", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-filesystem-grants-new-wins-"));
    const filePath = path.join(directory, "desktop-filesystem-grants.json");
    const legacyFilePath = path.join(directory, "workstation-grants.json");
    const currentEnvelope = {
      version: 1,
      instanceId: INSTANCE,
      revision: 1,
      grants: [grant("new-name")],
      updatedAt: INITIAL_TIME.toISOString(),
    };
    const legacyEnvelope = { ...currentEnvelope, revision: 9, grants: [grant("old-name")] };
    await Promise.all([
      fs.writeFile(filePath, `${JSON.stringify(currentEnvelope)}\n`),
      fs.writeFile(legacyFilePath, `${JSON.stringify(legacyEnvelope)}\n`),
    ]);
    try {
      const store = new DesktopFilesystemGrantStore({
        instanceId: INSTANCE,
        filePath,
        legacyFilePath,
        clock: () => new Date(INITIAL_TIME),
      });
      expect(await store.list({ userId: USER_A })).toMatchObject({
        ok: true,
        data: { revision: 1, grants: [{ grant: { id: "new-name" } }] },
      });
      expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual(currentEnvelope);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects corrupt legacy bytes without creating a renamed store", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-filesystem-grants-corrupt-"));
    const filePath = path.join(directory, "desktop-filesystem-grants.json");
    const legacyFilePath = path.join(directory, "workstation-grants.json");
    await fs.writeFile(legacyFilePath, "{not json");
    try {
      const store = new DesktopFilesystemGrantStore({
        instanceId: INSTANCE,
        filePath,
        legacyFilePath,
        clock: () => new Date(INITIAL_TIME),
      });
      expect(await store.list({ userId: USER_A })).toMatchObject({ ok: false, code: "store_corrupt" });
      await expect(fs.readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test("fails closed when atomically writing the renamed store during migration fails", async () => {
    const legacyEnvelope = {
      version: 1,
      instanceId: INSTANCE,
      revision: 2,
      grants: [grant("write-failure")],
      updatedAt: INITIAL_TIME.toISOString(),
    };
    let writeAttempts = 0;
    const store = new DesktopFilesystemGrantStore({
      instanceId: INSTANCE,
      filePath: "/unused/desktop-filesystem-grants.json",
      clock: () => new Date(INITIAL_TIME),
      storage: {
        read: async () => null,
        readLegacy: async () => JSON.stringify(legacyEnvelope),
        writeAtomic: async () => {
          writeAttempts += 1;
          throw new Error("disk full");
        },
      },
    });
    expect(await store.list({ userId: USER_A })).toMatchObject({ ok: false, code: "store_unavailable" });
    expect(writeAttempts).toBe(1);
  });

  test("keeps migrated grants available and idempotent when legacy cleanup fails", async () => {
    const legacyEnvelope = {
      version: 1,
      instanceId: INSTANCE,
      revision: 2,
      grants: [grant("cleanup-failure")],
      updatedAt: INITIAL_TIME.toISOString(),
    };
    let persisted: string | null = null;
    const store = new DesktopFilesystemGrantStore({
      instanceId: INSTANCE,
      filePath: "/unused/desktop-filesystem-grants.json",
      clock: () => new Date(INITIAL_TIME),
      storage: {
        read: async () => persisted,
        readLegacy: async () => JSON.stringify(legacyEnvelope),
        writeAtomic: async (bytes) => { persisted = bytes; },
        removeLegacy: async () => { throw new Error("permission denied"); },
      },
    });
    expect(await store.list({ userId: USER_A })).toMatchObject({
      ok: true,
      data: { revision: 2, grants: [{ grant: { id: "cleanup-failure" } }] },
    });
    expect(JSON.parse(persisted!)).toEqual(legacyEnvelope);
    expect(await store.list({ userId: USER_A })).toMatchObject({
      ok: true,
      data: { revision: 2, grants: [{ grant: { id: "cleanup-failure" } }] },
    });
  });

  test("isolates users and excludes revoked history from active grants", async () => {
    await withStore(async ({ store }) => {
      await store.create({ userId: USER_A, grant: grant("a") });
      await store.create({ userId: USER_B, grant: grant("b", USER_B) });

      const userA = await store.list({ userId: USER_A });
      expect(userA.ok && userA.data.grants.map(({ grant: item }) => item.id)).toEqual(["a"]);
      const userB = await store.list({ userId: USER_B });
      expect(userB.ok && userB.data.grants.map(({ grant: item }) => item.id)).toEqual(["b"]);

      const revoked = await store.revoke({ userId: USER_A, grantId: "a" });
      expect(revoked).toMatchObject({ ok: true, data: { revision: 3 } });
      expect(await store.list({ userId: USER_A })).toMatchObject({
        ok: true,
        data: { grants: [] },
      });
      expect(await store.list({ userId: USER_A, includeHistory: true })).toMatchObject({
        ok: true,
        data: { grants: [{ grant: { id: "a" }, status: "revoked" }] },
      });
    });
  });

  test("touches active grants but refuses revoked or expired authority", async () => {
    await withStore(async ({ store, setTime }) => {
      await store.create({ userId: USER_A, grant: grant("active") });
      expect(await store.touchLastUsed({ userId: USER_A, grantId: "active" })).toMatchObject({
        ok: true,
        data: { revision: 2, grant: { lastUsedAt: INITIAL_TIME.toISOString() } },
      });
      expect(await store.list({ userId: USER_A })).toMatchObject({
        ok: true,
        data: {
          grants: [{ grant: { id: "active", lastUsedAt: INITIAL_TIME.toISOString() }, status: "active" }],
        },
      });

      await store.revoke({ userId: USER_A, grantId: "active" });
      expect(await store.touchLastUsed({ userId: USER_A, grantId: "active" })).toMatchObject({
        ok: false,
        code: "grant_not_found",
      });

      await store.create({
        userId: USER_A,
        grant: grant("expired", USER_A, { expiresAt: "2026-07-12T12:00:01.000Z" }),
      });
      setTime(new Date("2026-07-12T12:00:02.000Z"));
      expect(await store.touchLastUsed({ userId: USER_A, grantId: "expired" })).toMatchObject({
        ok: false,
        code: "grant_not_found",
      });
    });
  });

  test("refuses corrupt and future-version bytes without rewriting them", async () => {
    await withStore(async ({ filePath, store }) => {
      const corrupt = "{ definitely not JSON";
      await fs.writeFile(filePath, corrupt);
      expect(await store.create({ userId: USER_A, grant: grant("new") })).toMatchObject({
        ok: false,
        code: "store_corrupt",
      });
      expect(await fs.readFile(filePath, "utf8")).toBe(corrupt);

      const future = JSON.stringify({
        version: 2,
        instanceId: INSTANCE,
        revision: 0,
        grants: [],
        updatedAt: INITIAL_TIME.toISOString(),
      });
      await fs.writeFile(filePath, future);
      expect(await store.list({ userId: USER_A })).toMatchObject({
        ok: false,
        code: "store_corrupt",
      });
      expect(await fs.readFile(filePath, "utf8")).toBe(future);
    });
  });

  test("rejects an envelope or grant bound to another instance", async () => {
    await withStore(async ({ filePath, store }) => {
      const mismatched = JSON.stringify({
        version: 1,
        instanceId: "other-instance",
        revision: 0,
        grants: [],
        updatedAt: INITIAL_TIME.toISOString(),
      });
      await fs.writeFile(filePath, mismatched);
      expect(await store.list({ userId: USER_A })).toMatchObject({
        ok: false,
        code: "store_instance_mismatch",
      });

      await fs.writeFile(
        filePath,
        JSON.stringify({
          version: 1,
          instanceId: INSTANCE,
          revision: 0,
          grants: [grant("foreign", USER_A, { subject: { ...grant("x").subject, instanceId: "other" } })],
          updatedAt: INITIAL_TIME.toISOString(),
        }),
      );
      expect(await store.list({ userId: USER_A })).toMatchObject({
        ok: false,
        code: "store_corrupt",
      });
    });
  });

  test("default-instance (\"\") grants persist and remain readable", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-filesystem-grants-default-"));
    const filePath = path.join(directory, "grants.json");
    let now = new Date(INITIAL_TIME);
    const store = new DesktopFilesystemGrantStore({
      instanceId: "",
      filePath,
      clock: () => new Date(now),
    });
    try {
      const defaultGrant = grant("default-grant", USER_A, {
        subject: { userId: USER_A, instanceId: "", relayId: "relay-desktop", agentScope: "agent-a" },
      });
      const created = await store.create({ userId: USER_A, grant: defaultGrant });
      expect(created).toMatchObject({ ok: true, data: { revision: 1 } });

      const envelope = JSON.parse(await fs.readFile(filePath, "utf8"));
      expect(envelope).toEqual({
        version: 1,
        instanceId: "",
        revision: 1,
        grants: [defaultGrant],
        updatedAt: INITIAL_TIME.toISOString(),
      });

      const listed = await store.list({ userId: USER_A });
      expect(listed).toMatchObject({
        ok: true,
        data: { revision: 1, grants: [{ grant: { id: "default-grant" }, status: "active" }] },
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects parser-invalid grants before creating the store", async () => {
    await withStore(async ({ filePath, store }) => {
      const invalid = grant("bad", USER_A, { canonicalRoot: "relative" });
      expect(await store.create({ userId: USER_A, grant: invalid })).toMatchObject({
        ok: false,
        code: "invalid_grant",
      });
      await expect(fs.readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  test("serializes concurrent writes and advances revisions", async () => {
    await withStore(async ({ filePath, store }) => {
      const [first, second] = await Promise.all([
        store.create({ userId: USER_A, grant: grant("one") }),
        store.create({ userId: USER_A, grant: grant("two") }),
      ]);
      expect(first).toMatchObject({ ok: true, data: { revision: 1 } });
      expect(second).toMatchObject({ ok: true, data: { revision: 2 } });
      const envelope = JSON.parse(await fs.readFile(filePath, "utf8"));
      expect(envelope.grants.map((item: DesktopFilesystemGrant) => item.id)).toEqual(["one", "two"]);
      expect(envelope.revision).toBe(2);
    });
  });

  test("creates restrictive parent and file modes", async () => {
    await withStore(async ({ filePath, store }) => {
      await store.create({ userId: USER_A, grant: grant("permissions") });
      expect((await fs.stat(path.dirname(filePath))).mode & 0o777).toBe(0o700);
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
      expect((await fs.readdir(path.dirname(filePath))).some((name) => name.includes(".tmp"))).toBe(false);
    });
  });
});
