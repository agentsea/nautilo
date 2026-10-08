import { describe, expect, test } from "bun:test";
import Fastify from "fastify";
import type { ChallengeProvider } from "@nautilo/trust";
import { InMemoryRelayRegistry, InMemoryWorkstationSessionRegistry, FULL_WORKSTATION_AGENT_SCOPE,
  type FullWorkstationBinding } from "@nautilo/runtime";
import type { RelayLocalExecutionBindingV1, RelayServerMessage, RelayWorkstationShellBinding } from "@nautilo/relay";
import { createWorkstationManagedExecutionRevoker, createWorkstationAuthorityReconciler, reconcileWorkstationEffectiveAuthority,
  workstationAccessRoutes } from "../../src/routes/workstation-access";

const session: FullWorkstationBinding = { userId: "human-fixture", instanceId: "instance-fixture", relayId: "relay-fixture",
  desktopSessionId: "desktop-fixture", serverBindingId: "server-fixture", pairingGeneration: "pairing-fixture",
  agentScope: FULL_WORKSTATION_AGENT_SCOPE, profileId: "profile-fixture", profileRevision: 1,
  grantIds: ["grant-a", "grant-b"], capabilityRevision: 1 };
const capabilities = { profile: "desktop-agent" as const, canExecuteLocal: true,
  localExecution: { version: 1 as const, generation: "generation-fixture", pipe: true as const, pty: true, capacity: 8 } };
async function fixture(holdStarts = false) {
  const sent: RelayServerMessage[] = [];
  const relay = new InMemoryRelayRegistry();
  const receive = (message: RelayServerMessage) => {
    sent.push(message);
    if (message.type === "relay:dispatch" && !holdStarts) relay.resolveDispatch(message.correlationId,
      { status: "ok", result: { state: "running", resources: "owned", session_id: message.localExecutionBinding?.executionId } });
  };
  await relay.register(session.relayId, session.userId, capabilities, receive, 20, session.desktopSessionId,
    session.capabilityRevision, session.pairingGeneration);
  const registry = new InMemoryWorkstationSessionRegistry({ onAuthorityRevoked: createWorkstationManagedExecutionRevoker(() => relay) });
  registry.activate(session, session);
  const start = (executionId: string, grants = session.grantIds, profileId = session.profileId) => {
    const shell: RelayWorkstationShellBinding = { version: 2, toolCallId: `call-${executionId}`, relayId: session.relayId,
      desktopSessionId: session.desktopSessionId, serverBindingId: session.serverBindingId, pairingGeneration: session.pairingGeneration,
      profileId, profileRevision: session.profileRevision, grantIds: grants, capabilityRevision: 1, currentFolder: "/fixture/project",
      grantRevision: 1, protectedPolicyVersion: 1, subject: { userId: session.userId, instanceId: session.instanceId,
        relayId: session.relayId, agentScope: session.agentScope }, operation: "execute", executionClass: "profile_bound_sandbox" };
    const binding: RelayLocalExecutionBindingV1 = { version: 1, generation: capabilities.localExecution.generation,
      executionId, invocationId: shell.toolCallId, operation: "start", owner: { instanceId: session.instanceId, humanUserId: session.userId,
        agentId: "agent-fixture", runId: "run-fixture", conversationId: "conversation-fixture", relayId: session.relayId,
        desktopSessionId: session.desktopSessionId, pairingGeneration: relay.getLocalExecutionPairingGeneration(session.relayId)!,
        serverBindingId: session.serverBindingId, profileId, profileRevision: 1, grantIds: grants, grantRevision: 1, protectedPolicyVersion: 1 } };
    const request = { toolName: "exec_command", args: { cmd: "echo fixture" }, impact: "destructive" as const,
      approvalObtained: true, localExecutionBinding: binding, workstationShellBinding: shell };
    return { binding, shell, request, result: relay.dispatch(session.relayId, request) };
  };
  return { relay, registry, sent, receive, start };
}
function stops(sent: RelayServerMessage[]) {
  return sent.filter(message => message.type === "relay:dispatch" && message.localExecutionBinding?.operation === "cancel");
}

