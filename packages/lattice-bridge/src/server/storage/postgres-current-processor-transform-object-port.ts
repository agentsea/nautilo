import {assertCurrentProcessorRunningRequest} from "./postgres-current-processor-running-request.ts";
import type {ResolveLiveShadowAgentObjectSigner} from "./postgres-object-access-manifest-v5.ts";
import {and, backgroundCryptoAuthorizationRequests, cryptoObjects, eq, isNull, type PostgresJsBridgeConnection} from "@nautilo/db";
import {verifyCommonObjectAccessManifest, LatticeCrypto, type ProcessorTransformInput} from "@nautilo/lattice-crypto";
import {
  decodeBackgroundAuthorizationResponseV2, decodeBackgroundProcessorWorkDescriptorV2,
  encodeBackgroundWorkDescriptorV2, inspectBackgroundAuthorizationResponseV2,
  destroyVerifiedProcessorSignerAuthorizationV2,
  type BackgroundAuthorizationIssuerContextV2, type ResolveCurrentBackgroundAuthorizationIssuerV2,
  copyPublicationReconciliationBindingV2, publicationReconciliationFingerprintV2,
  copyOutputRepairBindingV2, outputRepairFingerprintV2,
  type ProcessorOutputRepairBindingV2, type ProcessorOutputRepairObjectPortV2,
  type ProcessorReconciliationObjectPortV2, type ProcessorPublicationReconciliationBindingV2,
  type ProcessorTransformObjectPortV2,
} from "@nautilo/lattice-crypto/background";
import {decodeEncryptedPayloadV2, decodeNamespaceObjectEnvelopeV2} from "@nautilo/lattice-crypto/wire";
import type {PostgresDomainKeyAuthorityRepository} from "../delivery/postgres-domain-key-authority.ts";
import {assertVerifiedCryptoPostgresHandle, cryptoTypedDb, executeTypedCryptoQuery,
  type CryptoPostgresExecutor, type CryptoPostgresHandle} from "./postgres-lattice-storage.ts";
import {createPostgresProcessorTransformObjectPort, readExistingOutput, insertExactOutput,
  type ExactOutput, type VerifyProcessorTransformV5Input} from "./postgres-processor-transform-object-port.ts";
import {loadVerifiedCurrentProcessorSignerAuthorization, destroyVerifiedCurrentProcessorSignerEvidence,
  type VerifiedCurrentProcessorSignerEvidence} from "./postgres-current-processor-signer-authorization.ts";

export type WithCurrentProcessorPublicationAuthority = <Value>(input: Readonly<{
  context: BackgroundAuthorizationIssuerContextV2;
  signal?: AbortSignal;
  /** Exactly one existing policy/Room -> restricted authority transaction. */
  use(held: CurrentProcessorHeldAuthority): Promise<Value>;
}>) => Promise<Value | null>;

export type CurrentProcessorHeldAuthority = Readonly<{
  executor: CryptoPostgresExecutor;
  issuerSigningPublicKey: Uint8Array;
  /** Present only when the current-authority owner lends its existing product transaction. */
  product?: Pick<PostgresJsBridgeConnection, "query">;
  /** Granted by the held Lattice policy owner; absence never permits ordinary publication. */
  ordinarySiblingAllowed?: boolean;
}>;

export interface CurrentProcessorReconciliationAttachment {
  readonly binding: ProcessorPublicationReconciliationBindingV2;
  readonly attach: (input: Readonly<{
    held: CurrentProcessorHeldAuthority;
    outputs: readonly ProcessorTransformInput[];
    signal: AbortSignal;
    authorizedAt: number;
  }>) => Promise<void>;
}

export interface CurrentProcessorOutputRepairAttachment {
  readonly binding: ProcessorOutputRepairBindingV2;
  readonly withOrdinaryOutputs: (input: Readonly<{
    held: CurrentProcessorHeldAuthority; signal: AbortSignal;
  }>, use: Parameters<ProcessorOutputRepairObjectPortV2["withOrdinaryOutputs"]>[1]) => Promise<void>;
  readonly attach: CurrentProcessorReconciliationAttachment["attach"];
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
function digestEqual(value: unknown, expected: Uint8Array): boolean {
  return value instanceof Uint8Array && equal(value, expected);
}
function counter(value: unknown): number {
  const number = typeof value === "bigint" || (typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value)) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) throw new Error("Current processor durable counter is invalid");
  return number;
}
function instant(raw: unknown): number {
  const value = typeof raw === "string" ? new Date(raw) : raw;
  if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime())) throw new Error("Current processor durable deadline is unavailable");
  return value.getTime();
}

