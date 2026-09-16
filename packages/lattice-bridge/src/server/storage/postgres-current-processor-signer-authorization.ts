import {and, eq, humanCryptoDevices, processorCryptoSignerAuthorizations} from "@nautilo/db";
import type {LatticeCrypto} from "@nautilo/lattice-crypto";
import {verifyHistoricalProcessorSignerAuthorizationV2, readProcessorSignerAuthorizationVersion,
  destroyVerifiedProcessorSignerAuthorizationV2,
  backgroundProcessorNamespaceRequirementsV2,
  type ProcessorSignerAuthorizationCertificateV2} from "@nautilo/lattice-crypto/background";
import {cryptoTypedDb, executeTypedCryptoQuery, type CryptoPostgresExecutor} from "./postgres-lattice-storage.ts";
import type {DatabaseRow} from "./postgres-record-codecs.ts";
import {ClassifiedDataOperationError} from "../../transition/encryption-data-operation-owner.ts";

export interface VerifiedCurrentProcessorSignerEvidence {
  readonly certificate: ProcessorSignerAuthorizationCertificateV2;
  readonly authorizationHash: Uint8Array;
  readonly authorizationBytes: Uint8Array;
  readonly issuerPublicKey: Uint8Array;
  readonly requestId: string;
  readonly recipientGeneration: number;
}

export function destroyVerifiedCurrentProcessorSignerEvidence(value: VerifiedCurrentProcessorSignerEvidence): void {
  destroyVerifiedProcessorSignerAuthorizationV2(value);
  value.issuerPublicKey.fill(0);
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
function bytes(row: DatabaseRow, field: string): Uint8Array {
  const value = row[field];
  if (!(value instanceof Uint8Array)) throw new ClassifiedDataOperationError("integrity", `Current signer ${field} must be bytes`);
  return new Uint8Array(value);
}
function text(row: DatabaseRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new ClassifiedDataOperationError("integrity", `Current signer ${field} must be text`);
  return value;
}
function counter(row: DatabaseRow, field: string): number {
  const value = row[field];
  const normalized = typeof value === "bigint" || (typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value))
    ? Number(value) : value;
  if (typeof normalized !== "number" || !Number.isSafeInteger(normalized) || normalized < 0) {
    throw new ClassifiedDataOperationError("integrity", `Current signer ${field} must be a safe counter`);
  }
  return normalized;
}
function instant(row: DatabaseRow, field: string): number {
  const raw = row[field];
  const value = typeof raw === "string" ? new Date(raw) : raw;
  if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime())) throw new ClassifiedDataOperationError("integrity", `Current signer ${field} must be an instant`);
  return value.getTime();
}

/**
 * The append-only accepted certificate is publication authority evidence.
 * Reads deliberately survive request pruning and subsequent device revocation.
 * Immutable device generation/key identity is checked; M303 securityRevision
 * is never compared with the unrelated legacy device revision counter.
 */
