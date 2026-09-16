import { describe, expect, test } from "bun:test";
import {
  CodexAuthorityService,
  CodexProfileAuthorityService,
  type CodexBindingMutationPort,
  type CodexCanonicalBindingFacts,
  type CodexProfilePersistencePort,
  type CodexRelaySessionAuthorityPort,
} from "../../src/codex/authority";

const now = new Date("2026-07-27T10:00:00.000Z");
const request = {
  actorId: crypto.randomUUID(),
  agentId: crypto.randomUUID(),
  taskId: crypto.randomUUID(),
  taskRunId: crypto.randomUUID(),
  jobId: crypto.randomUUID(),
  roomId: crypto.randomUUID(),
  profileId: crypto.randomUUID(),
  laneKey: `room:${crypto.randomUUID()}`,
  posture: "codex_default" as const,
  collaborationMode: "work" as const,
};
const canonical: CodexCanonicalBindingFacts = {
  userId: crypto.randomUUID(),
  agentId: crypto.randomUUID(),
  taskId: crypto.randomUUID(),
  taskRunId: crypto.randomUUID(),
  jobId: crypto.randomUUID(),
  parentTaskId: null,
  roomId: crypto.randomUUID(),
  laneKey: `room:${crypto.randomUUID()}`,
  profileId: crypto.randomUUID(),
  relayId: "relay",
  profileHandle: "profile",
  profileGeneration: 2,
  accountGeneration: 3,
};
const facts = { resolve: async () => canonical };
const mutation = {
  bindingKind: "task" as const,
  codexThreadId: "thread",
  selectedModel: null,
};

type Session = NonNullable<
  ReturnType<CodexRelaySessionAuthorityPort["getCodexSession"]>
>;
function liveSession(
  input: {
    state?: "ready" | "limited" | "runtime_unavailable";
    compatibility?:
      | "certified"
      | "compatible_uncertified"
      | "limited"
      | "incompatible";
    protocol?: number;
    hostKind?: string;
    capabilityVersion?: number;
    capabilityRevision?: number;
    currentCapabilityRevision?: number;
    runtimeGeneration?: number;
    currentRuntimeGeneration?: number;
    stableConversation?: boolean;
    collaborationMode?: boolean;
    relaySessionId?: string;
    profileGeneration?: number;
    accountGeneration?: number;
    childGeneration?: number;
    profileState?: "signed_in" | "signed_out";
    issuedAt?: string;
    expiresAt?: string;
    correlationRelaySessionId?: string;
  } = {},
): Session {
  const capabilityRevision = input.capabilityRevision ?? 4;
  const relaySessionId = input.relaySessionId ?? "relay-session";
  const protocol = input.protocol ?? 8;
  return {
    relayId: canonical.relayId,
    userId: canonical.userId,
    relaySessionId,
    pairingGenerationRef: "pairing",
    desktopSessionId: "desktop",
    selectedProtocolVersion: protocol,
    capability: {
      version: input.capabilityVersion ?? 1,
      hostKind: input.hostKind ?? "electron",
    },
    capabilityRevision,
    currentCapabilityRevision:
      input.currentCapabilityRevision ?? capabilityRevision,
    currentRuntimeGeneration: input.currentRuntimeGeneration ?? 5,
    statusCorrelation: {
      relayId: canonical.relayId,
      relaySessionId:
        input.correlationRelaySessionId ?? relaySessionId,
      desktopSessionId: "desktop",
      pairingGenerationRef: "pairing",
      selectedProtocolVersion: protocol,
      capabilityRevision,
    },
    status: {
      state: input.state ?? "ready",
      compatibility: input.compatibility ?? "certified",
      features: {
        stableConversation: input.stableConversation ?? true,
        explicitSteer: true,
        codexApprovals: true,
        requestUserInput: true,
        collaborationMode: input.collaborationMode ?? false,
      },
      runtimeGeneration: input.runtimeGeneration ?? 5,
      profiles: [
        {
          profileHandle: canonical.profileHandle,
          profileGeneration:
            input.profileGeneration ?? canonical.profileGeneration,
          accountGeneration:
            input.accountGeneration ?? canonical.accountGeneration,
          childGeneration: input.childGeneration ?? 6,
          state: input.profileState ?? "signed_in",
        },
      ],
      workspace: {
        state: "bound",
        receipt: {
          workspaceRef: "workspace",
          revision: 7,
          fingerprint: "fingerprint",
          issuedAt: input.issuedAt ?? "2026-07-27T09:55:00.000Z",
          expiresAt: input.expiresAt ?? "2026-07-27T10:05:00.000Z",
        },
      },
    },
  };
}

