import { describe, expect, test } from "bun:test";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  artifactCryptoBlobs,
  artifactCryptoOperations,
  artifactCryptoRevisions,
  artifacts,
} from "../../src/schema";

describe("M261 dormant protected Artifact schema", () => {
  test("keeps internal and stable Artifact identities distinct", () => {
    const columns = getTableColumns(artifacts);
    expect(columns.id?.dataType).toBe("string");
    expect(columns.artifactId?.dataType).toBe("string");
    for (const field of [
      "cryptoObjectId", "cryptoAccessRevision",
      "cryptoRequiredNamespaceFingerprint", "blobId", "blobGeneration",
      "ciphertextLength", "ciphertextSha256", "mimeClass", "sizeBucket",
      "cryptoLifecycleState",
    ]) expect(Object.keys(columns)).toContain(field);
    expect(columns.path?.notNull).toBeFalse();
    expect(columns.storageUri?.notNull).toBeFalse();
    expect(getTableConfig(artifacts).checks.map((check) => check.name))
      .toContain("artifacts_crypto_mapping_coherent");
  });

  test("models one immutable ciphertext generation without plaintext", () => {
    const columns = getTableColumns(artifactCryptoBlobs);
    for (const field of [
      "artifactRowId", "artifactId", "blobId", "blobGeneration",
      "publicationOperationId", "storageRef", "ciphertextLength",
      "ciphertextSha256", "state", "failureCode",
    ]) expect(Object.keys(columns)).toContain(field);
    for (const forbidden of [
      "content", "path", "mimeType", "plaintextLength", "plaintextSha256",
      "key", "dek", "envelope", "signedBytes",
    ]) expect(Reflect.has(columns, forbidden)).toBeFalse();
    expect(getTableConfig(artifactCryptoBlobs).foreignKeys).toHaveLength(0);
  });

  test("uses the revision row as the exact blob ownership edge", () => {
    const columns = getTableColumns(artifactCryptoRevisions);
    expect(columns.mimeClass?.enumValues).toEqual([
      "text", "image", "audio", "video", "document", "archive", "binary",
    ]);
    expect(columns.sizeBucket?.enumValues).toEqual([
      "empty", "le_64_kib", "le_1_mib", "le_10_mib", "le_100_mib",
    ]);
    for (const forbidden of ["mimeType", "plaintextLength", "chunkCount"])
      expect(Reflect.has(columns, forbidden)).toBeFalse();
    expect(columns.blobReferenceState?.enumValues).toEqual(["retained", "released"]);
    const config = getTableConfig(artifactCryptoRevisions);
    expect(config.foreignKeys).toHaveLength(1);
    expect(config.foreignKeys.map((foreignKey) => foreignKey.getName()))
      .toContain("artifact_crypto_revisions_exact_blob_fk");
    expect(config.uniqueConstraints.map((constraint) => constraint.name))
      .toContainAllValues([
        "uq_artifact_crypto_revisions_internal_coordinate",
        "uq_artifact_crypto_revisions_stable_coordinate",
        "uq_artifact_crypto_revisions_object",
      ]);
  });

  test("keeps publication operations content-free and bounded", () => {
    const columns = getTableColumns(artifactCryptoOperations);
    expect(columns.operationType?.enumValues).toEqual([
      "create", "content", "control", "access",
    ]);
    expect(columns.expectedRequiredNamespaceFingerprint?.notNull).toBeFalse();
    expect(columns.targetRequiredNamespaceFingerprint?.notNull).toBeTrue();
    for (const forbidden of [
      "content", "path", "mimeType", "plaintext", "key", "dek", "signedBytes",
    ]) expect(Reflect.has(columns, forbidden)).toBeFalse();
    const checks = getTableConfig(artifactCryptoOperations).checks.map(
      (check) => check.name,
    );
    for (const check of [
      "artifact_crypto_operations_shape",
      "artifact_crypto_operations_digest_sizes",
      "artifact_crypto_operations_retry_coherent",
    ]) expect(checks).toContain(check);
    expect(getTableConfig(artifactCryptoOperations).foreignKeys).toHaveLength(0);
  });
});
