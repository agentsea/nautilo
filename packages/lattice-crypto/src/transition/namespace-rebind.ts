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
import { V2_LIMITS } from "../v2-types/limits.ts";
import {
  copyOwnedBytesV2,
  opaqueBytes,
} from "../v2-types/opaque.ts";

const KEY_BYTES = 32;

export type HumanNamespaceRebindReasonV2 =
  | "human_add"
  | "human_remove";

export interface PrepareHumanNamespaceRebindInputV2 {
  readonly crypto: LatticeCrypto;
  readonly reason: HumanNamespaceRebindReasonV2;
  readonly current: {
    readonly anchor: NamespaceBindingAnchorV2 | null;
    readonly proof: readonly NamespaceBindingV2[];
    readonly humanEnvelope: NamespaceKeyringEnvelopeV2;
    readonly aiEnvelope: NamespaceKeyringEnvelopeV2;
    readonly oldHumanDomainRoot: Uint8Array;
    readonly oldAiDomainRoot: Uint8Array;
  };
  readonly target: {
    readonly domainId: CryptoDomainId;
    readonly domainEpoch: DomainEpoch;
    readonly humanDomainRoot: Uint8Array;
    readonly aiDomainRoot: Uint8Array;
  };
  readonly committer: {
    readonly deviceId: CryptoDeviceId;
    readonly signingPrivateKey: Uint8Array;
  };
  readonly resolveHistoricalCommitter: HistoricalCommitterResolverV2;
  readonly resolveSourceCommitter: CurrentCommitterResolverV2;
  readonly resolveTargetCommitter: CurrentCommitterResolverV2;
}

