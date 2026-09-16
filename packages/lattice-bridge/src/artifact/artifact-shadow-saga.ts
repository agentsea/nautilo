import {
  artifactCryptoRevisionReference,
  artifactPublicationRequestDigest,
  artifactSizeBucketForPlaintextLength,
  assertArtifactPublicationPlan,
  fingerprintRequiredArtifactNamespaces,
  type ArtifactBlobVerificationPort,
  type ArtifactProductPublicationPort,
  type ArtifactPublicationLifecycle,
  type ArtifactPublicationPlanInput,
  type AtomicArtifactCryptoCompletionPort,
} from "./artifact-repository.ts";

export type ArtifactPublicationResult =
  | Readonly<{ status: "published" | "replayed"; lifecycle: ArtifactPublicationLifecycle }>
  | Readonly<{
    status: "pending" | "quarantined" | "stale";
    reason: "blob_unavailable" | "blob_mismatch" | "crypto_incomplete" | "crypto_mismatch" | "mapping_conflict";
  }>;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function storedBlobFacts(
  lifecycle: ArtifactPublicationLifecycle,
): Parameters<ArtifactBlobVerificationPort["inspectStored"]>[0] {
  return Object.freeze({
    artifactId: lifecycle.blob.artifactId,
    blobId: lifecycle.blob.blobId,
    blobGeneration: lifecycle.blob.blobGeneration,
    ciphertextLength: lifecycle.blob.ciphertextLength,
    ciphertextSha256: lifecycle.blob.ciphertextSha256,
  });
}

function exactVerified(
  lifecycle: ArtifactPublicationLifecycle,
  verified: Awaited<ReturnType<AtomicArtifactCryptoCompletionPort["verify"]>>,
): boolean {
  if (verified === null) return false;
  let namespaceFingerprint: Uint8Array;
  try {
    namespaceFingerprint = fingerprintRequiredArtifactNamespaces(
      verified.requiredNamespaceIds,
    );
  } catch {
    return false;
  }
  return verified.artifactId === lifecycle.artifactId
    && verified.artifactRevision === lifecycle.resultArtifactRevision
    && verified.objectId === lifecycle.cryptoObjectId
    && verified.accessRevision === lifecycle.resultAccessRevision
    && sameBytes(
      verified.requiredNamespaceFingerprint,
      lifecycle.requiredNamespaceFingerprint,
    )
    && sameBytes(namespaceFingerprint, lifecycle.requiredNamespaceFingerprint);
}

export function createDormantArtifactShadowRepository(input: Readonly<{
  product: ArtifactProductPublicationPort;
  crypto: AtomicArtifactCryptoCompletionPort;
  blobs: ArtifactBlobVerificationPort;
}>) {
  const reconcileLifecycle = async (
    lifecycle: ArtifactPublicationLifecycle,
  ): Promise<ArtifactPublicationResult> => {
    const blobStatus = await input.blobs.inspectStored(
      storedBlobFacts(lifecycle),
    );
    if (blobStatus.status !== "exact") {
      const reason = blobStatus.status === "missing"
        ? "blob_unavailable" as const
        : "blob_mismatch" as const;
      const terminal = lifecycle.completion === "complete";
      await input.product.recordFailure({
        operationId: lifecycle.operationId,
        requestDigest: lifecycle.requestDigest,
        disposition: terminal || blobStatus.status !== "missing"
          ? "quarantined"
          : "blocked",
        failureCode: reason,
      });
      return Object.freeze({
        status: terminal || blobStatus.status !== "missing"
          ? "quarantined"
          : "pending",
        reason,
      });
    }
    if (
      artifactSizeBucketForPlaintextLength(
        blobStatus.reference.plaintextLength,
      ) !== lifecycle.sizeBucket
    ) {
      await input.product.recordFailure({
        operationId: lifecycle.operationId,
        requestDigest: lifecycle.requestDigest,
        disposition: "quarantined",
        failureCode: "blob_mismatch",
      });
      return Object.freeze({ status: "quarantined", reason: "blob_mismatch" });
    }
    const verified = await input.crypto.verify(
      artifactCryptoRevisionReference(lifecycle),
    );
    if (verified === null) {
      await input.product.recordFailure({
        operationId: lifecycle.operationId,
        requestDigest: lifecycle.requestDigest,
        disposition: "blocked",
        failureCode: "crypto_incomplete",
      });
      return Object.freeze({ status: "pending", reason: "crypto_incomplete" });
    }
    if (!exactVerified(lifecycle, verified)) {
      await input.product.recordFailure({
        operationId: lifecycle.operationId,
        requestDigest: lifecycle.requestDigest,
        disposition: "quarantined",
        failureCode: "crypto_mismatch",
      });
      return Object.freeze({ status: "quarantined", reason: "crypto_mismatch" });
    }
    const published = await input.product.publish({
      lifecycle,
      verified,
      targetLifecycleState: "active",
    });
    if (published === "stale" || published === "conflict") {
      return Object.freeze({ status: "stale", reason: "mapping_conflict" });
    }
    const durable = await input.product.read(lifecycle.operationId);
    if (durable === null || durable.completion !== "complete") {
      throw new Error("Artifact publication did not produce a durable complete receipt");
    }
    return Object.freeze({
      status: published === "duplicate" ? "replayed" : "published",
      lifecycle: durable,
    });
  };

  return Object.freeze({
    async publish(
      value: Omit<
        ArtifactPublicationPlanInput,
        "requestDigest" | "allocationRequestDigest"
      >,
    ): Promise<ArtifactPublicationResult> {
      const requestDigest = artifactPublicationRequestDigest(value);
      const plan = Object.freeze({
        ...value,
        requestDigest,
        allocationRequestDigest: requestDigest.slice(),
      });
      assertArtifactPublicationPlan(plan);
      const reserved = await input.product.reserve(plan);
      if (reserved.status === "conflict") {
        return Object.freeze({ status: "stale", reason: "mapping_conflict" });
      }
      if (reserved.lifecycle.completion === "complete") {
        return reconcileLifecycle(reserved.lifecycle);
      }
      const blobStatus = await input.blobs.inspectStored(
        storedBlobFacts(reserved.lifecycle),
      );
      if (blobStatus.status !== "exact") {
        const reason = blobStatus.status === "missing"
          ? "blob_unavailable" as const
          : "blob_mismatch" as const;
        await input.product.recordFailure({
          operationId: reserved.lifecycle.operationId,
          requestDigest: reserved.lifecycle.requestDigest,
          disposition: blobStatus.status !== "missing"
            ? "quarantined"
            : "blocked",
          failureCode: reason,
        });
        return Object.freeze({
          status: blobStatus.status !== "missing"
            ? "quarantined"
            : "pending",
          reason,
        });
      }
      if (
        artifactSizeBucketForPlaintextLength(
          blobStatus.reference.plaintextLength,
        ) !== reserved.lifecycle.sizeBucket
      ) {
        await input.product.recordFailure({
          operationId: reserved.lifecycle.operationId,
          requestDigest: reserved.lifecycle.requestDigest,
          disposition: "quarantined",
          failureCode: "blob_mismatch",
        });
        return Object.freeze({
          status: "quarantined",
          reason: "blob_mismatch",
        });
      }
      await input.crypto.complete(value.revision);
      return reconcileLifecycle(reserved.lifecycle);
    },

    async reconcile(operationId: string): Promise<ArtifactPublicationResult | null> {
      const lifecycle = await input.product.read(operationId);
      return lifecycle === null ? null : reconcileLifecycle(lifecycle);
    },
  });
}
