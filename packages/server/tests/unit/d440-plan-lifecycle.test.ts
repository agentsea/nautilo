/**
 * D440 Phase 0 task 0.2.2 — executable lifecycle trace.
 *
 * Owners and revisions pinned here:
 *   1. server `InMemoryWorkstationSessionRegistry`: actor/binding tuple,
 *      profileRevision=4, capabilityRevision=12, grant ids, activatedAt;
 *   2. server `InMemoryRelayRegistry`: authenticated relay/user association,
 *      desktopSessionId, server-derived pairingGeneration, atomic capability
 *      revision, and advisory profile snapshot;
 *   3. server `createWorkstationApprovalOverrideResolver`: admits a transient
 *      plan for the toolCallId from the exact live session + relay fingerprint;
 *   4. runtime plan registry: five-minute default TTL, lazy expiry, explicit
 *      toolCall invalidation, binding invalidation, and shutdown clear;
 *   5. agent/relay phases (pinned in adjacent D440 tests): plan becomes
 *      `workstationShellBinding`; Electron reloads durable grants and profile
 *      state, authorizes Current Folder independently, and rebuilds the local
 *      sandbox envelope.
 *
 * Production app wiring maps relay unregister, desktop-session replacement,
 * pairing-generation replacement, and profile-snapshot clearing to
 * `invalidateForBinding`. Those same hooks are wired in this fixture rather
 * than mocked after the transition.
 */

import { describe, expect, test } from "bun:test";
import type { ToolCall } from "@langchain/core/messages/tool";
import type { RelayCapabilities } from "@nautilo/relay";
import {
  FULL_WORKSTATION_AGENT_SCOPE,
  InMemoryRelayRegistry,
  InMemoryWorkstationDispatchPlanRegistry,
  InMemoryWorkstationSessionRegistry,
  type FullWorkstationBinding,
} from "@nautilo/runtime";
import {
  createWorkstationApprovalOverrideResolver,
  resolveActiveWorkstationDispatchBinding,
  type WorkstationOverrideResolverRequest,
} from "../../src/routes/workstation-access";

const USER = "d440-user";
const RELAY = "d440-relay";
const DESKTOP = "d440-desktop-1";
const START_MS = Date.parse("2026-07-20T12:00:00.000Z");

function binding(overrides: Partial<FullWorkstationBinding> = {}): FullWorkstationBinding {
  return {
    userId: USER,
    instanceId: "instance-1",
    relayId: RELAY,
    desktopSessionId: DESKTOP,
    serverBindingId: "server-binding-1",
    pairingGeneration: "pairing-generation-1",
    agentScope: FULL_WORKSTATION_AGENT_SCOPE,
    profileId: "developer-workstation",
    profileRevision: 4,
    grantIds: ["profile-tools"],
    capabilityRevision: 12,
    ...overrides,
  };
}

function capabilities(options: {
  grantRevision?: number;
  includeProjectGrant?: boolean;
} = {}): RelayCapabilities {
  const includeProjectGrant = options.includeProjectGrant ?? true;
  return {
    profile: "desktop-agent",
    canRunShell: true,
    canReadWorkspace: true,
    canWriteWorkspace: true,
    workstationProfileSnapshot: {
      profileId: "developer-workstation",
      profileRevision: 4,
      grantIds: ["profile-tools"],
      protectedPolicyVersion: 3,
      networkMode: "isolated",
      capabilities: [],
    },
    // D440 Phase 1 — advertise a durable grant-store snapshot so the
    // admitted plan carries a revision-coherent `grantRevision` (8). The
    // snapshot is advisory discovery data; the plan never turns it into
    // filesystem authority (no roots cross the plan boundary).
    desktopFilesystemGrantSnapshot: {
      revision: options.grantRevision ?? 8,
      instanceId: "instance-1",
      agentScope: FULL_WORKSTATION_AGENT_SCOPE,
      grants: [
        {
          id: "profile-tools",
          canonicalRoot: "/opt/homebrew",
          access: ["read", "execute"],
          policyVersion: 3,
          lifetime: "durable",
        },
        ...(includeProjectGrant
          ? [{
              id: "durable-project",
              canonicalRoot: "/Users/d440/exact-project",
              access: ["read", "create_modify", "delete", "execute"] as const,
              policyVersion: 3,
              lifetime: "durable" as const,
            }]
          : []),
      ],
    },
  };
}

