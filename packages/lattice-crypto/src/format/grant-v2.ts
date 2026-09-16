import {
  canonicalizeParticipants,
  compareUnsignedUtf8,
} from "../domain/participants.ts";
import type {
  AgentId,
  AuthorizationRevision,
  CryptoDeviceId,
  CryptoDomainId,
  DomainEpoch,
  GrantId,
  HumanId,
} from "../v2-types/ids.ts";
import {
  agentId,
  assertPortableId,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  grantId,
  humanId,
} from "../v2-types/ids.ts";
import {
  assertV2Range,
  V2_LIMITS,
} from "../v2-types/limits.ts";
import {
  concatV2,
  decodeExact,
  encodeU32,
  encodeU64,
  frame,
  frameText,
  utf8V2,
} from "./v2-primitives.ts";

export const GRANT_V2_FORMAT_VERSION = 2 as const;
export const GRANT_V2_SCHEME = "domain-enumeration-v2" as const;

const GRANT_V2_DOMAIN = "nautilo/lattice-crypto/grant/v2";
const GRANT_SECRET_V2_DOMAIN =
  "nautilo/lattice-crypto/grant-secret/v2";
const DOMAIN_ROOT_BYTES = 32;
const RECIPIENT_KEY_LABEL = [
  "Recipient",
  "invocation",
  "key",
  "id",
].join(" ");

export type GrantOperationV2 = "decrypt" | "encrypt";

export interface GrantCoveredDomainV2 {
  readonly domainId: CryptoDomainId;
  readonly domainEpoch: DomainEpoch;
  readonly agentAuthorizationRevision: AuthorizationRevision;
}

export interface GrantV2 {
  readonly formatVersion: typeof GRANT_V2_FORMAT_VERSION;
  readonly id: GrantId;
  readonly issuingDeviceId: CryptoDeviceId;
  readonly recipientAgentId: AgentId;
  readonly recipientKeyId: string;
  readonly scope: readonly HumanId[];
  readonly operations: readonly GrantOperationV2[];
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly coveredDomains: readonly GrantCoveredDomainV2[];
  readonly encryptedSecret: Uint8Array;
  readonly scheme: typeof GRANT_V2_SCHEME;
  readonly signature: Uint8Array;
  readonly singleUse: boolean;
  readonly consumed: boolean;
}

export interface GrantSecretDomainRootV2 {
  readonly domainId: CryptoDomainId;
  readonly aiRoot: Uint8Array;
}

type GrantV2SigningFields = Omit<GrantV2, "signature" | "consumed">;

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return bytesToHex(left) === bytesToHex(right);
}

function equalStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalOperations(
  operations: readonly GrantOperationV2[],
): readonly GrantOperationV2[] {
  assertV2Range("Grant operations", operations.length, 1, 2);
  for (const operation of operations) {
    if (operation !== "decrypt" && operation !== "encrypt") {
      throw new RangeError("Grant operation is unsupported");
    }
  }
  const canonical = [...new Set(operations)].sort(compareUnsignedUtf8);
  if (
    !equalStrings(canonical, operations)
  ) {
    throw new RangeError("Grant operations must be canonical and unique");
  }
  return canonical;
}

function canonicalCoveredDomains(
  coveredDomains: readonly GrantCoveredDomainV2[],
): readonly GrantCoveredDomainV2[] {
  assertV2Range(
    "Grant covered Domains",
    coveredDomains.length,
    1,
    V2_LIMITS.agentGrantDomains,
  );
  for (const covered of coveredDomains) {
    cryptoDomainId(covered.domainId);
    domainEpoch(covered.domainEpoch);
    authorizationRevision(covered.agentAuthorizationRevision);
  }
  const ids = coveredDomains.map((covered) => covered.domainId);
  if (new Set(ids).size !== ids.length) {
    throw new RangeError("Grant covered Domains contain a duplicate");
  }
  const canonicalIds = [...ids].sort(compareUnsignedUtf8);
  if (!equalStrings(canonicalIds, ids)) {
    throw new RangeError("Grant covered Domains must be canonical");
  }
  return coveredDomains;
}

