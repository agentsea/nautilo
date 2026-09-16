import type { LatticeCrypto } from "../crypto/index.ts";
import { assertAgentRuntimeGeneration } from "../format/agent-runtime-v2.ts";
import {
  CanonicalDecodingError,
  StrictDecoder,
  concatV2,
  encodeU32,
  encodeU64,
  frame,
  frameText,
  utf8V2,
} from "../format/v2-primitives.ts";
import {
  agentId,
  agentRuntimeGeneration,
  assertPortableId,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  type AgentId,
  type AgentRuntimeGeneration,
  type AuthorizationRevision,
  type CryptoDeviceId,
  type CryptoDomainId,
  type DomainEpoch,
  type HumanId,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import {
  agentRuntimeObjectSignerKeyIdV1,
  deriveAgentRuntimeObjectSignerPublicV1,
  normalizeAgentRuntimeObjectSignerPrincipalV1,
} from "./object-signer-v1.ts";
import type { AgentRuntimeGenerationV2 } from "./types.ts";

export const AGENT_RUNTIME_SIGNER_PUBLICATION_DOMAIN_V1 =
  "nautilo/lattice-crypto/agent-runtime-signer-publication/v1";
export const AGENT_RUNTIME_SIGNER_PUBLICATION_FORMAT_VERSION_V1 = 1 as const;
export const MAX_AGENT_RUNTIME_SIGNER_PUBLICATION_WIRE_BYTES_V1 = 1_024;

const HASH_BYTES = 32;
const SIGNER_PUBLIC_KEY_BYTES = V2_LIMITS.signingPublicKeyBytes;
const MANAGER_PUBLIC_KEY_BYTES = V2_LIMITS.signingPublicKeyBytes;
const SIGNATURE_BYTES = V2_LIMITS.signatureBytes;
const INITIALIZATION_COMMITMENT_DOMAIN_V1 =
  "nautilo/lattice-crypto/agent-runtime-initialization-public-state/v1";

export type AgentRuntimeSignerPublicationTransitionKindV1 =
  | "initialization"
  | "rotation";

export interface AgentRuntimeSignerPublicationManagerV1 {
  readonly managerHumanId: HumanId;
  readonly managerAuthorizationRevision: AuthorizationRevision;
  readonly managerDeviceId: CryptoDeviceId;
}

export interface AgentRuntimeSignerPublicationUnsignedV1
  extends AgentRuntimeSignerPublicationManagerV1 {
  readonly formatVersion:
    typeof AGENT_RUNTIME_SIGNER_PUBLICATION_FORMAT_VERSION_V1;
  readonly transitionKind:
    AgentRuntimeSignerPublicationTransitionKindV1;
  readonly operationId: string;
  readonly agentId: AgentId;
  readonly authorizationRevision: AuthorizationRevision;
  readonly runtimeGeneration: AgentRuntimeGeneration;
  readonly signerKeyId: string;
  readonly signerPublicKey: Uint8Array;
  readonly transitionCommitment: Uint8Array;
  readonly managerSigningPublicKeyHash: Uint8Array;
}

export interface AgentRuntimeSignerPublicationV1
  extends AgentRuntimeSignerPublicationUnsignedV1 {
  readonly signature: Uint8Array;
}

export interface CurrentAgentRuntimeSignerPublicationManagerContextV1
  extends AgentRuntimeSignerPublicationManagerV1 {
  readonly purpose: "agent-runtime-signer-publication";
  readonly transitionKind:
    AgentRuntimeSignerPublicationTransitionKindV1;
  readonly operationId: string;
  readonly agentId: AgentId;
  readonly authorizationRevision: AuthorizationRevision;
  readonly runtimeGeneration: AgentRuntimeGeneration;
  readonly signerKeyId: string;
  readonly signerPublicKey: Uint8Array;
  readonly transitionCommitment: Uint8Array;
}

export interface HistoricalAgentRuntimeSignerPublicationManagerContextV1
  extends AgentRuntimeSignerPublicationUnsignedV1 {
  readonly purpose: "verify-historical-agent-runtime-signer-publication";
}

export type ResolveCurrentAgentRuntimeSignerPublicationManagerV1 = (
  context: CurrentAgentRuntimeSignerPublicationManagerContextV1,
) => Uint8Array | null;

export type ResolveHistoricalAgentRuntimeSignerPublicationManagerV1 = (
  context: HistoricalAgentRuntimeSignerPublicationManagerContextV1,
) => Uint8Array | null;

export interface AgentRuntimeInitializationPublicStateDomainV1 {
  readonly agentId: AgentId;
  readonly domainId: CryptoDomainId;
  readonly domainEpoch: DomainEpoch;
  readonly agentAuthorizationRevision: AuthorizationRevision;
  readonly runtimeGeneration: AgentRuntimeGeneration;
  readonly committerDeviceId: CryptoDeviceId;
  readonly envelopeHash: Uint8Array;
}

export interface AgentRuntimeInitializationPublicStateV1 {
  readonly agentId: AgentId;
  readonly authorizationRevision: AuthorizationRevision;
  readonly runtimeGeneration: AgentRuntimeGeneration;
  readonly configInventory: Readonly<{
    readonly objectCount: number;
    readonly digest: Uint8Array;
  }>;
  readonly domainEnvelopes:
    readonly AgentRuntimeInitializationPublicStateDomainV1[];
}

function assertObject(
  label: string,
  value: unknown,
): asserts value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertExactFields(
  label: string,
  value: object,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length
    || actual.some((field, index) => field !== canonical[index])
  ) {
    throw new TypeError(`${label} has an invalid field set`);
  }
}

