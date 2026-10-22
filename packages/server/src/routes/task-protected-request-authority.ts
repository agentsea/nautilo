import type { FastifyRequest } from "fastify";
import { resolveCurrentDeviceAdmission, type CurrentDeviceAdmission } from "../auth/device-admission-gate";
import type { DeviceAdmissionComposition } from "./device-admission";
import type { ProtectedTaskRouteAuthority } from "./task-protected-composition";

function sameAdmission(a: CurrentDeviceAdmission, b: CurrentDeviceAdmission): boolean {
  return a.deviceId === b.deviceId && a.deviceGeneration === b.deviceGeneration
    && a.serverInstanceId === b.serverInstanceId && a.lineageGeneration === b.lineageGeneration
    && a.epoch === b.epoch && a.securityRevision === b.securityRevision
    && a.headDigest.length === 32 && b.headDigest.length === 32
    && a.headDigest.every((value, index) => value === b.headDigest[index]);
}

/** Human HTTP authority comes only from bearer policy and its current admitted device. */
export function createProtectedTaskRequestAuthorityResolver(input: Readonly<{
  deviceAdmission: DeviceAdmissionComposition;
  now?: () => number;
}>): (request: FastifyRequest) => Promise<ProtectedTaskRouteAuthority | null> {
  const now = input.now ?? Date.now;
  return async request => {
    const { sessionUserId: userId, sessionActorId: actorId, memoryEnvelope: envelope,
      cryptoDeviceAdmission: admitted, accessTokenExpiresAt: credentialExpiresAt } = request;
    const at = now();
    if (!userId || !actorId || envelope === null || envelope.ownerId !== userId
      || envelope.actorId !== actorId || !envelope.agentId || admitted === null
      || admitted.expiresAt <= at || credentialExpiresAt === null || credentialExpiresAt <= at) return null;
    const agentId = envelope.agentId;
    const authorization = request.headers.authorization;
    const snapshot = { ...admitted, headDigest: Uint8Array.from(admitted.headDigest) };
    try {
      // Reuse the canonical bearer-bound admission owner rather than reconstructing
      // a device from route input or assuming the middleware snapshot is still current.
      const resolved = await resolveCurrentDeviceAdmission({ request, composition: input.deviceAdmission, now: at });
      const current = { ...resolved, headDigest: Uint8Array.from(resolved.headDigest) };
      try {
        const still = request.cryptoDeviceAdmission;
        if (!sameAdmission(snapshot, current) || current.expiresAt <= now() || snapshot.expiresAt <= now()
          || credentialExpiresAt <= now() || request.accessTokenExpiresAt !== credentialExpiresAt
          || request.sessionUserId !== userId || request.sessionActorId !== actorId
          || request.headers.authorization !== authorization
          || request.memoryEnvelope?.ownerId !== userId || request.memoryEnvelope.actorId !== actorId
          || request.memoryEnvelope.agentId !== agentId || still === null || !sameAdmission(snapshot, still)
          || still.expiresAt <= now()) return null;
        return Object.freeze({ userId, subjectHumanId: actorId, actorId, agentId,
          deviceId: current.deviceId, deviceGeneration: current.deviceGeneration,
          admission: Object.freeze({ ...current, headDigest: Uint8Array.from(current.headDigest),
            expiresAt: Math.min(current.expiresAt, snapshot.expiresAt, credentialExpiresAt) }) });
      } finally { current.headDigest.fill(0); }
    } finally { snapshot.headDigest.fill(0); }
  };
}
