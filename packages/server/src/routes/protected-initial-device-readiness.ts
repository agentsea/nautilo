import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  protectedInitialDeviceBeginRequestV1Schema,
  protectedInitialDeviceCompleteRequestV1Schema,
  protectedInitialDeviceReceiptRequestV1Schema,
  protectedInitialHumanDomainPlanRequestV1Schema,
  protectedInitialHumanDomainRequestV1Schema,
  type ProtectedInitialDeviceChallengeV1,
  type ProtectedInitialDeviceReceiptV1,
  type ProtectedInitialHumanDomainPlanResponseV1,
  type ProtectedInitialHumanDomainReceiptV1,
} from "@nautilo/api-client";
import {
  createPostgresJsBridgeConnection,
  getSharedDirectCryptoDb,
} from "@nautilo/db";
import {
  nautiloActorId,
  nautiloUserId,
  type BeginInitialDeviceBootstrap,
  type HumanMembershipTargetDomainSubmission,
  type InitialDeviceBootstrapChallenge,
  type InitialDeviceBootstrapCompletion,
  type InitialDeviceBootstrapReceipt,
  type InitialDeviceBootstrapReceiptQuery,
} from "@nautilo/lattice-bridge";
import {
  InitialDeviceBootstrapError,
  createPostgresInitialDeviceReadinessComposition,
  decodeInitialHumanDomainSubmission,
  verifyCryptoPostgresHandle,
  type CryptoPostgresHandle,
  type InitialHumanDomainAuthority,
} from "@nautilo/lattice-bridge/server";

function encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function decode(value: string): Uint8Array {
  const bytes = Uint8Array.from(Buffer.from(value, "base64url"));
  if (Buffer.from(bytes).toString("base64url") !== value) {
    bytes.fill(0);
    throw new TypeError("Protected readiness bytes are not canonical base64url");
  }
  return bytes;
}

function decodeAll(values: readonly string[]): Uint8Array[] {
  const decoded: Uint8Array[] = [];
  try {
    for (const value of values) decoded.push(decode(value));
    return decoded;
  } catch (error) {
    for (const bytes of decoded) bytes.fill(0);
    throw error;
  }
}

function signedInAuthority(request: FastifyRequest): Readonly<{
  userId: string;
  humanActorId: string;
}> | null {
  if (
    request.sessionUserId === null
    || request.sessionActorId === null
    || request.policyContext?.actorRole === "guest"
  ) return null;
  return Object.freeze({
    userId: request.sessionUserId,
    humanActorId: request.sessionActorId,
  });
}

// The recovery archive is capped at 1 MiB of binary data. Canonical base64url
// and the closed completion envelope remain safely bounded by 2 MiB.
const INITIAL_DEVICE_COMPLETION_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

function deviceRequest(
  authority: Readonly<{ userId: string; humanActorId: string }>,
  input: ReturnType<typeof protectedInitialDeviceBeginRequestV1Schema.parse>,
): BeginInitialDeviceBootstrap {
  const userId = nautiloUserId(authority.userId);
  const humanActorId = nautiloActorId(authority.humanActorId);
  if (!userId.ok || !humanActorId.ok) {
    throw new TypeError("Initial device product identity is malformed");
  }
  const detached = decodeAll([
    input.installationLineageDigestBase64url,
    input.signingPublicKeyBase64url,
    input.encryptionPublicKeyBase64url,
    input.recoveryPublicKeyBase64url,
  ]);
  return Object.freeze({
    formatVersion: 1,
    userId: userId.value,
    humanActorId: humanActorId.value,
    deviceId: input.deviceId,
    clientKind: input.clientKind,
    installationLineageDigest: detached[0]!,
    signingPublicKey: detached[1]!,
    encryptionPublicKey: detached[2]!,
    recoveryKeyId: input.recoveryKeyId,
    recoveryPublicKey: detached[3]!,
    context: Object.freeze({
      kind: "preparation" as const,
      authorityId: `initial-device:${authority.userId}`,
    }),
    idempotencyKey: input.idempotencyKey,
  });
}

