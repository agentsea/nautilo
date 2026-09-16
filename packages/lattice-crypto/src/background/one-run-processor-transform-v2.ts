import {ProcessorOutputRepairIntegrityErrorV2, copyOutputRepairBindingV2, outputRepairFingerprintV2, stenographerOrdinaryOutputFingerprint, type ProcessorOutputRepairBindingV2} from "./output-repair-v2.ts";
import {ProcessorReconciliationIntegrityErrorV2, copyPublicationReconciliationBindingV2, publicationReconciliationFingerprintV2, type ProcessorPublicationReconciliationBindingV2} from "./publication-reconciliation-v2.ts";
import type { LatticeCrypto } from "../crypto/index.ts";
import { createCurrentProcessorObjectAccessManifestV5 } from "../format/object-access-manifest-v5.ts";
import {
  decodeEncryptedPayloadV2, decodeNamespaceObjectEnvelopeV2,
  encodeEncryptedPayloadV2, encodeNamespaceObjectEnvelopeV2,
} from "../format/object-v2.ts";
import { decryptObjectThroughNamespaceV2, wrapObjectDekForNamespaceV2 } from "../object/namespace-envelope.ts";
import { encryptObjectPayloadV2 } from "../object/payload.ts";
import { accessRevision, authorizationRevision, namespaceId, namespaceGeneration, objectId, unixTimestamp } from "../v2-types/ids.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import {
  verifyBackgroundAuthorizationResponseV2, withOpenedBackgroundAuthorizationV2,
  type ResolveCurrentBackgroundAuthorizationIssuerV2, type VerifiedBackgroundAuthorizationV2,
} from "./processor-authorization-v2.ts";
import { decodeBackgroundProcessorWorkDescriptorV2, type BackgroundNamespaceAuthorityV2 } from "./work-descriptor-v2.ts";
import type {
  OneRunProcessorTransformResultV1, ProcessorCredentialClaimPortV1,
  ProcessorTransformCapabilityV1, ProcessorTransformInputV1,
  ProcessorTransformObjectPortV1, ProcessorTransformOutputV1,
  ProcessorTransformRecipientAttemptV1,
} from "./one-run-processor-transform-v1.ts";

export interface ProcessorTransformObjectPortV2 {
  readonly openInput: ProcessorTransformObjectPortV1["openInput"];
  /** Read the exact actually committed prefix through the existing authenticated storage reader. */
  readonly openPublishedOutput: ProcessorTransformObjectPortV1["openInput"];
  readonly publishOutputs: ProcessorTransformObjectPortV1["publishOutputs"];
  /**
   * Implemented by the current Domain Namespace bundle owner. Verify the exact
   * current signed bundle/retained set and lend only the requested generation
   * at its retained access revision. Both keys are borrowed for this call;
   * neither may be persisted or exposed to the model callback.
   */
  readonly withNamespaceKey: <Value>(input: Readonly<{
    domainKey: Uint8Array;
    authority: BackgroundNamespaceAuthorityV2;
    keyClass: "ai";
    generation: number;
    accessRevision: number;
    signal: AbortSignal;
  }>, use: (namespaceKey: Uint8Array) => Value | Promise<Value>) => Promise<Value>;
}

export interface ProcessorTransformRunContextV2 {
  readonly requestId: string;
  readonly recipientGeneration: number;
  readonly recipientKeyId: string;
  readonly claimId: string;
  readonly responseBytes: Uint8Array;
  readonly resolveCurrentIssuer: ResolveCurrentBackgroundAuthorizationIssuerV2;
  readonly claims: ProcessorCredentialClaimPortV1;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Absolute caller-owned lease deadline, also bounded by recipient expiry. */
  readonly deadlineAt?: number;
}

export interface ProcessorTransformRunInputV2 extends ProcessorTransformRunContextV2 {
  readonly objects: ProcessorTransformObjectPortV2;
  readonly binding?: never;
  readonly repairBinding?: never;
  readonly execute: (
    capability: ProcessorTransformCapabilityV1, signal: AbortSignal,
  ) => void | PromiseLike<void>;
}

export interface ProcessorReconciliationObjectPortV2 extends Pick<ProcessorTransformObjectPortV2, "openInput" | "withNamespaceKey"> {
  /** Atomically authorize and attach the original receipt, borrowing verified outputs only until return. */
  readonly attach: (input: Readonly<{
    outputs: readonly ProcessorTransformInputV1[];
    claimId: string;
    authorizeCommit: () => Promise<number>;
    signal: AbortSignal;
  }>) => Promise<void>;
}

