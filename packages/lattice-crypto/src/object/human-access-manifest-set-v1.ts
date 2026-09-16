import { bytesToHex } from "@noble/hashes/utils.js";

import type { LatticeCrypto } from "../crypto/index.ts";
import { compareUnsignedUtf8 } from "../domain/participants.ts";
import {
  createHumanObjectAccessManifestV5,
  encodeObjectAccessManifestV5,
  objectAccessManifestSigningBytesV5,
  verifyObjectAccessManifestChainV5,
  type ObjectAccessManifestV5,
  type ResolveAgentRuntimeSignerPublicKeyV5,
  type ResolveHistoricalHumanDeviceSigningPublicKeyV5,
  type ResolveHistoricalProcessorIssuingDevicePublicKeyV5,
  type ResolveProcessorSignerAuthorizationBytesV5,
  type TrustedMinimumObjectAccessHeadV5,
} from "../format/object-access-manifest-v5.ts";
import {
  decodeNamespaceObjectEnvelopeV2,
  encodeNamespaceObjectEnvelopeV2,
} from "../format/object-v2.ts";
import {
  accessRevision,
  assertPortableId,
  assertU64Counter,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  humanId,
  namespaceId,
  objectId,
} from "../v2-types/ids.ts";
import { V2_LIMITS, assertV2Limit } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";

const HASH_BYTES = 32;

export interface HumanObjectAccessNamespaceBindingV1 {
  readonly namespaceId: string;
  readonly domainId: string;
  readonly expectedAccessRevision: number;
  readonly expectedPolicyRevision: number;
  readonly bindingHash: Uint8Array;
}

export interface HumanObjectAccessEnvelopeContextV1 {
  readonly namespaceId: string;
  readonly keyGeneration: number;
  readonly bindingRevisionAtWrap: number;
  readonly envelopeHash: Uint8Array;
}

export interface HumanObjectAccessUpdateAuthorityContextV1 {
  readonly purpose: "persist-human-object-access-update-set";
  readonly operationId: string;
  readonly objectId: string;
  readonly payloadHash: Uint8Array;
  readonly expectedContentRevision: number;
  readonly currentAccessRevision: number;
  readonly currentManifestHash: Uint8Array;
  readonly nextAccessRevision: number;
  readonly nextManifestHash: Uint8Array;
  readonly currentNamespaceBindings:
    readonly HumanObjectAccessNamespaceBindingV1[];
  readonly targetNamespaceBindings:
    readonly HumanObjectAccessNamespaceBindingV1[];
  readonly removedNamespaceIds: readonly string[];
  readonly addedNamespaceIds: readonly string[];
  readonly currentEnvelopes: readonly HumanObjectAccessEnvelopeContextV1[];
  readonly targetEnvelopes: readonly HumanObjectAccessEnvelopeContextV1[];
  readonly subjectHumanId: string;
  readonly committerDeviceId: string;
  readonly hostAuthorizationRevision: number;
}

export interface PrepareHumanObjectAccessManifestUpdateSetInputV1 {
  readonly operationId: string;
  readonly expectedContentRevision: number;
  readonly currentManifestBytes: Uint8Array;
  readonly currentEnvelopeBytes: readonly Uint8Array[];
  readonly targetEnvelopeBytes: readonly Uint8Array[];
  readonly trustedMinimumHead: TrustedMinimumObjectAccessHeadV5;
  /** Revisions after the retained minimum and before currentManifestBytes. */
  readonly proof: readonly Uint8Array[];
  readonly resolveHistoricalHumanDeviceSigningPublicKey?:
    ResolveHistoricalHumanDeviceSigningPublicKeyV5;
  /** @deprecated Human-only compatibility adapter; v5 callers use the contextual resolver. */
  readonly resolveSigningPublicKey?: (deviceId: string) => Uint8Array | null;
  readonly resolveAgentRuntimeSignerPublicKey?:
    ResolveAgentRuntimeSignerPublicKeyV5;
  readonly resolveProcessorSignerAuthorizationBytes?:
    ResolveProcessorSignerAuthorizationBytesV5;
  readonly resolveHistoricalProcessorIssuingDevicePublicKey?:
    ResolveHistoricalProcessorIssuingDevicePublicKeyV5;
  readonly currentNamespaceBindings:
    readonly HumanObjectAccessNamespaceBindingV1[];
  readonly targetNamespaceBindings:
    readonly HumanObjectAccessNamespaceBindingV1[];
  readonly sourceAuthorized: boolean;
  readonly targetAuthorized: boolean;
  /** Exact Human principal authoring the new v5 access revision. */
  readonly subjectHumanId: string;
  readonly committerDeviceId: string;
  readonly hostAuthorizationRevision: number;
  readonly committerSigningPublicKey: Uint8Array;
  readonly committerSigningPrivateKey: Uint8Array;
}

