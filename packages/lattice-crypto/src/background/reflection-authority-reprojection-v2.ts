import {V2_LIMITS} from "../v2-types/limits.ts";
import {compareUnsignedUtf8} from "../domain/participants.ts";
import type {LatticeCrypto} from "../crypto/index.ts";
import {createCurrentProcessorObjectAccessManifestV5} from "../format/object-access-manifest-v5.ts";
import {decodeEncryptedPayloadV2, decodeNamespaceObjectEnvelopeV2, encodeEncryptedPayloadV2, encodeNamespaceObjectEnvelopeV2} from "../format/object-v2.ts";
import {concatV2, encodeU64, frame, frameText} from "../format/v2-primitives.ts";
import {decryptObjectThroughNamespaceV2, wrapObjectDekForNamespaceV2} from "../object/namespace-envelope.ts";
import {encryptObjectPayloadV2} from "../object/payload.ts";
import {accessRevision, assertPortableId, assertU64Counter, authorizationRevision, namespaceGeneration, namespaceId, objectId, unixTimestamp} from "../v2-types/ids.ts";
import {copyOwnedBytesV2} from "../v2-types/opaque.ts";
import type {OneRunProcessorTransformResultV1, ProcessorTransformObjectPortV1, ProcessorTransformRecipientAttemptV1} from "./one-run-processor-transform-v1.ts";
import type {ProcessorTransformObjectPortV2, ProcessorTransformRunContextV2} from "./one-run-processor-transform-v2.ts";
import {verifyBackgroundAuthorizationResponseV2, withOpenedReflectionBackgroundAuthorizationV2, type ResolveCurrentBackgroundAuthorizationIssuerV2, type VerifiedBackgroundAuthorizationV2} from "./processor-authorization-v2.ts";
import {decodeAnyBackgroundProcessorWorkDescriptorV2, REFLECTION_BACKGROUND_MAX_PLAINTEXT_BYTES_V2, REFLECTION_SEMANTIC_MAX_INPUT_PLAINTEXT_BYTES_V2, REFLECTION_SEMANTIC_MAX_OUTPUT_PLAINTEXT_BYTES_V2, type BackgroundReflectionSemanticInputBindingV2, type BackgroundNamespaceAuthorityV2} from "./work-descriptor-v2.ts";

/** Retained public publication evidence. attachmentPlanHash commits the exact product attachment plan. */
export interface ReflectionAuthorityReconciliationBindingV2 {
  readonly publicationId: string;
  readonly recordRef: string;
  readonly sourceChangeGeneration: number;
  readonly expectedProjectionGeneration: number;
  readonly previousRepresentationGeneration: number;
  readonly representationGeneration: number;
  readonly previousObjectId: string;
  readonly attachmentPlanHash: Uint8Array;
  readonly objectId: string;
  readonly objectType: "nautilo.reflection.record.v1";
  readonly createdAt: number;
  readonly payloadHash: Uint8Array;
  readonly namespaceEnvelopes: readonly Readonly<{namespaceId: string; envelopeHash: Uint8Array}>[];
}

/** New semantic publication, authenticated by its original operation and replay receipt. */
export interface ReflectionSemanticReconciliationBindingV2 extends Pick<ReflectionAuthorityReconciliationBindingV2,
  "publicationId" | "recordRef" | "representationGeneration" | "attachmentPlanHash" | "objectId" | "objectType" | "createdAt" | "payloadHash" | "namespaceEnvelopes"> {
  readonly kind: "semantic";
  readonly sourceRecordRef: string;
  readonly claimGeneration: number;
}
export type ReflectionPublicationReconciliationBindingV2 = ReflectionAuthorityReconciliationBindingV2 | ReflectionSemanticReconciliationBindingV2;

