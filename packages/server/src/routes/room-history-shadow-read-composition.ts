import {
  consumeServerUnavailableEncryptionTransitionHistoryReadAdmission,
  consumeSignedEncryptionTransitionHistoryReadAcknowledgement,
  consumeUnavailableEncryptionTransitionHistoryReadAdmission,
  consumeIneligibleEncryptionTransitionHistoryReadAdmission,
  createPostgresJsBridgeConnection,
  getEncryptionTransitionPolicy,
  getSharedDirectCryptoDb,
  issueEncryptionTransitionHistoryReadAdmission,
} from "@nautilo/db";
import {
  LatticeCrypto,
  humanHistoryReadSelectedCoordinateDigest,
  unixTimestamp,
  verifyHumanHistoryReadAcknowledgement,
  type HumanHistoryReadAcknowledgement,
} from "@nautilo/lattice-crypto";
import {
  decodeHumanHistoryReadAcknowledgementV1,
} from "@nautilo/lattice-crypto/wire";
import {
  createCurrentDomainKeyRoomHistoryAuthorityResolver,
  createCurrentHumanDomainKeyRoomHistoryAuthorityResolver,
  createHumanEditedRepresentationAuthorityResolver,
  createPostgresRoomHistoryShadowProjection,
  createPostgresForegroundAgentSignerResolver,
  PostgresDomainKeyAuthorityRepository,
  PostgresLatticeStorage,
  PostgresNamespaceProductAuthority,
  resolveRoomHistoryReaderSigningPublicKey,
  publishHumanDeviceOrdinaryRepairV2,
  verifyConversationProductPostgresHandle,
  verifyCryptoPostgresHandle,
  type RoomHistorySelectedCoordinate,
  type RoomHistoryShadowProjection,
} from "@nautilo/lattice-bridge/server";
import { decodeMessagePayloadV2 } from "@nautilo/lattice-bridge";
import type {
  RoomHistoryShadowReadAcknowledgementRequestV1,
  RoomHistoryShadowReadAcknowledgementResponseV1,
  RoomHistoryShadowReadResponseV1,
} from "@nautilo/api-client";
import { warn } from "@nautilo/logger";

import { getServerDirectDb } from "../lib/server-direct-db";
import { createHumanMessageProductStore } from "./human-message-product-store";

const ADMISSION_TTL_MS = 60_000;

type Authority = Readonly<{ userId: string; humanActorId: string }>;

export interface RoomHistoryShadowReadComposition {
  project(input: Readonly<{
    authority: Authority;
    roomId: string;
    readerDeviceId: string | null;
    clientRequestKey: string;
    selectedCoordinates: readonly RoomHistorySelectedCoordinate[];
    now: number;
  }>): Promise<RoomHistoryShadowReadResponseV1>;
  acknowledge(input: Readonly<{
    authority: Authority;
    roomId: string;
    operationId: string;
    request: RoomHistoryShadowReadAcknowledgementRequestV1;
    now: number;
  }>): Promise<RoomHistoryShadowReadAcknowledgementResponseV1 | null>;
}

export interface RoomHistoryShadowReadCompositionOverrides {
  readonly getPolicy?: () => Promise<Readonly<{
    mode: "plaintext_only" | "shadow_encryption" | "encrypted_only";
  }>>;
}

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64url(value: string): Uint8Array | null {
  try {
    const bytes = Buffer.from(value, "base64url");
    return bytes.length > 0 && bytes.toString("base64url") === value
      ? Uint8Array.from(bytes)
      : null;
  } catch {
    return null;
  }
}

function destroyAcknowledgement(value: HumanHistoryReadAcknowledgement): void {
  value.selectedCoordinateDigest.fill(0);
  value.orderedResultSetDigest.fill(0);
  value.signature.fill(0);
}

