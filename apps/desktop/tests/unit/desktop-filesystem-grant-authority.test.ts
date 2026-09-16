import { describe, expect, test } from "bun:test";

import type { DesktopFilesystemGrant } from "@nautilo/desktop-filesystem-grants";
import { DesktopFilesystemGrantStore } from "../../electron/desktop-filesystem-grants/store";
import type { DesktopFilesystemGrantStorage } from "../../electron/desktop-filesystem-grants/storage";
import {
  DesktopFilesystemGrantAuthority,
  isEphemeralDesktopFilesystemGrant,
} from "../../electron/desktop-filesystem-grants/authority";

const INSTANCE = "desktop-authority-test";
const RELAY = "relay-desktop";
const AGENT_SCOPE = "all_owned_agents";
const USER_A = "user-a";
const USER_B = "user-b";
const INITIAL_TIME = new Date("2026-07-12T12:00:00.000Z");

function grant(
  id: string,
  overrides: Partial<DesktopFilesystemGrant> & { userId?: string } = {},
): DesktopFilesystemGrant {
  const { userId = USER_A, ...rest } = overrides;
  return {
    schemaVersion: 1,
    id,
    canonicalRoot: "/Users/test/workspace",
    access: ["read"],
    origin: "user_picker",
    lifetime: "durable",
    subject: { userId, instanceId: INSTANCE, relayId: RELAY, agentScope: AGENT_SCOPE },
    createdBy: userId,
    createdAt: "2026-07-12T11:00:00.000Z",
    policyVersion: 1,
    ...rest,
  };
}

function createInMemoryStorage(): {
  storage: DesktopFilesystemGrantStorage;
  setBytes: (bytes: string | null) => void;
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
  };
}

function withAuthority(
  run: (context: {
    authority: DesktopFilesystemGrantAuthority;
    durable: DesktopFilesystemGrantStore;
    setBytes: (bytes: string | null) => void;
    setTime: (next: Date) => void;
  }) => Promise<void>,
): Promise<void> {
  let now = new Date(INITIAL_TIME);
  const { storage, setBytes } = createInMemoryStorage();
  const durable = new DesktopFilesystemGrantStore({
    instanceId: INSTANCE,
    filePath: "/unused/in-memory",
    storage,
    clock: () => new Date(now),
  });
  const authority = new DesktopFilesystemGrantAuthority({
    instanceId: INSTANCE,
    store: durable,
    clock: () => new Date(now),
  });
  return run({ authority, durable, setBytes, setTime: (next) => (now = new Date(next)) });
}

describe("DesktopFilesystemGrantAuthority — routing", () => {
  test("durable grants persist via the durable store; once/session grants stay in-memory only", async () => {
    await withAuthority(async ({ authority, durable, storage }) => {
      const durableCreated = await authority.create({ userId: USER_A, grant: grant("durable-1") });
      expect(durableCreated).toMatchObject({ ok: true, data: { grant: { id: "durable-1" } } });

      const onceCreated = await authority.create({
        userId: USER_A,
        grant: grant("once-1", { lifetime: "once" }),
      });
      expect(onceCreated).toMatchObject({ ok: true, data: { grant: { id: "once-1" } } });

      const sessionCreated = await authority.create({
        userId: USER_A,
        grant: grant("session-1", { lifetime: "session" }),
      });
      expect(sessionCreated).toMatchObject({ ok: true });

      // The durable store persists ONLY the durable grant.
      const durableOnly = await durable.list({ userId: USER_A, includeHistory: true });
      expect(durableOnly.ok && durableOnly.data.grants.map((g) => g.grant.id)).toEqual(["durable-1"]);

      // The authority's merged list sees all three.
      const merged = await authority.list({ userId: USER_A, includeHistory: true });
      expect(merged.ok && merged.data.grants.map((g) => g.grant.id).sort()).toEqual(
        ["durable-1", "once-1", "session-1"].sort(),
      );
    });
  });

  test("policy_pack origin grants are ephemeral regardless of lifetime", async () => {
    await withAuthority(async ({ authority, durable }) => {
      const added = await authority.addEphemeral({
        grant: grant("pack-1", { origin: "policy_pack", lifetime: "durable" }),
      });
      expect(added).toMatchObject({ ok: true });

      const durableOnly = await durable.list({ userId: USER_A, includeHistory: true });
      expect(durableOnly.ok && durableOnly.data.grants).toEqual([]);

      const merged = await authority.list({ userId: USER_A, includeHistory: true });
      expect(merged.ok && merged.data.grants.map((g) => g.grant.id)).toEqual(["pack-1"]);
    });
  });

  test("isEphemeralDesktopFilesystemGrant classifies by lifetime and origin", () => {
    expect(isEphemeralDesktopFilesystemGrant(grant("x", { lifetime: "once" }))).toBe(true);
    expect(isEphemeralDesktopFilesystemGrant(grant("x", { lifetime: "session" }))).toBe(true);
    expect(isEphemeralDesktopFilesystemGrant(grant("x", { origin: "policy_pack" }))).toBe(true);
    expect(isEphemeralDesktopFilesystemGrant(grant("x", { lifetime: "durable" }))).toBe(false);
    expect(isEphemeralDesktopFilesystemGrant(grant("x", { origin: "approval", lifetime: "durable" }))).toBe(false);
  });
});