export interface ProcessorReconciliationRunInputV2 extends ProcessorTransformRunContextV2 {
  readonly execute?: never;
  readonly repairBinding?: never;
  readonly binding: ProcessorPublicationReconciliationBindingV2;
  readonly objects: ProcessorReconciliationObjectPortV2;
}

export interface ProcessorOutputRepairOrdinaryOutputV2 {
  /** Historical ordinary receipt coordinate; distinct from signed crypto payload creation time. */
  readonly fingerprintCreatedAt: number;
  readonly logicalId: string;
  readonly objectId: string;
  readonly plaintext: Uint8Array;
}

export interface ProcessorOutputRepairObjectPortV2 extends ProcessorTransformObjectPortV2 {
  /** Called once after the durable grant claim. The gate wipes every lent byte buffer. */
  readonly withOrdinaryOutputs: (
    input: Readonly<{signal: AbortSignal}>,
    use: (outputs: readonly ProcessorOutputRepairOrdinaryOutputV2[]) => Promise<void>,
  ) => Promise<void>;
  readonly attach: ProcessorReconciliationObjectPortV2["attach"];
}

export interface ProcessorOutputRepairRunInputV2 extends ProcessorTransformRunContextV2 {
  readonly execute?: never;
  readonly binding?: never;
  readonly repairBinding: ProcessorOutputRepairBindingV2;
  readonly objects: ProcessorOutputRepairObjectPortV2;
}

