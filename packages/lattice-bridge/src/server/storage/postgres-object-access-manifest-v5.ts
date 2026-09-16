import {
  agentCryptoRuntimeSigners,
  and,
  asc,
  eq,
  gte,
  humanCryptoDevices,
  lte,
  objectCryptoAccessManifests,
  processorCryptoSignerAuthorizations,
} from "@nautilo/db";
import {
  verifyCommonObjectAccessManifest,
  type AgentRuntimeSignerPublication,
  type LatticeCrypto,
  type CommonObjectAccessManifest,
  type VerifiedCommonObjectAccessManifest,
} from "@nautilo/lattice-crypto";
import {
  decodeAgentRuntimeSignerPublicationV1,
  decodeObjectAccessManifestV5,
  encodeAgentRuntimeSignerPublicationV1,
} from "@nautilo/lattice-crypto/wire";

import {
  authenticateHistoricalAgentRuntimeSignerPublication,
  type ResolveHistoricalAgentRuntimeSignerManagerAuthority,
} from "./agent-runtime-signer-history.ts";
import { readProcessorSignerAuthorizationVersion, destroyVerifiedProcessorSignerAuthorizationV2 } from "@nautilo/lattice-crypto/background";
import {loadVerifiedCurrentProcessorSignerAuthorization, destroyVerifiedCurrentProcessorSignerEvidence} from "./postgres-current-processor-signer-authorization.ts";
import {
  loadVerifiedProcessorSignerAuthorization,
} from "./postgres-processor-transform-object-port.ts";
import {
  cryptoTypedDb,
  executeTypedCryptoQuery,
  type CryptoPostgresExecutor,
} from "./postgres-lattice-storage.ts";
import type { DatabaseRow } from "./postgres-record-codecs.ts";
import {ClassifiedDataOperationError} from "../../transition/encryption-data-operation-owner.ts";

const PAGE_SIZE = 128;

/** Resolve an exact principal from caller-authenticated foreground authority. */
export type ResolveLiveShadowAgentObjectSigner = (principal: Readonly<{
  agentId: string;
  runtimeGeneration: number;
  signerKeyId: string;
}>) => Uint8Array | null | Promise<Uint8Array | null>;

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function bytesHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function wipeManifestBytes(manifest: CommonObjectAccessManifest): void {
  manifest.payloadHash.fill(0);
  manifest.previousManifestHash?.fill(0);
  manifest.envelopeHashes.forEach((hash) => hash.fill(0));
  manifest.signerAuthorizationHash?.fill(0);
  if (manifest.signer.kind === "processor_invocation") {
    manifest.signer.workDescriptorHash.fill(0);
  }
  manifest.signature.fill(0);
}

function wipeVerifiedManifest(
  verified: VerifiedCommonObjectAccessManifest,
  keepManifest: boolean,
): void {
  verified.manifestBytes.fill(0);
  verified.manifestHash.fill(0);
  const authorization = verified.signerAuthorization;
  if (authorization !== null) {
    authorization.authorization.issuerSigningPublicKeyHash.fill(0);
    authorization.authorization.signer.workDescriptorHash.fill(0);
    authorization.authorization.signerPublicKey.fill(0);
    authorization.authorization.workDescriptorHash.fill(0);
    authorization.authorization.credentialHash.fill(0);
    authorization.authorization.signature.fill(0);
    authorization.authorizationBytes.fill(0);
    authorization.authorizationHash.fill(0);
  }
  if (verified.currentSignerAuthorization !== null) destroyVerifiedProcessorSignerAuthorizationV2(verified.currentSignerAuthorization);
  if (!keepManifest) wipeManifestBytes(verified.manifest);
}

function oneOrNull(
  rows: readonly DatabaseRow[],
  label: string,
): DatabaseRow | null {
  if (rows.length > 1) throw new ClassifiedDataOperationError("integrity", `${label} is not unique`);
  return rows[0] ?? null;
}

function rowString(row: DatabaseRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new ClassifiedDataOperationError("integrity", `${field} must be text`);
  return value;
}

function rowCounter(row: DatabaseRow, field: string): number {
  const raw = row[field];
  const value = typeof raw === "bigint"
    ? Number(raw)
    : typeof raw === "string" && /^(0|[1-9][0-9]*)$/u.test(raw)
    ? Number(raw)
    : raw;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ClassifiedDataOperationError("integrity", `${field} must be a nonnegative safe integer`);
  }
  return value as number;
}