export interface PreparedHumanNamespaceRebindV2 {
  readonly reason: HumanNamespaceRebindReasonV2;
  readonly expectedHead: NamespaceHeadExpectationV2;
  readonly nextHead: NamespaceHeadV2;
  readonly binding: NamespaceBindingV2;
  readonly bindingBytes: Uint8Array;
  readonly humanEnvelope: NamespaceKeyringEnvelopeV2;
  readonly aiEnvelope: NamespaceKeyringEnvelopeV2;
  readonly bindingRecord: NamespaceBindingRecordV2;
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

function context(
  purpose: NamespaceCommitterPurpose,
  binding: NamespaceBindingV2,
  domainId: CryptoDomainId,
  epoch: DomainEpoch,
  nextRevision: number,
  previousBindingHash: Uint8Array,
  deviceId: CryptoDeviceId,
): NamespaceCommitterContextV2 {
  return Object.freeze({
    purpose,
    namespaceId: binding.namespaceId,
    domainId,
    domainEpoch: epoch,
    accessRevision: accessRevision(nextRevision),
    committerDeviceId: deviceId,
    previousBindingHash: copyOwnedBytesV2(previousBindingHash),
  });
}

function resolveTransitionCommitter(
  input: PrepareHumanNamespaceRebindInputV2,
  binding: NamespaceBindingV2,
  previousBindingHash: Uint8Array,
  nextRevision: number,
  privateKey: Uint8Array,
): Uint8Array {
  const deviceId = cryptoDeviceId(input.committer.deviceId);
  const purposes: readonly NamespaceCommitterPurpose[] = [
    "namespace-keyring-envelope",
    "namespace-binding",
  ];
  const resolved: Uint8Array[] = [];
  for (const purpose of purposes) {
    const source = input.resolveSourceCommitter(
      context(
        purpose,
        binding,
        binding.domainId,
        binding.domainEpoch,
        Number(binding.accessRevision),
        previousBindingHash,
        deviceId,
      ),
    );
    const target = input.resolveTargetCommitter(
      context(
        purpose,
        binding,
        input.target.domainId,
        input.target.domainEpoch,
        nextRevision,
        previousBindingHash,
        deviceId,
      ),
    );
    resolved.push(
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
  const publicKey = resolved[0]!;
  if (!resolved.every((candidate) => equalBytes(candidate, publicKey))) {
    throw new Error(
      "Namespace rebind committer differs across transition contexts",
    );
  }
  const proof = input.crypto.sign(privateKey, previousBindingHash);
  if (!input.crypto.verify(publicKey, previousBindingHash, proof)) {
    throw new Error(
      "Namespace rebind private key does not match the authorized committer",
    );
  }
  return publicKey;
}

/**
 * Prepare the complete cryptographic consequence of a Human add/remove.
 *
 * The function performs no storage writes. It verifies the trusted current
 * binding, opens both complete retained keyrings, authenticates one committer
 * across the source and target transition contexts, appends independent fresh
 * generations, and returns exact immutable bytes plus CAS heads.
 */
export function prepareHumanNamespaceRebindV2(
  input: PrepareHumanNamespaceRebindInputV2,
): PreparedHumanNamespaceRebindV2 {
  if (input.reason !== "human_add" && input.reason !== "human_remove") {
    throw new RangeError("Namespace rebind reason is unsupported");
  }
  const targetDomainId = cryptoDomainId(input.target.domainId);
  const targetEpoch = domainEpoch(input.target.domainEpoch);
  let targetHumanRoot: Uint8Array | null = null;
  let targetAiRoot: Uint8Array | null = null;
  let oldHumanRoot: Uint8Array | null = null;
  let oldAiRoot: Uint8Array | null = null;
  let privateKey: Uint8Array | null = null;
  let openedHuman: NamespaceKeyringPlaintextV2 | null = null;
  let openedAi: NamespaceKeyringPlaintextV2 | null = null;
  let revisedHuman: NamespaceKeyringPlaintextV2 | null = null;
  let revisedAi: NamespaceKeyringPlaintextV2 | null = null;
  try {
    targetHumanRoot = assertExactBytes(
      "Target Human Domain root",
      input.target.humanDomainRoot,
    );
    targetAiRoot = assertExactBytes(
      "Target AI Domain root",
      input.target.aiDomainRoot,
    );
    oldHumanRoot = assertExactBytes(
      "Source Human Domain root",
      input.current.oldHumanDomainRoot,
    );
    oldAiRoot = assertExactBytes(
      "Source AI Domain root",
      input.current.oldAiDomainRoot,
    );
    privateKey = assertExactBytes(
      "Namespace rebind committer signing private key",
      input.committer.signingPrivateKey,
      V2_LIMITS.signingPrivateKeyBytes,
    );

    const verified = verifyNamespaceBindingProof({
      crypto: input.crypto,
      anchor: input.current.anchor,
      proof: input.current.proof,
      resolveHistoricalCommitter: input.resolveHistoricalCommitter,
    });
    const currentBinding = verified.binding;
    if (
      !verifyBindingEnvelopePair(
        currentBinding,
        input.current.humanEnvelope,
        input.current.aiEnvelope,
      )
    ) {
      throw new Error(
        "Namespace rebind requires the exact matching current envelope pair",
      );
    }
    if (targetDomainId === currentBinding.domainId) {
      throw new Error(
        "Human membership rebind must target a different Crypto Domain",
      );
    }

    // Open both complete keyrings before any fresh generation/random nonce work.
    openedHuman = openNamespaceKeyring({
      crypto: input.crypto,
      domainRoot: oldHumanRoot,
      envelope: input.current.humanEnvelope,
      resolveHistoricalCommitter: input.resolveHistoricalCommitter,
    });
    openedAi = openNamespaceKeyring({
      crypto: input.crypto,
      domainRoot: oldAiRoot,
      envelope: input.current.aiEnvelope,
      resolveHistoricalCommitter: input.resolveHistoricalCommitter,
    });

    const nextRevisionNumber = Number(currentBinding.accessRevision) + 1;
    const nextRevision = accessRevision(nextRevisionNumber);
    const previousBindingHash = verified.bindingHash;
    const committerPublicKey = resolveTransitionCommitter(
      input,
      currentBinding,
      previousBindingHash,
      nextRevisionNumber,
      privateKey,
    );
    const metadata = {
      domainId: targetDomainId,
      domainEpoch: targetEpoch,
      accessRevision: nextRevision,
      previousBindingHash,
      committerDeviceId: cryptoDeviceId(input.committer.deviceId),
    } as const;
    const targetResolver = () => committerPublicKey;
    revisedHuman = prepareNamespaceKeyringRevision(
      input.crypto,
      openedHuman,
      nextRevision,
      true,
    );
    revisedAi = prepareNamespaceKeyringRevision(
      input.crypto,
      openedAi,
      nextRevision,
      true,
    );
    const humanEnvelope = sealNamespaceKeyring({
      crypto: input.crypto,
      domainRoot: targetHumanRoot,
      keyring: revisedHuman,
      metadata,
      committerSigningPrivateKey: privateKey,
      resolveCurrentCommitter: targetResolver,
    });
    const aiEnvelope = sealNamespaceKeyring({
      crypto: input.crypto,
      domainRoot: targetAiRoot,
      keyring: revisedAi,
      metadata,
      committerSigningPrivateKey: privateKey,
      resolveCurrentCommitter: targetResolver,
    });
    const binding = createNamespaceBinding({
      crypto: input.crypto,
      humanEnvelope,
      aiEnvelope,
      committerSigningPrivateKey: privateKey,
      resolveCurrentCommitter: targetResolver,
    });
    const bindingBytes = serializeNamespaceBinding(binding);
    const humanEnvelopeBytes = serializeNamespaceKeyringEnvelope(
      humanEnvelope,
    );
    const aiEnvelopeBytes = serializeNamespaceKeyringEnvelope(aiEnvelope);
    const bindingHash = namespaceBindingHash(binding);
    const expectedHead: NamespaceHeadExpectationV2 = Object.freeze({
      namespaceId: binding.namespaceId,
      accessRevision: currentBinding.accessRevision,
      bindingHash: previousBindingHash,
    });
    const nextHead: NamespaceHeadV2 = Object.freeze({
      namespaceId: binding.namespaceId,
      accessRevision: binding.accessRevision,
      bindingHash,
      domainId: binding.domainId,
      domainEpoch: binding.domainEpoch,
    });
    const bindingRecord: NamespaceBindingRecordV2 = Object.freeze({
      namespaceId: binding.namespaceId,
      revision: binding.accessRevision,
      bindingHash: copyOwnedBytesV2(bindingHash),
      previousBindingHash: copyOwnedBytesV2(previousBindingHash),
      signedBindingBytes: copyOwnedBytesV2(bindingBytes),
      humanKeyringEnvelope: opaqueBytes(
        "human-keyring-envelope",
        humanEnvelopeBytes,
      ),
      aiKeyringEnvelope: opaqueBytes(
        "ai-keyring-envelope",
        aiEnvelopeBytes,
      ),
    });
    return Object.freeze({
      reason: input.reason,
      expectedHead,
      nextHead,
      binding,
      bindingBytes,
      humanEnvelope,
      aiEnvelope,
      bindingRecord,
    });
  } finally {
    wipeKeyring(revisedAi);
    wipeKeyring(revisedHuman);
    wipeKeyring(openedAi);
    wipeKeyring(openedHuman);
    privateKey?.fill(0);
    oldAiRoot?.fill(0);
    oldHumanRoot?.fill(0);
    targetAiRoot?.fill(0);
    targetHumanRoot?.fill(0);
  }
}