function exactBytes(
  label: string,
  value: unknown,
  length: number,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new TypeError(`${label} must be exactly ${length} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function exactManagerSigningPrivateKey(value: unknown): Uint8Array {
  return exactBytes(
    "Manager signing private key",
    value,
    V2_LIMITS.signingPrivateKeyBytes,
  );
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function comparePortableIds(left: string, right: string): number {
  const leftBytes = utf8V2(left);
  const rightBytes = utf8V2(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function initializationPublicStateBytes(
  value: AgentRuntimeInitializationPublicStateV1,
): Uint8Array {
  assertObject("Agent Runtime initialization public state", value);
  assertExactFields("Agent Runtime initialization public state", value, [
    "agentId",
    "authorizationRevision",
    "runtimeGeneration",
    "configInventory",
    "domainEnvelopes",
  ]);
  const normalizedAgentId = agentId(value.agentId);
  const normalizedAuthorizationRevision =
    authorizationRevision(value.authorizationRevision);
  const normalizedRuntimeGeneration =
    agentRuntimeGeneration(value.runtimeGeneration);
  if (normalizedRuntimeGeneration !== 0) {
    throw new TypeError(
      "Agent Runtime initialization public state must use generation zero",
    );
  }
  assertObject(
    "Agent Runtime initialization config inventory",
    value.configInventory,
  );
  assertExactFields(
    "Agent Runtime initialization config inventory",
    value.configInventory,
    ["objectCount", "digest"],
  );
  if (
    !Number.isSafeInteger(value.configInventory.objectCount)
    || value.configInventory.objectCount < 1
    || value.configInventory.objectCount > V2_LIMITS.batchItems
  ) {
    throw new RangeError(
      "Agent Runtime initialization config inventory count is invalid",
    );
  }
  const inventoryDigest = exactBytes(
    "Agent Runtime initialization config inventory digest",
    value.configInventory.digest,
    HASH_BYTES,
  );
  if (!Array.isArray(value.domainEnvelopes as unknown)) {
    inventoryDigest.fill(0);
    throw new TypeError(
      "Agent Runtime initialization Domain envelope inventory must be an array",
    );
  }
  if (value.domainEnvelopes.length > V2_LIMITS.agentGrantDomains) {
    inventoryDigest.fill(0);
    throw new RangeError(
      "Agent Runtime initialization Domain envelope inventory is too large",
    );
  }
  const encodedDomains: Uint8Array[] = [];
  let priorDomainId: CryptoDomainId | null = null;
  try {
    for (const raw of value.domainEnvelopes) {
      assertObject("Agent Runtime initialization Domain envelope", raw);
      assertExactFields(
        "Agent Runtime initialization Domain envelope",
        raw,
        [
          "agentId",
          "domainId",
          "domainEpoch",
          "agentAuthorizationRevision",
          "runtimeGeneration",
          "committerDeviceId",
          "envelopeHash",
        ],
      );
      const entryAgentId = agentId(raw.agentId);
      const entryDomainId = cryptoDomainId(raw.domainId);
      const entryRuntimeGeneration =
        agentRuntimeGeneration(raw.runtimeGeneration);
      if (
        entryAgentId !== normalizedAgentId
        || entryRuntimeGeneration !== normalizedRuntimeGeneration
      ) {
        throw new Error(
          "Agent Runtime initialization Domain envelope coordinates are inconsistent",
        );
      }
      if (
        priorDomainId !== null
        && comparePortableIds(priorDomainId, entryDomainId) >= 0
      ) {
        throw new Error(
          "Agent Runtime initialization Domain envelopes must be canonically ordered and unique",
        );
      }
      priorDomainId = entryDomainId;
      const envelopeHash = exactBytes(
        "Agent Runtime initialization Domain envelope hash",
        raw.envelopeHash,
        HASH_BYTES,
      );
      try {
        encodedDomains.push(concatV2(
          frameText(entryAgentId),
          frameText(entryDomainId),
          encodeU64(domainEpoch(raw.domainEpoch)),
          encodeU64(
            authorizationRevision(raw.agentAuthorizationRevision),
          ),
          encodeU64(entryRuntimeGeneration),
          frameText(cryptoDeviceId(raw.committerDeviceId)),
          frame(envelopeHash),
        ));
      } finally {
        envelopeHash.fill(0);
      }
    }
    return concatV2(
      frameText(INITIALIZATION_COMMITMENT_DOMAIN_V1),
      encodeU32(1),
      frameText(normalizedAgentId),
      encodeU64(normalizedAuthorizationRevision),
      encodeU64(normalizedRuntimeGeneration),
      encodeU32(value.configInventory.objectCount),
      frame(inventoryDigest),
      encodeU32(encodedDomains.length),
      ...encodedDomains,
    );
  } finally {
    inventoryDigest.fill(0);
    encodedDomains.forEach((bytes) => bytes.fill(0));
  }
}

export function agentRuntimeInitializationPublicStateCommitmentV1(
  crypto: LatticeCrypto,
  value: AgentRuntimeInitializationPublicStateV1,
): Uint8Array {
  const encoded = initializationPublicStateBytes(value);
  try {
    return exactBytes(
      "Agent Runtime initialization public state commitment",
      crypto.hash(encoded),
      HASH_BYTES,
    );
  } finally {
    encoded.fill(0);
  }
}

function transitionCode(
  value: AgentRuntimeSignerPublicationTransitionKindV1,
): number {
  if (value === "initialization") return 0;
  if (value === "rotation") return 1;
  throw new TypeError(
    "Agent Runtime signer publication transition kind is invalid",
  );
}

function assertTransitionGeneration(
  transitionKind: AgentRuntimeSignerPublicationTransitionKindV1,
  runtimeGeneration: AgentRuntimeGeneration,
): void {
  if (
    (transitionKind === "initialization" && runtimeGeneration !== 0)
    || (transitionKind === "rotation" && runtimeGeneration === 0)
  ) {
    throw new TypeError(
      "Agent Runtime signer publication transition does not match its Runtime generation",
    );
  }
}

function transitionFromCode(
  value: number,
): AgentRuntimeSignerPublicationTransitionKindV1 {
  if (value === 0) return "initialization";
  if (value === 1) return "rotation";
  throw new CanonicalDecodingError(
    "Agent Runtime signer publication transition kind is unsupported",
  );
}

function normalizeManager(
  value: AgentRuntimeSignerPublicationManagerV1,
): AgentRuntimeSignerPublicationManagerV1 {
  assertObject("Agent Runtime signer publication manager", value);
  assertExactFields("Agent Runtime signer publication manager", value, [
    "managerHumanId",
    "managerAuthorizationRevision",
    "managerDeviceId",
  ]);
  return Object.freeze({
    managerHumanId: humanId(value.managerHumanId),
    managerAuthorizationRevision:
      authorizationRevision(value.managerAuthorizationRevision),
    managerDeviceId: cryptoDeviceId(value.managerDeviceId),
  });
}

function normalizeUnsigned(
  value: AgentRuntimeSignerPublicationUnsignedV1,
): AgentRuntimeSignerPublicationUnsignedV1 {
  assertObject("Agent Runtime signer publication", value);
  assertExactFields("Agent Runtime signer publication", value, [
    "formatVersion",
    "transitionKind",
    "operationId",
    "agentId",
    "authorizationRevision",
    "runtimeGeneration",
    "signerKeyId",
    "signerPublicKey",
    "transitionCommitment",
    "managerHumanId",
    "managerAuthorizationRevision",
    "managerDeviceId",
    "managerSigningPublicKeyHash",
  ]);
  if (
    value.formatVersion
      !== AGENT_RUNTIME_SIGNER_PUBLICATION_FORMAT_VERSION_V1
  ) {
    throw new TypeError(
      "Agent Runtime signer publication version is unsupported",
    );
  }
  transitionCode(value.transitionKind);
  assertPortableId(
    "Agent Runtime signer publication operation id",
    value.operationId,
  );
  assertPortableId(
    "Agent Runtime signer publication signer key id",
    value.signerKeyId,
  );
  const normalizedAgentId = agentId(value.agentId);
  const normalizedGeneration =
    agentRuntimeGeneration(value.runtimeGeneration);
  assertTransitionGeneration(value.transitionKind, normalizedGeneration);
  const signer = normalizeAgentRuntimeObjectSignerPrincipalV1({
    kind: "agent_runtime",
    agentId: normalizedAgentId,
    runtimeGeneration: normalizedGeneration,
    signerKeyId: value.signerKeyId,
  });
  const signerPublicKey = exactBytes(
    "Agent Runtime signer publication signer public key",
    value.signerPublicKey,
    SIGNER_PUBLIC_KEY_BYTES,
  );
  const transitionCommitment = exactBytes(
    "Agent Runtime signer publication transition commitment",
    value.transitionCommitment,
    HASH_BYTES,
  );
  const managerSigningPublicKeyHash = exactBytes(
    "Agent Runtime signer publication manager signing public key hash",
    value.managerSigningPublicKeyHash,
    HASH_BYTES,
  );
  const manager = normalizeManager({
    managerHumanId: value.managerHumanId,
    managerAuthorizationRevision: value.managerAuthorizationRevision,
    managerDeviceId: value.managerDeviceId,
  });
  return Object.freeze({
    formatVersion: AGENT_RUNTIME_SIGNER_PUBLICATION_FORMAT_VERSION_V1,
    transitionKind: value.transitionKind,
    operationId: value.operationId,
    agentId: normalizedAgentId,
    authorizationRevision:
      authorizationRevision(value.authorizationRevision),
    runtimeGeneration: normalizedGeneration,
    signerKeyId: signer.signerKeyId,
    signerPublicKey,
    transitionCommitment,
    ...manager,
    managerSigningPublicKeyHash,
  });
}

function normalizePublication(
  value: AgentRuntimeSignerPublicationV1,
): AgentRuntimeSignerPublicationV1 {
  assertObject("Agent Runtime signer publication", value);
  assertExactFields("Agent Runtime signer publication", value, [
    "formatVersion",
    "transitionKind",
    "operationId",
    "agentId",
    "authorizationRevision",
    "runtimeGeneration",
    "signerKeyId",
    "signerPublicKey",
    "transitionCommitment",
    "managerHumanId",
    "managerAuthorizationRevision",
    "managerDeviceId",
    "managerSigningPublicKeyHash",
    "signature",
  ]);
  const {
    signature: rawSignature,
    ...rawUnsigned
  } = value;
  const unsigned = normalizeUnsigned(rawUnsigned);
  const signature = exactBytes(
    "Agent Runtime signer publication signature",
    rawSignature,
    SIGNATURE_BYTES,
  );
  return Object.freeze({ ...unsigned, signature });
}

function signingBytesFromNormalized(
  value: AgentRuntimeSignerPublicationUnsignedV1,
): Uint8Array {
  return concatV2(
    frameText(AGENT_RUNTIME_SIGNER_PUBLICATION_DOMAIN_V1),
    encodeU32(AGENT_RUNTIME_SIGNER_PUBLICATION_FORMAT_VERSION_V1),
    encodeU32(transitionCode(value.transitionKind)),
    frameText(value.operationId),
    frameText(value.agentId),
    encodeU64(value.authorizationRevision),
    encodeU64(value.runtimeGeneration),
    frameText(value.signerKeyId),
    frame(value.signerPublicKey),
    frame(value.transitionCommitment),
    frameText(value.managerHumanId),
    encodeU64(value.managerAuthorizationRevision),
    frameText(value.managerDeviceId),
    frame(value.managerSigningPublicKeyHash),
  );
}

export function agentRuntimeSignerPublicationSigningBytesV1(
  value: AgentRuntimeSignerPublicationUnsignedV1,
): Uint8Array {
  return signingBytesFromNormalized(normalizeUnsigned(value));
}

export function encodeAgentRuntimeSignerPublicationV1(
  value: AgentRuntimeSignerPublicationV1,
): Uint8Array {
  const normalized = normalizePublication(value);
  return concatV2(
    signingBytesFromNormalized(normalized),
    frame(normalized.signature),
  );
}

export function decodeAgentRuntimeSignerPublicationV1(
  bytes: Uint8Array,
): AgentRuntimeSignerPublicationV1 {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError(
      "Agent Runtime signer publication bytes must be Uint8Array",
    );
  }
  if (bytes.length > MAX_AGENT_RUNTIME_SIGNER_PUBLICATION_WIRE_BYTES_V1) {
    throw new CanonicalDecodingError(
      "Agent Runtime signer publication exceeds its wire limit",
    );
  }
  const reader = new StrictDecoder(bytes);
  try {
    const domain = reader.readText(
      utf8V2(AGENT_RUNTIME_SIGNER_PUBLICATION_DOMAIN_V1).length,
    );
    if (domain !== AGENT_RUNTIME_SIGNER_PUBLICATION_DOMAIN_V1) {
      throw new CanonicalDecodingError(
        "Agent Runtime signer publication domain mismatch",
      );
    }
    const formatVersion = reader.readVersion(
      AGENT_RUNTIME_SIGNER_PUBLICATION_FORMAT_VERSION_V1,
    ) as typeof AGENT_RUNTIME_SIGNER_PUBLICATION_FORMAT_VERSION_V1;
    const transitionKind = transitionFromCode(reader.readU32());
    const operationId = reader.readText(V2_LIMITS.idBytes);
    const decodedAgentId = agentId(reader.readText(V2_LIMITS.idBytes));
    const decodedAuthorizationRevision =
      authorizationRevision(reader.readU64());
    const decodedRuntimeGeneration =
      agentRuntimeGeneration(reader.readU64());
    const signerKeyId = reader.readText(V2_LIMITS.idBytes);
    const signerPublicKey = reader.readFrame(SIGNER_PUBLIC_KEY_BYTES);
    const transitionCommitment = reader.readFrame(HASH_BYTES);
    const managerHumanId = humanId(reader.readText(V2_LIMITS.idBytes));
    const managerAuthorizationRevision =
      authorizationRevision(reader.readU64());
    const managerDeviceId =
      cryptoDeviceId(reader.readText(V2_LIMITS.idBytes));
    const managerSigningPublicKeyHash = reader.readFrame(HASH_BYTES);
    const signature = reader.readFrame(SIGNATURE_BYTES);
    reader.assertFinished();
    return normalizePublication({
      formatVersion,
      transitionKind,
      operationId,
      agentId: decodedAgentId,
      authorizationRevision: decodedAuthorizationRevision,
      runtimeGeneration: decodedRuntimeGeneration,
      signerKeyId,
      signerPublicKey,
      transitionCommitment,
      managerHumanId,
      managerAuthorizationRevision,
      managerDeviceId,
      managerSigningPublicKeyHash,
      signature,
    });
  } finally {
    reader.destroy(true);
  }
}

function currentAuthorityContext(
  input: Readonly<{
    readonly transitionKind:
      AgentRuntimeSignerPublicationTransitionKindV1;
    readonly operationId: string;
    readonly authorizationRevision: AuthorizationRevision;
    readonly transitionCommitment: Uint8Array;
    readonly runtime: AgentRuntimeGenerationV2;
    readonly signerKeyId: string;
    readonly signerPublicKey: Uint8Array;
    readonly manager: AgentRuntimeSignerPublicationManagerV1;
  }>,
): CurrentAgentRuntimeSignerPublicationManagerContextV1 {
  return Object.freeze({
    purpose: "agent-runtime-signer-publication",
    transitionKind: input.transitionKind,
    operationId: input.operationId,
    agentId: input.runtime.agentId,
    authorizationRevision: input.authorizationRevision,
    runtimeGeneration: input.runtime.generation,
    signerKeyId: input.signerKeyId,
    signerPublicKey: copyOwnedBytesV2(input.signerPublicKey),
    transitionCommitment:
      copyOwnedBytesV2(input.transitionCommitment),
    ...input.manager,
  });
}

function destroyCurrentAuthorityContext(
  value: CurrentAgentRuntimeSignerPublicationManagerContextV1 | null,
): void {
  value?.signerPublicKey.fill(0);
  value?.transitionCommitment.fill(0);
}

function createAgentRuntimeSignerPublicationFromCommitmentV1(input: Readonly<{
  readonly crypto: LatticeCrypto;
  readonly transitionKind:
    AgentRuntimeSignerPublicationTransitionKindV1;
  readonly operationId: string;
  readonly authorizationRevision: AuthorizationRevision;
  readonly transitionCommitment: Uint8Array;
  readonly runtime: AgentRuntimeGenerationV2;
  readonly manager: AgentRuntimeSignerPublicationManagerV1;
  readonly managerSigningPrivateKey: Uint8Array;
  readonly resolveCurrentManagerAuthority:
    ResolveCurrentAgentRuntimeSignerPublicationManagerV1;
}>): AgentRuntimeSignerPublicationV1 {
  assertObject("Agent Runtime signer publication creation input", input);
  assertExactFields("Agent Runtime signer publication creation input", input, [
    "crypto",
    "transitionKind",
    "operationId",
    "authorizationRevision",
    "transitionCommitment",
    "runtime",
    "manager",
    "managerSigningPrivateKey",
    "resolveCurrentManagerAuthority",
  ]);
  transitionCode(input.transitionKind);
  assertPortableId(
    "Agent Runtime signer publication operation id",
    input.operationId,
  );
  assertAgentRuntimeGeneration(input.runtime);
  const nextAuthorizationRevision =
    authorizationRevision(input.authorizationRevision);
  assertTransitionGeneration(
    input.transitionKind,
    input.runtime.generation,
  );
  const transitionCommitment = exactBytes(
    "Agent Runtime signer publication transition commitment",
    input.transitionCommitment,
    HASH_BYTES,
  );
  const manager = normalizeManager(input.manager);
  const managerPrivate =
    exactManagerSigningPrivateKey(input.managerSigningPrivateKey);
  if (typeof input.resolveCurrentManagerAuthority !== "function") {
    transitionCommitment.fill(0);
    managerPrivate.fill(0);
    throw new TypeError(
      "Agent Runtime signer publication current manager resolver is required",
    );
  }

  let signerPublicKey: Uint8Array | null = null;
  let authorityContext:
    CurrentAgentRuntimeSignerPublicationManagerContextV1 | null = null;
  let managerPublicKey: Uint8Array | null = null;
  let managerPublicKeyHash: Uint8Array | null = null;
  let signingBytes: Uint8Array | null = null;
  let providerSignature: Uint8Array | null = null;
  try {
    const signer =
      deriveAgentRuntimeObjectSignerPublicV1(input.crypto, input.runtime);
    signerPublicKey = copyOwnedBytesV2(signer.publicKey);
    signer.publicKey.fill(0);
    authorityContext = currentAuthorityContext({
      transitionKind: input.transitionKind,
      operationId: input.operationId,
      authorizationRevision: nextAuthorizationRevision,
      transitionCommitment,
      runtime: input.runtime,
      signerKeyId: signer.principal.signerKeyId,
      signerPublicKey,
      manager,
    });
    const resolved =
      input.resolveCurrentManagerAuthority(authorityContext);
    if (resolved === null) {
      throw new Error(
        "Agent Runtime signer publication manager is not currently authorized",
      );
    }
    managerPublicKey = exactBytes(
      "Agent Runtime signer publication current manager signing public key",
      resolved,
      MANAGER_PUBLIC_KEY_BYTES,
    );
    managerPublicKeyHash = exactBytes(
      "Agent Runtime signer publication manager signing public key hash",
      input.crypto.hash(managerPublicKey),
      HASH_BYTES,
    );
    const unsigned = normalizeUnsigned({
      formatVersion: AGENT_RUNTIME_SIGNER_PUBLICATION_FORMAT_VERSION_V1,
      transitionKind: input.transitionKind,
      operationId: input.operationId,
      agentId: input.runtime.agentId,
      authorizationRevision: nextAuthorizationRevision,
      runtimeGeneration: input.runtime.generation,
      signerKeyId: signer.principal.signerKeyId,
      signerPublicKey,
      transitionCommitment,
      ...manager,
      managerSigningPublicKeyHash: managerPublicKeyHash,
    });
    signingBytes = signingBytesFromNormalized(unsigned);
    providerSignature = input.crypto.sign(managerPrivate, signingBytes);
    const signature = exactBytes(
      "Agent Runtime signer publication signature",
      providerSignature,
      SIGNATURE_BYTES,
    );
    try {
      if (
        !input.crypto.verify(
          managerPublicKey,
          signingBytes,
          signature,
        )
      ) {
        throw new Error(
          "Agent Runtime signer publication manager private key does not match current authority",
        );
      }
      return normalizePublication({ ...unsigned, signature });
    } finally {
      signature.fill(0);
    }
  } finally {
    transitionCommitment.fill(0);
    managerPrivate.fill(0);
    signerPublicKey?.fill(0);
    destroyCurrentAuthorityContext(authorityContext);
    managerPublicKey?.fill(0);
    managerPublicKeyHash?.fill(0);
    signingBytes?.fill(0);
    providerSignature?.fill(0);
  }
}

/**
 * Package-internal initialization mint. The caller must pass the exact public
 * state that will be committed by the initialization CAS; arbitrary
 * commitment bytes are deliberately not accepted.
 */
export function createAgentRuntimeInitializationSignerPublicationV1(
  input: Readonly<{
    readonly crypto: LatticeCrypto;
    readonly operationId: string;
    readonly publicState: AgentRuntimeInitializationPublicStateV1;
    readonly runtime: AgentRuntimeGenerationV2;
    readonly manager: AgentRuntimeSignerPublicationManagerV1;
    readonly managerSigningPrivateKey: Uint8Array;
    readonly resolveCurrentManagerAuthority:
      ResolveCurrentAgentRuntimeSignerPublicationManagerV1;
  }>,
): AgentRuntimeSignerPublicationV1 {
  assertObject(
    "Agent Runtime initialization signer publication input",
    input,
  );
  assertExactFields(
    "Agent Runtime initialization signer publication input",
    input,
    [
      "crypto",
      "operationId",
      "publicState",
      "runtime",
      "manager",
      "managerSigningPrivateKey",
      "resolveCurrentManagerAuthority",
    ],
  );
  const commitment = agentRuntimeInitializationPublicStateCommitmentV1(
    input.crypto,
    input.publicState,
  );
  try {
    return createAgentRuntimeSignerPublicationFromCommitmentV1({
      crypto: input.crypto,
      transitionKind: "initialization",
      operationId: input.operationId,
      authorizationRevision: input.publicState.authorizationRevision,
      transitionCommitment: commitment,
      runtime: input.runtime,
      manager: input.manager,
      managerSigningPrivateKey: input.managerSigningPrivateKey,
      resolveCurrentManagerAuthority:
        input.resolveCurrentManagerAuthority,
    });
  } finally {
    commitment.fill(0);
  }
}

/**
 * Package-internal rotation mint. The manifest hash is accepted only at the
 * already-validated rotation preparation boundary; it is intentionally not
 * re-exported from either public package surface.
 */
export function createAgentRuntimeRotationSignerPublicationV1(
  input: Readonly<{
    readonly crypto: LatticeCrypto;
    readonly operationId: string;
    readonly authorizationRevision: AuthorizationRevision;
    readonly validatedRotationManifestHash: Uint8Array;
    readonly runtime: AgentRuntimeGenerationV2;
    readonly manager: AgentRuntimeSignerPublicationManagerV1;
    readonly managerSigningPrivateKey: Uint8Array;
    readonly resolveCurrentManagerAuthority:
      ResolveCurrentAgentRuntimeSignerPublicationManagerV1;
  }>,
): AgentRuntimeSignerPublicationV1 {
  assertObject("Agent Runtime rotation signer publication input", input);
  assertExactFields(
    "Agent Runtime rotation signer publication input",
    input,
    [
      "crypto",
      "operationId",
      "authorizationRevision",
      "validatedRotationManifestHash",
      "runtime",
      "manager",
      "managerSigningPrivateKey",
      "resolveCurrentManagerAuthority",
    ],
  );
  return createAgentRuntimeSignerPublicationFromCommitmentV1({
    crypto: input.crypto,
    transitionKind: "rotation",
    operationId: input.operationId,
    authorizationRevision: input.authorizationRevision,
    transitionCommitment: input.validatedRotationManifestHash,
    runtime: input.runtime,
    manager: input.manager,
    managerSigningPrivateKey: input.managerSigningPrivateKey,
    resolveCurrentManagerAuthority: input.resolveCurrentManagerAuthority,
  });
}

export function agentRuntimeInitializationSignerPublicationMatchesStateV1(
  crypto: LatticeCrypto,
  publication: AgentRuntimeSignerPublicationV1,
  publicState: AgentRuntimeInitializationPublicStateV1,
): boolean {
  const normalized = normalizePublication(publication);
  const commitment = agentRuntimeInitializationPublicStateCommitmentV1(
    crypto,
    publicState,
  );
  try {
    return normalized.transitionKind === "initialization"
      && normalized.agentId === publicState.agentId
      && normalized.authorizationRevision
        === publicState.authorizationRevision
      && normalized.runtimeGeneration === publicState.runtimeGeneration
      && equalBytes(normalized.transitionCommitment, commitment);
  } finally {
    commitment.fill(0);
    normalized.signerPublicKey.fill(0);
    normalized.transitionCommitment.fill(0);
    normalized.managerSigningPublicKeyHash.fill(0);
    normalized.signature.fill(0);
  }
}

export function agentRuntimeRotationSignerPublicationMatchesManifestV1(
  publication: AgentRuntimeSignerPublicationV1,
  input: Readonly<{
    readonly operationId: string;
    readonly agentId: AgentId;
    readonly authorizationRevision: AuthorizationRevision;
    readonly runtimeGeneration: AgentRuntimeGeneration;
    readonly validatedRotationManifestHash: Uint8Array;
  }>,
): boolean {
  const normalized = normalizePublication(publication);
  const manifestHash = exactBytes(
    "Agent Runtime rotation manifest hash",
    input.validatedRotationManifestHash,
    HASH_BYTES,
  );
  try {
    return normalized.transitionKind === "rotation"
      && normalized.operationId === input.operationId
      && normalized.agentId === input.agentId
      && normalized.authorizationRevision === input.authorizationRevision
      && normalized.runtimeGeneration === input.runtimeGeneration
      && equalBytes(normalized.transitionCommitment, manifestHash);
  } finally {
    manifestHash.fill(0);
    normalized.signerPublicKey.fill(0);
    normalized.transitionCommitment.fill(0);
    normalized.managerSigningPublicKeyHash.fill(0);
    normalized.signature.fill(0);
  }
}

function historicalAuthorityContext(
  value: AgentRuntimeSignerPublicationUnsignedV1,
): HistoricalAgentRuntimeSignerPublicationManagerContextV1 {
  return Object.freeze({
    purpose: "verify-historical-agent-runtime-signer-publication",
    formatVersion: value.formatVersion,
    transitionKind: value.transitionKind,
    operationId: value.operationId,
    agentId: value.agentId,
    authorizationRevision: value.authorizationRevision,
    runtimeGeneration: value.runtimeGeneration,
    signerKeyId: value.signerKeyId,
    signerPublicKey: copyOwnedBytesV2(value.signerPublicKey),
    transitionCommitment:
      copyOwnedBytesV2(value.transitionCommitment),
    managerHumanId: value.managerHumanId,
    managerAuthorizationRevision: value.managerAuthorizationRevision,
    managerDeviceId: value.managerDeviceId,
    managerSigningPublicKeyHash:
      copyOwnedBytesV2(value.managerSigningPublicKeyHash),
  });
}

function destroyHistoricalAuthorityContext(
  value: HistoricalAgentRuntimeSignerPublicationManagerContextV1 | null,
): void {
  value?.signerPublicKey.fill(0);
  value?.transitionCommitment.fill(0);
  value?.managerSigningPublicKeyHash.fill(0);
}

export function verifyHistoricalAgentRuntimeSignerPublicationV1(
  input: Readonly<{
    readonly crypto: LatticeCrypto;
    readonly publication: AgentRuntimeSignerPublicationV1;
    readonly resolveHistoricalManagerAuthority:
      ResolveHistoricalAgentRuntimeSignerPublicationManagerV1;
  }>,
): boolean {
  assertObject("Historical Agent Runtime signer verification input", input);
  assertExactFields(
    "Historical Agent Runtime signer verification input",
    input,
    [
      "crypto",
      "publication",
      "resolveHistoricalManagerAuthority",
    ],
  );
  if (typeof input.resolveHistoricalManagerAuthority !== "function") {
    throw new TypeError(
      "Historical Agent Runtime signer manager resolver is required",
    );
  }
  const publication = normalizePublication(input.publication);
  let authorityContext:
    HistoricalAgentRuntimeSignerPublicationManagerContextV1 | null = null;
  let managerPublicKey: Uint8Array | null = null;
  let managerPublicKeyHash: Uint8Array | null = null;
  let signingBytes: Uint8Array | null = null;
  try {
    if (
      agentRuntimeObjectSignerKeyIdV1(
        input.crypto,
        publication.signerPublicKey,
      ) !== publication.signerKeyId
    ) return false;
    authorityContext = historicalAuthorityContext(publication);
    const resolved =
      input.resolveHistoricalManagerAuthority(authorityContext);
    if (resolved === null) return false;
    managerPublicKey = exactBytes(
      "Historical Agent Runtime signer publication manager public key",
      resolved,
      MANAGER_PUBLIC_KEY_BYTES,
    );
    managerPublicKeyHash = exactBytes(
      "Historical Agent Runtime signer publication manager public key hash",
      input.crypto.hash(managerPublicKey),
      HASH_BYTES,
    );
    if (
      !equalBytes(
        managerPublicKeyHash,
        publication.managerSigningPublicKeyHash,
      )
    ) return false;
    signingBytes = signingBytesFromNormalized(publication);
    return input.crypto.verify(
      managerPublicKey,
      signingBytes,
      publication.signature,
    );
  } finally {
    publication.signerPublicKey.fill(0);
    publication.transitionCommitment.fill(0);
    publication.managerSigningPublicKeyHash.fill(0);
    publication.signature.fill(0);
    destroyHistoricalAuthorityContext(authorityContext);
    managerPublicKey?.fill(0);
    managerPublicKeyHash?.fill(0);
    signingBytes?.fill(0);
  }
}

export function agentRuntimeSignerPublicationMatchesRuntimeV1(
  crypto: LatticeCrypto,
  runtime: AgentRuntimeGenerationV2,
  publication: AgentRuntimeSignerPublicationV1,
): boolean {
  assertAgentRuntimeGeneration(runtime);
  const normalized = normalizePublication(publication);
  let derivedPublicKey: Uint8Array | null = null;
  try {
    const derived = deriveAgentRuntimeObjectSignerPublicV1(crypto, runtime);
    derivedPublicKey = derived.publicKey;
    return normalized.agentId === runtime.agentId
      && normalized.runtimeGeneration === runtime.generation
      && normalized.signerKeyId === derived.principal.signerKeyId
      && equalBytes(normalized.signerPublicKey, derivedPublicKey);
  } finally {
    derivedPublicKey?.fill(0);
    normalized.signerPublicKey.fill(0);
    normalized.transitionCommitment.fill(0);
    normalized.managerSigningPublicKeyHash.fill(0);
    normalized.signature.fill(0);
  }
}