export interface PreparedHumanObjectAccessManifestUpdateSetV1 {
  readonly manifest: ObjectAccessManifestV5;
  readonly manifestBytes: Uint8Array;
  readonly manifestHash: Uint8Array;
  readonly envelopeBytes: readonly Uint8Array[];
  readonly authority: HumanObjectAccessUpdateAuthorityContextV1;
}

export interface PrepareHumanObjectAccessManifestGenesisSetV1 {
  readonly objectId: string;
  readonly payloadHash: Uint8Array;
  readonly envelopeBytes: readonly Uint8Array[];
  readonly sourceAuthorized: boolean;
  readonly targetAuthorized: boolean;
  readonly subjectHumanId: string;
  readonly committerDeviceId: string;
  readonly hostAuthorizationRevision: number;
  readonly committerSigningPublicKey: Uint8Array;
  readonly committerSigningPrivateKey: Uint8Array;
}

export interface PreparedHumanObjectAccessManifestGenesisSetV1 {
  readonly manifest: ObjectAccessManifestV5;
  readonly manifestBytes: Uint8Array;
  readonly manifestHash: Uint8Array;
  readonly envelopeBytes: readonly Uint8Array[];
}

type EnvelopeEntry = Readonly<{
  envelopeBytes: Uint8Array;
  context: HumanObjectAccessEnvelopeContextV1;
}>;

type PreparedSnapshot = Readonly<{
  manifestBytes: Uint8Array;
  manifestHash: Uint8Array;
  envelopeBytes: readonly Uint8Array[];
  manifestFingerprint: string;
  authorityFingerprint: string;
}>;

const preparedSnapshots = new WeakMap<object, PreparedSnapshot>();
const preparedGenesisSnapshots = new WeakMap<object, Readonly<{
  manifestBytes: Uint8Array;
  manifestHash: Uint8Array;
  envelopeBytes: readonly Uint8Array[];
}>>();

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function wipeBytes(...values: readonly (Uint8Array | undefined)[]): void {
  for (const value of values) value?.fill(0);
}

