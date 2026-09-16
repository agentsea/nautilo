import type { LatticeCrypto } from "../crypto/index.ts";
import {
  parseNamespaceBinding,
} from "../format/namespace-binding-v2.ts";
import {
  parseNamespaceKeyringEnvelope,
} from "../format/namespace-keyring-v2.ts";
import {
  namespaceBindingWriteRecordV2,
} from "../storage/v2-record-policy.ts";
import type {
  NamespaceBindingHeadCasStatusV2,
  NamespaceHeadExpectationV2,
  NamespaceHeadV2,
} from "../storage/v2-records.ts";
import {
  accessRevision,
  cryptoDomainId,
  domainEpoch,
  namespaceId,
} from "../v2-types/ids.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import {
  authorizeNamespaceBindingWriteV2,
  type AuthorizedNamespaceBindingWriteV2,
} from "./authorized-write.ts";
import {
  verifyNamespaceBinding,
} from "./bindings.ts";
import type {
  CurrentCommitterResolverV2,
  NamespaceBindingCasAuthorizationV2,
  NamespaceCommitterContextV2,
} from "./authorization.ts";
import {
  SIGNING_PUBLIC_KEY_BYTES,
} from "./types.ts";
import {
  verifyNamespaceKeyringEnvelope,
} from "./keyrings.ts";

const HASH_BYTES = 32;

export interface NamespaceBindingHeadCasStorageV2 {
  /**
   * A product adapter MUST compare `authorized.authorization` with its
   * authoritative host membership/device state in the same transaction as
   * the binding/head CAS, returning `stale` when that state changed.
   */
  compareAndSwapNamespaceBindingAndHead(
    authorized: AuthorizedNamespaceBindingWriteV2,
  ): Promise<NamespaceBindingHeadCasStatusV2>;
}

/**
 * Raw, durable, adapter-friendly publication material. This is deliberately
 * not a storage record or CAS capability: only the coordinator can authenticate
 * it, resolve fresh current committer authority, and mint the one-shot write.
 */
export interface NamespaceBindingPersistenceV2 {
  readonly expectedHead: NamespaceHeadExpectationV2 | null;
  readonly nextHead: NamespaceHeadV2;
  readonly signedBindingBytes: Uint8Array;
  readonly humanKeyringEnvelopeBytes: Uint8Array;
  readonly aiKeyringEnvelopeBytes: Uint8Array;
}

export class NamespaceBindingPersistenceOutcomeUnknownV2 extends Error {
  override readonly name = "NamespaceBindingPersistenceOutcomeUnknownV2";

  constructor(cause: unknown) {
    super(
      "Namespace binding storage outcome is ambiguous; retry must be explicit",
      { cause },
    );
  }
}

