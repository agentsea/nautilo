import { describe, expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import type { DirectDatabase } from "@nautilo/db";
import type { ProtectedTaskAuthorityOccurrence } from "@nautilo/runtime";
import type { LocalExecutionDelegation } from "@nautilo/types";

import {
  inspectProtectedTaskLocalExecutionReadiness,
  resolveProtectedTaskLocalExecutionPort,
} from "../../src/routes/protected-task-local-execution";

const ids = { task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  owner: "30000000-0000-4000-8000-000000000003",
  agent: "40000000-0000-4000-8000-000000000004",
  room: "50000000-0000-4000-8000-000000000005",
  namespace: "60000000-0000-4000-8000-000000000006" };
const fingerprint = new Uint8Array(32).fill(7);
const delegation: LocalExecutionDelegation = { version: 1, humanUserId: ids.owner,
  agentId: ids.agent, sourceRoomId: ids.room, sourceConversationId: `room:${ids.room}:bot:${ids.agent}`,
  rootTaskId: ids.task, projectGrantId: "grant", ceiling: "basic", profile: null,
  target: { instanceId: "instance", relayId: "relay", pairingGeneration: "pairing",
    serverOrigin: "https://server.example", serverFingerprint: "fingerprint" } };
const task = { id: ids.task, ownerId: ids.agent, requestorId: ids.owner,
  agentId: ids.agent, callingRoomId: ids.room, parentTaskId: null, targetRoomId: ids.room,
  scheduleKind: "now" as const, status: "running" as const,
  localExecutionDelegation: delegation, contentRepresentation: "protected" as const,
  contentNamespaceId: ids.namespace, contentRevision: 1, cryptoObjectId: "object",
  cryptoAccessRevision: 0, cryptoRequiredNamespaceFingerprint: fingerprint,
  cryptoMappingState: "verified" as const };
const run = { id: ids.run, taskId: ids.task, jobId: "job", graphThreadId: "thread",
  status: "running" as const };
const occurrence: ProtectedTaskAuthorityOccurrence = { task: { id: task.id, ownerId: task.ownerId,
  requestorId: task.requestorId, agentId: task.agentId, callingRoomId: task.callingRoomId,
  scheduleKind: task.scheduleKind, contentRepresentation: task.contentRepresentation,
  contentNamespaceId: task.contentNamespaceId, contentRevision: task.contentRevision,
  cryptoObjectId: task.cryptoObjectId, cryptoAccessRevision: task.cryptoAccessRevision,
  cryptoRequiredNamespaceFingerprint: fingerprint }, run: { ...run, startedAt: new Date(0) } };

function deps(overrides: Record<string, unknown> = {}) {
  return { readTask: async () => task, readRun: async () => run,
    assertPublicSource: async () => ({ humanActorId: "actor",
      source: { id: ids.room, graphThreadId: `room:${ids.room}` },
      calling: { id: ids.room, graphThreadId: `room:${ids.room}`, agentActorId: "agent-actor" } }),
    isTargetAvailable: () => true, ...overrides };
}

describe("protected Task local execution", () => {
  test("gates an exact delegated occurrence before claim and waits while its target is offline", async () => {
    expect(await inspectProtectedTaskLocalExecutionReadiness({ db: {} as DirectDatabase, occurrence }, deps()))
      .toEqual({ status: "ready" });
    expect(await inspectProtectedTaskLocalExecutionReadiness({ db: {} as DirectDatabase, occurrence },
      deps({ isTargetAvailable: () => false }))).toEqual({ status: "waiting" });
    expect(await inspectProtectedTaskLocalExecutionReadiness({ db: {} as DirectDatabase, occurrence },
      deps({ readTask: async () => ({ ...task, localExecutionDelegation: null }) })))
      .toEqual({ status: "not_required" });
  });

  test("brackets every admitted effect with current protected and public authority", async () => {
    const calls: string[] = [];
    const port = await resolveProtectedTaskLocalExecutionPort({ db: {} as DirectDatabase,
      occurrence, signal: new AbortController().signal,
      assertCurrentTaskAuthority: async () => { calls.push("protected"); } },
    deps({ assertPublicSource: async () => { calls.push("public"); return { humanActorId: "actor",
      source: { id: ids.room, graphThreadId: "thread" },
      calling: { id: ids.room, graphThreadId: "thread", agentActorId: "agent-actor" } }; } }));
    expect(port).toBeDefined();
    calls.length = 0;
    await port!.withAdmission("start", async admission => {
      expect(admission.delegation).toEqual(delegation);
    });
    expect(calls).toEqual(["protected", "public", "protected", "protected", "public", "protected"]);
  });

  test("fails closed when the occurrence or public authority changes", async () => {
    await rejects(inspectProtectedTaskLocalExecutionReadiness({ db: {} as DirectDatabase, occurrence },
      deps({ readRun: async () => ({ ...run, jobId: "other" }) })), /occurrence changed/u);
    await rejects(inspectProtectedTaskLocalExecutionReadiness({ db: {} as DirectDatabase, occurrence },
      deps({ assertPublicSource: async () => { throw new Error("revoked"); } })), /revoked/u);
  });
});