describe("DesktopFilesystemGrantAuthority — merged list + fail-closed", () => {
  test("filters by user and reports per-record status", async () => {
    await withAuthority(async ({ authority }) => {
      await authority.create({ userId: USER_A, grant: grant("a-durable") });
      await authority.addEphemeral({ grant: grant("a-session", { userId: USER_A, lifetime: "session" }) });
      await authority.addEphemeral({ grant: grant("b-session", { userId: USER_B, lifetime: "session" }) });

      const userA = await authority.list({ userId: USER_A, includeHistory: true });
      expect(userA.ok && userA.data.grants.map((g) => g.grant.id).sort()).toEqual(
        ["a-durable", "a-session"].sort(),
      );
      const userB = await authority.list({ userId: USER_B, includeHistory: true });
      expect(userB.ok && userB.data.grants.map((g) => g.grant.id)).toEqual(["b-session"]);
    });
  });

  test("a revoked durable grant stays revoked even when an overlay grant covers the same root", async () => {
    await withAuthority(async ({ authority, durable }) => {
      await authority.create({
        userId: USER_A,
        grant: grant("durable-root", { canonicalRoot: "/Users/test/workspace", access: ["read", "create_modify"] }),
      });
      await authority.revoke({ userId: USER_A, grantId: "durable-root" });
      await authority.addEphemeral({
        grant: grant("overlay-root", {
          canonicalRoot: "/Users/test/workspace",
          access: ["read", "create_modify"],
          lifetime: "session",
        }),
      });

      const merged = await authority.list({ userId: USER_A, includeHistory: true });
      expect(merged).toMatchObject({ ok: true });
      if (merged.ok) {
        const byId = new Map(merged.data.grants.map((g) => [g.grant.id, g]));
        // The durable record remains revoked — the overlay does not revive it.
        expect(byId.get("durable-root")?.status).toBe("revoked");
        // The overlay grant for the same root is independently active.
        expect(byId.get("overlay-root")?.status).toBe("active");
      }
      // Durable store still reports the durable grant as revoked.
      const durableOnly = await durable.list({ userId: USER_A, includeHistory: true });
      expect(durableOnly.ok && durableOnly.data.grants.find((g) => g.grant.id === "durable-root")?.status).toBe(
        "revoked",
      );
    });
  });

  test("durable store read failure fails closed: list returns the durable error and admits no overlay", async () => {
    await withAuthority(async ({ authority, setBytes }) => {
      await authority.addEphemeral({
        grant: grant("overlay-1", { lifetime: "session" }),
      });
      // Corrupt the durable bytes so the durable store read fails.
      setBytes("{ not json");
      const merged = await authority.list({ userId: USER_A, includeHistory: true });
      expect(merged).toMatchObject({ ok: false, code: "store_corrupt" });
    });
  });

  test("overlay grants never persist to the durable store", async () => {
    await withAuthority(async ({ authority, durable }) => {
      await authority.addEphemeral({ grant: grant("once-1", { lifetime: "once" }) });
      await authority.addEphemeral({ grant: grant("session-1", { lifetime: "session" }) });
      await authority.addEphemeral({ grant: grant("pack-1", { origin: "policy_pack" }) });
      const durableOnly = await durable.list({ userId: USER_A, includeHistory: true });
      expect(durableOnly.ok && durableOnly.data.grants).toEqual([]);
    });
  });
});

