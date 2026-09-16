import type { FastifyRequest } from "fastify";

import type { DeviceAdmissionComposition } from
  "../routes/device-admission";
import { decodeCanonicalBase64url } from "../lib/canonical-base64url";
import { bearerResolutionDigest } from "./resolve-bearer";

export interface CurrentDeviceAdmission {
  readonly deviceId: string;
  readonly deviceGeneration: number;
  readonly serverInstanceId: string;
  readonly lineageGeneration: number;
  readonly epoch: number;
  readonly securityRevision: number;
  readonly headDigest: Uint8Array;
  readonly expiresAt: number;
}

export { PRE_ADMISSION_ROUTE_INVENTORY, preAdmissionRouteKind } from "@nautilo/types";

export function cryptoDeviceAdmissionRequiredError(
  code:
    | "device_admission_required"
    | "device_admission_expired"
    | "device_removed_or_stale"
    | "device_admission_unavailable",
): Error {
  return Object.assign(new Error(code), {
    statusCode: code === "device_admission_unavailable" ? 503 : 428,
    code,
    publicError: code === "device_admission_unavailable"
      ? "Service Unavailable"
      : "Precondition Required",
  });
}

export async function resolveCurrentDeviceAdmission(input: Readonly<{
  request: FastifyRequest;
  composition: DeviceAdmissionComposition;
  now: number;
}>): Promise<CurrentDeviceAdmission> {
  const { request } = input;
  if (
    request.sessionUserId === null
    || request.sessionActorId === null
    || request.accessTokenExpiresAt === null
    || request.accessTokenExpiresAt <= input.now
  ) throw cryptoDeviceAdmissionRequiredError("device_admission_unavailable");
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    throw cryptoDeviceAdmissionRequiredError("device_admission_unavailable");
  }
  const credentialDigest = decodeCanonicalBase64url(
    bearerResolutionDigest(header.slice(7)),
    32,
  );
  if (credentialDigest === null) {
    throw cryptoDeviceAdmissionRequiredError("device_admission_unavailable");
  }
  const status = await input.composition.status({
    authority: {
      credentialDigest,
      userId: request.sessionUserId,
      humanActorId: request.sessionActorId,
    },
    now: input.now,
  });
  if (status.status !== "admitted") {
    request.log.warn({
      event: "crypto_device_admission_blocked",
      reason: status.reason,
    });
    throw cryptoDeviceAdmissionRequiredError(status.reason);
  }
  return Object.freeze({
    deviceId: status.deviceId,
    deviceGeneration: status.deviceGeneration,
    serverInstanceId: status.serverInstanceId,
    lineageGeneration: status.lineageGeneration,
    epoch: status.epoch,
    securityRevision: status.securityRevision,
    headDigest: status.headDigest.slice(),
    expiresAt: status.expiresAt,
  });
}
