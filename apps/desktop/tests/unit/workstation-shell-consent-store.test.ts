import { describe, expect, test } from "bun:test";
import { WorkstationShellConsentStore } from "../../electron/workstation-shell-consent-store";

function memoryStorage(initial: string | null = null) {
  let bytes = initial;
  let writes = 0;
  return {
    storage: {
      read: async () => bytes,
      writeAtomic: async (next: string) => {
        bytes = next;
        writes += 1;
      },
    },
    bytes: () => bytes,
    writes: () => writes,
  };
}

const subject = {
  instanceId: "",
  userId: "user-1",
  relayId: "relay-1",
  serverOrigin: "https://nautilo.example",
  pairingFingerprint: "pairing-fingerprint-1",
};
const identity = { canonicalRoot: "/Users/alice/project", device: 7, inode: 11 };

describe("workstation shell consent store", () => {
  test("persists and rehydrates only an exact subject and filesystem identity", async () => {
    const memory = memoryStorage();
    const first = new WorkstationShellConsentStore({
      instanceId: "",
      filePath: "/unused",
      storage: memory.storage,
      clock: () => new Date("2026-07-31T12:00:00.000Z"),
    });

    expect((await first.has({ subject, identity })).data).toBe(false);
    expect((await first.grant({ subject, identity })).ok).toBe(true);
    expect((await first.has({ subject, identity })).data).toBe(true);
    expect(
      (
        await first.has({
          subject: { ...subject, instanceId: "other-instance" },
          identity,
        })
      ).data,
    ).toBe(false);
    expect(
      (
        await first.has({
          subject: { ...subject, userId: "user-2" },
          identity,
        })
      ).data,
    ).toBe(false);
    expect(
      (
        await first.has({
          subject: { ...subject, relayId: "relay-2" },
          identity,
        })
      ).data,
    ).toBe(false);
    expect(
      (
        await first.has({
          subject,
          identity: { ...identity, canonicalRoot: "/Users/alice/other" },
        })
      ).data,
    ).toBe(false);
    expect(
      (
        await first.has({
          subject,
          identity: { ...identity, device: 8 },
        })
      ).data,
    ).toBe(false);
    expect(
      (
        await first.has({
          subject: { ...subject, serverOrigin: "https://other.example" },
          identity,
        })
      ).data,
    ).toBe(false);
    expect(
      (
        await first.has({
          subject: { ...subject, pairingFingerprint: "pairing-fingerprint-2" },
          identity,
        })
      ).data,
    ).toBe(false);
    expect(
      (
        await first.has({
          subject,
          identity: { ...identity, inode: 12 },
        })
      ).data,
    ).toBe(false);

    const restarted = new WorkstationShellConsentStore({
      instanceId: "",
      filePath: "/unused",
      storage: memory.storage,
    });
    expect((await restarted.has({ subject, identity })).data).toBe(true);
  });

  test("supports platforms without stable device/inode facts without widening identity", async () => {
    const memory = memoryStorage();
    const store = new WorkstationShellConsentStore({
      instanceId: "",
      filePath: "/unused",
      storage: memory.storage,
    });
    const pathOnly = { canonicalRoot: identity.canonicalRoot };
    expect((await store.grant({ subject, identity: pathOnly })).ok).toBe(true);
    expect((await store.has({ subject, identity: pathOnly })).data).toBe(true);
    expect((await store.has({ subject, identity })).data).toBe(false);
  });

  test("re-pairing replaces the old receipt and revoke removes the folder receipt", async () => {
    const memory = memoryStorage();
    const store = new WorkstationShellConsentStore({
      instanceId: "",
      filePath: "/unused",
      storage: memory.storage,
    });
    await store.grant({ subject, identity });
    const repaired = { ...subject, relayId: "relay-2" };
    await store.grant({ subject: repaired, identity });

    expect((await store.has({ subject, identity })).data).toBe(false);
    expect((await store.has({ subject: repaired, identity })).data).toBe(true);
    await store.revoke({
      instanceId: "",
      userId: subject.userId,
      canonicalRoot: identity.canonicalRoot,
    });
    expect((await store.has({ subject: repaired, identity })).data).toBe(false);
  });

  test("corrupt or cross-instance bytes fail closed and are never overwritten", async () => {
    for (const raw of [
      "{not-json",
      JSON.stringify({
        version: 1,
        instanceId: "other",
        receipts: [],
        updatedAt: "2026-07-31T12:00:00.000Z",
      }),
    ]) {
      const memory = memoryStorage(raw);
      const store = new WorkstationShellConsentStore({
        instanceId: "",
        filePath: "/unused",
        storage: memory.storage,
      });
      expect((await store.has({ subject, identity })).ok).toBe(false);
      expect((await store.grant({ subject, identity })).ok).toBe(false);
      expect(memory.writes()).toBe(0);
      expect(memory.bytes()).toBe(raw);
    }
  });

  test("rejects malformed envelopes and receipts rather than partially trusting them", async () => {
    const validReceipt = {
      version: 1,
      ...subject,
      ...identity,
      createdAt: "2026-07-31T12:00:00.000Z",
    };
    const envelope = (receipt: unknown) =>
      JSON.stringify({
        version: 1,
        instanceId: "",
        receipts: [receipt],
        updatedAt: "2026-07-31T12:00:00.000Z",
      });
    const malformed = [
      envelope({ ...validReceipt, version: 2 }),
      envelope({ ...validReceipt, userId: "" }),
      envelope({ ...validReceipt, relayId: "" }),
      envelope({ ...validReceipt, serverOrigin: "" }),
      envelope({ ...validReceipt, pairingFingerprint: "" }),
      envelope({ ...validReceipt, canonicalRoot: "" }),
      envelope({ ...validReceipt, createdAt: "not-a-date" }),
      envelope({ ...validReceipt, inode: undefined }),
      envelope({ ...validReceipt, device: -1 }),
      envelope({ ...validReceipt, unexpected: true }),
      JSON.stringify({
        version: 1,
        instanceId: "",
        receipts: [],
        updatedAt: "not-a-date",
      }),
    ];

    for (const raw of malformed) {
      const memory = memoryStorage(raw);
      const store = new WorkstationShellConsentStore({
        instanceId: "",
        filePath: "/unused",
        storage: memory.storage,
      });
      const result = await store.has({ subject, identity });
      expect(result.ok).toBe(false);
      expect(memory.writes()).toBe(0);
    }
  });

  test("storage read and write failures remain typed and fail closed", async () => {
    const readFailure = new WorkstationShellConsentStore({
      instanceId: "",
      filePath: "/unused",
      storage: {
        read: async () => {
          throw new Error("read denied");
        },
        writeAtomic: async () => undefined,
      },
    });
    expect(await readFailure.has({ subject, identity })).toMatchObject({
      ok: false,
      code: "store_unavailable",
    });

    const writeFailure = new WorkstationShellConsentStore({
      instanceId: "",
      filePath: "/unused",
      storage: {
        read: async () => null,
        writeAtomic: async () => {
          throw new Error("write denied");
        },
      },
    });
    expect(await writeFailure.grant({ subject, identity })).toMatchObject({
      ok: false,
      code: "store_unavailable",
    });
  });
});
