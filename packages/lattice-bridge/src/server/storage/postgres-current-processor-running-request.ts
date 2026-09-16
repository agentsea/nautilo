import {backgroundCryptoAuthorizationRequests, eq} from "@nautilo/db";
import type {LatticeCrypto} from "@nautilo/lattice-crypto";
import {backgroundProcessorNamespaceRequirementsV2, type BackgroundAuthorizationIssuerContextV2} from "@nautilo/lattice-crypto/background";
import {cryptoTypedDb, executeTypedCryptoQuery, type CryptoPostgresExecutor} from "./postgres-lattice-storage.ts";

const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, index) => byte === b[index]);
const digestEqual = (a: unknown, b: Uint8Array) => a instanceof Uint8Array && equal(a, b);
function counter(value: unknown): number {
  const n = typeof value === "bigint" || (typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value)) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new Error("Current processor durable counter is invalid");
  return n;
}
function instant(raw: unknown): number {
  const value = typeof raw === "string" ? new Date(raw) : raw;
  if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime())) throw new Error("Current processor durable deadline is unavailable");
  return value.getTime();
}

/** Shared current V2 claim proof. The anchor routes the row; the signed bytes bind the full set. */
export async function assertCurrentProcessorRunningRequest(input: Readonly<{
  executor: CryptoPostgresExecutor; crypto: LatticeCrypto; context: BackgroundAuthorizationIssuerContextV2;
  descriptorBytes: Uint8Array; responseHash: Uint8Array; credentialHash: Uint8Array; claimId: string;
}>) {
  const {executor, crypto, context, descriptorBytes, responseHash, credentialHash, claimId} = input;
  const d = context.descriptor;
  const anchor = backgroundProcessorNamespaceRequirementsV2(d).find(entry => entry.authority.namespaceId === d.anchorNamespaceId)?.authority;
  if (anchor === undefined) throw new Error("Current processor anchor is absent");
    const table = backgroundCryptoAuthorizationRequests;
    const rows = await executeTypedCryptoQuery(executor, cryptoTypedDb.select().from(table)
      .where(eq(table.requestId, d.requestId)).limit(2).for("update"));
    const row = rows[0];
    if (rows.length !== 1 || row === undefined || counter(row.format_version) !== 2 || row.state !== "running"
      || row.request_id !== d.requestId || row.idempotency_key !== d.idempotencyId || row.claim_id !== claimId
      || counter(row.recipient_generation) !== d.recipientGeneration || row.work_id !== d.workId || row.work_kind !== d.workKind
      || row.purpose !== d.purpose || row.namespace_id !== anchor.namespaceId || row.domain_id !== anchor.domainId
      || row.credential_subject_kind !== "processor" || row.processor_kind !== d.subject.processorKind || counter(row.processor_version) !== 1
      || row.processor_authorization_revision !== null || row.expected_domain_epoch !== null
      || row.agent_id !== null || row.agent_runtime_generation !== null || row.agent_authorization_revision !== null
      || counter(row.expected_namespace_access_revision) !== anchor.namespaceAccessRevision || counter(row.expected_policy_revision) !== d.policyRevision
      || !digestEqual(row.descriptor_hash, context.descriptorHash) || !digestEqual(row.descriptor_bytes, descriptorBytes)
      || !digestEqual(row.accepted_response_hash, responseHash) || row.accepted_response_kind !== "processor"
      || !(row.accepted_response_bytes instanceof Uint8Array) || !equal(crypto.hash(row.accepted_response_bytes), responseHash)
      || !digestEqual(row.credential_hash, credentialHash) || row.recipient_key_id !== d.recipientKeyId
      || !digestEqual(row.recipient_public_key, d.recipientPublicKey) || instant(row.recipient_expires_at) !== d.expiresAt
      || row.issuing_human_id !== context.issuer.humanId || row.issuing_device_id !== context.issuer.deviceId
      || counter(row.issuing_device_authorization_revision) !== context.issuer.securityRevision
      || !digestEqual(row.issuer_signing_public_key_hash, context.issuer.signingPublicKeyHash)
      || instant(row.authorization_expires_at) !== d.expiresAt) {
      throw new Error("Current processor durable request or claim is substituted");
    }
    return row;
}
