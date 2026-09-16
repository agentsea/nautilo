import type {
  ProtectedArtifactCiphertextStageResponseV1,
  ProtectedArtifactAccessOperationV1,
  ProtectedArtifactAccessPlanResponseV1,
  ProtectedArtifactAccessUpdateResponseV1,
  ProtectedArtifactPreparedAccessRequestV1,
  ProtectedArtifactDtoV1,
  ProtectedArtifactListResponseV1,
  ProtectedArtifactPreparedPublicationRequestV1,
  ProtectedArtifactPublicationPlanRequestV1,
  ProtectedArtifactPublicationPlanResponseV1,
  ProtectedArtifactPublicationResponseV1,
  ProtectedArtifactUnavailableResponseV1,
} from "@nautilo/api-client";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";

import type { EncryptedArtifactBlobStoreV1 } from "../../artifact/filesystem-blob-store.ts";
import {
  fingerprintRequiredArtifactNamespaces,
  type ArtifactPublicationLifecycle,
  type ArtifactPublicationReservationInput,
} from "../../artifact/artifact-repository.ts";
import type { HumanArtifactCryptoCompletionResult } from "./postgres-human-artifact-crypto-completion.ts";
import {
  authenticateHumanArtifactPublication,
  readAuthenticatedHumanArtifactPublication,
  type AuthenticatedHumanArtifactPublication,
  type ResolveHumanArtifactPublicationAuthority,
} from "./human-artifact-prepared-publication.ts";
import type { HumanArtifactRouteAuthority } from "./postgres-human-artifact-product-route.ts";
import type { HumanArtifactExactAccessRoutePorts } from "./human-artifact-exact-access-route-ports.ts";

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameAuthority(
  left: HumanArtifactRouteAuthority,
  right: HumanArtifactRouteAuthority,
): boolean {
  return left.userId === right.userId
    && left.subjectHumanId === right.subjectHumanId
    && left.actorId === right.actorId
    && left.agentId === null
    && right.agentId === null
    && sameIds(left.readableNamespaceIds, right.readableNamespaceIds)
    && sameIds(left.mutableNamespaceIds, right.mutableNamespaceIds)
    && sameIds(left.writableNamespaceIds, right.writableNamespaceIds);
}

function unavailable(
  reason: ProtectedArtifactUnavailableResponseV1["reason"],
): ProtectedArtifactUnavailableResponseV1 {
  return Object.freeze({ dtoVersion: 1, status: "unavailable", reason });
}

function exactReservation(
  reservation: ArtifactPublicationReservationInput,
  prepared: ProtectedArtifactPreparedPublicationRequestV1,
): boolean {
  return reservation.operationId === prepared.operationId
    && reservation.artifactRowId === prepared.artifactRowId
    && reservation.artifactId === prepared.artifactId
    && reservation.anchorNamespaceId === prepared.anchorNamespaceId
    && reservation.operationType === (
      prepared.operation === "create" ? "create"
        : prepared.operation === "replace_content" ? "content" : "control"
    )
    && reservation.expectedArtifactRevision === prepared.expectedArtifactRevision
    && reservation.resultArtifactRevision === prepared.nextArtifactRevision
    && reservation.expectedAccessRevision === prepared.expectedCryptoAccessRevision
    && reservation.resultAccessRevision === prepared.resultCryptoAccessRevision
    && reservation.expectedBlobGeneration === prepared.expectedBlobGeneration
    && reservation.resultBlobGeneration === prepared.resultBlobGeneration
    && reservation.expectedBlobId === prepared.expectedBlobId
    && reservation.resultBlobId === prepared.resultBlobId
    && Buffer.from(reservation.planDigest).toString("base64url")
      === prepared.planDigestBase64url;
}