describe("DesktopFilesystemGrantAuthority — revoke + last-used", () => {
  test("revoke marks overlay grants revoked in memory and delegates durable revoke", async () => {
    await withAuthority(async ({ authority, durable }) => {
      await authority.create({ userId: USER_A, grant: grant("dur-1") });
      await authority.addEphemeral({ grant: grant("sess-1", { lifetime: "session" }) });

      const revokedOverlay = await authority.revoke({ userId: USER_A, grantId: "sess-1" });
      expect(revokedOverlay).toMatchObject({ ok: true, data: { grant: { id: "sess-1", revokedAt: INITIAL_TIME.toISOString() } } });

      const revokedDurable = await authority.revoke({ userId: USER_A, grantId: "dur-1" });
      expect(revokedDurable).toMatchObject({ ok: true, data: { grant: { id: "dur-1" } } });

      const merged = await authority.list({ userId: USER_A, includeHistory: true });
      if (merged.ok) {
        const byId = new Map(merged.data.grants.map((g) => [g.grant.id, g]));
        expect(byId.get("sess-1")?.status).toBe("revoked");
        expect(byId.get("dur-1")?.status).toBe("revoked");
      }
      // Durable revoke persisted.
      const durableOnly = await durable.list({ userId: USER_A, includeHistory: true });
      expect(durableOnly.ok && durableOnly.data.grants.find((g) => g.grant.id === "dur-1")?.status).toBe("revoked");
    });
  });

  test("revoke of an unknown grant id reports grant_not_found", async () => {
    await withAuthority(async ({ authority }) => {
      const res = await authority.revoke({ userId: USER_A, grantId: "ghost" });
      expect(res).toMatchObject({ ok: false, code: "grant_not_found" });
    });
  });

  test("touchLastUsed tracks overlay use in memory only and persists durable use", async () => {
    await withAuthority(async ({ authority, durable }) => {
      await authority.create({ userId: USER_A, grant: grant("dur-1") });
      await authority.addEphemeral({ grant: grant("sess-1", { lifetime: "session" }) });

      const touchedOverlay = await authority.touchLastUsed({ userId: USER_A, grantId: "sess-1" });
      expect(touchedOverlay).toMatchObject({
        ok: true,
        data: { grant: { id: "sess-1", lastUsedAt: INITIAL_TIME.toISOString() } },
      });

      const touchedDurable = await authority.touchLastUsed({ userId: USER_A, grantId: "dur-1" });
      expect(touchedDurable).toMatchObject({ ok: true, data: { grant: { id: "dur-1" } } });

      // The overlay grant never reaches the durable store.
      const durableOnly = await durable.list({ userId: USER_A, includeHistory: true });
      expect(durableOnly.ok).toBe(true);
      if (durableOnly.ok) {
        expect(durableOnly.data.grants.find((g) => g.grant.id === "sess-1")).toBeUndefined();
        const durableDur = durableOnly.data.grants.find((g) => g.grant.id === "dur-1");
        expect(durableDur?.grant.lastUsedAt).toBe(INITIAL_TIME.toISOString());
      }

      // The overlay lastUsedAt is visible in the merged list (in memory only).
      const merged = await authority.list({ userId: USER_A, includeHistory: true });
      if (merged.ok) {
        const mergedSess = merged.data.grants.find((g) => g.grant.id === "sess-1");
        expect(mergedSess?.grant.lastUsedAt).toBe(INITIAL_TIME.toISOString());
      }
    });
  });

  test("touchLastUsed refuses revoked or expired overlay authority", async () => {
    await withAuthority(async ({ authority, setTime }) => {
      await authority.addEphemeral({
        grant: grant("exp-1", { lifetime: "session", expiresAt: "2026-07-12T12:00:01.000Z" }),
      });
      setTime(new Date("2026-07-12T12:00:02.000Z"));
      const expired = await authority.touchLastUsed({ userId: USER_A, grantId: "exp-1" });
      expect(expired).toMatchObject({ ok: false, code: "grant_not_found" });
    });
  });
});

