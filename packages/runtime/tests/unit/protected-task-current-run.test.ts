import { describe, expect, test } from "bun:test";

import { isCurrentProtectedTaskRunForGrant } from "../../src/tasks/protected-task-current-run";

type Input = Parameters<typeof isCurrentProtectedTaskRunForGrant>[0];

const fingerprint = new Uint8Array(32).fill(7);
const fixture: Input = {
  occurrence: {
    task: {
      id: "task", ownerId: "owner", requestorId: "requestor",
      agentId: "agent", callingRoomId: null, scheduleKind: "now",
      contentRepresentation: "protected", contentNamespaceId: "private-namespace",
      contentRevision: 2, cryptoObjectId: "object", cryptoAccessRevision: 4,
      cryptoRequiredNamespaceFingerprint: fingerprint,
    },
    run: {
      id: "run", taskId: "task", jobId: null, graphThreadId: "thread",
      status: "awaiting", startedAt: new Date(0),
    },
  },
  task: {
    id: "task", ownerId: "owner", requestorId: "requestor",
    agentId: "agent", callingRoomId: null, status: "pending", scheduleKind: "now",
    contentRepresentation: "protected", contentNamespaceId: "private-namespace",
    contentRevision: 2, cryptoObjectId: "object", cryptoAccessRevision: 4,
    cryptoRequiredNamespaceFingerprint: fingerprint,
    cryptoMappingState: "verified",
  },
  run: {
    id: "run", taskId: "task", jobId: null, graphThreadId: "thread",
    status: "awaiting", resultRepresentation: "ordinary",
    resultContentNamespaceId: null, resultRevision: 0,
    resultCryptoObjectId: null, resultCryptoAccessRevision: 0,
    resultCryptoRequiredNamespaceFingerprint: null,
    resultCryptoMappingState: "unmapped",
  },
  requestorUserId: "requestor", requestWorkId: "run",
  sourceRoomId: "private-room",
  requesterPrivateRoom: { roomId: "private-room", namespaceId: "private-namespace" },
  phase: "awaiting",
};

describe("current protected Task run for grant", () => {
  test("accepts exact orphan and open-Room source authority", () => {
    expect(isCurrentProtectedTaskRunForGrant(fixture)).toBe(true);
    expect(isCurrentProtectedTaskRunForGrant({
      ...fixture,
      occurrence: { ...fixture.occurrence, task: {
        ...fixture.occurrence.task, callingRoomId: "open-room",
      } },
      task: { ...fixture.task, callingRoomId: "open-room" },
      sourceRoomId: "open-room",
      requesterPrivateRoom: null,
    })).toBe(true);
  });

  test("rejects another requestor, source Room, or private Namespace", () => {
    expect(isCurrentProtectedTaskRunForGrant({ ...fixture, requestorUserId: "peer" })).toBe(false);
    expect(isCurrentProtectedTaskRunForGrant({ ...fixture, sourceRoomId: "other-room" })).toBe(false);
    expect(isCurrentProtectedTaskRunForGrant({
      ...fixture, requesterPrivateRoom: { roomId: "private-room", namespaceId: "other" },
    })).toBe(false);
  });

  test("rejects a stale Task, run, or result mapping", () => {
    expect(isCurrentProtectedTaskRunForGrant({
      ...fixture, task: { ...fixture.task, contentRevision: 3 },
    })).toBe(false);
    expect(isCurrentProtectedTaskRunForGrant({
      ...fixture, requestWorkId: "other-run",
    })).toBe(false);
    expect(isCurrentProtectedTaskRunForGrant({
      ...fixture, run: { ...fixture.run, resultRepresentation: "protected" },
    })).toBe(false);
    expect(isCurrentProtectedTaskRunForGrant({
      ...fixture, task: { ...fixture.task, cryptoMappingState: "stale" },
    })).toBe(false);
  });

  test("running authority requires a started Job and current running pair", () => {
    expect(isCurrentProtectedTaskRunForGrant({ ...fixture, phase: "running" })).toBe(false);
    expect(isCurrentProtectedTaskRunForGrant({
      ...fixture, phase: "running", task: { ...fixture.task, status: "running" },
      run: { ...fixture.run, status: "running", jobId: "job" },
    })).toBe(true);
    expect(isCurrentProtectedTaskRunForGrant({
      ...fixture, phase: "running", task: { ...fixture.task, status: "cancelled" },
      run: { ...fixture.run, status: "running", jobId: "job" },
    })).toBe(false);
  });

  test("accepts a running cron occurrence while its parent Task remains pending", () => {
    expect(isCurrentProtectedTaskRunForGrant({
      ...fixture,
      phase: "running",
      occurrence: {
        ...fixture.occurrence,
        task: { ...fixture.occurrence.task, scheduleKind: "cron" },
      },
      task: { ...fixture.task, scheduleKind: "cron", status: "pending" },
      run: { ...fixture.run, status: "running", jobId: "job" },
    })).toBe(true);
  });

  test("rejects stale or substituted cron schedule facts", () => {
    const cronOccurrence: Input = {
      ...fixture,
      phase: "running",
      occurrence: {
        ...fixture.occurrence,
        task: { ...fixture.occurrence.task, scheduleKind: "cron" },
      },
      task: { ...fixture.task, scheduleKind: "cron", status: "pending" },
      run: { ...fixture.run, status: "running", jobId: "job" },
    };
    expect(isCurrentProtectedTaskRunForGrant({
      ...cronOccurrence,
      task: { ...cronOccurrence.task, scheduleKind: "one_shot" },
    })).toBe(false);
    expect(isCurrentProtectedTaskRunForGrant({
      ...cronOccurrence,
      task: { ...cronOccurrence.task, status: "running" },
    })).toBe(false);
  });

  test("does not give now or one-shot runs the cron pending-parent exception", () => {
    for (const scheduleKind of ["now", "one_shot"] as const) {
      expect(isCurrentProtectedTaskRunForGrant({
        ...fixture,
        phase: "running",
        occurrence: {
          ...fixture.occurrence,
          task: { ...fixture.occurrence.task, scheduleKind },
        },
        task: { ...fixture.task, scheduleKind, status: "pending" },
        run: { ...fixture.run, status: "running", jobId: "job" },
      })).toBe(false);
    }
  });
});