/**
 * One factory belongs to one exact recipient attempt. Publication and issuer
 * lookups cannot overlap. During authorizeCommit, one matching resolver call
 * consumes a local permit for the authority locks already held by that call;
 * other resolver calls fail closed instead of borrowing or reacquiring locks.
 */
export function createPostgresCurrentProcessorTransformObjectPort(input: Readonly<{
  handle: CryptoPostgresHandle;
  crypto: LatticeCrypto;
  responseBytes: Uint8Array;
  domainKeys: Pick<PostgresDomainKeyAuthorityRepository, "inspectForegroundNamespaceAuthority" | "withOpenedForegroundNamespaceKey">;
  withCurrentAuthority: WithCurrentProcessorPublicationAuthority;
  verifyV5Input?: VerifyProcessorTransformV5Input;
  resolveLiveShadowAgentSigner?: ResolveLiveShadowAgentObjectSigner;
  reconciliation?: CurrentProcessorReconciliationAttachment;
  outputRepair?: CurrentProcessorOutputRepairAttachment;
}>): Readonly<{objects: ProcessorTransformObjectPortV2; resolveCurrentIssuer: ResolveCurrentBackgroundAuthorizationIssuerV2; reconciliationObjects?: ProcessorReconciliationObjectPortV2; outputRepairObjects?: ProcessorOutputRepairObjectPortV2}> {
  if (input.reconciliation !== undefined) input = {...input, reconciliation: {...input.reconciliation,
    binding: copyPublicationReconciliationBindingV2(input.reconciliation.binding)}};
  if (input.outputRepair !== undefined) input = {...input, outputRepair: {...input.outputRepair,
    binding: copyOutputRepairBindingV2(input.outputRepair.binding)}};
  assertVerifiedCryptoPostgresHandle(input.handle);
  const {crypto} = input;
  if (!(crypto instanceof LatticeCrypto)) throw new TypeError("Current processor requires LatticeCrypto");
  const context = inspectBackgroundAuthorizationResponseV2(input.responseBytes);
  const descriptorBytes = encodeBackgroundWorkDescriptorV2(context.descriptor);
  if (!equal(crypto.hash(descriptorBytes), context.descriptorHash)) throw new Error("Current processor descriptor hash conflicts");
  const responseHash = crypto.hash(input.responseBytes);
  const response = decodeBackgroundAuthorizationResponseV2(input.responseBytes);
  const credentialHash = crypto.hash(response.credentialBytes);
  response.credentialBytes.fill(0);
  const authorizationBytes = response.signerAuthorizationBytes;
  const d = context.descriptor;
  if (!("authority" in d)) throw new TypeError("Stenographer transform requires its own descriptor");
  const inputObjectIds = d.inputBindings.map((slot) => slot.objectId);
  if ((d.workKind === "stenographer.publication_reconcile") !== (input.reconciliation !== undefined)
    || (d.workKind === "stenographer.output_repair") !== (input.outputRepair !== undefined)) {
    throw new Error("Current processor storage contract differs from its descriptor kind");
  }
  if (input.reconciliation !== undefined) {
    const fingerprint = publicationReconciliationFingerprintV2(crypto, input.reconciliation.binding);
    try {
      if (!equal(fingerprint, d.source.fingerprint)
        || input.reconciliation.binding.outputs.length !== inputObjectIds.length
        || input.reconciliation.binding.outputs.some((output, index) => output.objectId !== inputObjectIds[index])) {
        throw new Error("Current reconciliation receipt is substituted");
      }
    } finally {fingerprint.fill(0);}
  }
  if (input.outputRepair !== undefined) {
    const binding = input.outputRepair.binding;
    const fingerprint = outputRepairFingerprintV2(crypto, binding);
    const existing = binding.outputs.filter(output => output.disposition === "existing");
    const missing = binding.outputs.filter(output => output.disposition === "create");
    try {
      if (!equal(fingerprint, d.source.fingerprint) || binding.receipt.roomId !== d.authority.roomId
        || binding.receipt.namespaceId !== d.authority.namespaceId
        || existing.length !== inputObjectIds.length || existing.some((output, i) => output.objectId !== inputObjectIds[i])
        || missing.length !== d.outputSlots.length || missing.some((output, i) => {
          const slot = d.outputSlots[i]!;
          return output.objectId !== slot.objectId || output.objectType !== slot.objectType || output.createdAt !== slot.createdAt;
        })) throw new Error("Current output repair receipt is substituted");
    } finally {fingerprint.fill(0);}
  }
  const cloneContext = (): BackgroundAuthorizationIssuerContextV2 => ({
    issuer: {...context.issuer, headDigest: new Uint8Array(context.issuer.headDigest),
      signingPublicKeyHash: new Uint8Array(context.issuer.signingPublicKeyHash)},
    descriptor: decodeBackgroundProcessorWorkDescriptorV2(descriptorBytes), descriptorHash: new Uint8Array(context.descriptorHash),
  });
  const matchesContext = (candidate: BackgroundAuthorizationIssuerContextV2): boolean => {
    const i = context.issuer;
    const c = candidate.issuer;
    return equal(candidate.descriptorHash, context.descriptorHash)
      && equal(encodeBackgroundWorkDescriptorV2(candidate.descriptor), descriptorBytes)
      && c.humanId === i.humanId && c.deviceId === i.deviceId && c.deviceGeneration === i.deviceGeneration
      && c.serverInstanceId === i.serverInstanceId && c.lineageGeneration === i.lineageGeneration
      && c.epoch === i.epoch && c.securityRevision === i.securityRevision
      && equal(c.headDigest, i.headDigest) && equal(c.signingPublicKeyHash, i.signingPublicKeyHash);
  };
  let resolving = false;
  let publishing = false;
  let published = false;
  let committedOutputIds: readonly string[] = [];
  let commitPermit: Uint8Array | undefined;
  const resolveCurrentIssuer: ResolveCurrentBackgroundAuthorizationIssuerV2 = async (candidate) => {
    if (!matchesContext(candidate)) return null;
    if (publishing) {
      if (commitPermit === undefined) throw new Error("Current processor publication resolver is unavailable");
      const key = new Uint8Array(commitPermit);
      commitPermit = undefined;
      return key;
    }
    if (resolving) throw new Error("Current processor authority lookup is unavailable");
    resolving = true;
    try {
      return await input.withCurrentAuthority({context: cloneContext(),
        use: (held) => Promise.resolve(new Uint8Array(held.issuerSigningPublicKey))});
    } finally {resolving = false;}
  };
  const legacy = createPostgresProcessorTransformObjectPort({handle: input.handle, crypto,
    ...(input.resolveLiveShadowAgentSigner === undefined ? {} : {resolveLiveShadowAgentSigner: input.resolveLiveShadowAgentSigner}),
    ...(input.verifyV5Input === undefined ? {} : {verifyV5Input: input.verifyV5Input})});
  const validateOutput = (output: Parameters<ProcessorTransformObjectPortV2["publishOutputs"]>[0]["outputs"][number],
    index: number, evidence: VerifiedCurrentProcessorSignerEvidence): ExactOutput => {
    const slot = d.outputSlots[index];
    if (slot === undefined || output.objectId !== slot.objectId || !equal(output.signerAuthorizationBytes, authorizationBytes)) {
      throw new Error("Current processor output or certificate is outside the authorized prefix");
    }
    const payload = decodeEncryptedPayloadV2(output.payloadBytes);
    const envelope = decodeNamespaceObjectEnvelopeV2(output.envelopeBytes);
    if (payload.context.objectId !== slot.objectId || payload.context.keyClass !== "ai"
      || payload.context.objectType !== slot.objectType || payload.context.createdAt !== slot.createdAt
      || envelope.context.objectId !== slot.objectId || envelope.context.keyClass !== "ai"
      || slot.namespaceIds.length !== 1
      || envelope.context.namespaceId !== slot.namespaceIds[0]
      || envelope.context.keyGeneration !== d.authority.namespaceKeyGeneration
      || envelope.context.bindingRevisionAtWrap !== d.authority.namespaceAccessRevision) {
      throw new Error("Current processor output payload or envelope conflicts with its descriptor");
    }
    const verifyManifest = (manifestBytes: Uint8Array) => verifyCommonObjectAccessManifest(crypto, {
      manifestBytes, resolveAgentRuntimeSignerPublicKey: () => null,
      resolveHistoricalHumanDeviceSigningPublicKey: () => null,
      resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
      resolveHistoricalCurrentIssuer: (candidate) => matchesContext(candidate) ? evidence.issuerPublicKey : null,
      resolveProcessorSignerAuthorizationBytes: (requested) =>
        requested.authorizationId === evidence.certificate.credentialId
          && equal(requested.authorizationHash, evidence.authorizationHash) ? authorizationBytes : null,
    });
    const verified: ReturnType<typeof verifyManifest>[] = [];
    try {
      const manifest = verifyManifest(output.manifestBytes); verified.push(manifest);
      const tombstone = verifyManifest(output.tombstoneManifestBytes); verified.push(tombstone);
      const payloadHash = crypto.hash(output.payloadBytes);
      const envelopeHash = crypto.hash(output.envelopeBytes);
      if (manifest.manifest.objectId !== slot.objectId || manifest.manifest.accessRevision !== 0
        || manifest.manifest.previousManifestHash !== null || !equal(manifest.manifest.payloadHash, payloadHash)
        || manifest.manifest.envelopeHashes.length !== 1 || !equal(manifest.manifest.envelopeHashes[0]!, envelopeHash)
        || tombstone.manifest.objectId !== slot.objectId || tombstone.manifest.accessRevision !== 1
        || !digestEqual(tombstone.manifest.previousManifestHash, manifest.manifestHash)
        || !equal(tombstone.manifest.payloadHash, payloadHash) || tombstone.manifest.envelopeHashes.length !== 0) {
        throw new Error("Current processor output manifest or tombstone conflicts with its exact publication");
      }
      return {objectId: slot.objectId, payloadBytes: output.payloadBytes, payloadHash,
        envelopeBytes: output.envelopeBytes, envelopeHash, namespaceId: slot.namespaceIds[0],
        manifestBytes: output.manifestBytes, manifestHash: new Uint8Array(manifest.manifestHash),
        tombstoneManifestBytes: output.tombstoneManifestBytes, tombstoneManifestHash: new Uint8Array(tombstone.manifestHash)};
    } finally {
      for (const value of verified) {
        value.manifestBytes.fill(0); value.manifestHash.fill(0);
        value.manifest.envelopeHashes.forEach((hash) => hash.fill(0));
        Object.values(value.manifest).forEach((field) => {if (field instanceof Uint8Array) field.fill(0);});
        if (value.currentSignerAuthorization !== null) destroyVerifiedProcessorSignerAuthorizationV2(value.currentSignerAuthorization);
      }
    }
  };
  const assertRunningRequest = (executor: CryptoPostgresExecutor, claimId: string) =>
    assertCurrentProcessorRunningRequest({executor, crypto, context, descriptorBytes, responseHash, credentialHash, claimId});
  const objects: ProcessorTransformObjectPortV2 = {
    openPublishedOutput: async (request) => {
      request.signal.throwIfAborted();
      if (!published || publishing || !committedOutputIds.includes(request.objectId)) {
        throw new Error("Current processor output is outside its committed prefix");
      }
      return legacy.openInput(request);
    },
    openInput: async (request) => {
      request.signal.throwIfAborted();
      const binding = d.inputBindings.find((slot) => slot.objectId === request.objectId);
      if (binding === undefined || publishing || published) throw new Error("Current processor input is outside its attempt");
      const opened = await legacy.openInput(request);
      if (opened.payload.context.objectId !== binding.objectId
        || opened.envelope.context.objectId !== binding.objectId
        || opened.envelope.context.namespaceId !== binding.namespaceId) {
        opened.payload.ciphertext.fill(0);
        opened.envelope.wrappedDek.fill(0);
        throw new Error("Current processor input Namespace conflicts with its descriptor");
      }
      return opened;
    },
    withNamespaceKey: async (request, use) => {
      request.signal.throwIfAborted();
      const a = request.authority;
      const expected = d.authority;
      if (request.keyClass !== "ai" || Object.keys(expected).some((key) => {
        const field = key as keyof typeof expected;
        const value = expected[field];
        return value instanceof Uint8Array ? !digestEqual(a[field], value) : a[field] !== value;
      })) throw new Error("Current processor Namespace key scope is substituted");
      const current = await input.domainKeys.inspectForegroundNamespaceAuthority({namespaceId: a.namespaceId, keyClass: "ai"});
      if (current.status !== "ready") throw new Error("Current processor Namespace bundle is unavailable");
      try {
        request.signal.throwIfAborted();
        if (current.namespaceId !== a.namespaceId || current.namespaceAccessRevision !== a.namespaceAccessRevision
          || current.namespaceKeyGeneration !== a.namespaceKeyGeneration || !equal(current.namespaceHeadDigest, a.namespaceHeadDigest)
          || current.domainId !== a.domainId || current.domainKeyGeneration !== a.domainKeyGeneration
          || current.domainAuthorizationRevision !== a.domainAuthorizationRevision || !equal(current.domainHeadDigest, a.domainHeadDigest)
          || current.bundleRevision !== a.bundleRevision || !equal(current.bundleDigest, a.bundleDigest)) {
          throw new Error("Current processor Namespace bundle is stale");
        }
        let called = false;
        const result = await input.domainKeys.withOpenedForegroundNamespaceKey({authority: current, domainKey: request.domainKey,
          keyGeneration: request.generation, accessRevision: request.accessRevision,
          use: (key) => {request.signal.throwIfAborted(); called = true; return use(key);}});
        request.signal.throwIfAborted();
        if (!called) throw new Error("Current processor retained Namespace key is unavailable");
        return result as Awaited<ReturnType<typeof use>>;
      } finally {
        Object.values(current).forEach((value) => {if (value instanceof Uint8Array) value.fill(0);});
      }
    },
    publishOutputs: async (request) => {
      request.signal.throwIfAborted();
      if (d.workKind === "stenographer.publication_reconcile" || resolving || publishing || published || request.idempotencyId !== d.idempotencyId
        || !Array.isArray(request.outputs as unknown) || request.outputs.length > d.outputSlots.length
        || !Number.isSafeInteger(request.authorityCheckedAt) || request.authorityCheckedAt < 0) {
        throw new Error("Current processor publication is unavailable or outside its attempt");
      }
      // Snapshot every borrowed output before acquiring asynchronous locks.
      const outputs = request.outputs.map((output) => ({objectId: output.objectId,
        payloadBytes: new Uint8Array(output.payloadBytes), envelopeBytes: new Uint8Array(output.envelopeBytes),
        manifestBytes: new Uint8Array(output.manifestBytes), tombstoneManifestBytes: new Uint8Array(output.tombstoneManifestBytes),
        signerAuthorizationBytes: new Uint8Array(output.signerAuthorizationBytes)}));
      publishing = true;
      try {
        const result = await input.withCurrentAuthority({context: cloneContext(), signal: request.signal, use: async (held) => {
          const executor = held.executor;
          request.signal.throwIfAborted();
          await executor.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 241))", [d.idempotencyId]);
          const table = backgroundCryptoAuthorizationRequests;
          const row = await assertRunningRequest(executor, request.claimId);
          const evidence = await loadVerifiedCurrentProcessorSignerAuthorization(executor, crypto, authorizationBytes);
          try {
            if (evidence.certificate.credentialId !== row.credential_id || evidence.requestId !== d.requestId
              || evidence.recipientGeneration !== d.recipientGeneration || !equal(evidence.certificate.descriptorBytes, descriptorBytes)
              || !equal(evidence.certificate.credentialHash, credentialHash)
              || !equal(evidence.issuerPublicKey, held.issuerSigningPublicKey)) throw new Error("Current processor accepted certificate conflicts");
            const exact = outputs.map((output, index) => validateOutput(output, index, evidence));
            const outputPlaintextBytes = outputs.map((output) => decodeEncryptedPayloadV2(output.payloadBytes).ciphertext.length - 40);
            if (outputPlaintextBytes.some((length) => length < 0)
              || outputPlaintextBytes.reduce((sum, length) => sum + length, 0) > d.maximumPlaintextBytes) {
              throw new Error("Current processor publication plaintext budget exceeded");
            }
            if (exact.reduce((sum, output) => sum + output.payloadBytes.length + output.envelopeBytes.length
              + output.manifestBytes.length + output.tombstoneManifestBytes.length + authorizationBytes.length, 0) > d.maximumCiphertextBytes) {
              throw new Error("Current processor publication ciphertext budget exceeded");
            }
            for (const slot of d.outputSlots) await executor.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 242))", [slot.objectId]);
            const existing = [];
            for (const output of exact) existing.push(await readExistingOutput(executor, output));
            if (existing.includes("absent") && existing.includes("exact")) throw new Error("Current processor publication has partial durable state");
            for (const slot of d.outputSlots.slice(outputs.length)) {
              const unused = await executeTypedCryptoQuery(executor, cryptoTypedDb.select({objectId: cryptoObjects.objectId})
                .from(cryptoObjects).where(eq(cryptoObjects.objectId, slot.objectId)).limit(2));
              if (unused.length !== 0) throw new Error("Current processor publication conflicts with an earlier output prefix");
            }
            const marker = [row.transform_commit_claim_id, row.transform_commit_descriptor_hash,
              row.transform_commit_recipient_generation, row.transform_commit_output_count, row.transform_committed_at];
            const markerAbsent = marker.every((value) => value === null);
            if (!markerAbsent && (marker.some((value) => value === null)
              || row.transform_commit_claim_id !== request.claimId || !digestEqual(row.transform_commit_descriptor_hash, context.descriptorHash)
              || counter(row.transform_commit_recipient_generation) !== d.recipientGeneration || counter(row.transform_commit_output_count) !== outputs.length)) {
              throw new Error("Current processor publication commit marker conflicts");
            }
            if (!markerAbsent) {
              instant(row.transform_committed_at);
              if (existing.some((state) => state !== "exact")) throw new Error("Current processor committed output is missing");
            }
            request.signal.throwIfAborted();
            commitPermit = held.issuerSigningPublicKey;
            let committedAt: number;
            try {committedAt = await request.authorizeCommit();}
            finally {commitPermit = undefined;}
            if (!Number.isSafeInteger(committedAt) || committedAt < request.authorityCheckedAt
              || committedAt >= d.expiresAt || committedAt >= instant(row.claim_expires_at)) {
              throw new Error("Current processor claim expired before publication");
            }
            request.signal.throwIfAborted();
            if (!existing.every((state) => state === "exact")) for (const output of exact) await insertExactOutput(executor, output);
            if (markerAbsent) {
              const inserted = await executeTypedCryptoQuery(executor, cryptoTypedDb.update(table).set({
                transformCommitClaimId: request.claimId, transformCommitDescriptorHash: context.descriptorHash,
                transformCommitRecipientGeneration: d.recipientGeneration, transformCommitOutputCount: outputs.length,
                transformCommittedAt: new Date(committedAt),
              }).where(and(eq(table.requestId, d.requestId), eq(table.state, "running"), eq(table.claimId, request.claimId),
                eq(table.descriptorHash, context.descriptorHash), eq(table.recipientGeneration, d.recipientGeneration),
                isNull(table.transformCommittedAt))).returning({requestId: table.requestId}));
              if (inserted.length !== 1) throw new Error("Current processor publication commit marker was not stored");
            }
            request.signal.throwIfAborted();
            return true;
          } finally {destroyVerifiedCurrentProcessorSignerEvidence(evidence);}
        }});
        if (result !== true) throw new Error("Current processor publication authority is unavailable");
        committedOutputIds = Object.freeze(outputs.map((output) => output.objectId));
        published = true;
      } finally {
        commitPermit = undefined; publishing = false;
        outputs.forEach((output) => Object.values(output).forEach((value) => {if (value instanceof Uint8Array) value.fill(0);}));
      }
    },
  };
  const reconciliationObjects: ProcessorReconciliationObjectPortV2 | undefined = input.reconciliation === undefined ? undefined : {
    openInput: objects.openInput,
    withNamespaceKey: objects.withNamespaceKey,
    attach: async (request) => {
      request.signal.throwIfAborted();
      if (resolving || publishing || published || request.outputs.length !== inputObjectIds.length
        || request.outputs.some((output, index) => output.objectId !== inputObjectIds[index])) {
        throw new Error("Current reconciliation attachment is unavailable");
      }
      publishing = true;
      try {
        const result = await input.withCurrentAuthority({context: cloneContext(), signal: request.signal, use: async held => {
          const row = await assertRunningRequest(held.executor, request.claimId);
          // Reconciliation never owns an encrypted-output publication marker.
          if ([row.transform_committed_at, row.transform_commit_claim_id, row.transform_commit_descriptor_hash,
            row.transform_commit_recipient_generation, row.transform_commit_output_count].some(value => value !== null)) {
            throw new Error("Reconciliation cannot own a transform commit");
          }
          commitPermit = held.issuerSigningPublicKey;
          let authorizedAt: number;
          try {authorizedAt = await request.authorizeCommit();} finally {commitPermit = undefined;}
          if (!Number.isSafeInteger(authorizedAt) || authorizedAt >= d.expiresAt
            || authorizedAt >= instant(row.claim_expires_at)) throw new Error("Reconciliation claim expired before attachment");
          request.signal.throwIfAborted();
          await input.reconciliation!.attach({held, outputs: request.outputs, signal: request.signal, authorizedAt});
          request.signal.throwIfAborted();
          return true;
        }});
        if (result !== true) throw new Error("Current reconciliation authority is unavailable");
        published = true;
      } finally {commitPermit = undefined; publishing = false;}
    },
  };
  let ordinaryRead = false;
  let repairAttached = false;
  const outputRepairObjects: ProcessorOutputRepairObjectPortV2 | undefined = input.outputRepair === undefined ? undefined : {
    ...objects,
    withOrdinaryOutputs: async (request, use) => {
      request.signal.throwIfAborted();
      if (ordinaryRead || resolving || publishing || published) throw new Error("Current repair ordinary read is unavailable");
      ordinaryRead = true;
      const result = await input.withCurrentAuthority({context: cloneContext(), signal: request.signal, use: async held => {
        const table = backgroundCryptoAuthorizationRequests;
        const rows = await executeTypedCryptoQuery(held.executor, cryptoTypedDb.select({claim_id: table.claimId}).from(table)
          .where(eq(table.requestId, d.requestId)).for("update"));
        const claimId = rows[0]?.claim_id;
        if (typeof claimId !== "string" || rows.length !== 1) throw new Error("Current repair is not durably claimed");
        const row = await assertRunningRequest(held.executor, claimId);
        if (row.transform_committed_at !== null) throw new Error("Committed repair requires reconciliation");
        request.signal.throwIfAborted();
        await input.outputRepair!.withOrdinaryOutputs({held, signal: request.signal}, use);
        request.signal.throwIfAborted();
        return true;
      }});
      if (result !== true) throw new Error("Current repair ordinary-read authority is unavailable");
    },
    attach: async request => {
      request.signal.throwIfAborted();
      const binding = input.outputRepair!.binding;
      if (!ordinaryRead || !published || resolving || publishing || repairAttached
        || request.outputs.length !== binding.outputs.length
        || request.outputs.some((output, i) => output.objectId !== binding.outputs[i]!.objectId)) {
        throw new Error("Current output repair attachment is unavailable");
      }
      publishing = true;
      try {
        const result = await input.withCurrentAuthority({context: cloneContext(), signal: request.signal, use: async held => {
          const row = await assertRunningRequest(held.executor, request.claimId);
          if (row.transform_committed_at === null || row.transform_commit_claim_id !== request.claimId
            || !digestEqual(row.transform_commit_descriptor_hash, context.descriptorHash)
            || counter(row.transform_commit_recipient_generation) !== d.recipientGeneration
            || counter(row.transform_commit_output_count) !== d.outputSlots.length) {
            throw new Error("Output repair transform commit is absent or substituted");
          }
          commitPermit = held.issuerSigningPublicKey;
          let authorizedAt: number;
          try {authorizedAt = await request.authorizeCommit();} finally {commitPermit = undefined;}
          if (!Number.isSafeInteger(authorizedAt) || authorizedAt >= d.expiresAt
            || authorizedAt >= instant(row.claim_expires_at)) throw new Error("Output repair claim expired before attachment");
          request.signal.throwIfAborted();
          await input.outputRepair!.attach({held, outputs: request.outputs, signal: request.signal, authorizedAt});
          request.signal.throwIfAborted();
          return true;
        }});
        if (result !== true) throw new Error("Current output repair attachment authority is unavailable");
        repairAttached = true;
      } finally {commitPermit = undefined; publishing = false;}
    },
  };
  return Object.freeze({objects, resolveCurrentIssuer,
    ...(reconciliationObjects === undefined ? {} : {reconciliationObjects}),
    ...(outputRepairObjects === undefined ? {} : {outputRepairObjects})});
}
