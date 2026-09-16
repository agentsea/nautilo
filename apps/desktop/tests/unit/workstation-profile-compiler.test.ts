import { describe, expect, test } from "bun:test";
import * as path from "node:path";

import {
  type DesktopFilesystemGrant,
  type DesktopFilesystemGrantSubject,
} from "@nautilo/desktop-filesystem-grants";
import {
  parseWorkstationProfile,
  WORKSTATION_PROFILE_SCHEMA_VERSION,
  type DiscoveredWorkstationFacts,
  type WorkstationProfile,
} from "@nautilo/workstation-profiles";

import { DesktopFilesystemGrantStore } from "../../electron/desktop-filesystem-grants/store";
import type { DesktopFilesystemGrantStorage } from "../../electron/desktop-filesystem-grants/storage";
import { DesktopFilesystemGrantAuthority } from "../../electron/desktop-filesystem-grants/authority";
import {
  clearCompiledProfileSession,
  compileWorkstationProfileSession,
} from "../../electron/workstation-profiles/compiler";

const INSTANCE = "desktop-profile-compiler-test";
const RELAY = "relay-desktop";
const AGENT_SCOPE = "all_owned_agents";
const USER_A = "user-a";
const NOW = new Date("2026-07-12T12:00:00.000Z");
const PARENT_ROOT = path.join(path.sep, "Users", "test", "workspace");
const BUN_BIN = path.join(path.sep, "Users", "test", ".bun", "bin", "bun");

function rootRule(p: string, access: readonly string[]) {
  return { path: p, access };
}

function profileRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: WORKSTATION_PROFILE_SCHEMA_VERSION,
    id: "profile-developer-workstation",
    revision: 1,
    name: "Developer Workstation",
    roots: [
      rootRule(PARENT_ROOT, ["read", "create_modify", "delete", "execute"]),
      rootRule(path.join(path.sep, "Users", "test", ".bun"), ["read", "create_modify"]),
    ],
    discoveryProviders: ["bun", "homebrew"],
    environmentKeys: ["BUN_INSTALL", "JAVA_HOME"],
    executableRules: [
      { id: "exec-bun", executable: BUN_BIN, argv: ["install", "run"], backend: "sandboxed" },
    ],
    network: { mode: "host", allow: [] },
    capabilities: ["background_processes", "mcp_hosts"],
    toolchainCapabilities: [
      {
        id: "cap-bun",
        kind: "toolchain",
        discoveredFrom: "fixed_argv",
        executable: BUN_BIN,
        roots: [rootRule(path.join(path.sep, "Users", "test", ".bun"), ["read", "create_modify"])],
        environmentKeys: ["BUN_INSTALL"],
        backend: "sandboxed",
        operations: ["run"],
      },
    ],
    protectedPolicyVersion: 7,
    createdAt: "2026-07-12T11:00:00.000Z",
    updatedAt: "2026-07-12T11:30:00.000Z",
    ...overrides,
  };
}

function validProfile(overrides: Record<string, unknown> = {}): WorkstationProfile {
  const parsed = parseWorkstationProfile(profileRecord(overrides), { now: NOW });
  if (!parsed.ok) throw new Error(`fixture profile rejected: ${parsed.error.code}`);
  return parsed.profile;
}

function factsRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    roots: [
      {
        path: path.join(PARENT_ROOT, "my-app"),
        access: ["read", "create_modify"],
        sourceProvider: "bun",
      },
      {
        path: path.join(path.sep, "Users", "test", ".bun", "cache"),
        access: ["read"],
        sourceProvider: "bun",
      },
    ],
    environmentKeys: ["BUN_INSTALL"],
    capabilities: [
      {
        id: "cap-bun",
        executable: BUN_BIN,
        roots: [
          { path: path.join(path.sep, "Users", "test", ".bun", "cache"), access: ["read", "create_modify"] },
        ],
        environmentKeys: ["BUN_INSTALL"],
        backend: "sandboxed",
        operations: ["run"],
      },
    ],
    ...overrides,
  };
}

function validFacts(overrides: Record<string, unknown> = {}): DiscoveredWorkstationFacts {
  return factsRecord(overrides) as unknown as DiscoveredWorkstationFacts;
}

function subject(userId: string = USER_A): DesktopFilesystemGrantSubject {
  return { userId, instanceId: INSTANCE, relayId: RELAY, agentScope: AGENT_SCOPE };
}