function rowBytes(row: DatabaseRow, field: string): Uint8Array {
  const value = row[field];
  if (!(value instanceof Uint8Array)) throw new ClassifiedDataOperationError("integrity", `${field} must be bytea`);
  return Uint8Array.from(value);
}

async function historicalAgentPublication(input: Readonly<{
  executor: CryptoPostgresExecutor;
  crypto: LatticeCrypto;
  manifest: CommonObjectAccessManifest;
  resolveHistoricalManagerAuthority:
    ResolveHistoricalAgentRuntimeSignerManagerAuthority;
}>): Promise<AgentRuntimeSignerPublication> {
  if (input.manifest.signer.kind !== "agent_runtime") {
    throw new TypeError("Agent publication lookup requires an Agent signer");
  }
  const signer = input.manifest.signer;
  const row = oneOrNull(await executeTypedCryptoQuery(
    input.executor,
    cryptoTypedDb.select({
      agent_id: agentCryptoRuntimeSigners.agentId,
      runtime_generation: agentCryptoRuntimeSigners.runtimeGeneration,
      authorization_revision:
        agentCryptoRuntimeSigners.authorizationRevision,
      transition_kind: agentCryptoRuntimeSigners.transitionKind,
      operation_id: agentCryptoRuntimeSigners.operationId,
      signer_key_id: agentCryptoRuntimeSigners.signerKeyId,
      signer_public_key: agentCryptoRuntimeSigners.signerPublicKey,
      publication_bytes: agentCryptoRuntimeSigners.publicationBytes,
    }).from(agentCryptoRuntimeSigners).where(and(
      eq(agentCryptoRuntimeSigners.agentId, signer.agentId),
      eq(
        agentCryptoRuntimeSigners.runtimeGeneration,
        signer.runtimeGeneration,
      ),
    )).limit(2),
  ), "common v5 Agent Runtime signer publication");
  if (row === null) throw new ClassifiedDataOperationError("integrity",
    "common v5 Agent Runtime signer publication is unavailable",
  );
  const publication = decodeAgentRuntimeSignerPublicationV1(
    rowBytes(row, "publication_bytes"),
  );
  if (
    publication.agentId !== rowString(row, "agent_id")
    || publication.runtimeGeneration !== rowCounter(row, "runtime_generation")
    || publication.authorizationRevision
      !== rowCounter(row, "authorization_revision")
    || publication.transitionKind !== rowString(row, "transition_kind")
    || publication.operationId !== rowString(row, "operation_id")
    || publication.signerKeyId !== rowString(row, "signer_key_id")
    || !bytesEqual(
      publication.signerPublicKey,
      rowBytes(row, "signer_public_key"),
    )
  ) throw new ClassifiedDataOperationError("integrity", "common v5 Agent signer publication columns conflict");
  const authenticated = await authenticateHistoricalAgentRuntimeSignerPublication({
    crypto: input.crypto,
    publication,
    resolveHistoricalManagerAuthority:
      input.resolveHistoricalManagerAuthority,
  });
  if (
    authenticated.agentId !== signer.agentId
    || authenticated.runtimeGeneration !== signer.runtimeGeneration
    || authenticated.signerKeyId !== signer.signerKeyId
  ) throw new ClassifiedDataOperationError("integrity", "common v5 Agent signer publication is substituted");
  return authenticated;
}

async function historicalHumanKey(input: Readonly<{
  executor: CryptoPostgresExecutor;
  manifest: CommonObjectAccessManifest;
  resolveHistoricalHumanDeviceSigningPublicKey?:
    ResolveHistoricalHumanDeviceSigningPublicKeyV5Async | undefined;
}>): Promise<Uint8Array> {
  if (input.manifest.signer.kind !== "human_device") {
    throw new TypeError("Human key lookup requires a Human signer");
  }
  const signer = input.manifest.signer;
  if (input.resolveHistoricalHumanDeviceSigningPublicKey !== undefined) {
    const resolved = await input.resolveHistoricalHumanDeviceSigningPublicKey({
      subjectHumanId: signer.subjectHumanId,
      committerDeviceId: signer.committerDeviceId,
      hostAuthorizationRevision: input.manifest.hostAuthorizationRevision,
    });
    if (!(resolved instanceof Uint8Array) || resolved.length !== 32) {
      throw new ClassifiedDataOperationError("integrity", "common v5 Human device signer history is unavailable");
    }
    return resolved.slice();
  }
  const row = oneOrNull(await executeTypedCryptoQuery(
    input.executor,
    cryptoTypedDb.select({
      device_id: humanCryptoDevices.deviceId,
      human_id: humanCryptoDevices.humanId,
      signing_public_key: humanCryptoDevices.signingPublicKey,
      state: humanCryptoDevices.state,
      revision: humanCryptoDevices.revision,
    }).from(humanCryptoDevices).where(eq(
      humanCryptoDevices.deviceId,
      signer.committerDeviceId,
    )).limit(2),
  ), "common v5 Human device signer");
  if (
    row === null
    || rowString(row, "device_id") !== signer.committerDeviceId
    || rowString(row, "human_id") !== signer.subjectHumanId
    || (rowString(row, "state") !== "active"
      && rowString(row, "state") !== "revoked")
    || rowCounter(row, "revision") < input.manifest.hostAuthorizationRevision
  ) throw new ClassifiedDataOperationError("integrity", "common v5 Human device signer history is unavailable");
  return rowBytes(row, "signing_public_key");
}

