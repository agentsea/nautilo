import type { LatticeCrypto } from "../crypto/index.ts";
import { serializeNamespaceBinding } from "../format/namespace-binding-v2.ts";
import { serializeNamespaceKeyringEnvelope } from "../format/namespace-keyring-v2.ts";
import type {
  CurrentCommitterResolverV2,
  HistoricalCommitterResolverV2,
  NamespaceCommitterContextV2,
  NamespaceCommitterPurpose,
} from "../namespace/authorization.ts";
import {
  createNamespaceBinding,
  namespaceBindingHash,
  verifyBindingEnvelopePair,
  verifyNamespaceBindingProof,
} from "../namespace/bindings.ts";
import {
  openNamespaceKeyring,
  prepareNamespaceKeyringRevision,
  sealNamespaceKeyring,
} from "../namespace/keyrings.ts";
import type {
  NamespaceBindingAnchorV2,
  NamespaceBindingV2,
  NamespaceKeyringEnvelopeV2,
  NamespaceKeyringPlaintextV2,
} from "../namespace/types.ts";
import type {
  NamespaceBindingRecordV2,
  NamespaceHeadExpectationV2,
  NamespaceHeadV2,
} from "../storage/v2-records.ts";
import {
  type CryptoDeviceId,
  type CryptoDomainId,
  type DomainEpoch,
  accessRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
} from "../v2-types/ids.ts";
import { V2_LIMITS, assertV2Range } from "../v2-types/limits.ts";
import {
  copyOwnedBytesV2,
  opaqueBytes,
} from "../v2-types/opaque.ts";

const KEY_BYTES = 32;

export type DomainEpochAdvanceReasonV2 =
  | "device_add"
  | "device_revoke";

export interface DomainEpochAdvanceNamespaceV2 {
  readonly anchor: NamespaceBindingAnchorV2 | null;
  readonly proof: readonly NamespaceBindingV2[];
  readonly humanEnvelope: NamespaceKeyringEnvelopeV2;
  readonly aiEnvelope: NamespaceKeyringEnvelopeV2;
}

export interface PrepareDomainEpochAdvanceInputV2 {
  readonly crypto: LatticeCrypto;
  readonly reason: DomainEpochAdvanceReasonV2;
  readonly domain: {
    readonly domainId: CryptoDomainId;
    readonly oldEpoch: DomainEpoch;
    readonly nextEpoch: DomainEpoch;
    readonly oldHumanRoot: Uint8Array;
    readonly oldAiRoot: Uint8Array;
    readonly nextHumanRoot: Uint8Array;
    readonly nextAiRoot: Uint8Array;
  };
  readonly affected: readonly DomainEpochAdvanceNamespaceV2[];
  readonly committer: {
    readonly deviceId: CryptoDeviceId;
    readonly signingPrivateKey: Uint8Array;
  };
  readonly resolveHistoricalCommitter: HistoricalCommitterResolverV2;
  readonly resolveSourceCommitter: CurrentCommitterResolverV2;
  readonly resolveTargetCommitter: CurrentCommitterResolverV2;
}

export interface PreparedDomainEpochNamespaceV2 {
  readonly expectedHead: NamespaceHeadExpectationV2;
  readonly nextHead: NamespaceHeadV2;
  readonly binding: NamespaceBindingV2;
  readonly bindingBytes: Uint8Array;
  readonly humanEnvelope: NamespaceKeyringEnvelopeV2;
  readonly aiEnvelope: NamespaceKeyringEnvelopeV2;
  readonly bindingRecord: NamespaceBindingRecordV2;
}

export interface PreparedDomainEpochAdvanceV2 {
  readonly reason: DomainEpochAdvanceReasonV2;
  readonly domainId: CryptoDomainId;
  readonly oldEpoch: DomainEpoch;
  readonly nextEpoch: DomainEpoch;
  readonly namespaces: readonly PreparedDomainEpochNamespaceV2[];
}

interface PreflightNamespace {
  readonly current: DomainEpochAdvanceNamespaceV2;
  readonly binding: NamespaceBindingV2;
  readonly bindingHash: Uint8Array;
  readonly nextRevision: number;
  readonly humanKeyring: NamespaceKeyringPlaintextV2;
  readonly aiKeyring: NamespaceKeyringPlaintextV2;
  readonly committerPublicKey: Uint8Array;
}