describe("DesktopFilesystemGrantAuthority — consume-once", () => {
  test("atomically consumes a once grant; a second consume fails", async () => {
    await withAuthority(async ({ authority }) => {
      await authority.addEphemeral({ grant: grant("once-1", { lifetime: "once" }) });

      const first = await authority.consumeOnce({ userId: USER_A, grantId: "once-1" });
      expect(first).toMatchObject({
        ok: true,
        data: { grant: { id: "once-1", revokedAt: INITIAL_TIME.toISOString() }, consumed: true },
      });

      const second = await authority.consumeOnce({ userId: USER_A, grantId: "once-1" });
      expect(second).toMatchObject({ ok: false, code: "grant_not_found" });

      const merged = await authority.list({ userId: USER_A, includeHistory: true });
      expect(merged.ok && merged.data.grants.find((g) => g.grant.id === "once-1")?.status).toBe("revoked");
    });
  });

  test("rejects consume-once against a non-once grant", async () => {
    await withAuthority(async ({ authority }) => {
      await authority.addEphemeral({ grant: grant("sess-1", { lifetime: "session" }) });
      const res = await authority.consumeOnce({ userId: USER_A, grantId: "sess-1" });
      expect(res).toMatchObject({ ok: false, code: "invalid_grant" });
    });
  });

  test("rejects consume-once against an unknown grant", async () => {
    await withAuthority(async ({ authority }) => {
      const res = await authority.consumeOnce({ userId: USER_A, grantId: "ghost" });
      expect(res).toMatchObject({ ok: false, code: "grant_not_found" });
    });
  });

  test("concurrent consumes of the same once grant succeed exactly once", async () => {
    await withAuthority(async ({ authority }) => {
      await authority.addEphemeral({ grant: grant("once-race", { lifetime: "once" }) });
      const results = await Promise.all([
        authority.consumeOnce({ userId: USER_A, grantId: "once-race" }),
        authority.consumeOnce({ userId: USER_A, grantId: "once-race" }),
        authority.consumeOnce({ userId: USER_A, grantId: "once-race" }),
      ]);
      const successes = results.filter((r) => r.ok);
      const failures = results.filter((r) => !r.ok);
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(2);
      expect(failures.every((r) => !r.ok && r.code === "grant_not_found")).toBe(true);
    });
  });
});

describe("DesktopFilesystemGrantAuthority — app-session clear", () => {
  test("clearSession without a user drops every overlay grant and leaves durable grants intact", async () => {
    await withAuthority(async ({ authority, durable }) => {
      await authority.create({ userId: USER_A, grant: grant("dur-1") });
      await authority.addEphemeral({ grant: grant("sess-a", { userId: USER_A, lifetime: "session" }) });
      await authority.addEphemeral({ grant: grant("sess-b", { userId: USER_B, lifetime: "session" }) });

      const cleared = await authority.clearSession();
      expect(cleared).toMatchObject({ ok: true, data: { cleared: 2 } });

      const mergedA = await authority.list({ userId: USER_A, includeHistory: true });
      expect(mergedA.ok && mergedA.data.grants.map((g) => g.grant.id)).toEqual(["dur-1"]);
      const mergedB = await authority.list({ userId: USER_B, includeHistory: true });
      expect(mergedB.ok && mergedB.data.grants).toEqual([]);

      // Durable store untouched.
      const durableOnly = await durable.list({ userId: USER_A, includeHistory: true });
      expect(durableOnly.ok && durableOnly.data.grants.map((g) => g.grant.id)).toEqual(["dur-1"]);
    });
  });

  test("clearSession with a user clears only that user's overlay grants", async () => {
    await withAuthority(async ({ authority }) => {
      await authority.addEphemeral({ grant: grant("sess-a", { userId: USER_A, lifetime: "session" }) });
      await authority.addEphemeral({ grant: grant("sess-b", { userId: USER_B, lifetime: "session" }) });

      const cleared = await authority.clearSession({ userId: USER_A });
      expect(cleared).toMatchObject({ ok: true, data: { cleared: 1 } });

      const mergedA = await authority.list({ userId: USER_A, includeHistory: true });
      expect(mergedA.ok && mergedA.data.grants).toEqual([]);
      const mergedB = await authority.list({ userId: USER_B, includeHistory: true });
      expect(mergedB.ok && mergedB.data.grants.map((g) => g.grant.id)).toEqual(["sess-b"]);
    });
  });
});