/** Only the Lattice storage adapter receives borrowed plaintext; never Runtime or a processor family. */
export interface ReflectionAuthorityObjectPortV2 {
  /** Uses the existing authenticated reader, including current manifest and historical signer authorization. */
  readonly openObject: (input: Readonly<{objectId: string; namespaceId: string; signal: AbortSignal}>) => ReturnType<ProcessorTransformObjectPortV1["openInput"]>;
  readonly withNamespaceKey: ProcessorTransformObjectPortV2["withNamespaceKey"];
  /** Decode the canonical Record payload and verify its exact logical Record identity. */
  readonly validateRecordPayload: (input: Readonly<{recordRef: string; plaintext: Uint8Array; signal: AbortSignal}>) => Promise<void>;
  readonly publishOutput: (input: Readonly<{
    objectId: string; payloadBytes: Uint8Array;
    namespaceEnvelopes: readonly Readonly<{namespaceId: string; envelopeBytes: Uint8Array}>[];
    manifestBytes: Uint8Array; tombstoneManifestBytes: Uint8Array; signerAuthorizationBytes: Uint8Array;
    idempotencyId: string; claimId: string; authorizeCommit: () => Promise<number>; signal: AbortSignal;
  }>) => Promise<void>;
  /** Attach only the reopened, verified Record under the owner's current product transaction. */
  readonly attach: (input: Readonly<{
    recordRef: string; objectId: string; plaintext: Uint8Array; claimId: string;
    authorizeCommit: () => Promise<number>; signal: AbortSignal;
  }>) => Promise<void>;
}

export interface ReflectionAuthorityRunInputV2 extends ProcessorTransformRunContextV2 {
  readonly reflectionObjects: ReflectionAuthorityObjectPortV2;
  readonly reconciliationBinding?: ReflectionPublicationReconciliationBindingV2;
  readonly execute?: never;
  readonly binding?: never;
  readonly repairBinding?: never;
}

export type ReflectionSemanticInputV2 = BackgroundReflectionSemanticInputBindingV2 & Readonly<{plaintext: Uint8Array}>;
export interface ReflectionSemanticOutputV2 {readonly objectId: string; readonly plaintext: Uint8Array}

/** Storage and product validation remain inside the Lattice composition. */
export interface ReflectionSemanticObjectPortV2 extends Pick<ReflectionAuthorityObjectPortV2, "openObject" | "withNamespaceKey" | "publishOutput"> {
  readonly validateInput: (input: ReflectionSemanticInputV2 & Readonly<{signal: AbortSignal}>) => Promise<void>;
  readonly validateOutput: (input: ReflectionSemanticOutputV2 & Readonly<{signal: AbortSignal}>) => Promise<void>;
  /** Null handles read-only search projection and lifecycle/no-change product effects. */
  readonly attach: (input: Readonly<{output: ReflectionSemanticOutputV2 | null; claimId: string; authorizeCommit: () => Promise<number>; signal: AbortSignal}>) => Promise<void>;
}

export interface ReflectionSemanticRunInputV2 extends ProcessorTransformRunContextV2 {
  readonly semanticObjects: ReflectionSemanticObjectPortV2;
  /**
   * One complete exact batch; every lent and returned plaintext buffer is wiped.
   * assertCurrent revalidates the signed grant before later disclosure while
   * this callback is pending, and cannot be used after the callback ends.
   */
  readonly execute: (inputs: readonly ReflectionSemanticInputV2[], signal: AbortSignal, assertCurrent: () => Promise<void>) => Promise<ReflectionSemanticOutputV2 | null>;
  readonly reflectionObjects?: never;
  readonly reconciliationBinding?: never;
  readonly binding?: never;
  readonly repairBinding?: never;
}