function request(toolCallId: string): WorkstationOverrideResolverRequest {
  return {
    userId: USER,
    actorId: "d440-actor",
    roomId: "d440-room",
    currentFolder: "/Users/d440/exact-project",
    workspacePath: "/Users/d440/exact-project",
    toolCall: {
      id: toolCallId,
      name: "run_shell",
      args: { command: "git status --short" },
    } as ToolCall,
  };
}

function lifecycleFixture() {
  let nowMs = START_MS;
  const now = () => new Date(nowMs);
  const sessions = new InMemoryWorkstationSessionRegistry({ now });
  const refs: { relays?: InMemoryRelayRegistry } = {};
  const plans = new InMemoryWorkstationDispatchPlanRegistry({
    now,
    getActiveBinding: ({ userId, currentFolder }) =>
      resolveActiveWorkstationDispatchBinding({
        userId,
        currentFolder,
        sessionRegistry: sessions,
        relayRegistry: refs.relays!,
      }),
  });
  const invalidate = (input: {
    userId: string;
    relayId: string;
    desktopSessionId: string;
  }) => plans.invalidateForBinding(input);
  const relays = new InMemoryRelayRegistry({
    onUnregister: (input) => {
      if (input.desktopSessionId !== null) {
        invalidate({
          userId: input.userId,
          relayId: input.relayId,
          desktopSessionId: input.desktopSessionId,
        });
      }
    },
    onDesktopSessionReplaced: (input) => {
      sessions.invalidateForRelayBinding({
        userId: input.userId,
        serverBindingId: "server-binding-1",
        relayId: input.relayId,
        desktopSessionId: input.previousDesktopSessionId,
      });
      invalidate({
        userId: input.userId,
        relayId: input.relayId,
        desktopSessionId: input.previousDesktopSessionId,
      });
    },
    onPairingGenerationChanged: (input) => {
      sessions.invalidateForRelayBinding({
        userId: input.userId,
        serverBindingId: "server-binding-1",
        relayId: input.relayId,
        desktopSessionId: input.desktopSessionId,
        pairingGeneration: input.previousPairingGeneration,
      });
      invalidate({
        userId: input.userId,
        relayId: input.relayId,
        desktopSessionId: input.desktopSessionId,
      });
    },
    onWorkstationProfileSnapshotCleared: (input) => {
      sessions.invalidateForRelayBinding({
        userId: input.userId,
        serverBindingId: "server-binding-1",
        relayId: input.relayId,
        desktopSessionId: input.desktopSessionId,
        ...(input.pairingGeneration
          ? { pairingGeneration: input.pairingGeneration }
          : {}),
      });
      invalidate({
        userId: input.userId,
        relayId: input.relayId,
        desktopSessionId: input.desktopSessionId,
      });
    },
  });
  refs.relays = relays;

  async function activateAndRegister(
    relayCapabilities: RelayCapabilities = capabilities(),
  ): Promise<void> {
    const exact = binding();
    const activated = sessions.activate(exact, exact);
    if (!activated.ok) throw new Error(activated.reason);
    await relays.register(
      RELAY,
      USER,
      relayCapabilities,
      () => {},
      9,
      DESKTOP,
      12,
      "pairing-generation-1",
    );
  }

  function admit(toolCallId: string) {
    return createWorkstationApprovalOverrideResolver({
      registry: sessions,
      relayRegistry: relays,
      planRegistry: plans,
      now,
    })(request(toolCallId));
  }

  return {
    sessions,
    plans,
    relays,
    now,
    advanceTo: (value: number) => {
      nowMs = value;
    },
    activateAndRegister,
    admit,
  };
}