function challengeDto(
  value: InitialDeviceBootstrapChallenge,
): ProtectedInitialDeviceChallengeV1 {
  if (value.context.kind !== "preparation") {
    throw new TypeError("Initial device challenge used an unsupported context");
  }
  if (value.clientKind === "tui") {
    throw new TypeError("TUI initial device bootstrap is unsupported");
  }
  return Object.freeze({
    formatVersion: 1,
    userId: value.userId,
    humanActorId: value.humanActorId,
    deviceId: value.deviceId,
    clientKind: value.clientKind,
    installationLineageDigestBase64url: encode(
      value.installationLineageDigest,
    ),
    signingPublicKeyBase64url: encode(value.signingPublicKey),
    encryptionPublicKeyBase64url: encode(value.encryptionPublicKey),
    recoveryKeyId: value.recoveryKeyId,
    recoveryPublicKeyBase64url: encode(value.recoveryPublicKey),
    context: value.context,
    idempotencyKey: value.idempotencyKey,
    challengeId: value.challengeId,
    authorizationEvidenceDigestBase64url: encode(
      value.authorizationEvidenceDigest,
    ),
    authorizationDigestBase64url: encode(value.authorizationDigest),
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
  });
}

function decodeChallenge(
  value: ProtectedInitialDeviceChallengeV1,
): InitialDeviceBootstrapChallenge {
  const userId = nautiloUserId(value.userId);
  const humanActorId = nautiloActorId(value.humanActorId);
  if (!userId.ok || !humanActorId.ok) {
    throw new TypeError("Initial device challenge identity is malformed");
  }
  const detached = decodeAll([
    value.installationLineageDigestBase64url,
    value.signingPublicKeyBase64url,
    value.encryptionPublicKeyBase64url,
    value.recoveryPublicKeyBase64url,
    value.authorizationEvidenceDigestBase64url,
    value.authorizationDigestBase64url,
  ]);
  return Object.freeze({
    formatVersion: 1,
    userId: userId.value,
    humanActorId: humanActorId.value,
    deviceId: value.deviceId,
    clientKind: value.clientKind,
    installationLineageDigest: detached[0]!,
    signingPublicKey: detached[1]!,
    encryptionPublicKey: detached[2]!,
    recoveryKeyId: value.recoveryKeyId,
    recoveryPublicKey: detached[3]!,
    context: value.context,
    idempotencyKey: value.idempotencyKey,
    challengeId: value.challengeId,
    authorizationEvidenceDigest: detached[4]!,
    authorizationDigest: detached[5]!,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
  });
}

function receiptDto(
  value: InitialDeviceBootstrapReceipt,
): ProtectedInitialDeviceReceiptV1 {
  return Object.freeze({ ...value });
}

function domainSubmission(
  value: ReturnType<
    typeof protectedInitialHumanDomainRequestV1Schema.parse
  >["submission"],
): HumanMembershipTargetDomainSubmission {
  return decodeInitialHumanDomainSubmission(value);
}

function destroyDeviceRequest(value: BeginInitialDeviceBootstrap): void {
  value.installationLineageDigest.fill(0);
  value.signingPublicKey.fill(0);
  value.encryptionPublicKey.fill(0);
  value.recoveryPublicKey.fill(0);
}

function destroyChallenge(value: InitialDeviceBootstrapChallenge): void {
  destroyDeviceRequest(value);
  value.authorizationEvidenceDigest.fill(0);
  value.authorizationDigest.fill(0);
}

function destroySubmission(value: HumanMembershipTargetDomainSubmission): void {
  value.participantDigest.fill(0);
  value.initialProviderHead.stateHash.fill(0);
  value.initialRosterBytes.fill(0);
  value.chainDigest.fill(0);
  value.signature.fill(0);
}