function same(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
function wipeDeep(value: unknown): void {
  if (value instanceof Uint8Array) value.fill(0);
  else if (value !== null && typeof value === "object") Object.values(value).forEach(wipeDeep);
}
function race<Value>(work: Promise<Value>, signal: AbortSignal): Promise<Value> {
  const reason = () => signal.reason instanceof Error ? signal.reason : new Error("Reflection authority aborted");
  if (signal.aborted) {void work.catch(() => {}); return Promise.reject(reason());}
  return new Promise((resolve, reject) => {
    const abort = () => reject(reason()); signal.addEventListener("abort", abort, {once: true});
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Commits ciphertext hashes and product revision metadata, never a public plaintext/body digest. */
export function reflectionAuthorityReconciliationFingerprintV2(
  crypto: Pick<LatticeCrypto, "hash">, binding: ReflectionPublicationReconciliationBindingV2,
): Uint8Array {
  const digest = (bytes: Uint8Array) => {
    if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new TypeError("Reflection reconciliation requires exact hashes");
    return frame(bytes);
  };
  if ("kind" in binding) {
    if (binding.kind !== "semantic" || binding.objectType !== "nautilo.reflection.record.v1"
      || binding.representationGeneration !== 1 || binding.namespaceEnvelopes.length < 1
      || binding.namespaceEnvelopes.length > V2_LIMITS.namespaceEnvelopesPerManifest) {
      throw new TypeError("Reflection semantic reconciliation inventory is invalid");
    }
    for (const value of [binding.publicationId, binding.recordRef, binding.sourceRecordRef, binding.objectId]) assertPortableId("Reflection reconciliation ID", value);
    assertU64Counter("Reflection source claim generation", binding.claimGeneration);
    assertU64Counter("Reflection output creation time", binding.createdAt);
    let previous: string | undefined;
    const envelopes = binding.namespaceEnvelopes.flatMap(entry => {
      assertPortableId("Reflection reconciliation Namespace", entry.namespaceId);
      if (previous !== undefined && compareUnsignedUtf8(previous, entry.namespaceId) >= 0) throw new TypeError("Reflection reconciliation Namespaces must be canonical");
      previous = entry.namespaceId; return [frameText(entry.namespaceId), digest(entry.envelopeHash)];
    });
    const bytes = concatV2(frameText("nautilo/reflection/semantic-reconciliation/v2"), frameText(binding.publicationId), frameText(binding.recordRef),
      frameText(binding.sourceRecordRef), encodeU64(binding.claimGeneration), encodeU64(binding.representationGeneration),
      digest(binding.attachmentPlanHash), frameText(binding.objectId), frameText(binding.objectType), encodeU64(binding.createdAt),
      digest(binding.payloadHash), encodeU64(binding.namespaceEnvelopes.length), ...envelopes);
    try {return crypto.hash(bytes);} finally {bytes.fill(0);}
  }
  for (const value of [binding.publicationId, binding.recordRef, binding.previousObjectId, binding.objectId]) assertPortableId("Reflection reconciliation ID", value);
  for (const value of [binding.sourceChangeGeneration, binding.expectedProjectionGeneration, binding.previousRepresentationGeneration, binding.representationGeneration, binding.createdAt]) assertU64Counter("Reflection reconciliation revision", value);
  if (binding.objectType !== "nautilo.reflection.record.v1" || binding.previousObjectId === binding.objectId
    || binding.previousRepresentationGeneration < 1 || binding.representationGeneration !== binding.previousRepresentationGeneration + 1
    || !Array.isArray(binding.namespaceEnvelopes as unknown) || binding.namespaceEnvelopes.length < 1
    || binding.namespaceEnvelopes.length > V2_LIMITS.namespaceEnvelopesPerManifest) throw new TypeError("Reflection reconciliation inventory is invalid");
  let previous: string | undefined;
  const envelopes = binding.namespaceEnvelopes.flatMap(entry => {
    assertPortableId("Reflection reconciliation Namespace", entry.namespaceId);
    if (previous !== undefined && compareUnsignedUtf8(previous, entry.namespaceId) >= 0) throw new TypeError("Reflection reconciliation Namespaces must be canonical");
    previous = entry.namespaceId; return [frameText(entry.namespaceId), digest(entry.envelopeHash)];
  });
  const bytes = concatV2(frameText("nautilo/reflection/authority-reconciliation/v2"), frameText(binding.publicationId), frameText(binding.recordRef),
    encodeU64(binding.sourceChangeGeneration), encodeU64(binding.expectedProjectionGeneration), encodeU64(binding.previousRepresentationGeneration), encodeU64(binding.representationGeneration),
    frameText(binding.previousObjectId), digest(binding.attachmentPlanHash), frameText(binding.objectId), frameText(binding.objectType), encodeU64(binding.createdAt),
    digest(binding.payloadHash), encodeU64(binding.namespaceEnvelopes.length), ...envelopes);
  try {return crypto.hash(bytes);} finally {bytes.fill(0);}
}

function copyBinding(value: ReflectionPublicationReconciliationBindingV2): ReflectionPublicationReconciliationBindingV2 {
  return {...value, attachmentPlanHash: copyOwnedBytesV2(value.attachmentPlanHash), payloadHash: copyOwnedBytesV2(value.payloadHash),
    namespaceEnvelopes: value.namespaceEnvelopes.map(entry => ({namespaceId: entry.namespaceId, envelopeHash: copyOwnedBytesV2(entry.envelopeHash)}))};
}

type OwnedRun = (ReflectionAuthorityRunInputV2 | ReflectionSemanticRunInputV2) & Readonly<{
  crypto: LatticeCrypto; recipientPrivateKey: Uint8Array; now: () => number; signal: AbortSignal;
  expectedAttempt: ProcessorTransformRecipientAttemptV1; abort: (reason: Error) => void;
}>;

/** Internal custody entry. The registry owns recipient consumption, deadline and cancellation. */
export async function executeReflectionAuthorityInternalV2(input: OwnedRun): Promise<OneRunProcessorTransformResultV1> {
  const semanticInput = "semanticObjects" in input ? input as ReflectionSemanticRunInputV2 : undefined;
  const objects = semanticInput?.semanticObjects ?? (input as ReflectionAuthorityRunInputV2).reflectionObjects;
  const responseBytes = copyOwnedBytesV2(input.responseBytes);
  const binding = input.reconciliationBinding === undefined ? undefined : copyBinding(input.reconciliationBinding);
  const owned = new Set<Uint8Array>();
  const authorizations = new Set<VerifiedBackgroundAuthorizationV2>();
  let finished = false;
  let issuerPublicKey: Uint8Array | undefined;
  const retain = (bytes: Uint8Array) => {owned.add(bytes); if (finished || input.signal.aborted) bytes.fill(0); return bytes;};
  const assertActive = () => {input.signal.throwIfAborted(); if (finished) throw new Error("Reflection authority is unavailable");};
  const wipe = () => {for (const bytes of owned) bytes.fill(0);};
  input.signal.addEventListener("abort", wipe, {once: true});
  try {
    const resolveCurrentIssuer: ResolveCurrentBackgroundAuthorizationIssuerV2 = async context => {
      assertActive();
      const key = await race(Promise.resolve().then(() => input.resolveCurrentIssuer(context)), input.signal);
      assertActive(); issuerPublicKey = key === null ? undefined : retain(copyOwnedBytesV2(key)); return issuerPublicKey ?? null;
    };
    const verify = async () => {
      assertActive();
      const verified = await race(verifyBackgroundAuthorizationResponseV2(input.crypto, {responseBytes, now: input.now(), resolveCurrentIssuer}).then(value => {
        if (finished || input.signal.aborted) wipeDeep(value); else authorizations.add(value); return value;
      }), input.signal);
      assertActive();
      if (verified.descriptor.subject.processorKind !== "reflection") throw new Error("Reflection gate requires named Reflection authority");
      if (input.now() < verified.descriptor.notBefore || input.now() >= verified.descriptor.expiresAt) throw new Error("Reflection authority expired");
      return verified;
    };
    const verified = await verify();
    const descriptor = decodeAnyBackgroundProcessorWorkDescriptorV2(verified.descriptorBytes);
    if (!("namespaceRequirements" in descriptor)) throw new Error("Reflection descriptor required");
    const reconcile = descriptor.workKind === "reflection.publication_reconcile";
    const semantic = descriptor.source.kind === "reflection_semantic";
    if (semantic !== (semanticInput !== undefined) || reconcile !== (binding !== undefined)
      || (!semantic && "execute" in input) || "binding" in input || "repairBinding" in input) throw new Error("Reflection authority purposes require separate exact inputs");
    if (!semantic && ((!reconcile && descriptor.inputBindings.length !== 1)
      || new Set(descriptor.inputBindings.map(entry => entry.objectId)).size !== 1)) throw new Error("Reflection maintenance requires exactly one logical Record input");
    if (binding !== undefined) {
      const fingerprint = reflectionAuthorityReconciliationFingerprintV2(input.crypto, binding);
      try {
        if (descriptor.source.kind !== "reflection_publication" || descriptor.source.publicationId !== binding.publicationId
          || descriptor.source.recordRef !== binding.recordRef || descriptor.source.representationGeneration !== binding.representationGeneration
          || !same(fingerprint, descriptor.source.fingerprint) || descriptor.inputBindings.length !== binding.namespaceEnvelopes.length
          || descriptor.inputBindings.some((entry, index) => entry.objectId !== binding.objectId || entry.namespaceId !== binding.namespaceEnvelopes[index]!.namespaceId)) {
          throw new Error("Reflection reconciliation differs from its signed publication binding");
        }
      } finally {fingerprint.fill(0);}
    }
    const expected = input.expectedAttempt;
    if (descriptor.requestId !== expected.requestId || descriptor.workId !== expected.workId || descriptor.anchorNamespaceId !== expected.namespaceId
      || descriptor.recipientGeneration !== expected.recipientGeneration || descriptor.recipientKeyId !== expected.recipientKeyId
      || descriptor.expiresAt !== expected.expiresAt || !same(descriptor.recipientPublicKey, expected.recipientPublicKey)) throw new Error("Reflection authority does not match its recipient");
    const credentialHash = copyOwnedBytesV2(verified.credentialHash), workDescriptorHash = copyOwnedBytesV2(verified.descriptorHash);
    let claim: "claimed" | "already_claimed";
    try {
      claim = await race(input.claims.claimExactCredential({credentialId: verified.credentialId, credentialHash, workDescriptorHash,
        requestId: descriptor.requestId, claimId: input.claimId, recipientGeneration: descriptor.recipientGeneration,
        idempotencyId: descriptor.idempotencyId, claimedAt: input.now(), signal: input.signal}), input.signal);
    } finally {credentialHash.fill(0); workDescriptorHash.fill(0);}
    assertActive();
    if (claim === "already_claimed") return {status: "unavailable", reason: "credential_replayed"};
    if (claim !== "claimed") throw new TypeError("Invalid Reflection claim result");
    return await race(withOpenedReflectionBackgroundAuthorizationV2(input.crypto, {
      responseBytes, recipientPrivateKey: input.recipientPrivateKey, now: input.now, resolveCurrentIssuer, signal: input.signal,
      use: async ({verified: opened, domainKeys, signerPrivateKey}) => {
        authorizations.add(opened);
        const check = async () => {
          const fresh = await verify(); authorizations.delete(fresh); wipeDeep(fresh); assertActive(); return input.now();
        };
        let plaintextBytes = 0, ciphertextBytes = 0;
        const budget = (plain: number, cipher: number) => {
          plaintextBytes += plain; ciphertextBytes += cipher;
          if (plaintextBytes > descriptor.maximumPlaintextBytes || ciphertextBytes > descriptor.maximumCiphertextBytes) throw new RangeError("Reflection maintenance byte budget exceeded");
        };
        const withKey = async <Value>(authority: BackgroundNamespaceAuthorityV2, generation: number, revision: number, use: (key: Uint8Array) => Value): Promise<Value> => {
          await check();
          if (generation > authority.namespaceKeyGeneration || revision > authority.namespaceAccessRevision) throw new Error("Reflection Namespace generation exceeds authority");
          const domainKey = domainKeys.find(entry => entry.domainId === authority.domainId)?.key;
          if (domainKey === undefined) throw new Error("Reflection Domain key is absent");
          let invoked = false, completed = false, closed = false;
          let failure: Error | undefined; let result: Value | undefined;
          // Lenders receive isolated owned snapshots, never authority or root buffers used by another operation.
          const root = retain(copyOwnedBytesV2(domainKey));
          const snapshot = structuredClone(authority);
          try {
            await race(objects.withNamespaceKey({domainKey: root, authority: snapshot, keyClass: "ai", generation, accessRevision: revision, signal: input.signal}, async borrowed => {
              assertActive();
              if (invoked || closed) {failure = new Error("Reflection Namespace key callback is one-use"); throw failure;}
              invoked = true; const key = retain(copyOwnedBytesV2(borrowed));
              try {await check(); result = use(key); completed = true; return result;}
              catch (error) {failure = error instanceof Error ? error : new Error("Reflection Namespace key use failed"); throw failure;}
              finally {key.fill(0); owned.delete(key);}
            }), input.signal);
            await check();
            if (failure !== undefined) throw failure;
            if (!completed) throw new Error("Reflection Namespace key callback did not complete");
            return result as Value;
          } finally {closed = true; root.fill(0); owned.delete(root); wipeDeep(snapshot);}
        };
        const authorityFor = (id: string) => {
          const authority = descriptor.namespaceRequirements.find(entry => entry.authority.namespaceId === id)?.authority;
          if (authority === undefined) throw new Error("Reflection Namespace is outside signed authority"); return authority;
        };
        const hashMatches = (bytes: Uint8Array, digest: Uint8Array) => {
          const hash = input.crypto.hash(bytes); try {return same(hash, digest);} finally {hash.fill(0);}
        };
        type Proof = Pick<ReflectionAuthorityReconciliationBindingV2, "objectId" | "objectType" | "createdAt" | "payloadHash" | "namespaceEnvelopes">;
        const open = async (id: string, ns: string, proof?: Proof, countPayload = true, countEnvelope = countPayload, expectedType = "nautilo.reflection.record.v1"): Promise<Uint8Array> => {
          await check();
          const loaded = await race(objects.openObject({objectId: id, namespaceId: ns, signal: input.signal}), input.signal);
          assertActive();
          const payloadBytes = retain(encodeEncryptedPayloadV2(loaded.payload)), envelopeBytes = retain(encodeNamespaceObjectEnvelopeV2(loaded.envelope));
          const payload = decodeEncryptedPayloadV2(payloadBytes), envelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
          try {
            if (payload.context.objectId !== id || payload.context.objectType !== expectedType || payload.context.keyClass !== "ai"
              || envelope.context.objectId !== id || envelope.context.namespaceId !== ns || envelope.context.keyClass !== "ai") throw new Error("Reflection input is outside its exact Record binding");
            // Same bound as the canonical Record payload codec (256 KiB), independent of primitive framing.
            const length = payload.ciphertext.length - 40;
            if (length < 0 || length > (semantic ? REFLECTION_SEMANTIC_MAX_INPUT_PLAINTEXT_BYTES_V2 : REFLECTION_BACKGROUND_MAX_PLAINTEXT_BYTES_V2 / 2)) throw new RangeError("Reflection Record payload exceeds its canonical byte bound");
            if (countPayload && (plaintextBytes + length > descriptor.maximumPlaintextBytes
              || semantic && plaintextBytes + length > REFLECTION_SEMANTIC_MAX_INPUT_PLAINTEXT_BYTES_V2)) throw new RangeError("Reflection input plaintext budget exceeded");
            if (proof !== undefined) {
              const expectedEnvelope = proof.namespaceEnvelopes.find(entry => entry.namespaceId === ns);
              if (expectedEnvelope === undefined || payload.context.createdAt !== proof.createdAt || !hashMatches(payloadBytes, proof.payloadHash)
                || !hashMatches(envelopeBytes, expectedEnvelope.envelopeHash)) throw new Error("Reflection persisted output differs from its exact publication proof");
            }
            budget(0, (countPayload ? payloadBytes.length : 0) + (countEnvelope ? envelopeBytes.length : 0));
            const plaintext = await withKey(authorityFor(ns), envelope.context.keyGeneration, envelope.context.bindingRevisionAtWrap, key => {
              const value = decryptObjectThroughNamespaceV2(input.crypto, key, envelope, payload);
              if (value === null) throw new Error("Reflection Record ciphertext failed to open"); return retain(value);
            });
            if (countPayload) budget(plaintext.length, 0);
            return plaintext;
          } finally {wipeDeep(payload); wipeDeep(envelope); payloadBytes.fill(0); envelopeBytes.fill(0); owned.delete(payloadBytes); owned.delete(envelopeBytes);}
        };
        const validate = async (plaintext: Uint8Array) => {
          await check(); const borrowed = retain(copyOwnedBytesV2(plaintext));
          try {
            await race(semanticInput !== undefined
              ? semanticInput.semanticObjects.validateOutput({objectId: descriptor.outputSlots[0]!.objectId, plaintext: borrowed, signal: input.signal})
              : (objects as ReflectionAuthorityObjectPortV2).validateRecordPayload({recordRef: descriptor.source.recordRef, plaintext: borrowed, signal: input.signal}), input.signal);
            await check();
          } finally {borrowed.fill(0); owned.delete(borrowed);}
        };
        const commit = async (use: (authorize: () => Promise<number>) => Promise<void>, finalSemanticAttachment = false) => {
          await check(); let state: "idle" | "checking" | "checked" | "closed" = "idle"; let failure: Error | undefined;
          try {
            await race(use(async () => {
              assertActive();
              if (state !== "idle") {failure = new Error("Reflection commit authorization is one-use"); throw failure;}
              state = "checking"; const at = await check(); state = "checked"; return at;
            }), input.signal);
            if (failure !== undefined) throw failure;
            if ((state as string) !== "checked") throw new Error("Reflection adapter skipped commit authorization");
            // Final semantic attachment can complete its source work or change
            // predecessor lifecycle. Its held transaction already checked live
            // authority at commit; re-reading the old source after that mutation
            // would reject our own successful write. No disclosure follows it.
            if (finalSemanticAttachment) assertActive(); else await check();
          } finally {state = "closed";}
        };
        let plaintext: Uint8Array;
        if (semanticInput !== undefined) {
          const inputs: ReflectionSemanticInputV2[] = [];
          let inputBytes = 0;
          for (const entry of descriptor.inputBindings) {
            if (!("objectType" in entry)) throw new Error("Reflection semantic binding is missing its type");
            const exact = entry;
            const bytes = await open(exact.objectId, exact.namespaceId, undefined, true, true, exact.objectType);
            inputBytes += bytes.length;
            if (inputBytes > REFLECTION_SEMANTIC_MAX_INPUT_PLAINTEXT_BYTES_V2) throw new RangeError("Reflection semantic input byte budget exceeded");
            await check();
            const validationBytes = retain(copyOwnedBytesV2(bytes));
            try {await race(semanticInput.semanticObjects.validateInput({...exact, plaintext: validationBytes, signal: input.signal}), input.signal);}
            finally {validationBytes.fill(0); owned.delete(validationBytes);}
            inputs.push(Object.freeze({...exact, plaintext: retain(copyOwnedBytesV2(bytes))}));
            bytes.fill(0); owned.delete(bytes);
          }
          await check();
          let result: ReflectionSemanticOutputV2 | null;
          let executing = true;
          const assertExecutionCurrent = async () => {
            if (!executing) throw new Error("Reflection semantic execution scope is closed");
            await check();
            if (!executing) throw new Error("Reflection semantic execution scope is closed");
          };
          try {
            result = await race(Promise.resolve().then(() => {assertActive(); return semanticInput.execute(Object.freeze(inputs), input.signal, assertExecutionCurrent);}).then(value => {
              if (value !== null && value.plaintext instanceof Uint8Array) {
                retain(value.plaintext);
                return {...value, plaintext: retain(copyOwnedBytesV2(value.plaintext))};
              }
              return value;
            }), input.signal);
          } finally {executing = false; inputs.forEach(entry => {entry.plaintext.fill(0); owned.delete(entry.plaintext);});}
          await check();
          if (result === null) {
            await commit(authorizeCommit => semanticInput.semanticObjects.attach({output: null, claimId: input.claimId, authorizeCommit, signal: input.signal}), true);
            return {status: "executed" as const};
          }
          const slot = descriptor.outputSlots[0];
          if (slot === undefined || result.objectId !== slot.objectId || !(result.plaintext instanceof Uint8Array)) throw new Error("Reflection semantic output exceeds its exact slot");
          if (result.plaintext.length > REFLECTION_SEMANTIC_MAX_OUTPUT_PLAINTEXT_BYTES_V2) throw new RangeError("Reflection semantic output byte budget exceeded");
          plaintext = retain(copyOwnedBytesV2(result.plaintext));
          result.plaintext.fill(0); owned.delete(result.plaintext);
        } else {
          const first = descriptor.inputBindings[0]!;
          plaintext = await open(first.objectId, first.namespaceId, binding);
        }
        await validate(plaintext);
        let proof: Proof;
        if (binding !== undefined) {
          proof = binding;
          for (const entry of binding.namespaceEnvelopes.slice(1)) {
            const other = await open(binding.objectId, entry.namespaceId, proof, false, true);
            try {if (!same(other, plaintext)) throw new Error("Reflection recovery envelope plaintext parity failed");}
            finally {other.fill(0); owned.delete(other);}
          }
        } else {
          const slot = descriptor.outputSlots[0]!;
          budget(plaintext.length, 0);
          const encrypted = encryptObjectPayloadV2(input.crypto, {objectId: objectId(slot.objectId), keyClass: "ai", objectType: slot.objectType, createdAt: unixTimestamp(slot.createdAt)}, plaintext);
          retain(encrypted.dek);
          const payloadBytes = retain(encodeEncryptedPayloadV2(encrypted.payload));
          const namespaceEnvelopes: {namespaceId: string; envelopeBytes: Uint8Array}[] = [];
          try {
            for (const id of slot.namespaceIds) {
              const authority = authorityFor(id);
              const envelopeBytes = await withKey(authority, authority.namespaceKeyGeneration, authority.namespaceAccessRevision, key => retain(encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespaceV2(input.crypto, key, {
                objectId: objectId(slot.objectId), namespaceId: namespaceId(id), keyClass: "ai", keyGeneration: namespaceGeneration(authority.namespaceKeyGeneration), bindingRevisionAtWrap: accessRevision(authority.namespaceAccessRevision),
              }, encrypted.dek))));
              namespaceEnvelopes.push({namespaceId: id, envelopeBytes});
            }
          } finally {encrypted.dek.fill(0); owned.delete(encrypted.dek); wipeDeep(encrypted.payload);}
          proof = {objectId: slot.objectId, objectType: "nautilo.reflection.record.v1", createdAt: slot.createdAt,
            payloadHash: retain(input.crypto.hash(payloadBytes)), namespaceEnvelopes: namespaceEnvelopes.map(entry => ({namespaceId: entry.namespaceId, envelopeHash: retain(input.crypto.hash(entry.envelopeBytes))}))};
          await check();
          const manifestInput = {signerPrivateKey, signerAuthorizationBytes: verified.signerAuthorizationBytes, issuerSigningPublicKey: issuerPublicKey!, now: input.now()};
          const manifest = createCurrentProcessorObjectAccessManifestV5(input.crypto, {
            objectId: objectId(slot.objectId), payloadHash: proof.payloadHash, accessRevision: accessRevision(0), previousManifestHash: null,
            envelopeHashes: proof.namespaceEnvelopes.map(entry => entry.envelopeHash), signer: verified.signer,
            signerAuthorizationHash: verified.signerAuthorizationHash, hostAuthorizationRevision: authorizationRevision(verified.issuer.securityRevision),
          }, manifestInput);
          retain(manifest.bytes);
          const tombstone = createCurrentProcessorObjectAccessManifestV5(input.crypto, {objectId: objectId(slot.objectId), payloadHash: proof.payloadHash,
            accessRevision: accessRevision(1), previousManifestHash: manifest.hash, envelopeHashes: [], signer: verified.signer,
            signerAuthorizationHash: verified.signerAuthorizationHash, hostAuthorizationRevision: authorizationRevision(verified.issuer.securityRevision)}, manifestInput);
          retain(tombstone.bytes);
          // Public certificate/descriptor/manifest metadata has its own structural bounds.
          budget(0, payloadBytes.length + namespaceEnvelopes.reduce((total, entry) => total + entry.envelopeBytes.length, 0));
          await commit(authorizeCommit => objects.publishOutput({objectId: slot.objectId, payloadBytes,
            namespaceEnvelopes: Object.freeze(namespaceEnvelopes), manifestBytes: manifest.bytes, tombstoneManifestBytes: tombstone.bytes,
            signerAuthorizationBytes: retain(copyOwnedBytesV2(verified.signerAuthorizationBytes)), idempotencyId: descriptor.idempotencyId, claimId: input.claimId, authorizeCommit, signal: input.signal}));
          for (const entry of proof.namespaceEnvelopes) {
            const reopened = await open(proof.objectId, entry.namespaceId, proof, false);
            try {if (!same(reopened, plaintext)) throw new Error("Reflection persisted plaintext differs from its source Record");}
            finally {reopened.fill(0); owned.delete(reopened);}
          }
        }
        const attachBytes = retain(copyOwnedBytesV2(plaintext));
        try {
          await commit(authorizeCommit => semanticInput !== undefined
            ? semanticInput.semanticObjects.attach({output: {objectId: proof.objectId, plaintext: attachBytes}, claimId: input.claimId, authorizeCommit, signal: input.signal})
            : (objects as ReflectionAuthorityObjectPortV2).attach({recordRef: descriptor.source.recordRef, objectId: proof.objectId,
              plaintext: attachBytes, claimId: input.claimId, authorizeCommit, signal: input.signal}), semanticInput !== undefined);
        } finally {attachBytes.fill(0); owned.delete(attachBytes);}
        return {status: "executed" as const};
      },
    }), input.signal);
  } finally {
    finished = true; wipe(); input.signal.removeEventListener("abort", wipe);
    responseBytes.fill(0); wipeDeep(binding); authorizations.forEach(wipeDeep);
  }
}