function validateSigningFields(
  value: GrantV2SigningFields,
): {
  readonly scope: readonly HumanId[];
  readonly operations: readonly GrantOperationV2[];
  readonly coveredDomains: readonly GrantCoveredDomainV2[];
} {
  if (value.formatVersion !== GRANT_V2_FORMAT_VERSION) {
    throw new RangeError("GrantV2 format version is unsupported");
  }
  grantId(value.id);
  cryptoDeviceId(value.issuingDeviceId);
  agentId(value.recipientAgentId);
  assertPortableId(RECIPIENT_KEY_LABEL, value.recipientKeyId);
  assertV2Range(
    "Grant Human scope",
    value.scope.length,
    1,
    V2_LIMITS.grantScopeHumans,
  );
  const scope = canonicalizeParticipants(value.scope);
  if (!equalStrings(scope, value.scope)) {
    throw new RangeError("Grant Human scope must be canonical");
  }
  const operations = canonicalOperations(value.operations);
  if (
    !Number.isSafeInteger(value.issuedAt)
    || !Number.isSafeInteger(value.expiresAt)
    || value.issuedAt < 0
    || value.expiresAt <= value.issuedAt
    || value.expiresAt - value.issuedAt > V2_LIMITS.grantTtlMs
  ) {
    throw new RangeError("Grant timestamps are invalid");
  }
  const coveredDomains = canonicalCoveredDomains(value.coveredDomains);
  if (
    !(value.encryptedSecret instanceof Uint8Array)
    || value.encryptedSecret.length < 1
    || value.encryptedSecret.length > V2_LIMITS.agentGrantSecretBytes
  ) {
    throw new RangeError("Grant encrypted secret exceeds format limits");
  }
  if (value.scheme !== GRANT_V2_SCHEME) {
    throw new RangeError("Grant scheme is unsupported");
  }
  if (typeof value.singleUse !== "boolean") {
    throw new TypeError("Grant single-use flag must be boolean");
  }
  return { scope, operations, coveredDomains };
}

export function grantV2SigningBytes(
  grant: GrantV2SigningFields,
): Uint8Array {
  const { scope, operations, coveredDomains } =
    validateSigningFields(grant);
  return concatV2(
    frameText(GRANT_V2_DOMAIN),
    encodeU32(GRANT_V2_FORMAT_VERSION),
    frameText(grant.id),
    frameText(grant.issuingDeviceId),
    frameText(grant.recipientAgentId),
    frameText(grant.recipientKeyId),
    encodeU32(scope.length),
    ...scope.map(frameText),
    encodeU32(operations.length),
    ...operations.map(frameText),
    encodeU64(grant.issuedAt),
    encodeU64(grant.expiresAt),
    encodeU32(coveredDomains.length),
    ...coveredDomains.map((covered) =>
      concatV2(
        frameText(covered.domainId),
        encodeU64(covered.domainEpoch),
        encodeU64(covered.agentAuthorizationRevision),
      )
    ),
    frame(grant.encryptedSecret),
    frameText(grant.scheme),
    frame(Uint8Array.of(grant.singleUse ? 1 : 0)),
  );
}

export function serializeGrantV2(grant: GrantV2): Uint8Array {
  if (
    !(grant.signature instanceof Uint8Array)
    || grant.signature.length !== V2_LIMITS.signatureBytes
  ) {
    throw new RangeError("Grant signature must be exactly 64 bytes");
  }
  const wire = concatV2(
    grantV2SigningBytes(grant),
    frame(grant.signature),
  );
  if (wire.length > V2_LIMITS.agentGrantWireBytes) {
    wire.fill(0);
    throw new RangeError("Grant exceeds its wire limit");
  }
  return wire;
}