export async function loadVerifiedCurrentProcessorSignerAuthorization(
  executor: CryptoPostgresExecutor, crypto: LatticeCrypto, inputBytes: Uint8Array,
): Promise<VerifiedCurrentProcessorSignerEvidence> {
  try {
    if (readProcessorSignerAuthorizationVersion(inputBytes) !== 2) throw new Error("Current signer certificate must use format 2");
  } catch (cause) {throw new ClassifiedDataOperationError("integrity", "Current signer certificate format is invalid", {cause});}
  const authorizationBytes = new Uint8Array(inputBytes);
  const authorizationHash = crypto.hash(authorizationBytes);
  let issuerPublicKey: Uint8Array | undefined;
  let verified: ReturnType<typeof verifyHistoricalProcessorSignerAuthorizationV2> | undefined;
  let retained = false;
  try {
    const table = processorCryptoSignerAuthorizations;
    const rows = await executeTypedCryptoQuery(executor, cryptoTypedDb.select({
      authorization_id: table.authorizationId, format_version: table.formatVersion,
      request_id: table.requestId, recipient_generation: table.recipientGeneration,
      processor_kind: table.processorKind, processor_version: table.processorVersion,
      work_id: table.workId, namespace_id: table.namespaceId, domain_id: table.domainId,
      domain_epoch: table.domainEpoch, namespace_access_revision: table.namespaceAccessRevision,
      policy_revision: table.policyRevision, processor_authorization_revision: table.processorAuthorizationRevision,
      issuing_human_id: table.issuingHumanId, issuing_device_id: table.issuingDeviceId,
      issuing_device_authorization_revision: table.issuingDeviceAuthorizationRevision,
      issuer_signing_public_key_hash: table.issuerSigningPublicKeyHash,
      signer_key_id: table.signerKeyId, signer_public_key: table.signerPublicKey,
      work_descriptor_hash: table.workDescriptorHash, work_descriptor_bytes: table.workDescriptorBytes,
      authorization_hash: table.authorizationHash, credential_hash: table.credentialHash,
      authorization_bytes: table.authorizationBytes, issued_at: table.issuedAt,
      expires_at: table.expiresAt, created_at: table.createdAt,
    }).from(table).where(and(eq(table.authorizationHash, authorizationHash), eq(table.formatVersion, 2))).limit(2));
    const row = rows[0];
    if (rows.length !== 1 || row === undefined || counter(row, "format_version") !== 2
      || !equal(bytes(row, "authorization_hash"), authorizationHash)
      || !equal(bytes(row, "authorization_bytes"), authorizationBytes)) {
      throw new ClassifiedDataOperationError("integrity", "Current processor signer evidence is unavailable or substituted");
    }
    const devices = await executeTypedCryptoQuery(executor, cryptoTypedDb.select({
      device_id: humanCryptoDevices.deviceId, human_id: humanCryptoDevices.humanId,
      device_generation: humanCryptoDevices.deviceGeneration,
      signing_public_key: humanCryptoDevices.signingPublicKey, state: humanCryptoDevices.state,
    }).from(humanCryptoDevices).where(eq(humanCryptoDevices.deviceId, text(row, "issuing_device_id"))).limit(2).for("share"));
    const device = devices[0];
    if (devices.length !== 1 || device === undefined
      || text(device, "device_id") !== text(row, "issuing_device_id")
      || text(device, "human_id") !== text(row, "issuing_human_id")
      || !["active", "revoked"].includes(text(device, "state"))) {
      throw new ClassifiedDataOperationError("integrity", "Current processor issuing device history is unavailable");
    }
    issuerPublicKey = bytes(device, "signing_public_key");
    const key = issuerPublicKey;
    try {
    verified = verifyHistoricalProcessorSignerAuthorizationV2(crypto, {
      authorizationBytes, resolveHistoricalIssuer: (context) =>
        context.issuer.deviceId === text(device, "device_id")
          && context.issuer.humanId === text(device, "human_id")
          && context.issuer.deviceGeneration === counter(device, "device_generation")
          && equal(context.issuer.signingPublicKeyHash, crypto.hash(key))
          ? key : null,
    });
    } catch (cause) {throw new ClassifiedDataOperationError("integrity", "Current processor signer certificate is invalid", {cause});}
    const {certificate: c} = verified;
    const d = c.descriptor;
    const anchor = backgroundProcessorNamespaceRequirementsV2(d)
      .find(entry => entry.authority.namespaceId === d.anchorNamespaceId)?.authority;
    if (anchor === undefined) throw new ClassifiedDataOperationError("integrity", "Processor certificate anchor is absent");
    if (text(row, "authorization_id") !== c.credentialId
      || text(row, "request_id") !== d.requestId || counter(row, "recipient_generation") !== d.recipientGeneration
      || text(row, "processor_kind") !== d.subject.processorKind || counter(row, "processor_version") !== d.subject.processorVersion
      || text(row, "work_id") !== d.workId || text(row, "namespace_id") !== d.anchorNamespaceId
      || text(row, "domain_id") !== d.anchorDomainId || row["domain_epoch"] !== null
      || row["processor_authorization_revision"] !== null
      || counter(row, "namespace_access_revision") !== anchor.namespaceAccessRevision
      || counter(row, "policy_revision") !== d.policyRevision
      || text(row, "issuing_human_id") !== c.issuer.humanId || text(row, "issuing_device_id") !== c.issuer.deviceId
      || counter(row, "issuing_device_authorization_revision") !== c.issuer.securityRevision
      || !equal(bytes(row, "issuer_signing_public_key_hash"), c.issuer.signingPublicKeyHash)
      || text(row, "signer_key_id") !== c.signer.signerKeyId || !equal(bytes(row, "signer_public_key"), c.signerPublicKey)
      || !equal(bytes(row, "work_descriptor_hash"), c.descriptorHash)
      || !equal(bytes(row, "work_descriptor_bytes"), c.descriptorBytes)
      || !equal(crypto.hash(bytes(row, "work_descriptor_bytes")), c.descriptorHash)
      || !equal(bytes(row, "credential_hash"), c.credentialHash)
      || instant(row, "issued_at") !== d.issuedAt || instant(row, "expires_at") !== d.expiresAt
      || instant(row, "created_at") < d.issuedAt || instant(row, "created_at") >= d.expiresAt) {
      throw new ClassifiedDataOperationError("integrity", "Current processor signer evidence has conflicting durable anchors");
    }
    retained = true;
    return Object.freeze({certificate: c, authorizationHash: verified.authorizationHash,
      authorizationBytes: verified.authorizationBytes, issuerPublicKey,
      requestId: d.requestId, recipientGeneration: d.recipientGeneration});
  } finally {
    authorizationBytes.fill(0); authorizationHash.fill(0);
    if (!retained) {
      issuerPublicKey?.fill(0);
      if (verified !== undefined) destroyVerifiedProcessorSignerAuthorizationV2(verified);
    }
  }
}