function assertExactFields(
  label: string,
  value: unknown,
  expected: readonly string[],
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${label} must be an object`);
  }
  const fields = Object.keys(value);
  if (
    fields.length !== expected.length
    || fields.some((field) => !expected.includes(field))
  ) {
    throw new TypeError(`${label} has an invalid field set`);
  }
}

function assertHash(label: string, value: unknown): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== HASH_BYTES) {
    throw new RangeError(`${label} must contain exactly ${HASH_BYTES} bytes`);
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  // compares values already validated as fixed 32-byte hashes or public keys.
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function cloneCommitterContext(
  context: NamespaceCommitterContextV2,
): NamespaceCommitterContextV2 {
  return Object.freeze({
    purpose: context.purpose,
    namespaceId: context.namespaceId,
    domainId: context.domainId,
    domainEpoch: context.domainEpoch,
    accessRevision: context.accessRevision,
    committerDeviceId: context.committerDeviceId,
    previousBindingHash: context.previousBindingHash === null
      ? null
      : copyOwnedBytesV2(context.previousBindingHash),
  });
}

function cloneExpectedHead(
  head: NamespaceHeadExpectationV2 | null,
): NamespaceHeadExpectationV2 | null {
  if (head === null) return null;
  assertExactFields("Expected Namespace head", head, [
    "namespaceId",
    "accessRevision",
    "bindingHash",
  ]);
  return Object.freeze({
    namespaceId: namespaceId(head.namespaceId),
    accessRevision: accessRevision(head.accessRevision),
    bindingHash: (() => {
      assertHash("Expected Namespace binding hash", head.bindingHash);
      return copyOwnedBytesV2(head.bindingHash);
    })(),
  });
}

function cloneNextHead(head: NamespaceHeadV2): NamespaceHeadV2 {
  assertExactFields("Next Namespace head", head, [
    "namespaceId",
    "accessRevision",
    "bindingHash",
    "domainId",
    "domainEpoch",
  ]);
  assertHash("Next Namespace binding hash", head.bindingHash);
  return Object.freeze({
    namespaceId: namespaceId(head.namespaceId),
    accessRevision: accessRevision(head.accessRevision),
    bindingHash: copyOwnedBytesV2(head.bindingHash),
    domainId: cryptoDomainId(head.domainId),
    domainEpoch: domainEpoch(head.domainEpoch),
  });
}

function assertBindingHeadTransition(
  expected: NamespaceHeadExpectationV2 | null,
  next: NamespaceHeadV2,
  bindingRecord: ReturnType<typeof namespaceBindingWriteRecordV2>,
): void {
  const signed = parseNamespaceBinding(bindingRecord.signedBindingBytes);
  if (
    bindingRecord.namespaceId !== next.namespaceId
    || bindingRecord.revision !== next.accessRevision
    || !equalBytes(bindingRecord.bindingHash, next.bindingHash)
    || signed.domainId !== next.domainId
    || signed.domainEpoch !== next.domainEpoch
  ) {
    throw new Error(
      "Namespace binding persistence binding and next-head coordinates differ",
    );
  }
  if (expected === null) {
    // Canonical binding decoding already proves revision zero has no previous
    // hash and every later revision does. The head revision is therefore the
    // only independent genesis condition left to enforce here.
    if (next.accessRevision !== 0) {
      throw new Error(
        "Initial Namespace binding persistence requires revision zero and no previous hash",
      );
    }
    return;
  }
  if (
    expected.namespaceId !== next.namespaceId
    || next.accessRevision !== expected.accessRevision + 1
    || !equalBytes(
      bindingRecord.previousBindingHash!,
      expected.bindingHash,
    )
  ) {
    throw new Error(
      "Namespace binding persistence requires one exact previous head",
    );
  }
}

/**
 * Authenticate and atomically persist one immutable Namespace binding plus its
 * public head. Exactly one fresh capability and one storage CAS are attempted.
 */
export async function persistNamespaceBindingV2(input: {
  readonly crypto: LatticeCrypto;
  readonly storage: NamespaceBindingHeadCasStorageV2;
  readonly prepared: NamespaceBindingPersistenceV2;
  readonly resolveCurrentCommitter: CurrentCommitterResolverV2;
}): Promise<NamespaceBindingHeadCasStatusV2> {
  assertExactFields("Namespace binding persistence input", input, [
    "crypto",
    "storage",
    "prepared",
    "resolveCurrentCommitter",
  ]);
  assertExactFields("Namespace binding persistence material", input.prepared, [
    "expectedHead",
    "nextHead",
    "signedBindingBytes",
    "humanKeyringEnvelopeBytes",
    "aiKeyringEnvelopeBytes",
  ]);
  if (typeof input.resolveCurrentCommitter !== "function") {
    throw new TypeError("Current Namespace committer resolver is required");
  }
  const expected = cloneExpectedHead(input.prepared.expectedHead);
  const next = cloneNextHead(input.prepared.nextHead);
  const bindingRecord = namespaceBindingWriteRecordV2({
    signedBindingBytes: input.prepared.signedBindingBytes,
    humanKeyringEnvelopeBytes:
      input.prepared.humanKeyringEnvelopeBytes,
    aiKeyringEnvelopeBytes: input.prepared.aiKeyringEnvelopeBytes,
  });
  assertBindingHeadTransition(expected, next, bindingRecord);

  const binding = parseNamespaceBinding(
    bindingRecord.signedBindingBytes,
  );
  const humanEnvelope = parseNamespaceKeyringEnvelope(
    bindingRecord.humanKeyringEnvelope.ciphertext,
  );
  const aiEnvelope = parseNamespaceKeyringEnvelope(
    bindingRecord.aiKeyringEnvelope.ciphertext,
  );

  let bindingCommitter: NamespaceCommitterContextV2 | null = null;
  let keyringCommitter: NamespaceCommitterContextV2 | null = null;
  let committerDeviceId:
    NamespaceCommitterContextV2["committerDeviceId"] | null = null;
  let committerSigningPublicKey: Uint8Array | null = null;
  const trackedResolver: CurrentCommitterResolverV2 = (context) => {
    const pristine = cloneCommitterContext(context);
    const resolved = input.resolveCurrentCommitter(
      cloneCommitterContext(pristine),
    );
    if (resolved === null) return null;
    if (
      !(resolved instanceof Uint8Array)
      || resolved.length !== SIGNING_PUBLIC_KEY_BYTES
    ) {
      throw new RangeError(
        `Current Namespace committer signing public key must contain exactly ${SIGNING_PUBLIC_KEY_BYTES} bytes`,
      );
    }
    const detachedKey = copyOwnedBytesV2(resolved);
    if (
      committerDeviceId !== null
      && committerDeviceId !== pristine.committerDeviceId
    ) {
      throw new Error(
        "Current Namespace committer authorization contexts differ",
      );
    }
    if (
      committerSigningPublicKey !== null
      && !equalBytes(committerSigningPublicKey, detachedKey)
    ) {
      throw new Error(
        "Current Namespace committer authorization keys differ",
      );
    }
    if (pristine.purpose === "namespace-binding") {
      bindingCommitter = pristine;
    } else {
      keyringCommitter = pristine;
    }
    committerDeviceId ??= pristine.committerDeviceId;
    committerSigningPublicKey ??= detachedKey;
    return detachedKey;
  };
  verifyNamespaceBinding({
    crypto: input.crypto,
    binding,
    resolveHistoricalCommitter: trackedResolver,
  });
  verifyNamespaceKeyringEnvelope({
    crypto: input.crypto,
    envelope: humanEnvelope,
    resolveHistoricalCommitter: trackedResolver,
  });
  verifyNamespaceKeyringEnvelope({
    crypto: input.crypto,
    envelope: aiEnvelope,
    resolveHistoricalCommitter: trackedResolver,
  });
  if (
    bindingCommitter === null
    || keyringCommitter === null
    || committerSigningPublicKey === null
  ) {
    throw new Error(
      "Current Namespace committer authorization evidence is incomplete",
    );
  }
  const authorization: NamespaceBindingCasAuthorizationV2 = Object.freeze({
    bindingCommitter: cloneCommitterContext(bindingCommitter),
    keyringCommitter: cloneCommitterContext(keyringCommitter),
    committerSigningPublicKeyHash:
      input.crypto.hash(committerSigningPublicKey),
  });
  const authorized = authorizeNamespaceBindingWriteV2({
    expected,
    binding: bindingRecord,
    next,
    authorization,
  });
  let status: NamespaceBindingHeadCasStatusV2;
  try {
    status = await input.storage.compareAndSwapNamespaceBindingAndHead(
      authorized,
    );
  } catch (cause) {
    throw new NamespaceBindingPersistenceOutcomeUnknownV2(cause);
  }
  if (
    status !== "applied"
    && status !== "duplicate"
    && status !== "stale"
  ) {
    throw new TypeError(
      "Namespace binding storage returned an invalid CAS status",
    );
  }
  return status;
}