export function parseGrantV2(bytes: Uint8Array): GrantV2 | null {
  if (
    !(bytes instanceof Uint8Array)
    || bytes.length > V2_LIMITS.agentGrantWireBytes
  ) return null;
  try {
    const parsed = decodeExact(bytes, (reader): GrantV2 => {
      reader.readFrame(utf8V2(GRANT_V2_DOMAIN).length);
      reader.readVersion(GRANT_V2_FORMAT_VERSION);
      const id = grantId(reader.readText(V2_LIMITS.idBytes));
      const issuingDeviceId = cryptoDeviceId(
        reader.readText(V2_LIMITS.idBytes),
      );
      const recipientAgentId = agentId(
        reader.readText(V2_LIMITS.idBytes),
      );
      const recipientKeyId = reader.readText(V2_LIMITS.idBytes);
      assertPortableId(RECIPIENT_KEY_LABEL, recipientKeyId);

      const scopeCount = reader.readCount(V2_LIMITS.grantScopeHumans);
      const scope = Array.from(
        { length: scopeCount },
        () => humanId(reader.readText(V2_LIMITS.idBytes)),
      );
      const operationCount = reader.readCount(2);
      const operations = Array.from(
        { length: operationCount },
        () => reader.readText(7) as GrantOperationV2,
      );
      const issuedAt = reader.readU64();
      const expiresAt = reader.readU64();

      const domainCount = reader.readCount(
        V2_LIMITS.agentGrantDomains,
      );
      const coveredDomains = Array.from(
        { length: domainCount },
        (): GrantCoveredDomainV2 => ({
          domainId: cryptoDomainId(reader.readText(V2_LIMITS.idBytes)),
          domainEpoch: domainEpoch(reader.readU64()),
          agentAuthorizationRevision: authorizationRevision(
            reader.readU64(),
          ),
        }),
      );
      const encryptedSecret = reader.readFrame(V2_LIMITS.agentGrantSecretBytes);
      const scheme = reader.readText(
        V2_LIMITS.schemeIdBytes,
      ) as typeof GRANT_V2_SCHEME;
      const singleUseBytes = reader.readFrame(1);
      const signature = reader.readFrame(V2_LIMITS.signatureBytes);
      return {
        formatVersion: GRANT_V2_FORMAT_VERSION,
        id,
        issuingDeviceId,
        recipientAgentId,
        recipientKeyId,
        scope,
        operations,
        issuedAt,
        expiresAt,
        coveredDomains,
        encryptedSecret,
        scheme,
        signature,
        singleUse: singleUseBytes[0] === 1,
        consumed: false,
      };
    });
    return equalBytes(serializeGrantV2(parsed), bytes) ? parsed : null;
  } catch {
    return null;
  }
}

function validateGrantSecretEntries(
  entries: readonly GrantSecretDomainRootV2[],
): void {
  assertV2Range(
    "Grant secret Domain roots",
    entries.length,
    1,
    V2_LIMITS.agentGrantDomains,
  );
  for (const entry of entries) {
    cryptoDomainId(entry.domainId);
    if (
      !(entry.aiRoot instanceof Uint8Array)
      || entry.aiRoot.length !== DOMAIN_ROOT_BYTES
    ) {
      throw new RangeError("Grant secret AI root must be exactly 32 bytes");
    }
  }
  const ids = entries.map((entry) => entry.domainId);
  if (new Set(ids).size !== ids.length) {
    throw new RangeError("Grant secret contains a duplicate Domain");
  }
  const canonicalIds = [...ids].sort(compareUnsignedUtf8);
  if (!equalStrings(canonicalIds, ids)) {
    throw new RangeError("Grant secret Domains must be canonical");
  }
}

export function serializeGrantSecretV2(
  entries: readonly GrantSecretDomainRootV2[],
): Uint8Array {
  validateGrantSecretEntries(entries);
  const bytes = concatV2(
    frameText(GRANT_SECRET_V2_DOMAIN),
    encodeU32(GRANT_V2_FORMAT_VERSION),
    encodeU32(entries.length),
    ...entries.map((entry) =>
      concatV2(frameText(entry.domainId), frame(entry.aiRoot))
    ),
  );
  return bytes;
}

export function parseGrantSecretV2(
  bytes: Uint8Array,
): GrantSecretDomainRootV2[] | null {
  try {
    const entries = decodeExact(bytes, (reader) => {
      reader.readFrame(utf8V2(GRANT_SECRET_V2_DOMAIN).length);
      reader.readVersion(GRANT_V2_FORMAT_VERSION);
      const count = reader.readCount(V2_LIMITS.agentGrantDomains);
      return Array.from(
        { length: count },
        (): GrantSecretDomainRootV2 => ({
          domainId: cryptoDomainId(reader.readText(V2_LIMITS.idBytes)),
          aiRoot: reader.readFrame(DOMAIN_ROOT_BYTES),
        }),
      );
    });
    return equalBytes(serializeGrantSecretV2(entries), bytes)
      ? entries
      : null;
  } catch {
    return null;
  }
}
import { bytesToHex } from "@noble/hashes/utils.js";