function assertExactBytes(
  label: string,
  value: unknown,
  length = KEY_BYTES,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new RangeError(`${label} must be exactly ${length} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.every((byte, index) => byte === right[index]);
}

function wipeKeyring(
  keyring: NamespaceKeyringPlaintextV2 | null,
): void {
  if (keyring === null) return;
  for (const generation of keyring.generations) {
    generation.key.fill(0);
  }
}

function wipePreflighted(
  preflighted: readonly PreflightNamespace[],
): void {
  for (const item of preflighted) {
    wipeKeyring(item.aiKeyring);
    wipeKeyring(item.humanKeyring);
  }
}

function committerContext(
  purpose: NamespaceCommitterPurpose,
  binding: NamespaceBindingV2,
  epoch: DomainEpoch,
  revision: number,
  bindingHash: Uint8Array,
  deviceId: CryptoDeviceId,
): NamespaceCommitterContextV2 {
  return Object.freeze({
    purpose,
    namespaceId: binding.namespaceId,
    domainId: binding.domainId,
    domainEpoch: epoch,
    accessRevision: accessRevision(revision),
    committerDeviceId: deviceId,
    previousBindingHash: copyOwnedBytesV2(bindingHash),
  });
}

function resolveCommitterForNamespace(
  input: PrepareDomainEpochAdvanceInputV2,
  binding: NamespaceBindingV2,
  bindingHash: Uint8Array,
  nextRevision: number,
): Uint8Array {
  const deviceId = cryptoDeviceId(input.committer.deviceId);
  const keys: Uint8Array[] = [];
  for (const purpose of [
    "namespace-keyring-envelope",
    "namespace-binding",
  ] as const) {
    const source = input.resolveSourceCommitter(
      committerContext(
        purpose,
        binding,
        input.domain.oldEpoch,
        Number(binding.accessRevision),
        bindingHash,
        deviceId,
      ),
    );
    const target = input.resolveTargetCommitter(
      committerContext(
        purpose,
        binding,
        input.domain.nextEpoch,
        nextRevision,
        bindingHash,
        deviceId,
      ),
    );
    keys.push(
      assertExactBytes(
        "Source committer public key",
        source,
        V2_LIMITS.signingPublicKeyBytes,
      ),
      assertExactBytes(
        "Target committer public key",
        target,
        V2_LIMITS.signingPublicKeyBytes,
      ),
    );
  }
  const first = keys[0]!;
  if (!keys.every((key) => equalBytes(key, first))) {
    throw new Error(
      "Domain epoch committer differs across transition contexts",
    );
  }
  return first;
}

function preflight(
  input: PrepareDomainEpochAdvanceInputV2,
  oldHumanRoot: Uint8Array,
  oldAiRoot: Uint8Array,
  privateKey: Uint8Array,
): readonly PreflightNamespace[] {
  const seen = new Set<string>();
  const preflighted: PreflightNamespace[] = [];
  let succeeded = false;
  try {
    for (const current of input.affected) {
      const verified = verifyNamespaceBindingProof({
        crypto: input.crypto,
        anchor: current.anchor,
        proof: current.proof,
        resolveHistoricalCommitter: input.resolveHistoricalCommitter,
      });
      const binding = verified.binding;
      if (
        binding.domainId !== input.domain.domainId
        || binding.domainEpoch !== input.domain.oldEpoch
      ) {
        throw new Error(
          "Affected Namespace is not at the exact source Domain epoch",
        );
      }
      if (seen.has(binding.namespaceId)) {
        throw new Error(
          "Domain epoch transition contains a duplicate Namespace",
        );
      }
      seen.add(binding.namespaceId);
      if (
        !verifyBindingEnvelopePair(
          binding,
          current.humanEnvelope,
          current.aiEnvelope,
        )
      ) {
        throw new Error(
          "Domain epoch transition requires the matching current envelope pair",
        );
      }
      let humanKeyring: NamespaceKeyringPlaintextV2 | null = null;
      let aiKeyring: NamespaceKeyringPlaintextV2 | null = null;
      let transferred = false;
      try {
        humanKeyring = openNamespaceKeyring({
          crypto: input.crypto,
          domainRoot: oldHumanRoot,
          envelope: current.humanEnvelope,
          resolveHistoricalCommitter: input.resolveHistoricalCommitter,
        });
        aiKeyring = openNamespaceKeyring({
          crypto: input.crypto,
          domainRoot: oldAiRoot,
          envelope: current.aiEnvelope,
          resolveHistoricalCommitter: input.resolveHistoricalCommitter,
        });
        if (
          input.reason === "device_revoke"
          && (
            humanKeyring.generations.length
              >= V2_LIMITS.retainedNamespaceGenerations
            || aiKeyring.generations.length
              >= V2_LIMITS.retainedNamespaceGenerations
          )
        ) {
          throw new RangeError(
            "Domain epoch revoke would exceed the retained generation limit",
          );
        }
        const bindingHash = verified.bindingHash;
        const nextRevision = Number(binding.accessRevision) + 1;
        accessRevision(nextRevision);
        preflighted.push({
          current,
          binding,
          bindingHash,
          nextRevision,
          humanKeyring,
          aiKeyring,
          committerPublicKey: resolveCommitterForNamespace(
            input,
            binding,
            bindingHash,
            nextRevision,
          ),
        });
        transferred = true;
      } finally {
        if (!transferred) {
          wipeKeyring(aiKeyring);
          wipeKeyring(humanKeyring);
        }
      }
    }
    if (preflighted.length === 0) {
      succeeded = true;
      return Object.freeze(preflighted);
    }
    const commonKey = preflighted[0]!.committerPublicKey;
    if (
      !preflighted.every((item) =>
        equalBytes(item.committerPublicKey, commonKey)
      )
    ) {
      throw new Error(
        "Domain epoch transition uses different committers across Namespaces",
      );
    }
    const challenge = preflighted[0]!.bindingHash;
    const signature = input.crypto.sign(privateKey, challenge);
    if (!input.crypto.verify(commonKey, challenge, signature)) {
      throw new Error(
        "Domain epoch private key does not match the authorized committer",
      );
    }
    succeeded = true;
    return Object.freeze(preflighted);
  } finally {
    if (!succeeded) wipePreflighted(preflighted);
  }
}

function prepareNamespace(
  input: PrepareDomainEpochAdvanceInputV2,
  item: PreflightNamespace,
  roots: {
    readonly oldHuman: Uint8Array;
    readonly oldAi: Uint8Array;
    readonly nextHuman: Uint8Array;
    readonly nextAi: Uint8Array;
  },
  privateKey: Uint8Array,
): PreparedDomainEpochNamespaceV2 {
  const resolver = () => item.committerPublicKey;
  const metadata = {
    domainId: input.domain.domainId,
    domainEpoch: input.domain.nextEpoch,
    accessRevision: accessRevision(item.nextRevision),
    previousBindingHash: item.bindingHash,
    committerDeviceId: cryptoDeviceId(input.committer.deviceId),
  } as const;
  const rotateGeneration = input.reason === "device_revoke";
  let revisedHuman: NamespaceKeyringPlaintextV2 | null = null;
  let revisedAi: NamespaceKeyringPlaintextV2 | null = null;
  try {
    revisedHuman = prepareNamespaceKeyringRevision(
      input.crypto,
      item.humanKeyring,
      item.nextRevision,
      rotateGeneration,
    );
    revisedAi = prepareNamespaceKeyringRevision(
      input.crypto,
      item.aiKeyring,
      item.nextRevision,
      rotateGeneration,
    );
    const humanEnvelope = sealNamespaceKeyring({
      crypto: input.crypto,
      domainRoot: roots.nextHuman,
      keyring: revisedHuman,
      metadata,
      committerSigningPrivateKey: privateKey,
      resolveCurrentCommitter: resolver,
    });
    const aiEnvelope = sealNamespaceKeyring({
      crypto: input.crypto,
      domainRoot: roots.nextAi,
      keyring: revisedAi,
      metadata,
      committerSigningPrivateKey: privateKey,
      resolveCurrentCommitter: resolver,
    });
    const binding = createNamespaceBinding({
      crypto: input.crypto,
      humanEnvelope,
      aiEnvelope,
      committerSigningPrivateKey: privateKey,
      resolveCurrentCommitter: resolver,
    });
    const bindingBytes = serializeNamespaceBinding(binding);
    const bindingHash = namespaceBindingHash(binding);
    const humanBytes = serializeNamespaceKeyringEnvelope(humanEnvelope);
    const aiBytes = serializeNamespaceKeyringEnvelope(aiEnvelope);
    return Object.freeze({
      expectedHead: Object.freeze({
        namespaceId: binding.namespaceId,
        accessRevision: item.binding.accessRevision,
        bindingHash: item.bindingHash,
      }),
      nextHead: Object.freeze({
        namespaceId: binding.namespaceId,
        accessRevision: binding.accessRevision,
        bindingHash,
        domainId: binding.domainId,
        domainEpoch: binding.domainEpoch,
      }),
      binding,
      bindingBytes,
      humanEnvelope,
      aiEnvelope,
      bindingRecord: Object.freeze({
        namespaceId: binding.namespaceId,
        revision: binding.accessRevision,
        bindingHash: copyOwnedBytesV2(bindingHash),
        previousBindingHash: copyOwnedBytesV2(item.bindingHash),
        signedBindingBytes: copyOwnedBytesV2(bindingBytes),
        humanKeyringEnvelope: opaqueBytes(
          "human-keyring-envelope",
          humanBytes,
        ),
        aiKeyringEnvelope: opaqueBytes("ai-keyring-envelope", aiBytes),
      }),
    });
  } finally {
    wipeKeyring(revisedAi);
    wipeKeyring(revisedHuman);
  }
}

/**
 * Prepare all Namespace consequences of one Domain device add/revoke.
 * Validation and authorization for the whole bounded batch finish before the
 * first fresh generation or AEAD nonce is consumed.
 */
export function prepareDomainEpochAdvanceV2(
  input: PrepareDomainEpochAdvanceInputV2,
): PreparedDomainEpochAdvanceV2 {
  assertV2Range(
    "Affected Namespaces",
    input.affected.length,
    input.reason === "device_add" ? 0 : 1,
    V2_LIMITS.namespacesPerDomainTransition,
  );
  if (input.reason !== "device_add" && input.reason !== "device_revoke") {
    throw new RangeError("Domain epoch advance reason is unsupported");
  }
  const domainId = cryptoDomainId(input.domain.domainId);
  const oldEpoch = domainEpoch(input.domain.oldEpoch);
  const nextEpoch = domainEpoch(input.domain.nextEpoch);
  if (Number(nextEpoch) !== Number(oldEpoch) + 1) {
    throw new RangeError("Domain epoch advance must increment exactly once");
  }
  cryptoDeviceId(input.committer.deviceId);
  let oldHuman: Uint8Array | null = null;
  let oldAi: Uint8Array | null = null;
  let nextHuman: Uint8Array | null = null;
  let nextAi: Uint8Array | null = null;
  let privateKey: Uint8Array | null = null;
  let preflighted: readonly PreflightNamespace[] | null = null;
  try {
    oldHuman = assertExactBytes(
      "Old Human Domain root",
      input.domain.oldHumanRoot,
    );
    oldAi = assertExactBytes("Old AI Domain root", input.domain.oldAiRoot);
    nextHuman = assertExactBytes(
      "Next Human Domain root",
      input.domain.nextHumanRoot,
    );
    nextAi = assertExactBytes(
      "Next AI Domain root",
      input.domain.nextAiRoot,
    );
    privateKey = assertExactBytes(
      "Domain epoch committer signing private key",
      input.committer.signingPrivateKey,
      V2_LIMITS.signingPrivateKeyBytes,
    );
    const roots = { oldHuman, oldAi, nextHuman, nextAi };
    preflighted = preflight(input, oldHuman, oldAi, privateKey);
    const namespaces = preflighted.map((item) =>
      prepareNamespace(input, item, roots, privateKey!)
    );
    return Object.freeze({
      reason: input.reason,
      domainId,
      oldEpoch,
      nextEpoch,
      namespaces: Object.freeze(namespaces),
    });
  } finally {
    if (preflighted !== null) wipePreflighted(preflighted);
    privateKey?.fill(0);
    nextAi?.fill(0);
    nextHuman?.fill(0);
    oldAi?.fill(0);
    oldHuman?.fill(0);
  }
}
