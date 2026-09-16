import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  deviceAdmissionChallengeRequestSchema,
  deviceAdmissionProofRequestSchema,
} from "@nautilo/api-client";
import {
  assertDeviceAdmissionChallenge,
  type DeviceAdmissionChallenge,
  type DeviceAdmissionProof,
} from "@nautilo/lattice-bridge";
import type {
  CurrentDeviceAdmissionAuthority,
  DeviceAdmissionStatus as StoredDeviceAdmissionStatus,
} from "@nautilo/lattice-bridge/server";

import { bearerResolutionDigest } from "../auth/resolve-bearer";
import { decodeCanonicalBase64url } from "../lib/canonical-base64url";

export interface DeviceAdmissionAuthority {
  readonly userId: string;
  readonly humanActorId: string;
  readonly credentialDigest: Uint8Array;
  readonly credentialExpiresAt: number;
}

export interface DeviceAdmissionComposition {
  issueChallenge(input: Readonly<{
    authority: DeviceAdmissionAuthority;
    deviceId: string;
    now: number;
  }>): Promise<DeviceAdmissionChallenge | null>;
  admit(input: Readonly<{
    authority: DeviceAdmissionAuthority;
    proof: DeviceAdmissionProof;
    now: number;
  }>): Promise<"admitted" | "invalid">;
  status(input: Readonly<{
    authority: Omit<DeviceAdmissionAuthority, "credentialExpiresAt">;
    now: number;
  }>): Promise<StoredDeviceAdmissionStatus>;
  currentAuthorityForDelegation(input: Readonly<{
    userId: string;
    humanActorId: string;
    deviceId: string;
  }>): Promise<CurrentDeviceAdmissionAuthority | null>;
}