export type VerifiedStoredObjectAccessManifestChainV5 = Readonly<{
  objectId: string;
  payloadHash: Uint8Array;
  headManifest: CommonObjectAccessManifest;
  headManifestBytes: Uint8Array;
  headManifestHash: Uint8Array;
  genesisHumanId: string | null;
  headSignerPublicKey: Uint8Array;
  headSignerAuthorizationBytes?: Uint8Array;
  headSignerIssuingPublicKey?: Uint8Array;
  signerEvidence: readonly Readonly<{
    kind: "agent_runtime_publication" | "processor_authorization";
    evidenceBytes: Uint8Array;
    issuer?: Readonly<{
      subjectHumanId: string;
      deviceId: string;
      hostAuthorizationRevision: number;
      signingPublicKey: Uint8Array;
    }>;
  }>[];
}>;

export type ResolveHistoricalHumanDeviceSigningPublicKeyV5Async = (
  context: Readonly<{
    subjectHumanId: string;
    committerDeviceId: string;
    hostAuthorizationRevision: number;
  }>,
) => Promise<Uint8Array | null>;

export function destroyVerifiedStoredObjectAccessManifestChainV5(
  value: VerifiedStoredObjectAccessManifestChainV5,
): void {
  wipeManifestBytes(value.headManifest);
  value.payloadHash.fill(0);
  value.headManifestBytes.fill(0);
  value.headManifestHash.fill(0);
  value.headSignerPublicKey.fill(0);
  value.headSignerAuthorizationBytes?.fill(0);
  value.headSignerIssuingPublicKey?.fill(0);
  value.signerEvidence.forEach(({ evidenceBytes, issuer }) => {
    evidenceBytes.fill(0);
    issuer?.signingPublicKey.fill(0);
  });
}

/**
 * Authenticates every retained common-v5 revision in bounded pages. No
 * database head is treated as a trust anchor merely because it was selected.
 */