describe("production managed Workstation revocation", () => {
  test("authenticated disable fences exact work, denies later read/input, and retains owner cleanup", async () => {
    const { relay, registry, sent, start } = await fixture();
    const owned = start("owned-execution"); await owned.result;
    const unrelated = start("unrelated-profile", session.grantIds, "other-profile"); await unrelated.result;
    const app = Fastify();
    app.decorateRequest("sessionUserId", null);
    app.addHook("preHandler", async request => { request.sessionUserId = session.userId; });
    workstationAccessRoutes(app, { registry, relayRegistry: relay, pinProvider: {} as ChallengeProvider,
      getCapabilities: () => Promise.resolve([]), relayBindingProvider: { resolve: () => Promise.resolve(session) }, auditEvent: () => {} });
    try {
      const response = await app.inject({ method: "POST", url: "/api/workstation-access/disable" });
      expect(response.statusCode).toBe(200);
      expect(stops(sent)).toHaveLength(1);
      const stop = stops(sent)[0];
      expect(stop?.type === "relay:dispatch" ? stop.localExecutionBinding?.executionId : null).toBe("owned-execution");
      for (const operation of ["read", "input"] as const) {
        expect(relay.dispatch(session.relayId, { toolName: "write_stdin", args: { session_id: owned.binding.executionId,
          ...(operation === "input" ? { chars: "echo fixture\n" } : {}) }, impact: "destructive", approvalObtained: true,
          localExecutionBinding: { ...owned.binding, invocationId: `call-${operation}`, operation }, workstationShellBinding: owned.shell })).rejects.toThrow("OWNER_FENCED");
      }
      await relay.dispatch(session.relayId, { toolName: "write_stdin", args: { session_id: owned.binding.executionId, cancel: true },
        impact: "destructive", approvalObtained: true, localExecutionBinding: { ...owned.binding, invocationId: "cleanup-call", operation: "cancel" } });
      await relay.dispatch(session.relayId, { toolName: "write_stdin", args: { session_id: unrelated.binding.executionId },
        impact: "destructive", approvalObtained: true, localExecutionBinding: { ...unrelated.binding, invocationId: "unrelated-read", operation: "read" } });
      const count = stops(sent).length;
      await app.inject({ method: "POST", url: "/api/workstation-access/disable" });
      expect(stops(sent)).toHaveLength(count);
    } finally { await app.close(); }
  });

  test("grant reduction selects affected records; capability-only refresh and broadening preserve them", async () => {
    const { registry, sent, start } = await fixture();
    await start("grant-a-execution", ["grant-a"]).result;
    await start("grant-b-execution", ["grant-b"]).result;
    const refresh = { ...session, capabilityRevision: 2 };
    registry.activate(refresh, refresh);
    expect(stops(sent)).toHaveLength(0);
    const broader = { ...refresh, capabilityRevision: 3, grantIds: [...session.grantIds, "grant-c"] };
    registry.activate(broader, broader);
    expect(stops(sent)).toHaveLength(0);
    const narrower = { ...broader, capabilityRevision: 4, grantIds: ["grant-b", "grant-c"] };
    registry.activate(narrower, narrower);
    expect(stops(sent)).toHaveLength(1);
    const stop = stops(sent)[0];
    expect(stop?.type === "relay:dispatch" ? stop.localExecutionBinding?.executionId : null).toBe("grant-a-execution");
  });

  test("offline revocation survives temporary discovery loss and reconnects only to the exact original host", async () => {
    const { relay, registry, sent, receive, start } = await fixture();
    await start("offline-execution").result;
    await relay.unregister(session.relayId);
    expect(stops(sent)).toHaveLength(0);
    registry.disable(session.userId);
    await relay.register(session.relayId, session.userId, { profile: "desktop-agent", canRunShell: true }, receive,
      20, session.desktopSessionId, 2, session.pairingGeneration);
    expect(stops(sent)).toHaveLength(0);
    await relay.register(session.relayId, session.userId, capabilities, receive, 20, session.desktopSessionId, 3, session.pairingGeneration);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(stops(sent)).toHaveLength(1);
  });

  test("late start success cannot cross revoked authority", async () => {
    const { relay, registry, sent, start } = await fixture(true);
    const owned = start("late-execution");
    const result = owned.result.catch((error: unknown) => error);
    registry.disable(session.userId);
    const request = sent[0];
    if (request?.type !== "relay:dispatch") throw new Error("missing dispatch fixture");
    relay.resolveDispatch(request.correlationId, { status: "ok", result: { state: "running", resources: "owned" } });
    expect(await result).toMatchObject({ runShellOutcome: "unknown" });
  });

  test("successful membership reconciliation preserves other grants and fences lost capability or unavailable authority", async () => {
    const first = await fixture(); await first.start("membership-execution").result;
    expect(await reconcileWorkstationEffectiveAuthority({ userId: session.userId, registry: first.registry,
      getCapabilities: () => Promise.resolve(["use_workstation"]) })).toBe("retained");
    expect(stops(first.sent)).toHaveLength(0);
    expect(await reconcileWorkstationEffectiveAuthority({ userId: session.userId, registry: first.registry,
      getCapabilities: () => Promise.resolve([]) })).toBe("revoked");
    expect(stops(first.sent)).toHaveLength(1);
    const second = await fixture(); await second.start("unavailable-execution").result;
    expect(await reconcileWorkstationEffectiveAuthority({ userId: session.userId, registry: second.registry,
      getCapabilities: () => Promise.reject(new Error("authority unavailable")) })).toBe("unavailable");
    expect(stops(second.sent)).toHaveLength(1);
  });

  test("sessions without managed work emit no cancellation", async () => {
    const { registry, sent } = await fixture();
    registry.disable(session.userId);
    expect(stops(sent)).toHaveLength(0);
    const completed = await fixture(true);
    const started = completed.start("completed-execution");
    const request = completed.sent[0];
    if (request?.type !== "relay:dispatch") throw new Error("missing dispatch fixture");
    completed.relay.resolveDispatch(request.correlationId, { status: "ok", result: { state: "completed", resources: "released" } });
    await started.result;
    completed.registry.disable(session.userId);
    expect(stops(completed.sent)).toHaveLength(0);
  });

  test("authority replacement cancels the old binding before admitting the new one", async () => {
    for (const replacement of [{ instanceId: "replacement-instance" }, { relayId: "replacement-relay" },
      { serverBindingId: "replacement-server" }, { profileRevision: 2 },
      { desktopSessionId: "replacement-desktop" }, { pairingGeneration: "replacement-pairing" }]) {
      const { registry, sent, start } = await fixture();
      await start("replaced-execution").result;
      const next = { ...session, ...replacement, capabilityRevision: 2 };
      expect(registry.activate(next, next).ok).toBe(true);
      expect(stops(sent)).toHaveLength(1);
      expect(registry.get(session.userId)?.serverBindingId).toBe(next.serverBindingId);
    }
  });

  test("explicit invalidation selects the original tuple and ignores foreign bindings", async () => {
    const { relay, registry, sent, start } = await fixture();
    await start("invalidated-execution").result;
    for (const field of ["userId", "instanceId", "relayId", "desktopSessionId", "serverBindingId", "pairingGeneration", "profileId"] as const) {
      expect(relay.revokeLocalExecutionsForWorkstationBinding({ ...session, [field]: "foreign-fixture" })).toBe(0);
    }
    expect(stops(sent)).toHaveLength(0);
    expect(registry.invalidateForRelayBinding({ userId: session.userId, serverBindingId: session.serverBindingId,
      relayId: session.relayId, desktopSessionId: session.desktopSessionId, pairingGeneration: session.pairingGeneration }).invalidated).toBe(true);
    expect(stops(sent)).toHaveLength(1);
  });
  test("generic Role and Group hooks recheck only effective permission and membership hooks target one Human", async () => {
    const { registry, sent, start } = await fixture();
    await start("rbac-execution").result;
    const other = { ...session, userId: "unrelated-human" };
    registry.activate(other, other);
    const checked: string[] = [];
    let removed = false;
    const reconcile = createWorkstationAuthorityReconciler({ registry: () => registry,
      getCapabilities: async userId => { checked.push(userId); return removed && userId === session.userId ? [] : ["use_workstation"]; } });
    await reconcile({ kind: "role.set_capabilities", roleId: "role-fixture", capabilities: [] });
    expect(checked).toEqual([session.userId, other.userId]);
    expect(stops(sent)).toHaveLength(0);
    checked.length = 0; removed = true;
    await reconcile({ kind: "membership.remove", userId: session.userId, groupId: "group-fixture" });
    expect(checked).toEqual([session.userId]);
    expect(stops(sent)).toHaveLength(1);
    expect(registry.get(other.userId)).not.toBeNull();
    await reconcile({ kind: "group.delete", groupId: "group-fixture" });
    expect(stops(sent)).toHaveLength(1);
  });

});