function unavailableResponse(input: Readonly<{
  admission: Awaited<ReturnType<
    typeof issueEncryptionTransitionHistoryReadAdmission
  >>;
  clientRequestKey: string;
  selectedCoordinateDigest: Uint8Array;
  selectedCount: number;
  eligibleCount: number;
  reason:
    | "client_crypto_unavailable"
    | "current_read_authority_unavailable"
    | "selection_changed"
    | "projection_corrupt";
}>): RoomHistoryShadowReadResponseV1 {
  return Object.freeze({
    responseVersion: 1,
    status: "unavailable",
    operationId: input.admission.operationId,
    clientRequestKey: input.clientRequestKey,
    policyRevision: input.admission.policyRevision,
    selectedCoordinateDigestBase64url:
      base64url(input.selectedCoordinateDigest),
    selectedCount: input.selectedCount,
    eligibleCount: input.eligibleCount,
    reason: input.reason,
  });
}

export function createProductionRoomHistoryShadowReadComposition(
  overrides: RoomHistoryShadowReadCompositionOverrides = {},
):
RoomHistoryShadowReadComposition {
  const crypto = new LatticeCrypto();
  // Retained Domain-key bindings authenticate the server origin that signed
  // them. History must use the same configured identity as publication; an
  // internal label would make every otherwise-valid retained binding fail.
  const serverId = process.env["NAUTILO_PUBLIC_BASE_URL"]?.trim()
    || "http://localhost:3001";
  let resolvedProductDb: ReturnType<typeof getServerDirectDb> | null = null;
  const productDb = (): ReturnType<typeof getServerDirectDb> => {
    resolvedProductDb ??= getServerDirectDb();
    return resolvedProductDb;
  };
  const readPolicy = overrides.getPolicy
    ?? (() => getEncryptionTransitionPolicy(productDb()));
  let resolvedProductConnection: ReturnType<
    typeof createPostgresJsBridgeConnection
  > | null = null;
  const resolveProductConnection = () => {
    resolvedProductConnection ??= createPostgresJsBridgeConnection(productDb());
    return resolvedProductConnection;
  };
  let resolvedRestrictedConnection: ReturnType<
    typeof createPostgresJsBridgeConnection
  > | null = null;
  const resolveRestrictedConnection = () => {
    resolvedRestrictedConnection ??= createPostgresJsBridgeConnection(
      getSharedDirectCryptoDb(),
    );
    return resolvedRestrictedConnection;
  };
  let projectionPromise: Promise<ReturnType<
    typeof createPostgresRoomHistoryShadowProjection
  >> | null = null;

  const projection = () => {
    projectionPromise ??= Promise.all([
      verifyConversationProductPostgresHandle(
        resolveProductConnection(),
      ),
      verifyCryptoPostgresHandle(resolveRestrictedConnection()),
    ]).then(([product, restricted]) => {
      const productAuthority = new PostgresNamespaceProductAuthority(
        resolveProductConnection(),
      );
      const domainKeys = new PostgresDomainKeyAuthorityRepository(
        resolveRestrictedConnection(),
        crypto,
        serverId,
      );
      return createPostgresRoomHistoryShadowProjection({
        product,
        crypto: new PostgresLatticeStorage(restricted),
        resolveForegroundAgentSigner: createPostgresForegroundAgentSignerResolver({ product, crypto }),
        restricted: resolveRestrictedConnection(),
        resolveAuthority: createCurrentDomainKeyRoomHistoryAuthorityResolver({
          product: resolveProductConnection(),
          productAuthority,
          domainKeys,
        }),
        resolveHumanPeerAuthority:
          createCurrentHumanDomainKeyRoomHistoryAuthorityResolver({
            product: resolveProductConnection(),
            productAuthority,
            domainKeys,
          }),
        resolveHumanEditedRepresentationAuthority:
          createHumanEditedRepresentationAuthorityResolver({ domainKeys }),
        resolveExistingRetainedGeneration: async (coordinates) => {
          const retained = await domainKeys.inspectNamespaceGenerationAuthorityMetadata({
            namespaceId: coordinates.namespaceId, keyClass: coordinates.keyClass,
            requested: [{ generation: coordinates.generation, accessRevision: coordinates.accessRevision }],
          });
          if (retained.status !== "ready") return null;
          try {
            const exact = retained.retainedGenerations.find((entry) =>
              entry.generation === coordinates.generation && entry.accessRevision === coordinates.accessRevision);
            return exact === undefined ? null : {
              namespaceGeneration: exact.generation, accessRevision: exact.accessRevision,
              headDigestBase64url: Buffer.from(exact.headDigest).toString("base64url"),
              publicationDigestBase64url: Buffer.from(exact.publicationDigest).toString("base64url"),
              publicationSetDigestBase64url: Buffer.from(exact.publicationSetDigest).toString("base64url"),
              audienceFingerprintBase64url: Buffer.from(exact.audienceFingerprint).toString("base64url"),
            };
          } finally {
            for (const entry of retained.retainedGenerations) {
              entry.headDigest.fill(0); entry.publicationDigest.fill(0);
              entry.publicationSetDigest.fill(0); entry.audienceFingerprint.fill(0);
            }
          }
        },
      });
    });
    return projectionPromise;
  };

  const issue = (input: Readonly<{
    clientRequestKey: string;
    subjectHumanId: string;
    readerDeviceId: string | null;
    readerDeviceSigningKeyGeneration: number | null;
    hostAuthorizationRevision: number | null;
    roomId: string;
    selectedCoordinateDigest: Uint8Array;
    selectedCount: number;
    eligibleCount: number;
    now: number;
  }>) => issueEncryptionTransitionHistoryReadAdmission(productDb(), {
    ...input,
    issuedAt: new Date(input.now),
    expiresAt: new Date(input.now + ADMISSION_TTL_MS),
  });

  return Object.freeze({
    project: async (
      input: Parameters<RoomHistoryShadowReadComposition["project"]>[0],
    ) => {
      // Plaintext-only is a real disabled state, not a failed Shadow read. Gate
      // before projection so pages without eligible protected siblings never
      // try to issue an observation against the intentionally absent epoch.
      const policy = await readPolicy();
      if (policy.mode === "plaintext_only") {
        return Object.freeze({
          responseVersion: 1,
          status: "disabled",
          mode: "plaintext_only",
        });
      }
      const projected: RoomHistoryShadowProjection = await (await projection())({
        subjectUserId: input.authority.userId,
        subjectHumanId: input.authority.humanActorId,
        readerDeviceId: input.readerDeviceId,
        roomId: input.roomId,
        selectedCoordinates: input.selectedCoordinates,
        representationMode: policy.mode === "encrypted_only" ? "protected-only" : "ordinary-and-protected",
      });
      if (projected.status === "disabled") {
        return Object.freeze({
          responseVersion: 1,
          status: "disabled",
          mode: "plaintext_only",
        });
      }
      const selectedCoordinateDigest =
        humanHistoryReadSelectedCoordinateDigest(
          crypto,
          input.selectedCoordinates,
        );
      try {
        if (
          projected.status === "ineligible"
          || projected.eligibleCount === 0
        ) {
          const admission = await issue({
            clientRequestKey: input.clientRequestKey,
            subjectHumanId: input.authority.humanActorId,
            readerDeviceId: null,
            readerDeviceSigningKeyGeneration: null,
            hostAuthorizationRevision: null,
            roomId: input.roomId,
            selectedCoordinateDigest,
            selectedCount: projected.selectedCount,
            eligibleCount: 0,
            now: input.now,
          });
          if (admission.status === "planned") {
            await consumeIneligibleEncryptionTransitionHistoryReadAdmission(
              productDb(),
              {
                token: admission.token,
                operationId: admission.operationId,
                clientRequestKey: input.clientRequestKey,
                policyRevision: admission.policyRevision,
                subjectHumanId: input.authority.humanActorId,
                readerDeviceId: null,
                readerDeviceSigningKeyGeneration: null,
                hostAuthorizationRevision: null,
                roomId: input.roomId,
                selectedCoordinateDigest,
                selectedCount: projected.selectedCount,
                eligibleCount: 0,
                issuedAt: admission.issuedAt,
                deadlineAt: admission.expiresAt,
                observedAt: new Date(input.now),
              },
            );
            admission.token.fill(0);
          }
          return Object.freeze({
            responseVersion: 1,
            status: "ineligible",
            selectedCount: projected.selectedCount,
            eligibleCount: 0,
          });
        }

        const ready = projected.status === "ready" ? projected.authority : null;
        const admission = await issue({
          clientRequestKey: input.clientRequestKey,
          subjectHumanId: input.authority.humanActorId,
          readerDeviceId: ready?.readerDeviceId ?? null,
          readerDeviceSigningKeyGeneration:
            ready?.readerDeviceSigningKeyGeneration ?? null,
          hostAuthorizationRevision:
            ready?.hostAuthorizationRevision ?? null,
          roomId: input.roomId,
          selectedCoordinateDigest,
          selectedCount: projected.selectedCount,
          eligibleCount: projected.eligibleCount,
          now: input.now,
        });

        if (projected.status !== "ready") {
          if (projected.status === "unavailable") {
            warn(
              `[history-read] unavailable projection for Room ${input.roomId}: ${projected.reason}`,
            );
          }
          if (admission.status === "planned") {
            const responseReason = input.readerDeviceId === null
              ? "client_crypto_unavailable" as const
              : projected.status === "unavailable"
              ? projected.reason
              : "current_read_authority_unavailable" as const;
            const observationReason = responseReason === "selection_changed"
                || responseReason === "projection_corrupt"
              ? "live_shadow_lifecycle_unavailable" as const
              : responseReason;
            await consumeServerUnavailableEncryptionTransitionHistoryReadAdmission(
              productDb(),
              {
                token: admission.token,
                operationId: admission.operationId,
                clientRequestKey: input.clientRequestKey,
                policyRevision: admission.policyRevision,
                subjectHumanId: input.authority.humanActorId,
                readerDeviceId: null,
                readerDeviceSigningKeyGeneration: null,
                hostAuthorizationRevision: null,
                roomId: input.roomId,
                selectedCoordinateDigest,
                selectedCount: projected.selectedCount,
                eligibleCount: projected.eligibleCount,
                issuedAt: admission.issuedAt,
                deadlineAt: admission.expiresAt,
                observedAt: new Date(input.now),
                reason: observationReason,
              },
            );
            admission.token.fill(0);
          }
          return unavailableResponse({
            admission,
            clientRequestKey: input.clientRequestKey,
            selectedCoordinateDigest,
            selectedCount: projected.selectedCount,
            eligibleCount: projected.eligibleCount,
            reason: input.readerDeviceId === null
              ? "client_crypto_unavailable"
              : projected.status === "unavailable"
              ? projected.reason
              : "current_read_authority_unavailable",
          });
        }

        if (admission.policyRevision !== projected.authority.policyRevision) {
          if (admission.status === "planned") {
            await consumeServerUnavailableEncryptionTransitionHistoryReadAdmission(
              productDb(),
              {
                token: admission.token,
                operationId: admission.operationId,
                clientRequestKey: input.clientRequestKey,
                policyRevision: admission.policyRevision,
                subjectHumanId: input.authority.humanActorId,
                readerDeviceId: projected.authority.readerDeviceId,
                readerDeviceSigningKeyGeneration:
                  projected.authority.readerDeviceSigningKeyGeneration,
                hostAuthorizationRevision:
                  projected.authority.hostAuthorizationRevision,
                roomId: input.roomId,
                selectedCoordinateDigest,
                selectedCount: projected.selectedCount,
                eligibleCount: projected.eligibleCount,
                issuedAt: admission.issuedAt,
                deadlineAt: admission.expiresAt,
                observedAt: new Date(input.now),
                reason: "current_read_authority_unavailable",
              },
            );
            admission.token.fill(0);
          }
          return unavailableResponse({
            admission,
            clientRequestKey: input.clientRequestKey,
            selectedCoordinateDigest,
            selectedCount: projected.selectedCount,
            eligibleCount: projected.eligibleCount,
            reason: "current_read_authority_unavailable",
          });
        }

        const acknowledgement = admission.status === "planned"
          ? Object.freeze({
            status: "required" as const,
            tokenBase64url: base64url(admission.token),
            issuedAt: admission.issuedAt.toISOString(),
            expiresAt: admission.expiresAt.toISOString(),
          })
          : Object.freeze({ status: "already_recorded" as const });
        if (admission.status === "planned") admission.token.fill(0);
        return Object.freeze({
          responseVersion: 1,
          status: "ready",
          operationId: admission.operationId,
          clientRequestKey: input.clientRequestKey,
          selectedCoordinateDigestBase64url: base64url(
            selectedCoordinateDigest,
          ),
          selectedCount: projected.selectedCount,
          selectedCoordinates: [...input.selectedCoordinates],
          eligibleCount: projected.eligibleCount,
          authority: projected.authority,
          ...(projected.authorities === undefined ? {} : { authorities: [...projected.authorities] }),
          records: projected.records.map((record) => Object.freeze({
            ...record,
            protectedMessage: record.protectedMessage,
          })),
          signerEvidence: [...projected.signerEvidence],
          acknowledgement,
        });
      } finally {
        selectedCoordinateDigest.fill(0);
      }
    },

    acknowledge: async (
      input: Parameters<RoomHistoryShadowReadComposition["acknowledge"]>[0],
    ) => {
      if (
        input.request.operationId !== input.operationId
        || input.request.status === "client_unavailable"
          && ![
            "client_crypto_unavailable",
            "client_custody_unavailable",
          ].includes(input.request.reason)
      ) return null;
      const token = decodeBase64url(input.request.tokenBase64url);
      if (token === null) return null;
      const productConnection = resolveProductConnection();
      try {
        if (input.request.status === "client_unavailable") {
          const rows = await productConnection.query(
            `/* m275_history_read_client_unavailable */
             SELECT operation_id, client_request_key, policy_revision::int,
                    subject_human_id, reader_device_id,
                    reader_device_signing_key_generation::int,
                    host_authorization_revision::int, room_id,
                    selected_coordinate_digest, eligible_count::int,
                    selected_count::int,
                    issued_at, expires_at
               FROM encryption_transition_history_read_admissions
              WHERE operation_id = $1
                AND subject_human_id = $2
                AND room_id = $3::uuid
              LIMIT 2`,
            [input.operationId, input.authority.humanActorId, input.roomId],
          );
          if (rows.length !== 1) return null;
          const row = rows[0]!;
          const digest = row["selected_coordinate_digest"];
          if (!(digest instanceof Uint8Array)) return null;
          const result = await consumeUnavailableEncryptionTransitionHistoryReadAdmission(
            productDb(),
            {
              token,
              operationId: input.operationId,
              clientRequestKey: String(row["client_request_key"]),
              policyRevision: Number(row["policy_revision"]),
              subjectHumanId: input.authority.humanActorId,
              readerDeviceId: String(row["reader_device_id"]),
              readerDeviceSigningKeyGeneration:
                Number(row["reader_device_signing_key_generation"]),
              hostAuthorizationRevision:
                Number(row["host_authorization_revision"]),
              roomId: input.roomId,
              selectedCoordinateDigest: digest,
              selectedCount: Number(row["selected_count"]),
              eligibleCount: Number(row["eligible_count"]),
              counts: {
                verified: 0,
                clientCryptoUnavailable:
                  input.request.reason === "client_crypto_unavailable"
                    ? Number(row["eligible_count"])
                    : 0,
                clientCustodyUnavailable:
                  input.request.reason === "client_custody_unavailable"
                    ? Number(row["eligible_count"])
                    : 0,
                currentReadAuthorityUnavailable: 0,
                retainedKeyMaterialUnavailable: 0,
                signerEvidenceUnavailable: 0,
                liveShadowLifecycleUnavailable: 0,
                integrityFailure: 0,
                parityMismatch: 0,
              },
              issuedAt: new Date(String(row["issued_at"])),
              deadlineAt: new Date(String(row["expires_at"])),
              observedAt: new Date(input.now),
            },
          );
          return result.status === "accepted" || result.status === "replayed"
            ? Object.freeze({
              responseVersion: 1,
              status: result.status === "accepted" ? "accepted" : "replayed",
              operationId: input.operationId,
            })
            : null;
        }

        const acknowledgementBytes = decodeBase64url(
          input.request.acknowledgementBytesBase64url,
        );
        if (acknowledgementBytes === null) return null;
        const decoded = decodeHumanHistoryReadAcknowledgementV1(
          acknowledgementBytes,
        );
        let signingPublicKey: Uint8Array | undefined;
        let verified: HumanHistoryReadAcknowledgement | undefined;
        let acknowledgementDigest: Uint8Array | undefined;
        try {
          if (
            decoded.operationId !== input.operationId
            || decoded.roomId !== input.roomId
            || decoded.subjectHumanId !== input.authority.humanActorId
          ) return null;
          const admissions = await productConnection.query(
            `/* m275_history_read_selected_count */
             SELECT selected_count::int
               FROM encryption_transition_history_read_admissions
              WHERE operation_id = $1
                AND subject_human_id = $2
                AND room_id = $3::uuid
              LIMIT 2`,
            [input.operationId, input.authority.humanActorId, input.roomId],
          );
          if (admissions.length !== 1) return null;
          const selectedCount = Number(admissions[0]!["selected_count"]);
          if (!Number.isSafeInteger(selectedCount) || selectedCount < 1) {
            return null;
          }
          signingPublicKey =
            await resolveRoomHistoryReaderSigningPublicKey(
              resolveRestrictedConnection(),
              {
                subjectUserId: input.authority.userId,
                subjectHumanId: input.authority.humanActorId,
                readerDeviceId: decoded.readerDeviceId,
                readerDeviceSigningKeyGeneration:
                  decoded.readerDeviceSigningKeyGeneration,
                hostAuthorizationRevision:
                  decoded.hostAuthorizationRevision,
              },
            ) ?? undefined;
          if (signingPublicKey === undefined) return null;
          verified = verifyHumanHistoryReadAcknowledgement(crypto, {
            acknowledgementBytes,
            now: unixTimestamp(input.now),
            resolvePlannedAuthority: (context) =>
              context.subjectHumanId === decoded.subjectHumanId
                  && context.operationId === decoded.operationId
                  && context.readerDeviceId === decoded.readerDeviceId
                  && context.readerDeviceSigningKeyGeneration
                    === decoded.readerDeviceSigningKeyGeneration
                  && context.hostAuthorizationRevision
                    === decoded.hostAuthorizationRevision
                ? signingPublicKey!.slice()
                : null,
          });
          acknowledgementDigest = crypto.hash(acknowledgementBytes);
          const result = await consumeSignedEncryptionTransitionHistoryReadAcknowledgement(
            productDb(),
            {
              token,
              operationId: verified.operationId,
              clientRequestKey: verified.clientRequestKey,
              policyRevision: verified.policyRevision,
              subjectHumanId: verified.subjectHumanId,
              readerDeviceId: verified.readerDeviceId,
              readerDeviceSigningKeyGeneration:
                verified.readerDeviceSigningKeyGeneration,
              hostAuthorizationRevision: verified.hostAuthorizationRevision,
              roomId: verified.roomId,
              selectedCoordinateDigest: verified.selectedCoordinateDigest,
              selectedCount,
              eligibleCount: verified.eligibleCount,
              counts: verified.resultCounts,
              acknowledgementDigest,
              orderedResultSetDigest: verified.orderedResultSetDigest,
              issuedAt: new Date(verified.issuedAt),
              deadlineAt: new Date(verified.deadlineAt),
              observedAt: new Date(input.now),
            },
          );
          if ((result.status === "accepted" || result.status === "replayed")
            && input.request.status === "signed_with_ordinary_repairs") {
            const selectedDigest = humanHistoryReadSelectedCoordinateDigest(
              crypto, input.request.selectedCoordinates,
            );
            try {
              if (selectedDigest.length !== verified.selectedCoordinateDigest.length
                || !selectedDigest.every((byte, index) =>
                  byte === verified!.selectedCoordinateDigest[index])) return null;
              const policy = await readPolicy();
              if (policy.mode !== "shadow_encryption") return null;
              const current = await (await projection())({
                subjectUserId: input.authority.userId,
                subjectHumanId: input.authority.humanActorId,
                readerDeviceId: verified.readerDeviceId,
                roomId: input.roomId,
                selectedCoordinates: input.request.selectedCoordinates,
                representationMode: "ordinary-and-protected",
              });
              if (current.status !== "ready"
                || current.authority.policyRevision !== verified.policyRevision) return null;
              const product = await createHumanMessageProductStore(input.authority.userId);
              for (const transport of input.request.ordinaryRepairs) {
                if (transport.operationId !== verified.operationId
                  || transport.policyRevision !== verified.policyRevision
                  || transport.subjectHumanId !== verified.subjectHumanId
                  || transport.readerDeviceId !== verified.readerDeviceId
                  || transport.readerDeviceSigningKeyGeneration
                    !== verified.readerDeviceSigningKeyGeneration
                  || transport.hostAuthorizationRevision
                    !== verified.hostAuthorizationRevision
                  || transport.roomId !== verified.roomId
                  || transport.issuedAt !== verified.issuedAt
                  || transport.deadlineAt !== verified.deadlineAt) return null;
                const record = current.records.find((candidate) =>
                  candidate.coordinate.sessionId === transport.sessionId
                  && candidate.coordinate.messageId === transport.messageId
                  && candidate.coordinate.editRevision === transport.editRevision);
                if (record === undefined
                  || !("retainedGeneration" in record) || record.retainedGeneration === undefined
                  || record.protectedMessage.protectedPayload.status !== "encrypted"
                  || record.protectedMessage.protectedPayload.keyClass !== (transport.version === 2 ? "human" : transport.keyClass)
                  || record.protectedMessage.protectedPayload.cryptoObjectId !== transport.cryptoObjectId
                  || record.protectedMessage.projection.namespaceId !== transport.namespaceId
                  || record.retainedGeneration.accessRevision !== transport.namespaceAccessRevision
                  || record.retainedGeneration.namespaceGeneration !== transport.namespaceKeyGeneration
                  || record.protectedMessage.projection.role !== transport.authorRole
                  || Date.parse(record.protectedMessage.projection.createdAt) !== transport.createdAt) return null;
                const payloadBytes = decodeBase64url(transport.payloadBytesBase64url);
                const payloadDigest = decodeBase64url(transport.payloadDigestBase64url);
                const signature = decodeBase64url(transport.signatureBase64url);
                if (payloadBytes === null || payloadDigest === null || signature === null) return null;
                try {
                  const {
                    payloadBytesBase64url: _payloadBytes,
                    payloadDigestBase64url: _payloadDigest,
                    signatureBase64url: _signature,
                    ...attestedCoordinates
                  } = transport;
                  const repair = await publishHumanDeviceOrdinaryRepairV2({
                    crypto,
                    restricted: resolveRestrictedConnection(),
                    product,
                    authority: input.authority,
                    attestation: { ...attestedCoordinates, payloadDigest, signature },
                    payload: decodeMessagePayloadV2(payloadBytes),
                    now: input.now,
                    currentNamespaceAccessRevision: current.authority.namespaceAccessRevision,
                  });
                  if (repair !== "applied" && repair !== "replayed") return null;
                } finally {
                  payloadBytes.fill(0); payloadDigest.fill(0); signature.fill(0);
                }
              }
            } finally {
              selectedDigest.fill(0);
            }
          }
          return result.status === "accepted" || result.status === "replayed"
            ? Object.freeze({
              responseVersion: 1,
              status: result.status === "accepted" ? "accepted" : "replayed",
              operationId: input.operationId,
            })
            : null;
        } finally {
          destroyAcknowledgement(decoded);
          if (verified !== undefined) destroyAcknowledgement(verified);
          signingPublicKey?.fill(0);
          acknowledgementDigest?.fill(0);
          acknowledgementBytes.fill(0);
        }
      } finally {
        token.fill(0);
      }
    },
  });
}