describe("D440 plan admission, TTL, and invalidation lifecycle", () => {
  test("production binding resolver feeds same-authority readmission with exact live revisions", async () => {
    const f = lifecycleFixture();
    await f.activateAndRegister();

    const fingerprint = {
      userId: USER,
      desktopSessionId: DESKTOP,
      capabilityRevision: 12,
      profileId: "developer-workstation",
      profileRevision: 4,
      pairingGeneration: "pairing-generation-1",
      grantRevision: 8,
      protectedPolicyVersion: 3,
    };
    const readmitted = f.plans.readmit({
      toolCallId: "d440-app-wired-refresh",
      userId: USER,
      currentFolder: "/Users/d440/exact-project",
      executionClass: "profile_bound_sandbox",
      fingerprint,
    });

    expect(readmitted).toMatchObject({
      toolCallId: "d440-app-wired-refresh",
      userId: USER,
      relayId: RELAY,
      grantRevision: 8,
      protectedPolicyVersion: 3,
      currentFolder: "/Users/d440/exact-project",
    });
  });

  test("production binding resolver rejects a non-exact user binding", async () => {
    const f = lifecycleFixture();
    await f.activateAndRegister();

    expect(
      resolveActiveWorkstationDispatchBinding({
        userId: "foreign-user",
        currentFolder: "/Users/d440/exact-project",
        sessionRegistry: f.sessions,
        relayRegistry: f.relays,
      }),
    ).toBeNull();
  });

  test("same-authority readmission does not require a duplicate exact Current Folder grant", async () => {
    const f = lifecycleFixture();
    await f.activateAndRegister(capabilities({
      grantRevision: 8,
      includeProjectGrant: false,
    }));

    const before = f.plans.readmit({
      toolCallId: "d440-without-project-grant",
      userId: USER,
      currentFolder: "/Users/d440/exact-project",
      executionClass: "profile_bound_sandbox",
      fingerprint: {
        userId: USER,
        desktopSessionId: DESKTOP,
        capabilityRevision: 12,
        profileId: "developer-workstation",
        profileRevision: 4,
        pairingGeneration: "pairing-generation-1",
        grantRevision: 8,
        protectedPolicyVersion: 3,
      },
    });

    expect(before).toMatchObject({
      capabilityRevision: 12,
      grantRevision: 8,
      currentFolder: "/Users/d440/exact-project",
    });

    expect(
      f.relays.updateCapabilities({
        relayId: RELAY,
        userId: USER,
        desktopSessionId: DESKTOP,
        capabilityRevision: 13,
        capabilities: capabilities({
          grantRevision: 9,
          includeProjectGrant: true,
        }),
      }),
    ).toEqual({ ok: true });

    const refreshed = f.plans.readmit({
      toolCallId: "d440-after-project-grant",
      userId: USER,
      currentFolder: "/Users/d440/exact-project",
      executionClass: "profile_bound_sandbox",
      fingerprint: {
        userId: USER,
        desktopSessionId: DESKTOP,
        capabilityRevision: 13,
        profileId: "developer-workstation",
        profileRevision: 4,
        pairingGeneration: "pairing-generation-1",
        grantRevision: 9,
        protectedPolicyVersion: 3,
      },
    });

    expect(refreshed).toMatchObject({
      capabilityRevision: 13,
      grantRevision: 9,
      currentFolder: "/Users/d440/exact-project",
    });
  });

  test("server admission copies the exact owner/revision tuple and no filesystem authority", async () => {
    const f = lifecycleFixture();
    await f.activateAndRegister();

    const decision = f.admit("d440-call");
    const plan = f.plans.get("d440-call");

    expect(decision.override).toBe("auto");
    expect(plan).toEqual({
      toolCallId: "d440-call",
      userId: USER,
      relayId: RELAY,
      instanceId: "instance-1",
      desktopSessionId: DESKTOP,
      serverBindingId: "server-binding-1",
      pairingGeneration: "pairing-generation-1",
      profileId: "developer-workstation",
      profileRevision: 4,
      grantIds: ["profile-tools"],
      capabilityRevision: 12,
      executionClass: "profile_bound_sandbox",
      admittedAt: "2026-07-20T12:00:00.000Z",
      // D440 Phase 1 — revision-coherent binding metadata admitted from
      // the live relay's advisory snapshots + the per-dispatch Current
      // Folder. These are non-secret binding fields, NOT filesystem
      // authority (roots / sandboxProfile remain absent below).
      currentFolder: "/Users/d440/exact-project",
      grantRevision: 8,
      protectedPolicyVersion: 3,
    });
    expect(plan).not.toHaveProperty("roots");
    expect(plan).not.toHaveProperty("sandboxProfile");
  });

  test("default plan TTL is exactly five minutes with lazy expiry after the boundary", async () => {
    const f = lifecycleFixture();
    await f.activateAndRegister();
    f.admit("d440-ttl");

    f.advanceTo(START_MS + 5 * 60_000);
    expect(f.plans.get("d440-ttl")).not.toBeNull();

    f.advanceTo(START_MS + 5 * 60_000 + 1);
    expect(f.plans.get("d440-ttl")).toBeNull();
  });

  test("explicit tool-call invalidation and shutdown clear own the remaining registry exits", async () => {
    const f = lifecycleFixture();
    await f.activateAndRegister();
    f.admit("d440-one");
    f.admit("d440-two");

    f.plans.invalidate("d440-one");
    expect(f.plans.get("d440-one")).toBeNull();
    expect(f.plans.get("d440-two")).not.toBeNull();

    f.plans.clear();
    expect(f.plans.size()).toBe(0);
  });

  test("relay unregister invalidates plans but preserves the active workstation session", async () => {
    const f = lifecycleFixture();
    await f.activateAndRegister();
    f.admit("d440-unregister");

    await f.relays.unregister(RELAY);

    expect(f.plans.get("d440-unregister")).toBeNull();
    expect(f.sessions.get(USER)).not.toBeNull();
  });

  test("desktop-session replacement invalidates both session and plans", async () => {
    const f = lifecycleFixture();
    await f.activateAndRegister();
    f.admit("d440-desktop-replaced");

    await f.relays.register(
      RELAY,
      USER,
      capabilities(),
      () => {},
      7,
      "d440-desktop-2",
      12,
      "pairing-generation-1",
    );

    expect(f.plans.get("d440-desktop-replaced")).toBeNull();
    expect(f.sessions.get(USER)).toBeNull();
  });

  test("pairing-generation replacement invalidates both session and plans", async () => {
    const f = lifecycleFixture();
    await f.activateAndRegister();
    f.admit("d440-repaired");

    await f.relays.register(
      RELAY,
      USER,
      capabilities(),
      () => {},
      7,
      DESKTOP,
      12,
      "pairing-generation-2",
    );

    expect(f.plans.get("d440-repaired")).toBeNull();
    expect(f.sessions.get(USER)).toBeNull();
  });

  test("profile-snapshot clearing invalidates both session and plans", async () => {
    const f = lifecycleFixture();
    await f.activateAndRegister();
    f.admit("d440-profile-cleared");

    const updated = f.relays.updateCapabilities({
      relayId: RELAY,
      userId: USER,
      desktopSessionId: DESKTOP,
      capabilityRevision: 13,
      capabilities: {
        profile: "desktop-agent",
        canRunShell: true,
      },
    });

    expect(updated).toEqual({ ok: true });
    expect(f.plans.get("d440-profile-cleared")).toBeNull();
    expect(f.sessions.get(USER)).toBeNull();
  });
});