function grant(
  id: string,
  overrides: Partial<DesktopFilesystemGrant> & { userId?: string } = {},
): DesktopFilesystemGrant {
  const { userId = USER_A, ...rest } = overrides;
  return {
    schemaVersion: 1,
    id,
    canonicalRoot: PARENT_ROOT,
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

function createInMemoryGrantStorage(): DesktopFilesystemGrantStorage {
  let bytes: string | null = null;
  return {
    async read() {
      return bytes;
    },
    async writeAtomic(next: string) {
      bytes = next;
    },
  };
}

function createAuthority(clock: () => Date = () => new Date(NOW)): {
  authority: DesktopFilesystemGrantAuthority;
  durable: DesktopFilesystemGrantStore;
} {
  const durable = new DesktopFilesystemGrantStore({
    instanceId: INSTANCE,
    filePath: "/unused/in-memory",
    storage: createInMemoryGrantStorage(),
    clock,
  });
  const authority = new DesktopFilesystemGrantAuthority({
    instanceId: INSTANCE,
    store: durable,
    clock,
  });
  return { authority, durable };
}

describe("compileWorkstationProfileSession — success", () => {
  test("compiles roots into policy_pack/session grants in the overlay and returns session ids", async () => {
    const { authority, durable } = createAuthority();
    const profile = validProfile();

    const result = await compileWorkstationProfileSession(
      { profile, facts: validFacts(), subject: subject(), authority },
      { clock: () => new Date(NOW) },
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        profileId: "profile-developer-workstation",
        profileRevision: 1,
        compiledAt: "2026-07-12T12:00:00.000Z",
      },
    });
    if (!result.ok) return;

    // One grant per compiled root (2 roots in the fixture).
    expect(result.data.grantIds).toHaveLength(2);

    const merged = await authority.list({ userId: USER_A, includeHistory: true });
    expect(merged.ok).toBe(true);
    if (merged.ok) {
      const compiled = merged.data.grants.filter((g) => g.grant.origin === "policy_pack");
      expect(compiled.map((g) => g.grant.id).sort()).toEqual([...result.data.grantIds].sort());
      for (const entry of compiled) {
        expect(entry.grant.origin).toBe("policy_pack");
        expect(entry.grant.lifetime).toBe("session");
        expect(entry.status).toBe("active");
        // Grant policyVersion is a fixed constant, kept separate from the
        // profile's protectedPolicyVersion (which is 7 in the fixture).
        expect(entry.grant.policyVersion).toBe(1);
      }
    }

    // Policy-pack grants never reach the durable store.
    const durableOnly = await durable.list({ userId: USER_A, includeHistory: true });
    expect(durableOnly.ok && durableOnly.data.grants).toEqual([]);
  });

  test("compiled grants bind to the supplied subject", async () => {
    const { authority } = createAuthority();
    const result = await compileWorkstationProfileSession(
      { profile: validProfile(), facts: validFacts(), subject: subject("user-x"), authority },
      { clock: () => new Date(NOW) },
    );
    expect(result.ok).toBe(true);
    const merged = await authority.list({ userId: "user-x", includeHistory: true });
    if (merged.ok) {
      for (const entry of merged.data.grants) {
        expect(entry.grant.subject.userId).toBe("user-x");
        expect(entry.grant.subject.instanceId).toBe(INSTANCE);
      }
    }
  });
});

describe("compileWorkstationProfileSession — compile failure", () => {
  test("returns compile_failed with the shared compile error code and adds no grants", async () => {
    const { authority } = createAuthority();
    const result = await compileWorkstationProfileSession(
      {
        profile: validProfile(),
        facts: validFacts({
          roots: [{ path: path.join(path.sep, "etc", "secret"), access: ["read"] }],
        }),
        subject: subject(),
        authority,
      },
      { clock: () => new Date(NOW) },
    );
    expect(result).toMatchObject({
      ok: false,
      code: "compile_failed",
      compileErrorCode: "discovered_root_not_allowed",
    });
    const merged = await authority.list({ userId: USER_A, includeHistory: true });
    expect(merged.ok && merged.data.grants).toEqual([]);
  });

  test("returns compile_failed for malformed discovered facts", async () => {
    const { authority } = createAuthority();
    const result = await compileWorkstationProfileSession(
      {
        profile: validProfile(),
        facts: { roots: "not-an-array" } as unknown as DiscoveredWorkstationFacts,
        subject: subject(),
        authority,
      },
      { clock: () => new Date(NOW) },
    );
    expect(result).toMatchObject({ ok: false, code: "compile_failed", compileErrorCode: "invalid_discovered_facts" });
  });

  test("rejects an invalid compile clock", async () => {
    const { authority } = createAuthority();
    const invalid = new Date("not-a-date");
    const result = await compileWorkstationProfileSession(
      { profile: validProfile(), facts: validFacts(), subject: subject(), authority },
      { clock: () => invalid },
    );
    expect(result).toMatchObject({ ok: false, code: "compile_failed" });
  });
});