describe("DesktopFilesystemGrantAuthority — addEphemeral validation", () => {
  test("rejects a non-ephemeral grant", async () => {
    await withAuthority(async ({ authority }) => {
      const res = await authority.addEphemeral({ grant: grant("dur-1", { lifetime: "durable" }) });
      expect(res).toMatchObject({ ok: false, code: "invalid_grant" });
    });
  });

  test("rejects a grant bound to another instance", async () => {
    await withAuthority(async ({ authority }) => {
      const res = await authority.addEphemeral({
        grant: grant("sess-1", {
          lifetime: "session",
          subject: { userId: USER_A, instanceId: "other-instance", relayId: RELAY, agentScope: AGENT_SCOPE },
        }),
      });
      expect(res).toMatchObject({ ok: false, code: "invalid_grant" });
    });
  });

  test("rejects a grant whose id collides with a durable grant", async () => {
    await withAuthority(async ({ authority }) => {
      await authority.create({ userId: USER_A, grant: grant("shared-id") });
      const res = await authority.addEphemeral({ grant: grant("shared-id", { lifetime: "session" }) });
      expect(res).toMatchObject({ ok: false, code: "invalid_grant" });
    });
  });

  test("rejects a grant whose id already exists in the overlay", async () => {
    await withAuthority(async ({ authority }) => {
      await authority.addEphemeral({ grant: grant("sess-1", { lifetime: "session" }) });
      const res = await authority.addEphemeral({ grant: grant("sess-1", { lifetime: "session" }) });
      expect(res).toMatchObject({ ok: false, code: "invalid_grant" });
    });
  });
});

describe("DesktopFilesystemGrantAuthority — revision + sharing shape", () => {
  test("revision is monotonic across durable and overlay mutations", async () => {
    await withAuthority(async ({ authority }) => {
      const r0 = await authority.list({ userId: USER_A });
      await authority.create({ userId: USER_A, grant: grant("dur-1") });
      const r1 = await authority.list({ userId: USER_A });
      await authority.addEphemeral({ grant: grant("sess-1", { lifetime: "session" }) });
      const r2 = await authority.list({ userId: USER_A });
      await authority.revoke({ userId: USER_A, grantId: "sess-1" });
      const r3 = await authority.list({ userId: USER_A });
      await authority.clearSession({ userId: USER_A });
      const r4 = await authority.list({ userId: USER_A });
      expect(r0.ok && r0.data.revision).toBe(0);
      expect(r1.ok && r1.data.revision).toBeGreaterThan(r0.ok ? r0.data.revision : -1);
      expect(r2.ok && r2.data.revision).toBeGreaterThan(r1.ok ? r1.data.revision : -1);
      expect(r3.ok && r3.data.revision).toBeGreaterThan(r2.ok ? r2.data.revision : -1);
      expect(r4.ok && r4.data.revision).toBeGreaterThanOrEqual(r3.ok ? r3.data.revision : -1);
    });
  });

  test("list returns a revision so the authority satisfies the snapshot store shape", async () => {
    await withAuthority(async ({ authority }) => {
      await authority.addEphemeral({ grant: grant("sess-1", { lifetime: "session" }) });
      const merged = await authority.list({ userId: USER_A });
      expect(merged).toMatchObject({ ok: true, data: { revision: expect.any(Number) } });
    });
  });
});