function encode(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function authority(request: FastifyRequest): DeviceAdmissionAuthority | null {
  if (
    request.sessionUserId === null
    || request.sessionActorId === null
    || request.accessTokenExpiresAt === null
    || request.accessTokenExpiresAt <= Date.now()
  ) return null;
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  const bearer = header.slice(7);
  const digest = decodeCanonicalBase64url(bearerResolutionDigest(bearer), 32);
  if (digest === null) return null;
  return Object.freeze({
    userId: request.sessionUserId,
    humanActorId: request.sessionActorId,
    credentialDigest: digest,
    credentialExpiresAt: request.accessTokenExpiresAt,
  });
}

function challengeDto(challenge: DeviceAdmissionChallenge) {
  return Object.freeze({
    formatVersion: 1 as const,
    challengeId: challenge.challengeId,
    credentialDigestBase64url: encode(challenge.credentialDigest),
    userId: challenge.userId,
    humanActorId: challenge.humanActorId,
    deviceId: challenge.deviceId,
    deviceGeneration: challenge.deviceGeneration,
    serverInstanceId: challenge.serverInstanceId,
    lineageGeneration: challenge.lineageGeneration,
    epoch: challenge.epoch,
    securityRevision: challenge.securityRevision,
    headDigestBase64url: encode(challenge.headDigest),
    nonceBase64url: encode(challenge.nonce),
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
  });
}

function proofFromDto(
  input: ReturnType<typeof deviceAdmissionProofRequestSchema.parse>["proof"],
): DeviceAdmissionProof | null {
  const credentialDigest = decodeCanonicalBase64url(
    input.credentialDigestBase64url,
    32,
  );
  const headDigest = decodeCanonicalBase64url(input.headDigestBase64url, 32);
  const nonce = decodeCanonicalBase64url(input.nonceBase64url, 32);
  const signature = decodeCanonicalBase64url(input.signatureBase64url, 64);
  if (
    credentialDigest === null
    || headDigest === null
    || nonce === null
    || signature === null
  ) return null;
  const proof = Object.freeze({
    formatVersion: 1 as const,
    challengeId: input.challengeId,
    credentialDigest,
    userId: input.userId,
    humanActorId: input.humanActorId,
    deviceId: input.deviceId,
    deviceGeneration: input.deviceGeneration,
    serverInstanceId: input.serverInstanceId,
    lineageGeneration: input.lineageGeneration,
    epoch: input.epoch,
    securityRevision: input.securityRevision,
    headDigest,
    nonce,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    signature,
  });
  try {
    assertDeviceAdmissionChallenge(proof);
    return proof;
  } catch {
    credentialDigest.fill(0);
    headDigest.fill(0);
    nonce.fill(0);
    signature.fill(0);
    return null;
  }
}

export function deviceAdmissionRoutes(
  app: FastifyInstance,
  input: Readonly<{
    composition: DeviceAdmissionComposition;
    requiresCryptoDevice(): Promise<boolean>;
  }>,
): void {
  app.get("/api/crypto-device-admission/status", async (request, reply) => {
    const session = authority(request);
    if (session === null) {
      return reply.code(401).send({
        error: "device_admission_unavailable",
        retryable: true,
      });
    }
    if (!await input.requiresCryptoDevice()) {
      return reply.send({
        responseVersion: 1 as const,
        required: false,
        status: "not_required" as const,
      });
    }
    const status = await input.composition.status({
      authority: session,
      now: Date.now(),
    });
    request.log.info({
      event: "crypto_device_admission_status",
      outcome: status.status,
      reason: status.status === "required" ? status.reason : undefined,
    });
    return reply.send(status.status === "admitted"
      ? {
        responseVersion: 1 as const,
        required: true as const,
        status: "admitted" as const,
        deviceId: status.deviceId,
        deviceGeneration: status.deviceGeneration,
        expiresAt: status.expiresAt,
      }
      : {
        responseVersion: 1 as const,
        required: true as const,
        status: "required" as const,
        reason: status.reason,
      });
  });

  app.post("/api/crypto-device-admission/challenge", async (request, reply) => {
    const session = authority(request);
    if (session === null) {
      return reply.code(401).send({
        error: "device_admission_unavailable",
        retryable: true,
      });
    }
    const parsed = deviceAdmissionChallengeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "device_admission_invalid_request",
        retryable: false,
      });
    }
    const challenge = await input.composition.issueChallenge({
      authority: session,
      deviceId: parsed.data.deviceId,
      now: Date.now(),
    });
    if (challenge === null) {
      request.log.warn({
        event: "crypto_device_admission_challenge_rejected",
        reason: "device_enrollment_required",
      });
      return reply.code(409).send({
        error: "device_enrollment_required",
        retryable: false,
      });
    }
    request.log.info({ event: "crypto_device_admission_challenge_issued" });
    return reply.send({
      responseVersion: 1 as const,
      challenge: challengeDto(challenge),
    });
  });

  app.post("/api/crypto-device-admission/proof", async (request, reply) => {
    const session = authority(request);
    if (session === null) {
      return reply.code(401).send({
        error: "device_admission_unavailable",
        retryable: true,
      });
    }
    const parsed = deviceAdmissionProofRequestSchema.safeParse(request.body);
    const proof = parsed.success ? proofFromDto(parsed.data.proof) : null;
    if (proof === null) {
      request.log.warn({
        event: "crypto_device_admission_proof_rejected",
        reason: "invalid_proof_dto",
      });
      return reply.code(400).send({
        error: "device_admission_invalid_proof",
        retryable: false,
      });
    }
    const admitted = await input.composition.admit({
      authority: session,
      proof,
      now: Date.now(),
    });
    if (admitted !== "admitted") {
      request.log.warn({
        event: "crypto_device_admission_proof_rejected",
        reason: "invalid_or_stale_proof",
      });
      return reply.code(409).send({
        error: "device_admission_invalid_proof",
        retryable: true,
      });
    }
    const status = await input.composition.status({
      authority: session,
      now: Date.now(),
    });
    if (status.status !== "admitted") {
      request.log.warn({
        event: "crypto_device_admission_proof_rejected",
        reason: status.reason,
      });
      return reply.code(409).send({
        error: "device_admission_unavailable",
        retryable: true,
      });
    }
    request.log.info({ event: "crypto_device_admission_proof_accepted" });
    return reply.send({
      responseVersion: 1 as const,
      status: "admitted" as const,
      deviceId: status.deviceId,
      deviceGeneration: status.deviceGeneration,
      expiresAt: status.expiresAt,
    });
  });
}