function same(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** Abort releases the gate promptly; late completions remain observed. */
function race<Value>(work: Promise<Value>, signal: AbortSignal): Promise<Value> {
  const reason = () => signal.reason instanceof Error ? signal.reason : new Error("Current processor aborted");
  if (signal.aborted) {
    void work.catch(() => {});
    return Promise.reject(reason());
  }
  return new Promise<Value>((resolve, reject) => {
    const abort = () => reject(reason());
    signal.addEventListener("abort", abort, {once: true});
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function wipeBytesDeep(value: unknown): void {
  if (value instanceof Uint8Array) value.fill(0);
  else if (value !== null && typeof value === "object") Object.values(value).forEach(wipeBytesDeep);
}

type OwnedRun = (ProcessorTransformRunInputV2 | ProcessorReconciliationRunInputV2 | ProcessorOutputRepairRunInputV2) & Readonly<{
  crypto: LatticeCrypto;
  recipientPrivateKey: Uint8Array;
  now: () => number;
  signal: AbortSignal;
  expectedAttempt: ProcessorTransformRecipientAttemptV1;
  abort: (reason: Error) => void;
}>;

/** Internal registry entry: callers use runCurrent, never obtain recipient keys. */
export async function executeOneRunProcessorTransformInternalV2(
  input: OwnedRun,
): Promise<OneRunProcessorTransformResultV1> {
  if (input.binding !== undefined) input = {...input, binding: copyPublicationReconciliationBindingV2(input.binding)};
  if (input.repairBinding !== undefined) input = {...input, repairBinding: copyOutputRepairBindingV2(input.repairBinding)};
  const responseBytes = copyOwnedBytesV2(input.responseBytes);
  let issuerPublicKey: Uint8Array | undefined;
  const publicKeys = new Set<Uint8Array>();
  const authorizations = new Set<VerifiedBackgroundAuthorizationV2>();
  let finished = false;
  try {
  const resolveCurrentIssuer: ResolveCurrentBackgroundAuthorizationIssuerV2 = async (context) => {
    input.signal.throwIfAborted();
    const key = await race(Promise.resolve().then(() => input.resolveCurrentIssuer(context)), input.signal);
    input.signal.throwIfAborted();
    issuerPublicKey = key === null ? undefined : copyOwnedBytesV2(key);
    if (issuerPublicKey !== undefined) publicKeys.add(issuerPublicKey);
    return issuerPublicKey ?? null;
  };
  const verify = async () => {
    input.signal.throwIfAborted();
    const verified = await race(verifyBackgroundAuthorizationResponseV2(input.crypto, {
      responseBytes, now: input.now(), resolveCurrentIssuer,
    }).then((result) => {
      if (finished || input.signal.aborted) wipeBytesDeep(result);
      else authorizations.add(result);
      return result;
    }), input.signal);
    input.signal.throwIfAborted();
    const now = input.now();
    if (now < verified.descriptor.notBefore || now >= verified.descriptor.expiresAt) {
      throw new Error("Current processor authorization expired");
    }
    return {...verified, descriptor: decodeBackgroundProcessorWorkDescriptorV2(verified.descriptorBytes)};
  };
  const verified = await verify();
  const descriptor = verified.descriptor;
  const reconciliation = input.binding !== undefined ? input as ProcessorReconciliationRunInputV2 : null;
  const repair = input.repairBinding !== undefined ? input as ProcessorOutputRepairRunInputV2 : null;
  if ((descriptor.workKind === "stenographer.publication_reconcile") !== (reconciliation !== null)
    || (descriptor.workKind === "stenographer.output_repair") !== (repair !== null)
    || ((reconciliation !== null || repair !== null) && "execute" in input)) {
    throw new Error("Reconciliation and model execution require separate gates");
  }
  if (reconciliation !== null) {
    const fingerprint = publicationReconciliationFingerprintV2(input.crypto, reconciliation.binding);
    try {
      if (!same(fingerprint, descriptor.source.fingerprint)
        || reconciliation.binding.outputs.length !== descriptor.inputBindings.map(slot => slot.objectId).length
        || reconciliation.binding.outputs.some((output, index) => output.objectId !== descriptor.inputBindings.map(slot => slot.objectId)[index])) {
        throw new Error("Reconciliation receipt differs from its signed authority");
      }
    } finally {fingerprint.fill(0);}
  }
  if (repair !== null) {
    const fingerprint = outputRepairFingerprintV2(input.crypto, repair.repairBinding);
    const {receipt, outputs} = repair.repairBinding;
    const existing = outputs.filter(output => output.disposition === "existing");
    const missing = outputs.filter(output => output.disposition === "create");
    try {
      if (!same(fingerprint, descriptor.source.fingerprint)
        || receipt.roomId !== descriptor.authority.roomId || receipt.namespaceId !== descriptor.authority.namespaceId
        || receipt.rebuildGeneration !== descriptor.source.rebuildGeneration
        || existing.length !== descriptor.inputBindings.map(slot => slot.objectId).length || missing.length !== descriptor.outputSlots.length
        || existing.some((output, index) => output.objectId !== descriptor.inputBindings.map(slot => slot.objectId)[index])
        || missing.some((output, index) => {
          const slot = descriptor.outputSlots[index]!;
          return output.objectId !== slot.objectId || output.objectType !== slot.objectType || output.createdAt !== slot.createdAt;
        })) throw new Error("Output repair inventory differs from its signed authority");
    } finally {fingerprint.fill(0);}
  }
  const expected = input.expectedAttempt;
  if (descriptor.requestId !== expected.requestId || descriptor.workId !== expected.workId
    || descriptor.authority.namespaceId !== expected.namespaceId
    || descriptor.recipientGeneration !== expected.recipientGeneration
    || descriptor.recipientKeyId !== expected.recipientKeyId
    || descriptor.expiresAt !== expected.expiresAt
    || !same(descriptor.recipientPublicKey, expected.recipientPublicKey)) {
    throw new Error("Current processor authorization does not match its recipient");
  }
  // This durable CAS must precede opening the sealed Domain key or any body.
  const credentialHash = copyOwnedBytesV2(verified.credentialHash);
  const workDescriptorHash = copyOwnedBytesV2(verified.descriptorHash);
  let claim: "claimed" | "already_claimed";
  try {
    claim = await race(input.claims.claimExactCredential(Object.freeze({
      credentialId: verified.credentialId, credentialHash, workDescriptorHash,
      requestId: descriptor.requestId, claimId: input.claimId,
      recipientGeneration: descriptor.recipientGeneration,
      idempotencyId: descriptor.idempotencyId, claimedAt: input.now(), signal: input.signal,
    })), input.signal);
  } finally {
    credentialHash.fill(0); workDescriptorHash.fill(0);
  }
  input.signal.throwIfAborted();
  if (claim === "already_claimed") return Object.freeze({status: "unavailable", reason: "credential_replayed"});
  if (claim !== "claimed") throw new TypeError("Invalid current processor claim result");

  return await race(withOpenedBackgroundAuthorizationV2(input.crypto, {
    responseBytes, recipientPrivateKey: input.recipientPrivateKey, now: input.now,
    resolveCurrentIssuer, signal: input.signal,
    use: async ({verified: openedAuthorization, domainKey, signerPrivateKey}) => {
      authorizations.add(openedAuthorization);
      let active = true;
      let inputPhase: "idle" | "opening" | "opened" = "idle";
      let outputPhase: "idle" | "publishing" | "published" = "idle";
      let publishedBorrowed = false;
      const committedOutputs: Readonly<{objectId: string; payloadHash: Uint8Array; envelopeHash: Uint8Array;
        plaintextHash: Uint8Array; plaintextLength: number}>[] = [];
      let plaintextBytes = 0;
      let ciphertextBytes = 0;
      const secrets = new Set<Uint8Array>();
      const operations = new Set<Promise<unknown>>();
      const errors: unknown[] = [];
      const wipe = () => {
        active = false;
        for (const bytes of secrets) bytes.fill(0);
      };
      const assertActive = () => {
        input.signal.throwIfAborted();
        if (!active || input.now() >= descriptor.expiresAt) throw new Error("Current processor capability is unavailable");
      };
      const check = async () => {
        assertActive();
        const fresh = await verify();
        try {
          assertActive();
          return input.now();
        } finally {
          authorizations.delete(fresh);
          wipeBytesDeep(fresh);
        }
      };
      const budget = (plain: number, cipher: number) => {
        if (plain < 0 || cipher < 0
          || plaintextBytes + plain > descriptor.maximumPlaintextBytes
          || ciphertextBytes + cipher > descriptor.maximumCiphertextBytes) {
          throw new RangeError("Current processor byte budget exceeded");
        }
        plaintextBytes += plain;
        ciphertextBytes += cipher;
      };
      const withKey = async <Value>(generation: number, revision: number,
        use: (key: Uint8Array) => Value): Promise<Value> => {
        await check();
        if (generation > descriptor.authority.namespaceKeyGeneration
          || revision > descriptor.authority.namespaceAccessRevision) {
          throw new Error("Current processor Namespace generation is outside authority");
        }
        let invoked = false;
        let completed = false;
        let failure: Error | undefined;
        let result: Value | undefined;
        await race(input.objects.withNamespaceKey({
          domainKey, authority: decodeBackgroundProcessorWorkDescriptorV2(verified.descriptorBytes).authority,
          keyClass: "ai", generation,
          accessRevision: revision, signal: input.signal,
        }, async (borrowed) => {
          assertActive();
          if (invoked) {
            failure = new Error("Namespace key callback must be called exactly once");
            throw failure;
          }
          invoked = true;
          const key = copyOwnedBytesV2(borrowed);
          secrets.add(key);
          try {
            await check();
            result = use(key);
            completed = true;
            return result;
          } catch (error) {
            failure = error instanceof Error ? error : new Error("Namespace key use failed");
            throw failure;
          } finally {
            key.fill(0); secrets.delete(key);
          }
        }), input.signal);
        await check();
        if (failure !== undefined) throw failure;
        if (!completed) throw new Error("Namespace key callback did not complete");
        return result as Value;
      };
      const storedIntegrityError = (message: string): Error => repair === null ? new Error(message) : new ProcessorOutputRepairIntegrityErrorV2(message);
      const openInputs = async (): Promise<readonly ProcessorTransformInputV1[]> => {
        assertActive();
        if (inputPhase !== "idle") throw new Error("Current processor inputs are already opened");
        inputPhase = "opening";
        const opened: ProcessorTransformInputV1[] = [];
        for (const id of descriptor.inputBindings.map(slot => slot.objectId)) {
          await check();
          const loaded = await race(input.objects.openInput({objectId: id, signal: input.signal}), input.signal);
          await check();
          // Canonical snapshots stop adapter-owned buffers changing over awaits.
          const payloadBytes = encodeEncryptedPayloadV2(loaded.payload);
          const envelopeBytes = encodeNamespaceObjectEnvelopeV2(loaded.envelope);
          budget(0, payloadBytes.length + envelopeBytes.length);
          if (reconciliation !== null) {
            const expected = reconciliation.binding.outputs[opened.length]!;
            const payloadHash = input.crypto.hash(payloadBytes);
            const envelopeHash = input.crypto.hash(envelopeBytes);
            try {
              if (!same(payloadHash, expected.payloadHash) || !same(envelopeHash, expected.envelopeHash)
                || loaded.payload.context.objectType !== expected.objectType
                || loaded.payload.context.createdAt !== expected.createdAt) {
                throw new ProcessorReconciliationIntegrityErrorV2("Reconciliation stored output differs from its signed receipt binding");
              }
            } finally {payloadHash.fill(0); envelopeHash.fill(0);}
          }
          const payload = decodeEncryptedPayloadV2(payloadBytes);
          const envelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
          if (payload.context.objectId !== id || payload.context.keyClass !== "ai"
            || envelope.context.objectId !== id || envelope.context.keyClass !== "ai"
            || envelope.context.namespaceId !== descriptor.authority.namespaceId) {
            throw new Error("Current processor input does not match its descriptor");
          }
          if (repair !== null) {
            const expected = repair.repairBinding.outputs.find(output => output.objectId === id)!;
            if (payload.context.objectType !== expected.objectType || payload.context.createdAt !== expected.createdAt) {
              throw storedIntegrityError("Output repair existing payload metadata differs from its receipt");
            }
          }
          const expectedPlaintext = payload.ciphertext.length - 40;
          if (expectedPlaintext < 0 || expectedPlaintext > descriptor.maximumPlaintextBytes - plaintextBytes) {
            throw new RangeError("Current processor input exceeds remaining plaintext budget");
          }
          const plaintext = await withKey(envelope.context.keyGeneration,
            envelope.context.bindingRevisionAtWrap, (key) => {
              const value = decryptObjectThroughNamespaceV2(input.crypto, key, envelope, payload);
              if (value === null) throw reconciliation === null ? storedIntegrityError("Current processor input ciphertext failed to open")
                : new ProcessorReconciliationIntegrityErrorV2("Reconciliation output ciphertext failed to open");
              secrets.add(value);
              return value;
            });
          budget(plaintext.length, 0);
          opened.push(Object.freeze({objectId: id, plaintext}));
        }
        inputPhase = "opened";
        return Object.freeze(opened);
      };
      const hashMatches = (bytes: Uint8Array, expected: Uint8Array): boolean => {
        const digest = input.crypto.hash(bytes);
        try {return same(digest, expected);} finally {digest.fill(0);}
      };
      // Reopening is a proof of already budgeted outputs, never expanded model input authority.
      const reopenPublished = async (): Promise<readonly ProcessorTransformInputV1[]> => {
        const opened: ProcessorTransformInputV1[] = [];
        try {
          for (const expected of committedOutputs) {
            await check();
            if (!("openPublishedOutput" in input.objects)) throw new Error("Reconciliation cannot reopen new publications");
            const loaded = await race(input.objects.openPublishedOutput({objectId: expected.objectId, signal: input.signal}), input.signal);
            assertActive();
            if (!(loaded.payload.ciphertext instanceof Uint8Array)
              || loaded.payload.ciphertext.length - 40 !== expected.plaintextLength) {
              throw storedIntegrityError("Current processor persisted output exceeds its exact plaintext length");
            }
            const buffers: Uint8Array[] = [];
            const snapshots: object[] = [];
            const retain = (bytes: Uint8Array) => {buffers.push(bytes); secrets.add(bytes); return bytes;};
            try {
              const payloadBytes = retain(encodeEncryptedPayloadV2(loaded.payload));
              const envelopeBytes = retain(encodeNamespaceObjectEnvelopeV2(loaded.envelope));
              if (!hashMatches(payloadBytes, expected.payloadHash)
                || !hashMatches(envelopeBytes, expected.envelopeHash)) {
                throw storedIntegrityError("Current processor persisted output differs from its committed bytes");
              }
              const payload = decodeEncryptedPayloadV2(payloadBytes); snapshots.push(payload);
              const envelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes); snapshots.push(envelope);
              // These are exact committed bytes; retain the explicit scope fence as well.
              if (payload.context.objectId !== expected.objectId || payload.context.keyClass !== "ai"
                || envelope.context.objectId !== expected.objectId || envelope.context.keyClass !== "ai"
                || envelope.context.namespaceId !== descriptor.authority.namespaceId
                || payload.ciphertext.length - 40 !== expected.plaintextLength) {
                throw storedIntegrityError("Current processor persisted output is outside its publication scope");
              }
              const plaintext = await withKey(envelope.context.keyGeneration, envelope.context.bindingRevisionAtWrap, (key) => {
                const value = decryptObjectThroughNamespaceV2(input.crypto, key, envelope, payload);
                if (value === null) throw storedIntegrityError("Current processor persisted output failed to reopen");
                secrets.add(value);
                if (value.length !== expected.plaintextLength || !hashMatches(value, expected.plaintextHash)) {
                  value.fill(0); secrets.delete(value);
                  throw storedIntegrityError("Current processor persisted plaintext differs from its published plaintext");
                }
                return value;
              });
              opened.push(Object.freeze({objectId: expected.objectId, plaintext}));
            } finally {
              snapshots.forEach(wipeBytesDeep);
              buffers.forEach((bytes) => {bytes.fill(0); secrets.delete(bytes);});
            }
          }
          await check();
          return Object.freeze(opened);
        } catch (error) {
          opened.forEach(({plaintext}) => {plaintext.fill(0); secrets.delete(plaintext);});
          throw error;
        }
      };
      const wipeOpened = (opened: readonly ProcessorTransformInputV1[]) => {
        opened.forEach(({plaintext}) => {plaintext.fill(0); secrets.delete(plaintext);});
      };
      const withPublishedOutputs = async <Value>(
        use: (outputs: readonly ProcessorTransformInputV1[]) => Value | Promise<Value>,
      ): Promise<Value> => {
        assertActive();
        if (outputPhase !== "published" || publishedBorrowed) throw new Error("Current processor published outputs are unavailable or already borrowed");
        if (typeof use !== "function") throw new TypeError("Current processor published output callback is required");
        publishedBorrowed = true;
        const opened = await reopenPublished();
        try {
          await check();
          const value = await race(Promise.resolve().then(() => {assertActive(); return use(opened);}), input.signal);
          await check();
          return value;
        } finally {wipeOpened(opened);}
      };
      const publishOutputs = async (outputs: readonly ProcessorTransformOutputV1[]): Promise<void> => {
        // Ownership transfers even when the supplied output shape is rejected.
        const transferred = Array.isArray(outputs as unknown) ? outputs.flatMap((output) =>
          output?.plaintext instanceof Uint8Array ? [output.plaintext] : []) : [];
        transferred.forEach((bytes) => secrets.add(bytes));
        const preparedBytes: Uint8Array[] = [];
        const plaintextSnapshots: Uint8Array[] = [];
        const ownPrepared = (bytes: Uint8Array) => {
          preparedBytes.push(bytes); secrets.add(bytes); return bytes;
        };
        try {
          assertActive();
          if (inputPhase !== "opened" || outputPhase !== "idle") throw new Error("Current processor output phase is invalid");
          outputPhase = "publishing";
          if (!Array.isArray(outputs as unknown) || outputs.length > descriptor.outputSlots.length
            || outputs.some((output, index) => output.objectId !== descriptor.outputSlots[index]!.objectId
              || !(output.plaintext instanceof Uint8Array))) {
            throw new Error("Current processor outputs must be a canonical authorized prefix");
          }
          // Snapshot plaintext and IDs before the first asynchronous boundary.
          const ownedOutputs = outputs.map((output) => {
            const plaintext = copyOwnedBytesV2(output.plaintext);
            secrets.add(plaintext);
            plaintextSnapshots.push(plaintext);
            budget(plaintext.length, 0);
            return {objectId: output.objectId, plaintext};
          });
          const prepared: Parameters<ProcessorTransformObjectPortV1["publishOutputs"]>[0]["outputs"][number][] = [];
          for (const [index, output] of ownedOutputs.entries()) {
            const metadata = descriptor.outputSlots[index]!;
            const current = descriptor.authority;
            const encoded = await withKey(current.namespaceKeyGeneration, current.namespaceAccessRevision, (key) => {
              const encrypted = encryptObjectPayloadV2(input.crypto, {
                objectId: objectId(output.objectId), keyClass: "ai", objectType: metadata.objectType,
                createdAt: unixTimestamp(metadata.createdAt),
              }, output.plaintext);
              try {
                const payloadBytes = ownPrepared(encodeEncryptedPayloadV2(encrypted.payload));
                const envelopeBytes = ownPrepared(encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespaceV2(input.crypto, key, {
                  objectId: objectId(output.objectId), namespaceId: namespaceId(current.namespaceId), keyClass: "ai",
                  keyGeneration: namespaceGeneration(current.namespaceKeyGeneration),
                  bindingRevisionAtWrap: accessRevision(current.namespaceAccessRevision),
                }, encrypted.dek)));
                return {payloadBytes, envelopeBytes};
              } finally {
                encrypted.dek.fill(0);
              }
            });
            await check();
            const manifestInput = {signerPrivateKey, signerAuthorizationBytes: verified.signerAuthorizationBytes,
              issuerSigningPublicKey: issuerPublicKey!, now: input.now()};
            const manifest = createCurrentProcessorObjectAccessManifestV5(input.crypto, {
              objectId: objectId(output.objectId), payloadHash: input.crypto.hash(encoded.payloadBytes),
              accessRevision: accessRevision(0), previousManifestHash: null,
              envelopeHashes: [input.crypto.hash(encoded.envelopeBytes)], signer: verified.signer,
              signerAuthorizationHash: verified.signerAuthorizationHash,
              hostAuthorizationRevision: authorizationRevision(verified.issuer.securityRevision),
            }, manifestInput);
            ownPrepared(manifest.bytes);
            const tombstone = createCurrentProcessorObjectAccessManifestV5(input.crypto, {
              objectId: objectId(output.objectId), payloadHash: manifest.manifest.payloadHash,
              accessRevision: accessRevision(1), previousManifestHash: manifest.hash,
              envelopeHashes: [], signer: verified.signer,
              signerAuthorizationHash: verified.signerAuthorizationHash,
              hostAuthorizationRevision: authorizationRevision(verified.issuer.securityRevision),
            }, manifestInput);
            ownPrepared(tombstone.bytes);
            budget(0, encoded.payloadBytes.length + encoded.envelopeBytes.length + manifest.bytes.length
              + tombstone.bytes.length + verified.signerAuthorizationBytes.length);
            const proof = Object.freeze({objectId: output.objectId,
              payloadHash: input.crypto.hash(encoded.payloadBytes), envelopeHash: input.crypto.hash(encoded.envelopeBytes),
              plaintextHash: input.crypto.hash(output.plaintext), plaintextLength: output.plaintext.length});
            [proof.payloadHash, proof.envelopeHash, proof.plaintextHash].forEach((bytes) => secrets.add(bytes));
            committedOutputs.push(proof);
            prepared.push(Object.freeze({objectId: output.objectId, ...encoded,
              manifestBytes: manifest.bytes, tombstoneManifestBytes: tombstone.bytes,
              signerAuthorizationBytes: ownPrepared(copyOwnedBytesV2(verified.signerAuthorizationBytes))}));
          }
          let commitState: "idle" | "checking" | "checked" = "idle";
          const authorityCheckedAt = await check();
          if (!("publishOutputs" in input.objects)) throw new Error("Reconciliation cannot publish new outputs");
          await race(input.objects.publishOutputs({idempotencyId: descriptor.idempotencyId,
            claimId: input.claimId, authorityCheckedAt, outputs: Object.freeze(prepared), signal: input.signal,
            authorizeCommit: async () => {
              assertActive();
              if (commitState !== "idle") throw new Error("Current processor commit authorization is one-use");
              commitState = "checking";
              const checkedAt = await check();
              commitState = "checked";
              return checkedAt;
            },
          }), input.signal);
          assertActive();
          if ((commitState as string) !== "checked") throw new Error("Current processor publication skipped commit authorization");
          const reopened = await reopenPublished();
          wipeOpened(reopened);
          outputPhase = "published";
        } finally {
          [...transferred, ...plaintextSnapshots, ...preparedBytes].forEach((bytes) => {bytes.fill(0); secrets.delete(bytes);});
        }
      };
      const track = <Value>(work: Promise<Value>): Promise<Value> => {
        const tracked = work.catch((error: unknown) => {
          errors.push(error);
          input.abort(error instanceof Error ? error : new Error("Current processor operation failed"));
          throw error;
        }).finally(() => operations.delete(tracked));
        operations.add(tracked);
        void tracked.catch(() => {});
        return tracked;
      };
      const capability = Object.freeze({
        openInputs: () => track(openInputs()),
        publishOutputs: (outputs: readonly ProcessorTransformOutputV1[]) => track(publishOutputs(outputs)),
        withPublishedOutputs: <Value>(use: (outputs: readonly ProcessorTransformInputV1[]) => Value | Promise<Value>) => track(withPublishedOutputs(use)),
      }) as ProcessorTransformCapabilityV1;
      input.signal.addEventListener("abort", wipe, {once: true});
      try {
        await check();
        if (repair !== null) {
          const ordinary: ProcessorOutputRepairOrdinaryOutputV2[] = [];
          let invoked = false;
          let completed = false;
          let callbackFailure: Error | undefined;
          try {
            await race(repair.objects.withOrdinaryOutputs({signal: input.signal}, (borrowed) => {
              // Take ownership before any check, including a late or duplicate callback.
              const transferred = Array.isArray(borrowed as unknown) ? borrowed.flatMap(output =>
                output?.plaintext instanceof Uint8Array ? [output.plaintext] : []) : [];
              transferred.forEach(bytes => secrets.add(bytes));
              try {
                assertActive();
                if (invoked) throw new Error("Output repair ordinary callback is one-use");
                invoked = true;
                if (!Array.isArray(borrowed as unknown) || borrowed.length !== repair.repairBinding.outputs.length) {
                  throw new Error("Output repair ordinary inventory is incomplete");
                }
                let total = 0;
                for (const [index, output] of borrowed.entries()) {
                  const expected = repair.repairBinding.outputs[index]!;
                  if (output.logicalId !== expected.logicalId || output.objectId !== expected.objectId
                    || !(output.plaintext instanceof Uint8Array)) throw new Error("Output repair ordinary identity changed");
                  if (!Number.isSafeInteger(output.fingerprintCreatedAt) || output.fingerprintCreatedAt < 0) {
                    throw new Error("Output repair ordinary fingerprint timestamp is invalid");
                  }
                  total += output.plaintext.length;
                  if (total > descriptor.maximumPlaintextBytes) throw new RangeError("Output repair plaintext budget exceeded");
                  const plaintext = copyOwnedBytesV2(output.plaintext);
                  secrets.add(plaintext);
                  ordinary.push(Object.freeze({logicalId: output.logicalId, objectId: output.objectId,
                    fingerprintCreatedAt: output.fingerprintCreatedAt, plaintext}));
                }
                const receipt = repair.repairBinding.receipt;
                const fingerprint = stenographerOrdinaryOutputFingerprint({...receipt, receiptId: receipt.id,
                  outputs: ordinary.map((output, index) => ({logicalId: output.logicalId,
                    objectType: repair.repairBinding.outputs[index]!.objectType,
                    createdAt: output.fingerprintCreatedAt, payloadBytes: output.plaintext}))});
                try {
                  if (!same(fingerprint, receipt.ordinaryOutputFingerprint)) throw storedIntegrityError("Output repair ordinary aggregate differs from its receipt");
                } finally {fingerprint.fill(0);}
                // The lender may hold the current Room/claim transaction.
                // Recheck after it returns below, before opening or publishing:
                // a nested authority lookup would wait for our own Room lock.
                completed = true;
                return Promise.resolve();
              } catch (error) {callbackFailure = error instanceof Error ? error : new Error("Output repair ordinary callback failed"); return Promise.reject(callbackFailure);}
              finally {transferred.forEach(bytes => {bytes.fill(0); secrets.delete(bytes);});}
            }), input.signal);
            await check();
            if (callbackFailure !== undefined) throw callbackFailure;
            if (!completed) throw new Error("Output repair ordinary callback did not complete");
            const existing = await openInputs();
            for (const output of existing) {
              const expected = ordinary.find(value => value.objectId === output.objectId)!;
              if (!same(output.plaintext, expected.plaintext)) throw storedIntegrityError("Output repair existing plaintext parity failed");
            }
            // Existing plaintext is counted once by openInputs; missing plaintext once by publishOutputs.
            await publishOutputs(ordinary.filter((_output, index) => repair.repairBinding.outputs[index]!.disposition === "create"));
            await withPublishedOutputs(async published => {
              const complete = Object.freeze(repair.repairBinding.outputs.map(output => {
                const verified = [...existing, ...published].find(value => value.objectId === output.objectId);
                if (verified === undefined) throw new Error("Output repair verified inventory is incomplete");
                return verified;
              }));
              let commitState: "idle" | "checking" | "checked" = "idle";
              await check();
              await race(repair.objects.attach({outputs: complete, claimId: input.claimId, signal: input.signal,
                authorizeCommit: async () => {
                  if (commitState !== "idle") throw new Error("Output repair attachment authorization is one-use");
                  commitState = "checking";
                  const at = await check();
                  commitState = "checked";
                  return at;
                },
              }), input.signal);
              assertActive();
              if ((commitState as string) !== "checked") throw new Error("Output repair skipped attachment authorization");
            });
            return Object.freeze({status: "executed" as const});
          } finally {ordinary.forEach(({plaintext}) => {plaintext.fill(0); secrets.delete(plaintext);});}
        }
        if (reconciliation !== null) {
          const opened = await openInputs();
          let commitState: "idle" | "checking" | "checked" = "idle";
          try {
            await check();
            await race(reconciliation.objects.attach({outputs: opened, claimId: input.claimId, signal: input.signal,
              authorizeCommit: async () => {
                if (commitState !== "idle") throw new Error("Reconciliation attachment authorization is one-use");
                commitState = "checking";
                const at = await check();
                commitState = "checked";
                return at;
              },
            }), input.signal);
            assertActive();
            if ((commitState as string) !== "checked") throw new Error("Reconciliation skipped attachment authorization");
            return Object.freeze({status: "executed" as const});
          } finally {wipeOpened(opened);}
        }
        if (typeof input.execute !== "function") throw new Error("Current processor execution callback is unavailable");
        const execute = input.execute;
        await race(Promise.resolve().then(() => execute(capability, input.signal)), input.signal);
        while (operations.size > 0) await race(Promise.allSettled([...operations]), input.signal);
        assertActive();
        if (errors.length > 0) throw errors[0];
        if ((inputPhase as string) !== "opened" || (outputPhase as string) !== "published") {
          throw new Error("Current processor must open its inputs and publish its outputs");
        }
        return Object.freeze({status: "executed" as const});
      } catch (error) {
        input.abort(error instanceof Error ? error : new Error("Current processor execution failed"));
        throw error;
      } finally {
        input.signal.removeEventListener("abort", wipe);
        wipe();
      }
    },
  }), input.signal);
  } finally {
    finished = true;
    if (input.binding !== undefined) wipeBytesDeep(input.binding);
    if (input.repairBinding !== undefined) wipeBytesDeep(input.repairBinding);
    responseBytes.fill(0);
    publicKeys.forEach((key) => key.fill(0));
    authorizations.forEach(wipeBytesDeep);
  }
}