export interface ProtectedInitialDeviceReadinessComposition {
  begin(input: Readonly<{
    authority: Readonly<{ userId: string; humanActorId: string }>;
    request: BeginInitialDeviceBootstrap;
  }>): Promise<InitialDeviceBootstrapChallenge>;
  complete(input: Readonly<{
    authority: Readonly<{ userId: string; humanActorId: string }>;
    completion: InitialDeviceBootstrapCompletion;
  }>): Promise<InitialDeviceBootstrapReceipt>;
  resolveReceipt(input: Readonly<{
    authority: Readonly<{ userId: string; humanActorId: string }>;
    query: InitialDeviceBootstrapReceiptQuery;
  }>): Promise<InitialDeviceBootstrapReceipt | null>;
  planDomain(input: Readonly<{
    authority: InitialHumanDomainAuthority;
  }>): Promise<ProtectedInitialHumanDomainPlanResponseV1>;
  activateDomain(input: Readonly<{
    authority: InitialHumanDomainAuthority;
    submission: HumanMembershipTargetDomainSubmission;
    now: number;
  }>): Promise<ProtectedInitialHumanDomainReceiptV1>;
}

function mapBootstrapError(error: unknown): number {
  if (!(error instanceof InitialDeviceBootstrapError)) return 500;
  return error.code === "authorization_rejected" ? 403
    : error.code === "challenge_expired" ? 409
    : error.code === "already_initialized" ? 409
    : 422;
}