export async function verifyStoredObjectAccessManifestChainV5(input: Readonly<{
  executor: CryptoPostgresExecutor;
  crypto: LatticeCrypto;
  objectId: string;
  headAccessRevision: number;
  expectedPayloadHash: Uint8Array;
  expectedHeadManifestHash: Uint8Array;
  resolveHistoricalAgentManagerAuthority:
    ResolveHistoricalAgentRuntimeSignerManagerAuthority;
  resolveLiveShadowAgentSigner?: ResolveLiveShadowAgentObjectSigner | undefined;
  resolveHistoricalHumanDeviceSigningPublicKey?:
    ResolveHistoricalHumanDeviceSigningPublicKeyV5Async | undefined;
}>): Promise<VerifiedStoredObjectAccessManifestChainV5> {
  let cursor = 0;
  let previousHash: Uint8Array | null = null;
  let genesisHumanId: string | null = null;
  let head: VerifiedStoredObjectAccessManifestChainV5 | undefined;
  let succeeded = false;
  const signerEvidence = new Map<string, Readonly<{
    kind: "agent_runtime_publication" | "processor_authorization";
    evidenceBytes: Uint8Array;
    issuer?: Readonly<{
      subjectHumanId: string;
      deviceId: string;
      hostAuthorizationRevision: number;
      signingPublicKey: Uint8Array;
    }>;
  }>>();
  try {
    while (cursor <= input.headAccessRevision) {
      const rows = await executeTypedCryptoQuery(
        input.executor,
        cryptoTypedDb.select({
          object_id: objectCryptoAccessManifests.objectId,
          access_revision: objectCryptoAccessManifests.accessRevision,
          manifest_hash: objectCryptoAccessManifests.manifestHash,
          previous_manifest_hash:
            objectCryptoAccessManifests.previousManifestHash,
          payload_hash: objectCryptoAccessManifests.payloadHash,
          manifest_bytes: objectCryptoAccessManifests.manifestBytes,
        }).from(objectCryptoAccessManifests).where(and(
          eq(objectCryptoAccessManifests.objectId, input.objectId),
          gte(objectCryptoAccessManifests.accessRevision, cursor),
          lte(
            objectCryptoAccessManifests.accessRevision,
            input.headAccessRevision,
          ),
        )).orderBy(asc(objectCryptoAccessManifests.accessRevision)).limit(
          PAGE_SIZE,
        ),
      );
      if (rows.length === 0 || rows.length > PAGE_SIZE) {
        throw new ClassifiedDataOperationError("integrity", "common v5 object access chain is incomplete");
      }
      for (const row of rows) {
        const revision = rowCounter(row, "access_revision");
        const manifestBytes = rowBytes(row, "manifest_bytes");
        const manifestHash = rowBytes(row, "manifest_hash");
        let decoded: CommonObjectAccessManifest;
        try {decoded = decodeObjectAccessManifestV5(manifestBytes);}
        catch (cause) {
          manifestBytes.fill(0); manifestHash.fill(0);
          throw new ClassifiedDataOperationError("integrity", "Stored V5 manifest encoding is invalid", {cause});
        }
        let signerPublicKey: Uint8Array | undefined;
        let signerAuthorizationBytes: Uint8Array | undefined;
        let signerIssuingPublicKey: Uint8Array | undefined;
        let publicEvidenceBytes: Uint8Array | undefined;
        let publicEvidenceKind:
          | "agent_runtime_publication"
          | "processor_authorization"
          | undefined;
        let publicEvidenceIssuer: Readonly<{
          subjectHumanId: string;
          deviceId: string;
          hostAuthorizationRevision: number;
          signingPublicKey: Uint8Array;
        }> | undefined;
        let verified: VerifiedCommonObjectAccessManifest | undefined;
        let keepVerifiedManifest = false;
        try {
        if (decoded.signer.kind === "human_device") {
          signerPublicKey = await historicalHumanKey({
            executor: input.executor,
            manifest: decoded,
            resolveHistoricalHumanDeviceSigningPublicKey:
              input.resolveHistoricalHumanDeviceSigningPublicKey,
          });
          if (revision === 0) genesisHumanId = decoded.signer.subjectHumanId;
        } else if (decoded.signer.kind === "agent_runtime") {
          // Foreground signers are authenticated by the admitted execution,
          // not by the persistent background Runtime publication inventory.
          signerPublicKey = await input.resolveLiveShadowAgentSigner?.(
            Object.freeze({
              agentId: decoded.signer.agentId,
              runtimeGeneration: decoded.signer.runtimeGeneration,
              signerKeyId: decoded.signer.signerKeyId,
            }),
          ) ?? undefined;
          if (signerPublicKey === undefined) {
            const publication = await historicalAgentPublication({
              executor: input.executor,
              crypto: input.crypto,
              manifest: decoded,
              resolveHistoricalManagerAuthority:
                input.resolveHistoricalAgentManagerAuthority,
            });
            signerPublicKey = publication.signerPublicKey.slice();
            publicEvidenceBytes = encodeAgentRuntimeSignerPublicationV1(
              publication,
            );
            publicEvidenceKind = "agent_runtime_publication";
          }
        } else {
          const authorizationRow = oneOrNull(await executeTypedCryptoQuery(
            input.executor,
            cryptoTypedDb.select({
              authorization_bytes:
                processorCryptoSignerAuthorizations.authorizationBytes,
            }).from(processorCryptoSignerAuthorizations).where(eq(
              processorCryptoSignerAuthorizations.authorizationId,
              decoded.signer.signerAuthorizationId,
            )).limit(2),
          ), "common v5 processor signer authorization");
          if (authorizationRow === null) throw new ClassifiedDataOperationError("integrity",
            "common v5 processor signer authorization is unavailable",
          );
          const authorizationBytes = rowBytes(authorizationRow, "authorization_bytes");
          let signerVersion: ReturnType<typeof readProcessorSignerAuthorizationVersion>;
          try {signerVersion = readProcessorSignerAuthorizationVersion(authorizationBytes);}
          catch (cause) {
            authorizationBytes.fill(0);
            throw new ClassifiedDataOperationError("integrity", "Stored V5 processor signer format is invalid", {cause});
          }
          if (signerVersion === 2) {
            const current = await loadVerifiedCurrentProcessorSignerAuthorization(input.executor, input.crypto, authorizationBytes);
            try {
              signerPublicKey = current.certificate.signerPublicKey.slice();
              signerAuthorizationBytes = current.authorizationBytes.slice();
              signerIssuingPublicKey = current.issuerPublicKey.slice();
              publicEvidenceIssuer = Object.freeze({
                subjectHumanId: current.certificate.issuer.humanId,
                deviceId: current.certificate.issuer.deviceId,
                hostAuthorizationRevision: current.certificate.issuer.securityRevision,
                signingPublicKey: current.issuerPublicKey.slice(),
              });
              publicEvidenceBytes = current.authorizationBytes.slice();
            } finally {destroyVerifiedCurrentProcessorSignerEvidence(current); authorizationBytes.fill(0);}
          } else {
          const verifiedAuthorization =
            await loadVerifiedProcessorSignerAuthorization(
              input.executor,
              input.crypto,
              rowBytes(authorizationRow, "authorization_bytes"),
            );
          signerPublicKey = verifiedAuthorization.authorization.signerPublicKey
            .slice();
          signerAuthorizationBytes =
            verifiedAuthorization.authorizationBytes.slice();
          signerIssuingPublicKey = verifiedAuthorization.issuerPublicKey.slice();
          publicEvidenceIssuer = Object.freeze({
            subjectHumanId: verifiedAuthorization.authorization.issuingHumanId,
            deviceId: verifiedAuthorization.authorization.issuingDeviceId,
            hostAuthorizationRevision: verifiedAuthorization.authorization
              .issuingDeviceAuthorizationRevision,
            signingPublicKey: verifiedAuthorization.issuerPublicKey.slice(),
          });
          publicEvidenceBytes =
            verifiedAuthorization.authorizationBytes.slice();
          authorizationBytes.fill(0);
          }
          publicEvidenceKind = "processor_authorization";
        }
          try {
          verified = verifyCommonObjectAccessManifest(input.crypto, {
            manifestBytes,
            resolveHistoricalHumanDeviceSigningPublicKey: (context) =>
              decoded.signer.kind === "human_device"
                  && context.subjectHumanId === decoded.signer.subjectHumanId
                  && context.committerDeviceId
                    === decoded.signer.committerDeviceId
                ? signerPublicKey ?? null : null,
            resolveAgentRuntimeSignerPublicKey: (principal) =>
              decoded.signer.kind === "agent_runtime"
                  && principal.agentId === decoded.signer.agentId
                  && principal.runtimeGeneration
                    === decoded.signer.runtimeGeneration
                  && principal.signerKeyId === decoded.signer.signerKeyId
                ? signerPublicKey ?? null : null,
            resolveProcessorSignerAuthorizationBytes: (evidence) =>
              decoded.signer.kind === "processor_invocation"
                  && evidence.authorizationId
                    === decoded.signer.signerAuthorizationId
                ? signerAuthorizationBytes ?? null : null,
            resolveHistoricalProcessorIssuingDevicePublicKey: () =>
              signerIssuingPublicKey ?? null,
            resolveHistoricalCurrentIssuer: context =>
              publicEvidenceIssuer !== undefined
                && context.issuer.humanId === publicEvidenceIssuer.subjectHumanId
                && context.issuer.deviceId === publicEvidenceIssuer.deviceId
                && context.issuer.securityRevision === publicEvidenceIssuer.hostAuthorizationRevision
                ? signerIssuingPublicKey ?? null : null,
          });
          } catch (cause) {throw new ClassifiedDataOperationError("integrity", "Stored V5 manifest signature or signer is invalid", {cause});}
          const commonMismatch =
            rowString(row, "object_id") !== input.objectId
            || revision !== cursor
            || verified.manifest.objectId !== input.objectId
            || verified.manifest.accessRevision !== revision;
          const payloadMismatch =
            !bytesEqual(
              verified.manifest.payloadHash,
              input.expectedPayloadHash,
            )
            || !bytesEqual(
              rowBytes(row, "payload_hash"),
              input.expectedPayloadHash,
            );
          const manifestMismatch =
            !bytesEqual(verified.manifestHash, manifestHash)
            || !bytesEqual(input.crypto.hash(manifestBytes), manifestHash);
          const manifestPreviousMismatch = previousHash === null
            ? verified.manifest.previousManifestHash !== null
            : verified.manifest.previousManifestHash === null
              || !bytesEqual(
                verified.manifest.previousManifestHash,
                previousHash,
              );
          const storedPreviousMismatch = previousHash === null
            ? row["previous_manifest_hash"] !== null
            : row["previous_manifest_hash"] === null
              || !bytesEqual(
                rowBytes(row, "previous_manifest_hash"),
                previousHash,
              );
          const previousMismatch = manifestPreviousMismatch
            || storedPreviousMismatch;
          if (
            commonMismatch || payloadMismatch || manifestMismatch
            || previousMismatch
          ) {
            const category = commonMismatch ? "coordinate"
              : payloadMismatch ? "payload"
              : manifestMismatch ? "manifest"
              : manifestPreviousMismatch ? "manifest-previous"
              : "stored-previous";
            throw new ClassifiedDataOperationError("integrity",
              `common v5 object access chain is substituted: ${category}`,
            );
          }
          previousHash?.fill(0);
          previousHash = manifestHash.slice();
          if (
            publicEvidenceBytes !== undefined
            && publicEvidenceKind !== undefined
          ) {
            const evidenceHash = input.crypto.hash(publicEvidenceBytes);
            const key = `${publicEvidenceKind}:${bytesHex(evidenceHash)}`;
            evidenceHash.fill(0);
            if (!signerEvidence.has(key)) {
              signerEvidence.set(key, Object.freeze({
                kind: publicEvidenceKind,
                evidenceBytes: publicEvidenceBytes.slice(),
                ...(publicEvidenceIssuer === undefined ? {} : {
                  issuer: Object.freeze({
                    ...publicEvidenceIssuer,
                    signingPublicKey: publicEvidenceIssuer.signingPublicKey.slice(),
                  }),
                }),
              }));
            }
          }
          if (revision === input.headAccessRevision) {
            if (!bytesEqual(manifestHash, input.expectedHeadManifestHash)) {
              throw new ClassifiedDataOperationError("integrity", "common v5 object access head hash is substituted");
            }
            head = Object.freeze({
              objectId: input.objectId,
              payloadHash: input.expectedPayloadHash.slice(),
              headManifest: verified.manifest,
              headManifestBytes: manifestBytes.slice(),
              headManifestHash: manifestHash.slice(),
              genesisHumanId,
              headSignerPublicKey: signerPublicKey.slice(),
              ...(signerAuthorizationBytes === undefined ? {} : {
                headSignerAuthorizationBytes: signerAuthorizationBytes.slice(),
              }),
              ...(signerIssuingPublicKey === undefined ? {} : {
                headSignerIssuingPublicKey: signerIssuingPublicKey.slice(),
              }),
              signerEvidence: Object.freeze([]),
            });
            keepVerifiedManifest = true;
          }
        } finally {
          if (verified !== undefined) {
            wipeVerifiedManifest(verified, keepVerifiedManifest);
          }
          wipeManifestBytes(decoded);
          manifestBytes.fill(0);
          manifestHash.fill(0);
          signerPublicKey?.fill(0);
          signerAuthorizationBytes?.fill(0);
          signerIssuingPublicKey?.fill(0);
          publicEvidenceBytes?.fill(0);
          publicEvidenceIssuer?.signingPublicKey.fill(0);
        }
        cursor += 1;
      }
    }
    if (head === undefined || cursor !== input.headAccessRevision + 1) {
      throw new ClassifiedDataOperationError("integrity", "common v5 object access chain is incomplete");
    }
    const result = Object.freeze({
      ...head,
      signerEvidence: Object.freeze([...signerEvidence.entries()]
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([, entry]) => Object.freeze({
          kind: entry.kind,
          evidenceBytes: entry.evidenceBytes.slice(),
          ...(entry.issuer === undefined ? {} : {
            issuer: Object.freeze({
              ...entry.issuer,
              signingPublicKey: entry.issuer.signingPublicKey.slice(),
            }),
          }),
        }))),
    });
    succeeded = true;
    return result;
  } finally {
    previousHash?.fill(0);
    signerEvidence.forEach(({ evidenceBytes, issuer }) => {
      evidenceBytes.fill(0);
      issuer?.signingPublicKey.fill(0);
    });
    if (!succeeded && head !== undefined) {
      destroyVerifiedStoredObjectAccessManifestChainV5(head);
    }
  }
}