export interface HumanArtifactRoutePorts {
  planAccess(input: Readonly<{
    authority: HumanArtifactRouteAuthority;
    artifactId: string;
    operation: ProtectedArtifactAccessOperationV1;
  }>): Promise<ProtectedArtifactAccessPlanResponseV1 | ProtectedArtifactUnavailableResponseV1>;
  commitAccess(input: Readonly<{
    authority: HumanArtifactRouteAuthority;
    artifactId: string;
    prepared: ProtectedArtifactPreparedAccessRequestV1;
  }>): Promise<ProtectedArtifactAccessUpdateResponseV1 | ProtectedArtifactUnavailableResponseV1>;
  list(input: Readonly<{
    authority: HumanArtifactRouteAuthority;
    cursor?: string;
    limit?: number;
    includeArchive?: boolean;
  }>): Promise<ProtectedArtifactListResponseV1 | ProtectedArtifactUnavailableResponseV1>;
  detail(input: Readonly<{
    authority: HumanArtifactRouteAuthority;
    artifactId: string;
  }>): Promise<ProtectedArtifactDtoV1 | ProtectedArtifactUnavailableResponseV1>;
  ciphertextRange(input: Readonly<{
    authority: HumanArtifactRouteAuthority;
    artifactId: string;
    start: number;
    endExclusive: number;
  }>): Promise<HumanArtifactCiphertextRange | ProtectedArtifactUnavailableResponseV1>;
  plan(input: Readonly<{
    authority: HumanArtifactRouteAuthority;
    request: ProtectedArtifactPublicationPlanRequestV1;
  }>): Promise<ProtectedArtifactPublicationPlanResponseV1>;
  stageCiphertext(input: Readonly<{
    authority: HumanArtifactRouteAuthority;
    artifactId: string;
    operationId: string;
    blobId: string;
    blobGeneration: number;
    ciphertextLength: number;
    ciphertextSha256: Uint8Array;
    ciphertext: AsyncIterable<Uint8Array>;
  }>): Promise<
    ProtectedArtifactCiphertextStageResponseV1
    | ProtectedArtifactUnavailableResponseV1
  >;
  publish(input: Readonly<{
    authority: HumanArtifactRouteAuthority;
    prepared: ProtectedArtifactPreparedPublicationRequestV1;
  }>): Promise<
    ProtectedArtifactPublicationResponseV1
    | ProtectedArtifactUnavailableResponseV1
  >;
}

export interface HumanArtifactCiphertextRange {
  readonly status: "encrypted_chunks";
  readonly artifactId: string;
  readonly artifactRevision: number;
  readonly cryptoAccessRevision: number;
  readonly blobId: string;
  readonly blobGeneration: number;
  readonly plaintextLength: number;
  readonly ciphertextLength: number;
  readonly ciphertextSha256: Uint8Array;
  readonly chunkPlaintextBytes: number;
  readonly chunkCount: number;
  readonly firstChunkIndex: number;
  readonly returnedChunkCount: number;
  readonly body: Uint8Array;
}

export interface HumanArtifactProductPlanPort {
  plan(input: Parameters<HumanArtifactRoutePorts["plan"]>[0]): ReturnType<
    HumanArtifactRoutePorts["plan"]
  >;
}

export interface HumanArtifactProductReadPort {
  list(input: Parameters<HumanArtifactRoutePorts["list"]>[0]): ReturnType<
    HumanArtifactRoutePorts["list"]
  >;
  detail(input: Parameters<HumanArtifactRoutePorts["detail"]>[0]): ReturnType<
    HumanArtifactRoutePorts["detail"]
  >;
  ciphertextRange(
    input: Parameters<HumanArtifactRoutePorts["ciphertextRange"]>[0],
  ): ReturnType<HumanArtifactRoutePorts["ciphertextRange"]>;
}