export function protectedInitialDeviceReadinessRoutes(
  app: FastifyInstance,
  options: Readonly<{
    composition: ProtectedInitialDeviceReadinessComposition;
    now?: () => number;
  }>,
): void {
  const now = options.now ?? Date.now;
  app.post("/api/protected/devices/initial-bootstrap/begin", async (
    request,
    reply,
  ) => {
    const authority = signedInAuthority(request);
    if (authority === null) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const parsed = protectedInitialDeviceBeginRequestV1Schema.safeParse(
      request.body,
    );
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_initial_device_request" });
    }
    let value: BeginInitialDeviceBootstrap;
    try {
      value = deviceRequest(authority, parsed.data);
    } catch {
      return reply.code(400).send({ error: "invalid_initial_device_request" });
    }
    try {
      return reply.send(challengeDto(await options.composition.begin({
        authority,
        request: value,
      })));
    } catch (error) {
      return reply.code(mapBootstrapError(error)).send({
        error: error instanceof InitialDeviceBootstrapError
          ? error.code
          : "initial_device_unavailable",
      });
    } finally {
      destroyDeviceRequest(value);
    }
  });

  app.post("/api/protected/devices/initial-bootstrap/complete", {
    bodyLimit: INITIAL_DEVICE_COMPLETION_BODY_LIMIT_BYTES,
  }, async (
    request,
    reply,
  ) => {
    const authority = signedInAuthority(request);
    if (authority === null) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const parsed = protectedInitialDeviceCompleteRequestV1Schema.safeParse(
      request.body,
    );
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_initial_device_completion" });
    }
    let challenge: InitialDeviceBootstrapChallenge | null = null;
    let recoveryArchiveBytes: Uint8Array | null = null;
    let deviceProof: Uint8Array | null = null;
    try {
      challenge = decodeChallenge(parsed.data.challenge);
      const detached = decodeAll([
        parsed.data.recoveryArchiveBytesBase64url,
        parsed.data.deviceProofBase64url,
      ]);
      const archive = detached[0]!;
      const proof = detached[1]!;
      recoveryArchiveBytes = archive;
      deviceProof = proof;
    } catch {
      if (challenge !== null) destroyChallenge(challenge);
      recoveryArchiveBytes?.fill(0);
      deviceProof?.fill(0);
      return reply.code(400).send({ error: "invalid_initial_device_completion" });
    }
    if (
      challenge === null
      || recoveryArchiveBytes === null
      || deviceProof === null
    ) {
      return reply.code(400).send({ error: "invalid_initial_device_completion" });
    }
    try {
      if (
        challenge.userId !== authority.userId
        || challenge.humanActorId !== authority.humanActorId
      ) return reply.code(403).send({ error: "authorization_rejected" });
      return reply.send(receiptDto(await options.composition.complete({
        authority,
        completion: Object.freeze({
          formatVersion: 1,
          challenge,
          recoveryArchiveBytes,
          deviceProof,
        }),
      })));
    } catch (error) {
      return reply.code(mapBootstrapError(error)).send({
        error: error instanceof InitialDeviceBootstrapError
          ? error.code
          : "initial_device_unavailable",
      });
    } finally {
      if (challenge !== null) destroyChallenge(challenge);
      recoveryArchiveBytes?.fill(0);
      deviceProof?.fill(0);
    }
  });

  app.post("/api/protected/devices/initial-bootstrap/receipt", async (
    request,
    reply,
  ) => {
    const authority = signedInAuthority(request);
    if (authority === null) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const parsed = protectedInitialDeviceReceiptRequestV1Schema.safeParse(
      request.body,
    );
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_initial_device_receipt" });
    }
    let publicFingerprint: Uint8Array;
    try {
      publicFingerprint = decode(parsed.data.publicFingerprintBase64url);
    } catch {
      return reply.code(400).send({ error: "invalid_initial_device_receipt" });
    }
    try {
      const userId = nautiloUserId(authority.userId);
      const humanActorId = nautiloActorId(authority.humanActorId);
      if (!userId.ok || !humanActorId.ok) {
        return reply.code(403).send({ error: "authorization_rejected" });
      }
      const result = await options.composition.resolveReceipt({
        authority,
        query: Object.freeze({
          formatVersion: 1,
          userId: userId.value,
          humanActorId: humanActorId.value,
          deviceId: parsed.data.deviceId,
          challengeId: parsed.data.challengeId,
          publicFingerprint,
        }),
      });
      return reply.send(result === null ? null : receiptDto(result));
    } catch (error) {
      return reply.code(mapBootstrapError(error)).send({
        error: error instanceof InitialDeviceBootstrapError
          ? error.code
          : "initial_device_unavailable",
      });
    } finally {
      publicFingerprint.fill(0);
    }
  });

  app.post("/api/protected/devices/initial-domain/plan", async (
    request,
    reply,
  ) => {
    const identity = signedInAuthority(request);
    if (identity === null) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const parsed = protectedInitialHumanDomainPlanRequestV1Schema.safeParse(
      request.body,
    );
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_initial_domain_plan" });
    }
    return reply.send(await options.composition.planDomain({
      authority: Object.freeze({
        ...identity,
        humanId: identity.humanActorId,
        deviceId: parsed.data.deviceId,
      }),
    }));
  });

  app.post("/api/protected/devices/initial-domain", async (request, reply) => {
    const identity = signedInAuthority(request);
    if (identity === null) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const parsed = protectedInitialHumanDomainRequestV1Schema.safeParse(
      request.body,
    );
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_initial_domain_request" });
    }
    let submission: HumanMembershipTargetDomainSubmission;
    try {
      submission = domainSubmission(parsed.data.submission);
    } catch {
      return reply.code(400).send({ error: "invalid_initial_domain_request" });
    }
    try {
      if (submission.committerHumanId !== identity.humanActorId) {
        return reply.code(403).send({ error: "authorization_rejected" });
      }
      return reply.send(await options.composition.activateDomain({
        authority: Object.freeze({
          ...identity,
          humanId: identity.humanActorId,
          deviceId: submission.committerDeviceId,
        }),
        submission,
        now: now(),
      }));
    } catch (error) {
      if (error instanceof TypeError || (
        error instanceof Error
        && error.message.startsWith("Initial Human Domain rejected:")
      )) {
        return reply.code(409).send({ error: "initial_domain_unavailable" });
      }
      throw error;
    } finally {
      destroySubmission(submission);
    }
  });
}

export function createProductionInitialDeviceReadinessComposition():
ProtectedInitialDeviceReadinessComposition {
  let handlePromise: Promise<CryptoPostgresHandle> | null = null;
  return createPostgresInitialDeviceReadinessComposition({
    getHandle: () => {
      handlePromise ??= verifyCryptoPostgresHandle(
        createPostgresJsBridgeConnection(getSharedDirectCryptoDb()),
      );
      return handlePromise;
    },
  });
}
