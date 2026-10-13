import { describe, expect, mock, test } from "bun:test";
import { rejects } from "node:assert/strict";
import type { FastifyRequest } from "fastify";
import type { CurrentDeviceAdmission } from "../../src/auth/device-admission-gate";
import type { DeviceAdmissionComposition } from "../../src/routes/device-admission";
import { createProtectedTaskRequestAuthorityResolver } from "../../src/routes/task-protected-request-authority";

const admission: CurrentDeviceAdmission = { deviceId: "browser", deviceGeneration: 2,
  serverInstanceId: "server", lineageGeneration: 3, epoch: 4, securityRevision: 5,
  headDigest: new Uint8Array(32).fill(7), expiresAt: 200 };
function fixture() {
  let now = 100;
  const request = { sessionUserId: "requester-user", sessionActorId: "requester-Actor",
    accessTokenExpiresAt: 210, headers: { authorization: "Bearer current-credential" },
    memoryEnvelope: { ownerId: "requester-user", actorId: "requester-Actor", agentId: "actual-selected-Agent",
      roomId: "actual-room", readableNamespaces: [], mutableNamespaces: [], writableNamespaces: [], toolPolicy: {} },
    cryptoDeviceAdmission: { ...admission, headDigest: admission.headDigest.slice() }, log: { warn: mock(() => {}) },
    body: { agentId: "forged-body-Agent", userId: "other-user" }, query: { agentId: "forged-query-Agent" },
  } as unknown as FastifyRequest;
  let status: Awaited<ReturnType<DeviceAdmissionComposition["status"]>> = { ...admission, status: "admitted" };
  let during: (() => void) | undefined;
  const composition: DeviceAdmissionComposition = {
    issueChallenge: mock(async () => null), admit: mock(async () => "invalid" as const),
    currentAuthorityForDelegation: mock(async () => null),
    status: mock(async (input: Parameters<DeviceAdmissionComposition["status"]>[0]) => {
      expect(input.authority.userId).toBe("requester-user");
      expect(input.authority.humanActorId).toBe("requester-Actor");
      expect(input.authority.credentialDigest).toHaveLength(32);
      during?.();
      return status;
    }),
  };
  return { request, composition, resolve: createProtectedTaskRequestAuthorityResolver({ deviceAdmission: composition, now: () => now }),
    change: (next: typeof status) => { status = next; }, during: (use: () => void) => { during = use; }, expire: () => { now = 201; } };
}

describe("protected Task request authority", () => {
  test("uses actual authenticated User/Actor, envelope Agent and bearer-bound current device", async () => {
    const f = fixture();
    const original = f.request.cryptoDeviceAdmission!.headDigest.slice();
    const result = await f.resolve(f.request);
    expect(result).toEqual({ userId: "requester-user", subjectHumanId: "requester-Actor", actorId: "requester-Actor",
      agentId: "actual-selected-Agent", deviceId: "browser", deviceGeneration: 2, admission });
    expect(Object.isFrozen(result)).toBe(true);
    expect(f.request.cryptoDeviceAdmission!.headDigest).toEqual(original);
    expect(admission.headDigest).toEqual(original);
  });
  test("does not wipe a canonical admission backed by a PostgreSQL Buffer", async () => {
    const f = fixture(); const head = Buffer.from(admission.headDigest);
    f.change({ ...admission, headDigest: head, status: "admitted" });
    const result = await f.resolve(f.request);
    expect(result).not.toBeNull(); expect(head).toEqual(Buffer.from(admission.headDigest));
  });
  for (const missing of ["user", "actor", "envelope", "device", "agent", "ownerMismatch", "actorMismatch", "expired"] as const) {
    test(`rejects ${missing} before any admission access`, async () => {
      const f = fixture();
      if (missing === "user") f.request.sessionUserId = null;
      if (missing === "actor") f.request.sessionActorId = null;
      if (missing === "envelope") f.request.memoryEnvelope = null;
      if (missing === "device") f.request.cryptoDeviceAdmission = null;
      if (missing === "agent") f.request.memoryEnvelope!.agentId = "";
      if (missing === "ownerMismatch") f.request.memoryEnvelope!.ownerId = "foreign";
      if (missing === "actorMismatch") f.request.memoryEnvelope!.actorId = "foreign";
      if (missing === "expired") f.expire();
      expect(await f.resolve(f.request)).toBeNull(); expect(f.composition.status).not.toHaveBeenCalled();
    });
  }
  for (const change of [{ deviceId: "other" }, { deviceGeneration: 3 }, { serverInstanceId: "other" },
    { lineageGeneration: 4 }, { epoch: 5 }, { securityRevision: 6 }, { headDigest: new Uint8Array(32) }]) {
    test(`rejects changed current device ${Object.keys(change)[0]}`, async () => {
      const f = fixture(); f.change({ ...admission, ...change, status: "admitted" });
      expect(await f.resolve(f.request)).toBeNull();
    });
  }
  test("preserves canonical revoked-device refusal", async () => {
    const f = fixture(); f.change({ status: "required", reason: "device_removed_or_stale" });
    await rejects(f.resolve(f.request), { code: "device_removed_or_stale", statusCode: 428 });
  });
  test("identity substitution or expiry during admission cannot authorize the request", async () => {
    for (const changed of ["agent", "user", "bearer", "expiry"] as const) {
      const f = fixture();
      f.during(() => {
        if (changed === "agent") f.request.memoryEnvelope!.agentId = "other";
        if (changed === "user") f.request.sessionUserId = "other";
        if (changed === "bearer") f.request.headers.authorization = "Bearer changed";
        if (changed === "expiry") f.expire();
      });
      expect(await f.resolve(f.request)).toBeNull();
    }
  });
});