function sessionWithoutCompatibility(): Session {
  const session = liveSession();
  const { compatibility: _compatibility, ...status } = session.status!;
  return { ...session, status };
}

function bindingSpy() {
  const scopes: unknown[] = [];
  const port: CodexBindingMutationPort = {
    insert: async (scope) => {
      scopes.push(scope);
      return "inserted";
    },
    replace: async (scope) => {
      scopes.push(scope);
      return "replaced";
    },
    update: async (scope) => {
      scopes.push(scope);
      return "updated";
    },
    archive: async (scope) => {
      scopes.push(scope);
      return "archived";
    },
    rebind: async (scope) => {
      scopes.push(scope);
      return "rebound";
    },
  };
  return { port, scopes };
}

async function expectFailure(
  operation: () => Promise<unknown>,
  code: string,
) {
  try {
    await operation();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("Codex binding authority", () => {
  test("accepts exact ready and limited baselines and uses canonical facts", async () => {
    for (const session of [
      liveSession(),
      liveSession({ protocol: 9 }),
      liveSession({ state: "limited", compatibility: "limited" }),
      liveSession({ compatibility: "compatible_uncertified" }),
    ]) {
      const spy = bindingSpy();
      const service = new CodexAuthorityService(
        facts,
        { getCodexSession: () => session },
        spy.port,
        () => now,
      );
      expect(await service.insertBinding(request, mutation)).toBe("inserted");
      expect(spy.scopes[0]).toMatchObject({
        userId: canonical.userId,
        agentId: canonical.agentId,
        taskId: canonical.taskId,
        taskRunId: canonical.taskRunId,
        jobId: canonical.jobId,
        roomId: canonical.roomId,
        profileId: canonical.profileId,
        selectedProtocolVersion: session.selectedProtocolVersion,
        runtimeGeneration: 5,
        childGeneration: 6,
      });
    }
  });

  test("admits Plan only when the exact authenticated runtime advertises it", async () => {
    const plan = { ...request, collaborationMode: "plan" as const };
    const unavailable = new CodexAuthorityService(
      facts,
      { getCodexSession: () => liveSession({ collaborationMode: false }) },
      bindingSpy().port,
      () => now,
    );
    await expectFailure(
      () => unavailable.insertBinding(plan, mutation),
      "CODEX_STALE",
    );
    const ready = new CodexAuthorityService(
      facts,
      { getCodexSession: () => liveSession({ collaborationMode: true }) },
      bindingSpy().port,
      () => now,
    );
    expect(await ready.insertBinding(plan, mutation)).toBe("inserted");
  });

  test("rejects unavailable, incompatible, missing compatibility, and unstable conversation", async () => {
    const cases: Session[] = [
      liveSession({ state: "runtime_unavailable" }),
      liveSession({ compatibility: "incompatible" }),
      sessionWithoutCompatibility(),
      liveSession({ stableConversation: false }),
    ];
    for (const session of cases) {
      const spy = bindingSpy();
      const service = new CodexAuthorityService(
        facts,
        { getCodexSession: () => session },
        spy.port,
        () => now,
      );
      await expectFailure(
        () => service.insertBinding(request, mutation),
        "CODEX_STALE",
      );
      expect(spy.scopes).toHaveLength(0);
    }
  });


  test("rejects non-v8, non-Electron, stale revisions/generations, and socket mismatch", async () => {
    const cases: Array<[Session, string]> = [
      [liveSession({ protocol: 7 }), "CODEX_UNAVAILABLE"],
      [liveSession({ hostKind: "headless" }), "CODEX_UNAVAILABLE"],
      [liveSession({ capabilityVersion: 2 }), "CODEX_UNAVAILABLE"],
      [liveSession({ currentCapabilityRevision: 99 }), "CODEX_UNAVAILABLE"],
      [liveSession({ runtimeGeneration: 99 }), "CODEX_STALE"],
      [
        liveSession({ correlationRelaySessionId: "other-session" }),
        "CODEX_UNAVAILABLE",
      ],
      [liveSession({ relaySessionId: " " }), "CODEX_UNAVAILABLE"],
    ];
    for (const [session, code] of cases) {
      const service = new CodexAuthorityService(
        facts,
        { getCodexSession: () => session },
        bindingSpy().port,
        () => now,
      );
      await expectFailure(
        () => service.insertBinding(request, mutation),
        code,
      );
    }
  });

  test("rejects profile and canonical receipt mismatch", async () => {
    const cases = [
      liveSession({ profileGeneration: 99 }),
      liveSession({ accountGeneration: 99 }),
      liveSession({ profileState: "signed_out" }),
      liveSession({ childGeneration: -1 }),
      liveSession({ issuedAt: "2026-07-27T10:00:00.000Z" }),
      liveSession({ expiresAt: "2026-07-27T10:00:00.000Z" }),
      liveSession({ issuedAt: "not-an-iso-date" }),
    ];
    for (const session of cases) {
      const service = new CodexAuthorityService(
        facts,
        { getCodexSession: () => session },
        bindingSpy().port,
        () => now,
      );
      await expectFailure(
        () => service.insertBinding(request, mutation),
        "CODEX_STALE",
      );
    }
  });

  test("forged canonical resolution never reaches persistence", async () => {
    const spy = bindingSpy();
    const service = new CodexAuthorityService(
      {
        resolve: async () => {
          throw new Error("actor/task/profile mismatch");
        },
      },
      { getCodexSession: () => liveSession() },
      spy.port,
    );
    await expectFailure(
      () => service.insertBinding(request, mutation),
      "CODEX_FORBIDDEN",
    );
    expect(spy.scopes).toHaveLength(0);
  });
});

describe("Codex profile authority", () => {
  const profileFacts = {
    userId: canonical.userId,
    agentId: canonical.agentId,
    relayId: canonical.relayId,
    profileId: canonical.profileId,
    profileHandle: canonical.profileHandle,
    profileGeneration: canonical.profileGeneration,
    accountGeneration: canonical.accountGeneration,
  };
  const correlated = {
    relayId: canonical.relayId,
    relaySessionId: "relay-session",
    desktopSessionId: "desktop",
    pairingGenerationRef: "pairing",
    selectedProtocolVersion: 8,
    capabilityRevision: 4,
    profileHandle: canonical.profileHandle,
    homeHandle: "home-handle",
    profileGeneration: canonical.profileGeneration,
    accountGeneration: canonical.accountGeneration,
    authState: "signed_in" as const,
  };

  function profileSpy() {
    const calls: string[] = [];
    const port: CodexProfilePersistencePort = {
      createProfile: async () => {
        calls.push("create");
        return "created";
      },
      updateProfileStatus: async () => {
        calls.push("status");
        return "updated";
      },
    };
    return { calls, port };
  }

  test("accepts correlated creation and status", async () => {
    const spy = profileSpy();
    const service = new CodexProfileAuthorityService(
      {
        resolveRelay: async () => profileFacts,
        resolveProfile: async () => profileFacts,
      },
      { getCodexSession: () => liveSession() },
      spy.port,
    );
    expect(
      await service.createProfile({
        actorId: request.actorId,
        label: "Primary",
        result: correlated,
      }),
    ).toBe("created");
    expect(
      await service.updateProfileStatus({
        actorId: request.actorId,
        profileId: request.profileId,
        expectedRevision: 0,
        result: correlated,
      }),
    ).toBe("updated");
    expect(spy.calls).toEqual(["create", "status"]);
  });

  test("rejects uncorrelated host result and unreachable profile/default", async () => {
    const spy = profileSpy();
    const service = new CodexProfileAuthorityService(
      {
        resolveRelay: async () => profileFacts,
        resolveProfile: async () => profileFacts,
      },
      {
        getCodexSession: () =>
          liveSession({ profileState: "signed_out" }),
      },
      spy.port,
    );
    await expectFailure(
      () =>
        service.createProfile({
          actorId: request.actorId,
          label: "Primary",
          result: { ...correlated, relaySessionId: "forged" },
        }),
      "CODEX_STALE",
    );
    expect(spy.calls).toHaveLength(0);
  });
});
