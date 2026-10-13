/**
 * ActiveWorkstationProfileController state machine tests.
 *
 * Covers activate, replace (swap), failed-replacement preserves prior state,
 * deactivate, snapshot redaction, and the onActiveProfileChanged callback.
 * The controller is exercised against in-memory profile + grant stores and a
 * shared DesktopFilesystemGrantAuthority overlay, with no Electron runtime.
 */
import { beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import * as path from "node:path";

import {
  type DesktopFilesystemGrantSubject,
} from "@nautilo/desktop-filesystem-grants";
import {
  parseWorkstationProfile,
  WORKSTATION_PROFILE_SCHEMA_VERSION,
  type DiscoveredWorkstationFacts,
  type WorkstationProfile,
} from "@nautilo/workstation-profiles";
import { parseRelayWorkstationProfileSnapshot } from "@nautilo/relay";

import { DesktopFilesystemGrantStore } from "../../electron/desktop-filesystem-grants/store";
import type { DesktopFilesystemGrantStorage } from "../../electron/desktop-filesystem-grants/storage";
import { DesktopFilesystemGrantAuthority } from "../../electron/desktop-filesystem-grants/authority";
import { WorkstationProfileStore } from "../../electron/workstation-profiles/store";
import type { WorkstationProfileStorage } from "../../electron/workstation-profiles/storage";
import type { ActiveWorkstationProfileController as ActiveWorkstationProfileControllerInstance } from "../../electron/workstation-profiles/active-controller";

// The controller imports `paths.ts`, which imports Electron's `app`. Every
// other desktop unit test mocks `paths` so the SUT can load without an
// Electron runtime; do the same here. The mock is never invoked on the read
// path because every fixture injects an in-memory storage + explicit filePath.
mock.module("../../electron/paths", () => ({
  workstationProfilesFilePath: () => "/unused/in-memory-profiles",
}));

let ActiveWorkstationProfileController: typeof import("../../electron/workstation-profiles/active-controller").ActiveWorkstationProfileController;

beforeAll(async () => {
  ({ ActiveWorkstationProfileController } = await import(
    "../../electron/workstation-profiles/active-controller"
  ));
});

const INSTANCE = "desktop-active-profile-test";
const RELAY = "relay-desktop";
const AGENT_SCOPE = "all_owned_agents";
const USER_A = "user-a";
const NOW = new Date("2026-07-12T12:00:00.000Z");
const PARENT_ROOT = path.join(path.sep, "Users", "test", "workspace");
const BUN_ROOT = path.join(path.sep, "Users", "test", ".bun");
const BUN_BIN = path.join(path.sep, "Users", "test", ".bun", "bin", "bun");

function rootRule(p: string, access: readonly string[]) {
  return { path: p, access };
}

function profileRecord(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: WORKSTATION_PROFILE_SCHEMA_VERSION,
    id,
    revision: 1,
    name: "Developer Workstation",
    roots: [
      rootRule(PARENT_ROOT, ["read", "create_modify", "delete", "execute"]),
      rootRule(BUN_ROOT, ["read", "create_modify"]),
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
        roots: [rootRule(BUN_ROOT, ["read", "create_modify"])],
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

function validProfile(id: string, overrides: Record<string, unknown> = {}): WorkstationProfile {
  const parsed = parseWorkstationProfile(profileRecord(id, overrides), { now: NOW });
  if (!parsed.ok) throw new Error(`fixture profile rejected: ${parsed.error.code}`);
  return parsed.profile;
}

function factsRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    roots: [
      { path: path.join(PARENT_ROOT, "my-app"), access: ["read", "create_modify"], sourceProvider: "bun" },
      { path: path.join(BUN_ROOT, "cache"), access: ["read"], sourceProvider: "bun" },
    ],
    environmentKeys: ["BUN_INSTALL"],
    environmentValues: { BUN_INSTALL: BUN_ROOT },
    capabilities: [
      {
        id: "cap-bun",
        executable: BUN_BIN,
        roots: [{ path: path.join(BUN_ROOT, "cache"), access: ["read", "create_modify"] }],
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

function createInMemoryProfileStorage(): WorkstationProfileStorage {
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

/** A profile storage whose read always throws — simulates an unavailable store. */
function createThrowingProfileStorage(): WorkstationProfileStorage {
  return {
    async read() {
      throw new Error("disk read failed");
    },
    async writeAtomic() {
      /* unused on the read path */
    },
  };
}

/** A profile storage that returns invalid JSON — simulates a corrupt store. */
function createCorruptProfileStorage(): WorkstationProfileStorage {
  return {
    async read() {
      return "not valid json {{{";
    },
    async writeAtomic() {
      /* unused on the read path */
    },
  };
}

function createFixtureWithProfileStorage(
  storage: WorkstationProfileStorage,
): Pick<ControllerFixture, "controller" | "authority"> {
  const durable = new DesktopFilesystemGrantStore({
    instanceId: INSTANCE,
    filePath: "/unused/in-memory",
    storage: createInMemoryGrantStorage(),
    clock: () => new Date(NOW),
  });
  const authority = new DesktopFilesystemGrantAuthority({
    instanceId: INSTANCE,
    store: durable,
    clock: () => new Date(NOW),
  });
  const profileStore = new WorkstationProfileStore({
    instanceId: INSTANCE,
    filePath: "/unused/in-memory",
    storage,
    clock: () => new Date(NOW),
  });
  const controller = new ActiveWorkstationProfileController({
    instanceId: INSTANCE,
    authority,
    profileStore,
    clock: () => new Date(NOW),
    mintGrantId: (() => {
      let n = 0;
      return () => `pp-${++n}`;
    })(),
    homeDirectory: path.join(path.sep, "Users", "test"),
  });
  return { controller, authority };
}

interface ControllerFixture {
  controller: ActiveWorkstationProfileControllerInstance;
  authority: DesktopFilesystemGrantAuthority;
  durable: DesktopFilesystemGrantStore;
  profileStore: WorkstationProfileStore;
  changes: string[];
}

function createFixture(): ControllerFixture {
  const durable = new DesktopFilesystemGrantStore({
    instanceId: INSTANCE,
    filePath: "/unused/in-memory",
    storage: createInMemoryGrantStorage(),
    clock: () => new Date(NOW),
  });
  const authority = new DesktopFilesystemGrantAuthority({
    instanceId: INSTANCE,
    store: durable,
    clock: () => new Date(NOW),
  });
  const profileStore = new WorkstationProfileStore({
    instanceId: INSTANCE,
    filePath: "/unused/in-memory",
    storage: createInMemoryProfileStorage(),
    clock: () => new Date(NOW),
  });
  const changes: string[] = [];
  const controller = new ActiveWorkstationProfileController({
    instanceId: INSTANCE,
    authority,
    profileStore,
    clock: () => new Date(NOW),
    mintGrantId: (() => {
      let n = 0;
      return () => `pp-${++n}`;
    })(),
    homeDirectory: path.join(path.sep, "Users", "test"),
    onActiveProfileChanged: (reason) => {
      changes.push(reason);
    },
  });
  return { controller, authority, durable, profileStore, changes };
}

async function activePolicyPackGrantIds(
  authority: DesktopFilesystemGrantAuthority,
  userId: string,
): Promise<string[]> {
  const merged = await authority.list({ userId, includeHistory: true });
  if (!merged.ok) return [];
  return merged.data.grants
    .filter((g) => g.grant.origin === "policy_pack" && g.status === "active")
    .map((g) => g.grant.id);
}

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function expectHiddenAuthority(controller: ActiveWorkstationProfileControllerInstance) {
  expect(controller.getActiveSession()).toBeNull();
  expect(controller.getActiveNetworkPolicy()).toBeNull();
  expect(controller.getExecutionEnvironment()).toBeNull();
  expect(await controller.getProfileSnapshot()).toBeUndefined();
}

describe("ActiveWorkstationProfileController — activate", () => {
  test("compiles a stored profile into policy-pack grants and binds the active session", async () => {
    const { controller, authority, profileStore, changes } = createFixture();
    await profileStore.create({ profile: validProfile("profile-a") });

    const result = await controller.activate({
      profileId: "profile-a",
      facts: validFacts(),
      subject: subject(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.session).toMatchObject({
      profileId: "profile-a",
      profileRevision: 1,
      protectedPolicyVersion: 7,
      networkMode: "host",
      compiledAt: "2026-07-12T12:00:00.000Z",
    });
    // One grant per compiled root (2 roots in the fixture).
    expect(result.data.session.grantIds).toHaveLength(2);

    // The session is the active session.
    expect(controller.getActiveSession()?.profileId).toBe("profile-a");
    expect(controller.getExecutionEnvironment()).toEqual({
      profileId: "profile-a", profileRevision: 1, protectedPolicyVersion: 7,
      home: path.join(path.sep, "Users", "test"),
      environmentValues: { BUN_INSTALL: BUN_ROOT },
      executables: [{ capabilityId: "cap-bun", executable: BUN_BIN, backend: "sandboxed" }],
    });
    expect(Object.isFrozen(controller.getExecutionEnvironment())).toBe(true);

    // The compiled grants are live policy-pack overlay authority.
    const ids = await activePolicyPackGrantIds(authority, USER_A);
    expect(ids.sort()).toEqual([...result.data.session.grantIds].sort());

    // The callback fired once for the activation.
    expect(changes).toEqual(["workstation profile activate"]);
  });

  test("carries explicit user-environment authority and declared package prefixes locally", async () => {
    const { controller, profileStore } = createFixture();
    const base = profileRecord("profile-a");
    const toolchainCapabilities = (base["toolchainCapabilities"] as Record<string, unknown>[])
      .map((capability) => ({
        ...capability,
        id: "cap-homebrew",
        operations: ["run", "install"],
      }));
    await profileStore.create({
      profile: validProfile("profile-a", {
        capabilities: ["background_processes", "mcp_hosts", "user_environment"],
        toolchainCapabilities,
      }),
    });

    const result = await controller.activate({
      profileId: "profile-a",
      facts: validFacts({
        roots: [
          { path: PARENT_ROOT, access: ["read"], sourceProvider: "homebrew" },
          { path: BUN_ROOT, access: ["read"], sourceProvider: "homebrew" },
        ],
        capabilities: (factsRecord()["capabilities"] as Record<string, unknown>[])
          .map((capability) => ({
            ...capability,
            id: "cap-homebrew",
            operations: ["run", "install"],
          })),
      }),
      subject: subject(),
    });

    expect(result.ok).toBe(true);
    expect(controller.getExecutionEnvironment()).toMatchObject({
      userEnvironment: true,
      userEnvironmentWritablePaths: [PARENT_ROOT, BUN_ROOT],
    });
    expect(Object.isFrozen(controller.getExecutionEnvironment()?.userEnvironmentWritablePaths)).toBe(true);
  });

  test("rejects a subject bound to a different instance without mutating state", async () => {
    const { controller, profileStore, authority, changes } = createFixture();
    await profileStore.create({ profile: validProfile("profile-a") });

    const result = await controller.activate({
      profileId: "profile-a",
      facts: validFacts(),
      subject: { userId: USER_A, instanceId: "other-instance", relayId: RELAY, agentScope: AGENT_SCOPE },
    });

    expect(result).toMatchObject({ ok: false, code: "subject_instance_mismatch" });
    expect(controller.getActiveSession()).toBeNull();
    expect(await activePolicyPackGrantIds(authority, USER_A)).toEqual([]);
    expect(changes).toEqual([]);
  });

  test("returns profile_not_found for an unknown profile id and adds no authority", async () => {
    const { controller, authority, changes } = createFixture();
    const result = await controller.activate({
      profileId: "ghost",
      facts: validFacts(),
      subject: subject(),
    });
    expect(result).toMatchObject({ ok: false, code: "profile_not_found" });
    expect(controller.getActiveSession()).toBeNull();
    expect(await activePolicyPackGrantIds(authority, USER_A)).toEqual([]);
    expect(changes).toEqual([]);
  });
});

describe("ActiveWorkstationProfileController — store error mapping", () => {
  test("returns store_unavailable when the profile store cannot be read", async () => {
    const { controller, authority } = createFixtureWithProfileStorage(
      createThrowingProfileStorage(),
    );
    const result = await controller.activate({
      profileId: "profile-a",
      facts: validFacts(),
      subject: subject(),
    });
    expect(result).toMatchObject({ ok: false, code: "store_unavailable" });
    expect(controller.getActiveSession()).toBeNull();
    expect(await activePolicyPackGrantIds(authority, USER_A)).toEqual([]);
  });

  test("returns store_corrupt when the profile store bytes are invalid", async () => {
    const { controller, authority } = createFixtureWithProfileStorage(
      createCorruptProfileStorage(),
    );
    const result = await controller.activate({
      profileId: "profile-a",
      facts: validFacts(),
      subject: subject(),
    });
    expect(result).toMatchObject({ ok: false, code: "store_corrupt" });
    expect(controller.getActiveSession()).toBeNull();
    expect(await activePolicyPackGrantIds(authority, USER_A)).toEqual([]);
  });
});

describe("ActiveWorkstationProfileController — replace (swap)", () => {
  test("activating a second profile clears the prior session's grants and binds the new one", async () => {
    const { controller, authority, profileStore, changes } = createFixture();
    await profileStore.create({ profile: validProfile("profile-a") });
    await profileStore.create({ profile: validProfile("profile-b") });

    const first = await controller.activate({
      profileId: "profile-a",
      facts: validFacts(),
      subject: subject(),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstIds = [...first.data.session.grantIds];

    const second = await controller.activate({
      profileId: "profile-b",
      facts: validFacts(),
      subject: subject(),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const secondIds = [...second.data.session.grantIds];

    // The active session is now profile-b.
    expect(controller.getActiveSession()?.profileId).toBe("profile-b");
    expect(second.data.session.grantIds).not.toEqual(firstIds);

    // The new session's grants are the only active policy-pack grants; the
    // prior session's grants were revoked on swap.
    const activeIds = await activePolicyPackGrantIds(authority, USER_A);
    expect(activeIds.sort()).toEqual(secondIds.sort());

    const merged = await authority.list({ userId: USER_A, includeHistory: true });
    if (merged.ok) {
      const byId = new Map(merged.data.grants.map((g) => [g.grant.id, g]));
      for (const id of firstIds) {
        expect(byId.get(id)?.status).toBe("revoked");
        expect(byId.get(id)?.grant.origin).toBe("policy_pack");
      }
      for (const id of secondIds) {
        expect(byId.get(id)?.status).toBe("active");
      }
    }

    // Both activations fired the callback.
    expect(changes).toEqual(["workstation profile activate", "workstation profile activate"]);
  });
});

describe("ActiveWorkstationProfileController — failed replacement preserves prior state", () => {
  test("a failed compile leaves the prior active session and its grants intact", async () => {
    const { controller, authority, profileStore, changes } = createFixture();
    await profileStore.create({ profile: validProfile("profile-a") });
    await profileStore.create({ profile: validProfile("profile-b") });

    const first = await controller.activate({
      profileId: "profile-a",
      facts: validFacts(),
      subject: subject(),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstIds = [...first.data.session.grantIds];

    // Facts with a root not within any profile root rule → compile fails.
    const failed = await controller.activate({
      profileId: "profile-b",
      facts: validFacts({
        roots: [{ path: path.join(path.sep, "etc", "secret"), access: ["read"] }],
      }),
      subject: subject(),
    });

    expect(failed).toMatchObject({
      ok: false,
      code: "compile_failed",
      compileErrorCode: "discovered_root_not_allowed",
    });

    // The prior session is still the active session.
    expect(controller.getActiveSession()?.profileId).toBe("profile-a");

    // The prior session's grants remain active; the failed compile added none.
    const activeIds = await activePolicyPackGrantIds(authority, USER_A);
    expect(activeIds.sort()).toEqual(firstIds.sort());

    // The callback did NOT fire for the failed activation.
    expect(changes).toEqual(["workstation profile activate"]);
  });
});

describe("ActiveWorkstationProfileController — deactivate", () => {
  test("revokes the active session's grants, drops the binding, and omits the snapshot", async () => {
    const { controller, authority, profileStore, changes } = createFixture();
    await profileStore.create({ profile: validProfile("profile-a") });
    const first = await controller.activate({
      profileId: "profile-a",
      facts: validFacts(),
      subject: subject(),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstIds = [...first.data.session.grantIds];

    const deactivated = await controller.deactivate();
    expect(deactivated.ok).toBe(true);
    if (!deactivated.ok) return;
    expect(deactivated.data.cleared).toBe(firstIds.length);
    expect(deactivated.data.skipped).toEqual([]);

    expect(controller.getActiveSession()).toBeNull();
    expect(await activePolicyPackGrantIds(authority, USER_A)).toEqual([]);
    expect(await controller.getProfileSnapshot()).toBeUndefined();

    // The deactivate fired the callback.
    expect(changes).toEqual(["workstation profile activate", "workstation profile deactivate"]);
  });

  test("deactivate with no active profile returns no_active_profile and does not fire the callback", async () => {
    const { controller, changes } = createFixture();
    const deactivated = await controller.deactivate();
    expect(deactivated).toMatchObject({ ok: false, code: "no_active_profile" });
    expect(changes).toEqual([]);
  });
});

describe("ActiveWorkstationProfileController — immediate authority reduction", () => {
  test("hides all authority getters before deactivation queued behind activation can run", async () => {
    const { controller, profileStore } = createFixture();
    await profileStore.create({ profile: validProfile("profile-a") });
    await profileStore.create({ profile: validProfile("profile-b") });
    expect((await controller.activate({ profileId: "profile-a", facts: validFacts(), subject: subject() })).ok).toBe(true);
    const entered = barrier();
    const resume = barrier();
    const originalGet = profileStore.get.bind(profileStore);
    const get = spyOn(profileStore, "get").mockImplementation(async (input) => {
      entered.release();
      await resume.promise;
      return originalGet(input);
    });
    const activation = controller.activate({ profileId: "profile-b", facts: validFacts(), subject: subject() });
    await entered.promise;
    expect(controller.getActiveSession()?.profileId).toBe("profile-a");
    const cleanup = controller.deactivate();
    try {
      await expectHiddenAuthority(controller);
      resume.release();
      expect((await activation).ok).toBe(true);
      expect((await cleanup).ok).toBe(true);
      await expectHiddenAuthority(controller);
    } finally {
      resume.release();
      await Promise.allSettled([activation, cleanup]);
      get.mockRestore();
    }
  });

  test("hides all authority getters while grant teardown is still running", async () => {
    const { controller, authority, profileStore } = createFixture();
    await profileStore.create({ profile: validProfile("profile-a") });
    expect((await controller.activate({ profileId: "profile-a", facts: validFacts(), subject: subject() })).ok).toBe(true);
    const entered = barrier();
    const resume = barrier();
    const originalList = authority.list.bind(authority);
    const list = spyOn(authority, "list").mockImplementation(async (input) => {
      entered.release();
      await resume.promise;
      return originalList(input);
    });
    const cleanup = controller.deactivate();
    try {
      await expectHiddenAuthority(controller);
      await entered.promise;
      await expectHiddenAuthority(controller);
      resume.release();
      expect((await cleanup).ok).toBe(true);
      await expectHiddenAuthority(controller);
    } finally {
      resume.release();
      await Promise.allSettled([cleanup]);
      list.mockRestore();
    }
  });

  test("overlapping reductions prevent a queued activation from exposing authority until a fresh activation", async () => {
    const { controller, authority, profileStore, changes } = createFixture();
    await profileStore.create({ profile: validProfile("profile-a") });
    await profileStore.create({ profile: validProfile("profile-b") });
    expect((await controller.activate({ profileId: "profile-a", facts: validFacts(), subject: subject() })).ok).toBe(true);
    const entered = [barrier(), barrier()];
    const resume = [barrier(), barrier()];
    let call = 0;
    const originalList = authority.list.bind(authority);
    const list = spyOn(authority, "list").mockImplementation(async (input) => {
      const index = call++;
      if (index < entered.length) {
        entered[index]!.release();
        await resume[index]!.promise;
      }
      return originalList(input);
    });
    const firstCleanup = controller.deactivate();
    await entered[0]!.promise;
    const activation = controller.activate({ profileId: "profile-b", facts: validFacts(), subject: subject() });
    const secondCleanup = controller.deactivate();
    try {
      await expectHiddenAuthority(controller);
      resume[0]!.release();
      expect((await firstCleanup).ok).toBe(true);
      expect((await activation).ok).toBe(true);
      await entered[1]!.promise;
      await expectHiddenAuthority(controller);
      resume[1]!.release();
      expect((await secondCleanup).ok).toBe(true);
      await expectHiddenAuthority(controller);
      expect(changes).toEqual([
        "workstation profile activate", "workstation profile deactivate",
        "workstation profile activate", "workstation profile deactivate",
      ]);
      expect((await controller.activate({ profileId: "profile-a", facts: validFacts(), subject: subject() })).ok).toBe(true);
      expect(controller.getActiveSession()?.profileId).toBe("profile-a");
      expect(controller.getActiveNetworkPolicy()).not.toBeNull();
      expect((await controller.getProfileSnapshot())?.profileId).toBe("profile-a");
    } finally {
      for (const gate of resume) gate.release();
      await Promise.allSettled([firstCleanup, activation, secondCleanup]);
      list.mockRestore();
    }
  });

  test("teardown rejection stays hidden through failed activation and exposes only a fresh successful activation", async () => {
    const { controller, authority, profileStore } = createFixture();
    await profileStore.create({ profile: validProfile("profile-a") });
    await profileStore.create({ profile: validProfile("profile-b") });
    expect((await controller.activate({ profileId: "profile-a", facts: validFacts(), subject: subject() })).ok).toBe(true);
    const list = spyOn(authority, "list").mockImplementationOnce(async () => { throw new Error("fixture teardown failed"); });
    try {
      const cleanup = controller.deactivate().catch((error: unknown) => error);
      await expectHiddenAuthority(controller);
      expect(await cleanup).toMatchObject({ message: "fixture teardown failed" });
      await expectHiddenAuthority(controller);
    } finally {
      list.mockRestore();
    }
    expect((await controller.activate({ profileId: "missing", facts: validFacts(), subject: subject() })).ok).toBe(false);
    await expectHiddenAuthority(controller);
    expect((await controller.activate({ profileId: "profile-b", facts: validFacts(), subject: subject() })).ok).toBe(true);
    expect(controller.getActiveSession()?.profileId).toBe("profile-b");
    expect(controller.getActiveNetworkPolicy()).not.toBeNull();
    expect((await controller.getProfileSnapshot())?.profileId).toBe("profile-b");
  });
});

describe("ActiveWorkstationProfileController — snapshot redaction", () => {
  test("the advertised snapshot carries only the strict redacted binding fields and round-trips the protocol parser", async () => {
    const { controller, profileStore } = createFixture();
    await profileStore.create({ profile: validProfile("profile-a") });
    await controller.activate({
      profileId: "profile-a",
      facts: validFacts(),
      subject: subject(),
    });

    const snapshot = await controller.getProfileSnapshot();
    expect(snapshot).not.toBeUndefined();
    if (snapshot === undefined) return;

    // Exactly the six allowed fields, nothing else.
    expect(Object.keys(snapshot).sort()).toEqual([
      "capabilities",
      "grantIds",
      "networkMode",
      "profileId",
      "profileRevision",
      "protectedPolicyVersion",
    ]);

    // Capability entries are redacted to {id, backend} only.
    expect(snapshot.capabilities).toHaveLength(1);
    expect(Object.keys(snapshot.capabilities[0]!).sort()).toEqual(["backend", "id"]);
    expect(snapshot.capabilities[0]).toEqual({ id: "cap-bun", backend: "sandboxed" });

    // Binding fields come from the stored profile.
    expect(snapshot).toMatchObject({
      profileId: "profile-a",
      profileRevision: 1,
      protectedPolicyVersion: 7,
      networkMode: "host",
    });
    expect(snapshot.grantIds).toHaveLength(2);

    // The snapshot is accepted by the strict protocol parser — no smuggled
    // roots / env / executable / identity / name / timestamps cross the wire.
    const parsed = parseRelayWorkstationProfileSnapshot(snapshot);
    expect(parsed).toEqual({ ok: true, snapshot });
  });

  test("getProfileSnapshot is undefined when no profile is active", async () => {
    const { controller } = createFixture();
    expect(await controller.getProfileSnapshot()).toBeUndefined();
  });
});

describe("ActiveWorkstationProfileController — shared authority / store accessors", () => {
  test("exposes the shared authority and owned profile store (no duplicate stores)", async () => {
    const { controller, authority, profileStore } = createFixture();
    expect(controller.getAuthority()).toBe(authority);
    expect(controller.getProfileStore()).toBe(profileStore);
  });
});

describe("ActiveWorkstationProfileController — active network policy", () => {
  test("getActiveNetworkPolicy returns the complete active-profile network policy (LOCAL authority, not the wire snapshot)", async () => {
    const { controller, profileStore } = createFixture();
    await profileStore.create({
      profile: validProfile("profile-a", {
        network: {
          mode: "proxy_allowlist",
          allow: [
            { id: "registry", kind: "domain", value: "registry.npmjs.org" },
            { id: "lab", kind: "cidr", value: "192.0.2.0/24" },
          ],
        },
      }),
    });
    await controller.activate({
      profileId: "profile-a",
      facts: validFacts(),
      subject: subject(),
    });

    const policy = controller.getActiveNetworkPolicy();
    expect(policy).not.toBeNull();
    expect(policy).toEqual({
      mode: "proxy_allowlist",
      allow: [
        { id: "registry", kind: "domain", value: "registry.npmjs.org" },
        { id: "lab", kind: "cidr", value: "192.0.2.0/24" },
      ],
    });

    // The wire snapshot stays redacted to networkMode only — the complete
    // allow rules never cross the wire.
    const snapshot = await controller.getProfileSnapshot();
    expect(snapshot?.networkMode).toBe("proxy_allowlist");
    expect(Object.keys(snapshot ?? {})).not.toContain("network");
  });

  test("getActiveNetworkPolicy is null when no profile is bound", async () => {
    const { controller } = createFixture();
    expect(controller.getActiveNetworkPolicy()).toBeNull();
  });

  test("the bound session carries the complete network policy alongside networkMode", async () => {
    const { controller, profileStore } = createFixture();
    await profileStore.create({ profile: validProfile("profile-a") });
    await controller.activate({
      profileId: "profile-a",
      facts: validFacts(),
      subject: subject(),
    });
    const session = controller.getActiveSession();
    expect(session?.networkMode).toBe("host");
    expect(session?.network).toEqual({ mode: "host", allow: [] });
  });

  test("deactivate drops the active network policy", async () => {
    const { controller, profileStore } = createFixture();
    await profileStore.create({ profile: validProfile("profile-a") });
    await controller.activate({
      profileId: "profile-a",
      facts: validFacts(),
      subject: subject(),
    });
    expect(controller.getActiveNetworkPolicy()).not.toBeNull();
    const deactivated = await controller.deactivate();
    expect(deactivated.ok).toBe(true);
    expect(controller.getActiveNetworkPolicy()).toBeNull();
  });
});