describe("compileWorkstationProfileSession — rollback fail-closed", () => {
  test("revokes earlier additions when a later add fails, leaving no partial authority", async () => {
    const { authority } = createAuthority();

    // Pre-seed the overlay with a policy_pack session grant whose id collides
    // with the SECOND minted id, so the first compiled root adds and the
    // second add fails — forcing rollback of the first.
    await authority.addEphemeral({
      grant: grant("pp-2", {
        origin: "policy_pack",
        lifetime: "session",
        canonicalRoot: path.join(path.sep, "Users", "test", ".bun", "cache"),
        access: ["read"],
      }),
    });

    let counter = 0;
    const result = await compileWorkstationProfileSession(
      { profile: validProfile(), facts: validFacts(), subject: subject(), authority },
      { clock: () => new Date(NOW), mintGrantId: () => `pp-${++counter}` },
    );

    expect(result).toMatchObject({ ok: false, code: "grant_add_failed", rolledBack: 1 });

    const merged = await authority.list({ userId: USER_A, includeHistory: true });
    if (merged.ok) {
      const byId = new Map(merged.data.grants.map((g) => [g.grant.id, g]));
      // The first compiled grant (pp-1) was rolled back to revoked — no
      // authority from the partial compile.
      expect(byId.get("pp-1")?.status).toBe("revoked");
      expect(byId.get("pp-1")?.grant.origin).toBe("policy_pack");
      // The pre-seeded pp-2 is untouched and still active.
      expect(byId.get("pp-2")?.status).toBe("active");
      // No compiled grant from this session remains active.
      expect(
        merged.data.grants.filter((g) => g.grant.origin === "policy_pack" && g.status === "active"),
      ).toHaveLength(1);
    }
  });
});

describe("clearCompiledProfileSession — targeted teardown", () => {
  test("revokes only the session's policy_pack grants and leaves unrelated once/session grants intact", async () => {
    const { authority } = createAuthority();

    const compiled = await compileWorkstationProfileSession(
      { profile: validProfile(), facts: validFacts(), subject: subject(), authority },
      { clock: () => new Date(NOW) },
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    // Unrelated ephemeral grants that must NOT be cleared.
    await authority.addEphemeral({ grant: grant("once-unrelated", { lifetime: "once" }) });
    await authority.addEphemeral({
      grant: grant("session-unrelated", { lifetime: "session", origin: "user_picker" }),
    });

    const cleared = await clearCompiledProfileSession({
      authority,
      userId: USER_A,
      grantIds: compiled.data.grantIds,
    });
    expect(cleared.cleared).toBe(compiled.data.grantIds.length);
    expect(cleared.skipped).toEqual([]);

    const merged = await authority.list({ userId: USER_A, includeHistory: true });
    if (merged.ok) {
      const byId = new Map(merged.data.grants.map((g) => [g.grant.id, g]));
      for (const id of compiled.data.grantIds) {
        expect(byId.get(id)?.status).toBe("revoked");
      }
      expect(byId.get("once-unrelated")?.status).toBe("active");
      expect(byId.get("session-unrelated")?.status).toBe("active");
    }
  });

  test("skips ids that are not policy_pack grants rather than touching unrelated authority", async () => {
    const { authority } = createAuthority();
    await authority.addEphemeral({ grant: grant("once-unrelated", { lifetime: "once" }) });
    // A durable grant that must never be revoked by the clear helper.
    await authority.create({ userId: USER_A, grant: grant("dur-unrelated") });

    const cleared = await clearCompiledProfileSession({
      authority,
      userId: USER_A,
      grantIds: ["once-unrelated", "dur-unrelated", "ghost"],
    });
    expect(cleared.cleared).toBe(0);
    expect(cleared.skipped.sort()).toEqual(["dur-unrelated", "ghost", "once-unrelated"].sort());

    const merged = await authority.list({ userId: USER_A, includeHistory: true });
    if (merged.ok) {
      const byId = new Map(merged.data.grants.map((g) => [g.grant.id, g]));
      expect(byId.get("once-unrelated")?.status).toBe("active");
      expect(byId.get("dur-unrelated")?.status).toBe("active");
    }
  });

  test("clears nothing when no grant ids are supplied", async () => {
    const { authority } = createAuthority();
    const cleared = await clearCompiledProfileSession({
      authority,
      userId: USER_A,
      grantIds: [],
    });
    expect(cleared).toEqual({ cleared: 0, skipped: [] });
  });

  test("is idempotent across repeated clears of the same session", async () => {
    const { authority } = createAuthority();
    const compiled = await compileWorkstationProfileSession(
      { profile: validProfile(), facts: validFacts(), subject: subject(), authority },
      { clock: () => new Date(NOW) },
    );
    if (!compiled.ok) return;

    const first = await clearCompiledProfileSession({
      authority,
      userId: USER_A,
      grantIds: compiled.data.grantIds,
    });
    expect(first.cleared).toBe(compiled.data.grantIds.length);

    const second = await clearCompiledProfileSession({
      authority,
      userId: USER_A,
      grantIds: compiled.data.grantIds,
    });
    // Already revoked — revoke is a no-op that still returns ok, so the count
    // repeats; the guarantee is no authority is conferred and unrelated grants
    // are untouched.
    expect(second.cleared).toBe(compiled.data.grantIds.length);
  });
});