function exactHash(label: string, value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== HASH_BYTES) {
    throw new TypeError(`${label} must be exactly ${HASH_BYTES} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function assertExactFields(
  label: string,
  value: object,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort(compareUnsignedUtf8);
  const sortedExpected = [...expected].sort(compareUnsignedUtf8);
  if (
    actual.length !== sortedExpected.length
    || actual.some((field, index) => field !== sortedExpected[index])
  ) throw new TypeError(`${label} fields must be exact`);
}

function cloneExactBindingSet(
  label: string,
  bindings: readonly HumanObjectAccessNamespaceBindingV1[],
): readonly HumanObjectAccessNamespaceBindingV1[] {
  if (!Array.isArray(bindings as unknown)) {
    throw new TypeError(`${label} must be an array`);
  }
  assertV2Limit(
    `${label} count`,
    bindings.length,
    V2_LIMITS.namespaceEnvelopesPerManifest,
  );
  const cloned = bindings.map((binding) => {
    if (typeof binding !== "object" || binding === null) {
      throw new TypeError(`${label} entry must be an object`);
    }
    assertExactFields(`${label} entry`, binding, [
      "bindingHash",
      "domainId",
      "expectedAccessRevision",
      "expectedPolicyRevision",
      "namespaceId",
    ]);
    const normalizedNamespaceId = namespaceId(binding.namespaceId);
    const normalizedDomainId = cryptoDomainId(binding.domainId);
    assertU64Counter(
      `${label} expected access revision`,
      binding.expectedAccessRevision,
    );
    assertU64Counter(
      `${label} expected policy revision`,
      binding.expectedPolicyRevision,
    );
    return Object.freeze({
      namespaceId: normalizedNamespaceId,
      domainId: normalizedDomainId,
      expectedAccessRevision: binding.expectedAccessRevision,
      expectedPolicyRevision: binding.expectedPolicyRevision,
      bindingHash: exactHash(`${label} binding hash`, binding.bindingHash),
    });
  });
  for (let index = 1; index < cloned.length; index++) {
    if (
      compareUnsignedUtf8(
        cloned[index - 1]!.namespaceId,
        cloned[index]!.namespaceId,
      ) >= 0
    ) throw new TypeError(
      `${label} must use canonical unique Namespace ordering`,
    );
  }
  return Object.freeze(cloned);
}

function exactEnvelopeSet(
  crypto: LatticeCrypto,
  label: string,
  object: string,
  source: readonly Uint8Array[],
  bindings: readonly HumanObjectAccessNamespaceBindingV1[],
): readonly EnvelopeEntry[] {
  if (!Array.isArray(source as unknown)) {
    throw new TypeError(`${label} must be an array`);
  }
  if (source.length !== bindings.length) {
    throw new TypeError(`${label} must exactly match its binding set`);
  }
  let aggregateBytes = 0;
  const entries = source.map((sourceBytes, index) => {
    if (!(sourceBytes instanceof Uint8Array)) {
      throw new TypeError(`${label} entry must be bytes`);
    }
    aggregateBytes += sourceBytes.length;
    assertV2Limit(
      `${label} bytes`,
      aggregateBytes,
      V2_LIMITS.manifestEnvelopeBytes,
    );
    const decoded = decodeNamespaceObjectEnvelopeV2(sourceBytes);
    const canonical = encodeNamespaceObjectEnvelopeV2(decoded);
    if (!equalBytes(canonical, sourceBytes)) {
      canonical.fill(0);
      throw new TypeError(`${label} entry must use canonical bytes`);
    }
    const expected = bindings[index]!;
    if (
      decoded.context.objectId !== object
      || decoded.context.keyClass !== "ai"
      || decoded.context.namespaceId !== expected.namespaceId
    ) {
      canonical.fill(0);
      throw new TypeError(
        `${label} must be an exact AI Namespace envelope set`,
      );
    }
    if (
      decoded.context.bindingRevisionAtWrap
        > expected.expectedAccessRevision
    ) {
      canonical.fill(0);
      throw new TypeError(`${label} binding revision is ahead of authority`);
    }
    return Object.freeze({
      envelopeBytes: canonical,
      context: Object.freeze({
        namespaceId: decoded.context.namespaceId,
        keyGeneration: decoded.context.keyGeneration,
        bindingRevisionAtWrap: decoded.context.bindingRevisionAtWrap,
        envelopeHash: crypto.hash(canonical),
      }),
    });
  });
  return Object.freeze(entries);
}

function assertCurrentInventory(
  expectedHashes: readonly Uint8Array[],
  entries: readonly EnvelopeEntry[],
): void {
  const actual = entries.map((entry) => entry.context.envelopeHash)
    .sort((left, right) =>
      compareUnsignedUtf8(bytesToHex(left), bytesToHex(right))
    );
  if (
    actual.length !== expectedHashes.length
    || actual.some((hash, index) => !equalBytes(hash, expectedHashes[index]!))
  ) throw new TypeError("Human object current envelope inventory is inexact");
}

function assertStableDomains(
  current: readonly HumanObjectAccessNamespaceBindingV1[],
  target: readonly HumanObjectAccessNamespaceBindingV1[],
): void {
  const currentDomains = new Map(
    current.map((entry) => [entry.namespaceId, entry.domainId] as const),
  );
  for (const entry of target) {
    const priorDomain = currentDomains.get(entry.namespaceId);
    if (priorDomain !== undefined && priorDomain !== entry.domainId) {
      throw new TypeError(
        "Human object retained Namespace Domain expectation was substituted",
      );
    }
  }
}

function bindingFingerprint(
  binding: HumanObjectAccessNamespaceBindingV1,
): string {
  return JSON.stringify({
    ...binding,
    bindingHash: bytesToHex(binding.bindingHash),
  });
}

function deriveAndValidateDelta(
  currentBindings: readonly HumanObjectAccessNamespaceBindingV1[],
  targetBindings: readonly HumanObjectAccessNamespaceBindingV1[],
  currentEntries: readonly EnvelopeEntry[],
  targetEntries: readonly EnvelopeEntry[],
): Readonly<{
  removedNamespaceIds: readonly string[];
  addedNamespaceIds: readonly string[];
}> {
  const currentByNamespace = new Map(currentBindings.map((binding, index) => [
    binding.namespaceId,
    { binding, envelope: currentEntries[index]! },
  ] as const));
  const targetByNamespace = new Map(targetBindings.map((binding, index) => [
    binding.namespaceId,
    { binding, envelope: targetEntries[index]! },
  ] as const));
  const removedNamespaceIds = currentBindings
    .filter((binding) => !targetByNamespace.has(binding.namespaceId))
    .map((binding) => binding.namespaceId);
  const addedNamespaceIds = targetBindings
    .filter((binding) => !currentByNamespace.has(binding.namespaceId))
    .map((binding) => binding.namespaceId);
  for (const addedNamespaceId of addedNamespaceIds) {
    const added = targetByNamespace.get(addedNamespaceId)!;
    if (
      added.envelope.context.bindingRevisionAtWrap
        !== added.binding.expectedAccessRevision
    ) throw new TypeError(
      "Human object added Namespace envelope uses a stale binding revision",
    );
  }
  for (const [retainedNamespaceId, current] of currentByNamespace) {
    const target = targetByNamespace.get(retainedNamespaceId);
    if (target === undefined) continue;
    if (
      bindingFingerprint(current.binding) !== bindingFingerprint(target.binding)
      || !equalBytes(
        current.envelope.envelopeBytes,
        target.envelope.envelopeBytes,
      )
    ) throw new TypeError(
      "Human object retained Namespace authority or envelope was substituted",
    );
  }
  if (removedNamespaceIds.length === 0 && addedNamespaceIds.length === 0) {
    throw new TypeError("Human object exact target is unchanged");
  }
  return Object.freeze({
    removedNamespaceIds: Object.freeze(removedNamespaceIds),
    addedNamespaceIds: Object.freeze(addedNamespaceIds),
  });
}

function cloneEnvelopeContexts(
  entries: readonly EnvelopeEntry[],
): readonly HumanObjectAccessEnvelopeContextV1[] {
  return Object.freeze(entries.map((entry) => Object.freeze({
    ...entry.context,
    envelopeHash: copyOwnedBytesV2(entry.context.envelopeHash),
  })));
}

function cloneBindings(
  entries: readonly HumanObjectAccessNamespaceBindingV1[],
): readonly HumanObjectAccessNamespaceBindingV1[] {
  return Object.freeze(entries.map((entry) => Object.freeze({
    ...entry,
    bindingHash: copyOwnedBytesV2(entry.bindingHash),
  })));
}

function authorityFingerprint(
  authority: HumanObjectAccessUpdateAuthorityContextV1,
): string {
  return JSON.stringify({
    ...authority,
    payloadHash: bytesToHex(authority.payloadHash),
    currentManifestHash: bytesToHex(authority.currentManifestHash),
    nextManifestHash: bytesToHex(authority.nextManifestHash),
    currentNamespaceBindings: authority.currentNamespaceBindings.map(
      (entry) => ({ ...entry, bindingHash: bytesToHex(entry.bindingHash) }),
    ),
    targetNamespaceBindings: authority.targetNamespaceBindings.map(
      (entry) => ({ ...entry, bindingHash: bytesToHex(entry.bindingHash) }),
    ),
    currentEnvelopes: authority.currentEnvelopes.map(
      (entry) => ({ ...entry, envelopeHash: bytesToHex(entry.envelopeHash) }),
    ),
    targetEnvelopes: authority.targetEnvelopes.map(
      (entry) => ({ ...entry, envelopeHash: bytesToHex(entry.envelopeHash) }),
    ),
  });
}

function manifestFingerprint(manifest: ObjectAccessManifestV5): string {
  return bytesToHex(encodeObjectAccessManifestV5(manifest));
}

function copyHumanSigningPublicKey(source: Uint8Array): Uint8Array {
  const publicKey = copyOwnedBytesV2(source);
  if (publicKey.length !== V2_LIMITS.signingPublicKeyBytes) {
    publicKey.fill(0);
    throw new TypeError(
      `Human object access signing public key must be exactly ${V2_LIMITS.signingPublicKeyBytes} bytes`,
    );
  }
  return publicKey;
}

function copyHumanSigningPrivateKey(source: Uint8Array): Uint8Array {
  const privateKey = copyOwnedBytesV2(source);
  if (privateKey.length !== V2_LIMITS.signingPrivateKeyBytes) {
    privateKey.fill(0);
    throw new TypeError(
      `Human object access signing private key must be exactly ${V2_LIMITS.signingPrivateKeyBytes} bytes`,
    );
  }
  return privateKey;
}

export function prepareHumanObjectAccessManifestGenesisSetV1(
  crypto: LatticeCrypto,
  input: PrepareHumanObjectAccessManifestGenesisSetV1,
): PreparedHumanObjectAccessManifestGenesisSetV1 {
  if (input.sourceAuthorized !== true || input.targetAuthorized !== true) {
    throw new TypeError(
      "Human object access genesis requires explicit source and target authority",
    );
  }
  const targetObjectId = objectId(input.objectId);
  if (!Array.isArray(input.envelopeBytes as unknown)) {
    throw new TypeError("Human object genesis envelopes must be an array");
  }
  assertV2Limit(
    "Human object genesis envelope count",
    input.envelopeBytes.length,
    V2_LIMITS.namespaceEnvelopesPerManifest,
  );
  const envelopes: Uint8Array[] = [];
  const hashes: Uint8Array[] = [];
  const namespaces = new Set<string>();
  let aggregateBytes = 0;
  let publicKey: Uint8Array | undefined;
  let privateKey: Uint8Array | undefined;
  let signingBytes: Uint8Array | undefined;
  let signature: Uint8Array | undefined;
  let succeeded = false;
  try {
    for (const source of input.envelopeBytes) {
      if (!(source instanceof Uint8Array)) {
        throw new TypeError("Human object genesis envelope must be bytes");
      }
      aggregateBytes += source.length;
      assertV2Limit(
        "Human object genesis envelope bytes",
        aggregateBytes,
        V2_LIMITS.manifestEnvelopeBytes,
      );
      const decoded = decodeNamespaceObjectEnvelopeV2(source);
      const canonical = encodeNamespaceObjectEnvelopeV2(decoded);
      if (
        !equalBytes(canonical, source)
        || decoded.context.objectId !== targetObjectId
        || decoded.context.keyClass !== "ai"
        || namespaces.has(decoded.context.namespaceId)
      ) {
        canonical.fill(0);
        throw new TypeError(
          "Human object genesis requires one canonical AI envelope per Namespace",
        );
      }
      namespaces.add(decoded.context.namespaceId);
      envelopes.push(canonical);
      hashes.push(crypto.hash(canonical));
    }
    publicKey = copyHumanSigningPublicKey(input.committerSigningPublicKey);
    privateKey = copyHumanSigningPrivateKey(input.committerSigningPrivateKey);
    const created = createHumanObjectAccessManifestV5(crypto, {
      objectId: targetObjectId,
      payloadHash: input.payloadHash,
      accessRevision: accessRevision(0),
      previousManifestHash: null,
      envelopeHashes: hashes,
      signer: {
        kind: "human_device",
        subjectHumanId: humanId(input.subjectHumanId),
        committerDeviceId: cryptoDeviceId(input.committerDeviceId),
      },
      signerAuthorizationHash: null,
      hostAuthorizationRevision: authorizationRevision(
        input.hostAuthorizationRevision,
      ),
    }, privateKey);
    signingBytes = objectAccessManifestSigningBytesV5({
      objectId: created.manifest.objectId,
      payloadHash: created.manifest.payloadHash,
      accessRevision: created.manifest.accessRevision,
      previousManifestHash: created.manifest.previousManifestHash,
      envelopeHashes: created.manifest.envelopeHashes,
      signer: created.manifest.signer,
      signerAuthorizationHash: created.manifest.signerAuthorizationHash,
      hostAuthorizationRevision: created.manifest.hostAuthorizationRevision,
    });
    signature = copyOwnedBytesV2(created.manifest.signature);
    if (!crypto.verify(publicKey, signingBytes, signature)) {
      created.bytes.fill(0);
      created.hash.fill(0);
      throw new TypeError("Human object genesis signing keys do not match");
    }
    const prepared = Object.freeze({
      manifest: created.manifest,
      manifestBytes: created.bytes,
      manifestHash: created.hash,
      envelopeBytes: Object.freeze(envelopes.map(copyOwnedBytesV2)),
    });
    preparedGenesisSnapshots.set(prepared, Object.freeze({
      manifestBytes: copyOwnedBytesV2(prepared.manifestBytes),
      manifestHash: copyOwnedBytesV2(prepared.manifestHash),
      envelopeBytes: Object.freeze(prepared.envelopeBytes.map(copyOwnedBytesV2)),
    }));
    succeeded = true;
    return prepared;
  } finally {
    envelopes.forEach((bytes) => bytes.fill(0));
    hashes.forEach((bytes) => bytes.fill(0));
    publicKey?.fill(0);
    privateKey?.fill(0);
    signingBytes?.fill(0);
    signature?.fill(0);
    if (!succeeded) namespaces.clear();
  }
}

export function assertAuthenticPreparedHumanObjectAccessManifestGenesisSetV1(
  prepared: PreparedHumanObjectAccessManifestGenesisSetV1,
): void {
  const snapshot = preparedGenesisSnapshots.get(prepared as object);
  if (
    snapshot === undefined
    || !equalBytes(snapshot.manifestBytes, prepared.manifestBytes)
    || !equalBytes(snapshot.manifestHash, prepared.manifestHash)
    || snapshot.envelopeBytes.length !== prepared.envelopeBytes.length
    || snapshot.envelopeBytes.some((bytes, index) =>
      !equalBytes(bytes, prepared.envelopeBytes[index]!)
    )
  ) throw new TypeError(
    "Human object access persistence requires an authentic prepared v5 genesis",
  );
}

/**
 * Signs one on-demand Human exact-set replacement. The complete empty target
 * is ordinary access removal; no future revision is preauthorized.
 */
export function prepareHumanObjectAccessManifestUpdateSetV1(
  crypto: LatticeCrypto,
  input: PrepareHumanObjectAccessManifestUpdateSetInputV1,
): PreparedHumanObjectAccessManifestUpdateSetV1 {
  if (
    typeof input.sourceAuthorized !== "boolean"
    || typeof input.targetAuthorized !== "boolean"
  ) throw new TypeError(
    "Human object access update source and target authority must be explicit",
  );
  assertPortableId("Human object access operation ID", input.operationId);
  assertU64Counter(
    "Human object access expected content revision",
    input.expectedContentRevision,
  );
  const currentBindings = cloneExactBindingSet(
    "Human object current Namespace bindings",
    input.currentNamespaceBindings,
  );
  const targetBindings = cloneExactBindingSet(
    "Human object target Namespace bindings",
    input.targetNamespaceBindings,
  );
  assertStableDomains(currentBindings, targetBindings);

  const verified = verifyObjectAccessManifestChainV5(crypto, {
    manifestBytes: input.currentManifestBytes,
    proof: input.proof,
    trustedMinimumHead: input.trustedMinimumHead,
    resolveHistoricalHumanDeviceSigningPublicKey: (context) =>
      input.resolveHistoricalHumanDeviceSigningPublicKey?.(context)
      ?? input.resolveSigningPublicKey?.(context.committerDeviceId)
      ?? null,
    resolveAgentRuntimeSignerPublicKey:
      input.resolveAgentRuntimeSignerPublicKey ?? (() => null),
    resolveProcessorSignerAuthorizationBytes:
      input.resolveProcessorSignerAuthorizationBytes ?? (() => null),
    resolveHistoricalProcessorIssuingDevicePublicKey:
      input.resolveHistoricalProcessorIssuingDevicePublicKey ?? (() => null),
  });
  let currentEntries: readonly EnvelopeEntry[] = [];
  let targetEntries: readonly EnvelopeEntry[] = [];
  let publicKey: Uint8Array | undefined;
  let privateKey: Uint8Array | undefined;
  let signingBytes: Uint8Array | undefined;
  let verificationSignature: Uint8Array | undefined;
  let succeeded = false;
  try {
    currentEntries = exactEnvelopeSet(
      crypto,
      "Human object current Namespace envelopes",
      verified.manifest.objectId,
      input.currentEnvelopeBytes,
      currentBindings,
    );
    assertCurrentInventory(verified.manifest.envelopeHashes, currentEntries);
    targetEntries = exactEnvelopeSet(
      crypto,
      "Human object target Namespace envelopes",
      verified.manifest.objectId,
      input.targetEnvelopeBytes,
      targetBindings,
    );
    const delta = deriveAndValidateDelta(
      currentBindings,
      targetBindings,
      currentEntries,
      targetEntries,
    );
    if (
      (delta.removedNamespaceIds.length > 0 && !input.sourceAuthorized)
      || (delta.addedNamespaceIds.length > 0 && !input.targetAuthorized)
    ) throw new TypeError(
      "Human object access update lacks authority for its removed or added Namespace set",
    );
    publicKey = copyHumanSigningPublicKey(input.committerSigningPublicKey);
    privateKey = copyHumanSigningPrivateKey(input.committerSigningPrivateKey);
    const subjectHumanId = humanId(input.subjectHumanId);
    const next = createHumanObjectAccessManifestV5(crypto, {
      objectId: verified.manifest.objectId,
      payloadHash: verified.manifest.payloadHash,
      accessRevision: accessRevision(verified.manifest.accessRevision + 1),
      previousManifestHash: verified.manifestHash,
      envelopeHashes: targetEntries.map((entry) => entry.context.envelopeHash),
      signer: {
        kind: "human_device",
        subjectHumanId,
        committerDeviceId: cryptoDeviceId(input.committerDeviceId),
      },
      signerAuthorizationHash: null,
      hostAuthorizationRevision: authorizationRevision(
        input.hostAuthorizationRevision,
      ),
    }, privateKey);
    signingBytes = objectAccessManifestSigningBytesV5({
      objectId: next.manifest.objectId,
      payloadHash: next.manifest.payloadHash,
      accessRevision: next.manifest.accessRevision,
      previousManifestHash: next.manifest.previousManifestHash,
      envelopeHashes: next.manifest.envelopeHashes,
      signer: next.manifest.signer,
      signerAuthorizationHash: next.manifest.signerAuthorizationHash,
      hostAuthorizationRevision: next.manifest.hostAuthorizationRevision,
    });
    verificationSignature = copyOwnedBytesV2(next.manifest.signature);
    if (!crypto.verify(publicKey, signingBytes, verificationSignature)) {
      wipeBytes(next.bytes, next.hash);
      throw new TypeError("Human object access signing keys do not match");
    }
    const authority = Object.freeze({
      purpose: "persist-human-object-access-update-set" as const,
      operationId: input.operationId,
      objectId: verified.manifest.objectId,
      payloadHash: copyOwnedBytesV2(verified.manifest.payloadHash),
      expectedContentRevision: input.expectedContentRevision,
      currentAccessRevision: verified.manifest.accessRevision,
      currentManifestHash: copyOwnedBytesV2(verified.manifestHash),
      nextAccessRevision: next.manifest.accessRevision,
      nextManifestHash: copyOwnedBytesV2(next.hash),
      currentNamespaceBindings: cloneBindings(currentBindings),
      targetNamespaceBindings: cloneBindings(targetBindings),
      removedNamespaceIds: delta.removedNamespaceIds,
      addedNamespaceIds: delta.addedNamespaceIds,
      currentEnvelopes: cloneEnvelopeContexts(currentEntries),
      targetEnvelopes: cloneEnvelopeContexts(targetEntries),
      subjectHumanId,
      committerDeviceId: next.manifest.signer.kind === "human_device"
        ? next.manifest.signer.committerDeviceId
        : cryptoDeviceId(input.committerDeviceId),
      hostAuthorizationRevision: next.manifest.hostAuthorizationRevision,
    });
    const prepared = Object.freeze({
      manifest: next.manifest,
      manifestBytes: next.bytes,
      manifestHash: next.hash,
      envelopeBytes: Object.freeze(targetEntries.map((entry) =>
        copyOwnedBytesV2(entry.envelopeBytes)
      )),
      authority,
    });
    preparedSnapshots.set(prepared, Object.freeze({
      manifestBytes: copyOwnedBytesV2(prepared.manifestBytes),
      manifestHash: copyOwnedBytesV2(prepared.manifestHash),
      envelopeBytes: Object.freeze(prepared.envelopeBytes.map(copyOwnedBytesV2)),
      manifestFingerprint: manifestFingerprint(prepared.manifest),
      authorityFingerprint: authorityFingerprint(prepared.authority),
    }));
    succeeded = true;
    return prepared;
  } finally {
    currentEntries.forEach((entry) => wipeBytes(
      entry.envelopeBytes,
      entry.context.envelopeHash,
    ));
    targetEntries.forEach((entry) => wipeBytes(
      entry.envelopeBytes,
      entry.context.envelopeHash,
    ));
    if (!succeeded) {
      currentBindings.forEach((entry) => entry.bindingHash.fill(0));
      targetBindings.forEach((entry) => entry.bindingHash.fill(0));
    }
    wipeBytes(
      verified.manifestBytes,
      verified.manifestHash,
      publicKey,
      privateKey,
      signingBytes,
      verificationSignature,
    );
  }
}

export function assertAuthenticPreparedHumanObjectAccessManifestUpdateSetV1(
  prepared: PreparedHumanObjectAccessManifestUpdateSetV1,
): void {
  const snapshot = preparedSnapshots.get(prepared as object);
  let currentManifestFingerprint: string | undefined;
  let currentAuthorityFingerprint: string | undefined;
  try {
    currentManifestFingerprint = manifestFingerprint(prepared.manifest);
    currentAuthorityFingerprint = authorityFingerprint(prepared.authority);
  } catch {
    // Uniform failure below avoids leaking which structural substitution won.
  }
  if (
    snapshot === undefined
    || !equalBytes(snapshot.manifestBytes, prepared.manifestBytes)
    || !equalBytes(snapshot.manifestHash, prepared.manifestHash)
    || snapshot.envelopeBytes.length !== prepared.envelopeBytes.length
    || snapshot.envelopeBytes.some((bytes, index) =>
      !equalBytes(bytes, prepared.envelopeBytes[index]!)
    )
    || snapshot.manifestFingerprint !== currentManifestFingerprint
    || snapshot.authorityFingerprint !== currentAuthorityFingerprint
  ) throw new TypeError(
    "Human object access persistence requires an authentic prepared exact-set update",
  );
}