export interface HumanArtifactProductPublicationPort {
  readPlan(operationId: string): Promise<ArtifactPublicationReservationInput | null>;
  read(operationId: string): Promise<ArtifactPublicationLifecycle | null>;
  reserve: import("../../artifact/artifact-repository.ts").ArtifactProductPublicationPort["reserve"];
  publish: import("../../artifact/artifact-repository.ts").ArtifactProductPublicationPort["publish"];
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function completedReplayMatches(input: Readonly<{
  crypto: LatticeCrypto;
  lifecycle: ArtifactPublicationLifecycle;
  reservation: ArtifactPublicationReservationInput;
  prepared: ProtectedArtifactPreparedPublicationRequestV1;
}>): boolean {
  const signedBytes = new Uint8Array(Buffer.from(
    input.prepared.signedPublicationRequestBytesBase64url,
    "base64url",
  ));
  const planDigest = new Uint8Array(Buffer.from(
    input.prepared.planDigestBase64url,
    "base64url",
  ));
  const ciphertextDigest = new Uint8Array(Buffer.from(
    input.prepared.ciphertextSha256Base64url,
    "base64url",
  ));
  const targetFingerprint = fingerprintRequiredArtifactNamespaces(
    input.prepared.requiredNamespaceIds,
  );
  const signedDigest = input.crypto.hash(signedBytes);
  try {
    const lifecycle = input.lifecycle;
    const prepared = input.prepared;
    return lifecycle.completion === "complete"
      && lifecycle.disposition === "complete"
      && exactReservation(input.reservation, prepared)
      && lifecycle.operationId === prepared.operationId
      && lifecycle.artifactRowId === prepared.artifactRowId
      && lifecycle.artifactId === prepared.artifactId
      && lifecycle.anchorNamespaceId === prepared.anchorNamespaceId
      && lifecycle.resultArtifactRevision === prepared.nextArtifactRevision
      && lifecycle.resultAccessRevision === prepared.resultCryptoAccessRevision
      && lifecycle.resultBlobGeneration === prepared.resultBlobGeneration
      && lifecycle.resultBlobId === prepared.resultBlobId
      && lifecycle.cryptoObjectId === prepared.cryptoObjectId
      && lifecycle.blob.artifactId === prepared.artifactId
      && lifecycle.blob.blobId === prepared.resultBlobId
      && lifecycle.blob.blobGeneration === prepared.resultBlobGeneration
      && lifecycle.blob.ciphertextLength === prepared.ciphertextLength
      && lifecycle.mimeClass === prepared.mimeClass
      && lifecycle.sizeBucket === prepared.sizeBucket
      && sameBytes(lifecycle.requestDigest, planDigest)
      && sameBytes(lifecycle.allocationRequestDigest, signedDigest)
      && sameBytes(lifecycle.requiredNamespaceFingerprint, targetFingerprint)
      && sameBytes(lifecycle.blob.ciphertextSha256, ciphertextDigest);
  } finally {
    signedBytes.fill(0);
    planDigest.fill(0);
    ciphertextDigest.fill(0);
    targetFingerprint.fill(0);
    signedDigest.fill(0);
  }
}

export interface HumanArtifactCryptoCompletionPort {
  complete(
    prepared: AuthenticatedHumanArtifactPublication,
  ): Promise<HumanArtifactCryptoCompletionResult>;
}

/** Dormant, direct-source composition. Server code must separately brand it. */
export function createHumanArtifactRoutePorts(input: Readonly<{
  target: HumanArtifactRouteAuthority;
  crypto: LatticeCrypto;
  now(): number;
  productRoute: HumanArtifactProductPlanPort;
  productRead: HumanArtifactProductReadPort;
  productPublication: HumanArtifactProductPublicationPort;
  cryptoCompletion: HumanArtifactCryptoCompletionPort;
  blobs: EncryptedArtifactBlobStoreV1;
  resolvePublicationAuthority: ResolveHumanArtifactPublicationAuthority;
  exactAccess: HumanArtifactExactAccessRoutePorts;
}>): HumanArtifactRoutePorts {
  const target = Object.freeze({
    ...input.target,
    readableNamespaceIds: Object.freeze([...input.target.readableNamespaceIds]),
    mutableNamespaceIds: Object.freeze([...input.target.mutableNamespaceIds]),
    writableNamespaceIds: Object.freeze([...input.target.writableNamespaceIds]),
  });
  const authorized = (authority: HumanArtifactRouteAuthority) =>
    sameAuthority(authority, target) && authority.agentId === null;
  return Object.freeze({
    planAccess(operation: Parameters<HumanArtifactRoutePorts["planAccess"]>[0]) {
      return authorized(operation.authority)
        ? input.exactAccess.planAccess(operation)
        : Promise.resolve(unavailable("authorization_required"));
    },
    commitAccess(operation: Parameters<HumanArtifactRoutePorts["commitAccess"]>[0]) {
      return authorized(operation.authority)
        ? input.exactAccess.commitAccess(operation)
        : Promise.resolve(unavailable("authorization_required"));
    },
    list(operation: Parameters<HumanArtifactRoutePorts["list"]>[0]) {
      return authorized(operation.authority)
        ? input.productRead.list(operation)
        : Promise.resolve(unavailable("authorization_required"));
    },
    detail(operation: Parameters<HumanArtifactRoutePorts["detail"]>[0]) {
      return authorized(operation.authority)
        ? input.productRead.detail(operation)
        : Promise.resolve(unavailable("authorization_required"));
    },
    ciphertextRange(
      operation: Parameters<HumanArtifactRoutePorts["ciphertextRange"]>[0],
    ) {
      return authorized(operation.authority)
        ? input.productRead.ciphertextRange(operation)
        : Promise.resolve(unavailable("authorization_required"));
    },
    plan(operation: Parameters<HumanArtifactRoutePorts["plan"]>[0]) {
      return authorized(operation.authority)
        ? input.productRoute.plan(operation)
        : Promise.resolve(unavailable("authorization_required"));
    },

    async stageCiphertext(
      operation: Parameters<HumanArtifactRoutePorts["stageCiphertext"]>[0],
    ) {
      if (!authorized(operation.authority)) {
        return unavailable("authorization_required");
      }
      const reservation = await input.productPublication.readPlan(
        operation.operationId,
      );
      if (
        reservation === null
        || reservation.operationType === "control"
        || reservation.artifactId !== operation.artifactId
        || reservation.resultBlobId !== operation.blobId
        || reservation.resultBlobGeneration !== operation.blobGeneration
        || !target.writableNamespaceIds.includes(reservation.anchorNamespaceId)
      ) return unavailable("stale_revision");
      const published = await input.blobs.publishCiphertext({
        artifactId: operation.artifactId,
        blobId: operation.blobId,
        blobGeneration: operation.blobGeneration,
        ciphertextLength: operation.ciphertextLength,
        ciphertextSha256: operation.ciphertextSha256,
        ciphertext: operation.ciphertext,
      });
      if (published.status === "quarantined") {
        return unavailable("integrity_failure");
      }
      return Object.freeze({
        dtoVersion: 1,
        status: published.status === "published" ? "staged" : "replayed",
        operationId: operation.operationId,
        artifactId: published.reference.artifactId,
        blobId: published.reference.blobId,
        blobGeneration: published.reference.blobGeneration,
        ciphertextLength: published.reference.ciphertextLength,
        ciphertextSha256Base64url: Buffer.from(
          published.reference.ciphertextSha256,
        ).toString("base64url"),
      });
    },

    async publish(
      operation: Parameters<HumanArtifactRoutePorts["publish"]>[0],
    ) {
      if (!authorized(operation.authority)) {
        return unavailable("authorization_required");
      }
      const prepared = operation.prepared;
      const reservation = await input.productPublication.readPlan(
        prepared.operationId,
      );
      if (reservation === null || !exactReservation(reservation, prepared)) {
        return unavailable("stale_revision");
      }
      const durable = await input.productPublication.read(prepared.operationId);
      if (durable?.completion === "complete") {
        if (!completedReplayMatches({
          crypto: input.crypto,
          lifecycle: durable,
          reservation,
          prepared,
        })) return unavailable("integrity_failure");
        return Object.freeze({
          dtoVersion: 1,
          status: "replayed",
          operationId: durable.operationId,
          artifactId: durable.artifactId,
          artifactRevision: durable.resultArtifactRevision,
          cryptoAccessRevision: durable.resultAccessRevision,
          blobId: durable.resultBlobId,
          blobGeneration: durable.resultBlobGeneration,
          requiredNamespaceIds: [...prepared.requiredNamespaceIds],
        });
      }
      const inspected = await input.blobs.inspectStored({
        artifactId: prepared.artifactId,
        blobId: prepared.resultBlobId,
        blobGeneration: prepared.resultBlobGeneration,
        ciphertextLength: prepared.ciphertextLength,
        ciphertextSha256: new Uint8Array(Buffer.from(
          prepared.ciphertextSha256Base64url,
          "base64url",
        )),
      });
      if (inspected.status === "missing") return unavailable("storage_unavailable");
      if (inspected.status === "mismatch") return unavailable("integrity_failure");
      let authenticated;
      try {
        authenticated = await authenticateHumanArtifactPublication({
          crypto: input.crypto,
          expectedHumanId: target.subjectHumanId,
          prepared,
          blob: inspected.reference,
          now: input.now(),
          resolveAuthority: input.resolvePublicationAuthority,
        });
      } catch {
        return unavailable("authorization_required");
      }
      const snapshot = readAuthenticatedHumanArtifactPublication(authenticated);
      const reserved = await input.productPublication.reserve(snapshot.plan);
      if (reserved.status === "conflict") return unavailable("stale_revision");
      let completed;
      try {
        completed = await input.cryptoCompletion.complete(authenticated);
      } catch {
        return unavailable("encryption_pending");
      }
      const published = await input.productPublication.publish({
        lifecycle: reserved.lifecycle,
        verified: completed.verified,
        targetLifecycleState: snapshot.lifecycleAction === "archive"
          ? "archived" : "active",
      });
      if (published === "stale" || published === "conflict") {
        return unavailable("stale_revision");
      }
      return Object.freeze({
        dtoVersion: 1,
        status: published === "duplicate" ? "replayed" : "published",
        operationId: prepared.operationId,
        artifactId: prepared.artifactId,
        artifactRevision: prepared.nextArtifactRevision,
        cryptoAccessRevision: prepared.resultCryptoAccessRevision,
        blobId: prepared.resultBlobId,
        blobGeneration: prepared.resultBlobGeneration,
        requiredNamespaceIds: [...prepared.requiredNamespaceIds],
      });
    },
  });
}
