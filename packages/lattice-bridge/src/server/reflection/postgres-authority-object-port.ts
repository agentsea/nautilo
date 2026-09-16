import {decodeRecordPayloadV1} from "@nautilo/reflection/payload";
import {and, asc, backgroundCryptoAuthorizationRequests, eq, isNull, objectCryptoAccessHeads, objectCryptoNamespaceEnvelopes} from "@nautilo/db";
import {verifyCommonObjectAccessManifest, type LatticeCrypto} from "@nautilo/lattice-crypto";
import {decodeAnyBackgroundProcessorWorkDescriptorV2, decodeBackgroundAuthorizationResponseV2,
  encodeBackgroundWorkDescriptorV2, inspectBackgroundAuthorizationResponseV2,
  destroyVerifiedProcessorSignerAuthorizationV2,
  type BackgroundAuthorizationIssuerContextV2, type ReflectionAuthorityObjectPortV2, type ReflectionSemanticObjectPortV2,
  type ResolveCurrentBackgroundAuthorizationIssuerV2} from "@nautilo/lattice-crypto/background";
import {decodeEncryptedPayloadV2, decodeNamespaceObjectEnvelopeV2} from "@nautilo/lattice-crypto/wire";
import type {PostgresDomainKeyAuthorityRepository} from "../delivery/postgres-domain-key-authority.ts";
import {readVerifiedDeviceWrappedAgentObject} from "../memory/postgres-memory-crypto-completion.ts";
import type {WithCurrentProcessorPublicationAuthority, CurrentProcessorHeldAuthority} from "../storage/postgres-current-processor-transform-object-port.ts";
import {assertCurrentProcessorRunningRequest} from "../storage/postgres-current-processor-running-request.ts";
import {destroyVerifiedCurrentProcessorSignerEvidence, loadVerifiedCurrentProcessorSignerAuthorization} from "../storage/postgres-current-processor-signer-authorization.ts";
import {assertVerifiedCryptoPostgresHandle, cryptoTypedDb, executeTypedCryptoQuery, type CryptoPostgresHandle} from "../storage/postgres-lattice-storage.ts";
import {insertExactOutput, readExistingOutput, type ExactNamespaceSetOutput} from "../storage/postgres-processor-transform-object-port.ts";

const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);
function wipe(value: unknown): void {
  if (value instanceof Uint8Array) value.fill(0);
  else if (value !== null && typeof value === "object") Object.values(value).forEach(wipe);
}
function requireIntegrity(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Reflection authority: ${message}`);
}

type ReflectionAuthorityObjectPortInput = Readonly<{
  handle: CryptoPostgresHandle; crypto: LatticeCrypto; responseBytes: Uint8Array; claimId: string;
  domainKeys: Pick<PostgresDomainKeyAuthorityRepository, "inspectForegroundNamespaceAuthority" | "withOpenedForegroundNamespaceKey">;
  withCurrentAuthority: WithCurrentProcessorPublicationAuthority;
  attach(request: Parameters<ReflectionAuthorityObjectPortV2["attach"]>[0] & Readonly<{held: CurrentProcessorHeldAuthority}>): Promise<void>;
}>;
type ReflectionSemanticObjectPortInput = Omit<ReflectionAuthorityObjectPortInput, "attach"> & Readonly<{
  /** Public evidence for the original input publication, never a new Agent grant. */
  resolveHistoricalAgentSignerAuthority?: Parameters<typeof readVerifiedDeviceWrappedAgentObject>[0]["resolveHistoricalAgentSignerAuthority"];
  resolveLiveShadowAgentSigner?: NonNullable<Parameters<typeof readVerifiedDeviceWrappedAgentObject>[0]["resolveLiveShadowAgentSigner"]>;
  validateInput: ReflectionSemanticObjectPortV2["validateInput"];
  validateOutput: ReflectionSemanticObjectPortV2["validateOutput"];
  attach(request: Parameters<ReflectionSemanticObjectPortV2["attach"]>[0] & Readonly<{held: CurrentProcessorHeldAuthority}>): Promise<void>;
}>;
type ReflectionObjectPortResult<Objects> = Readonly<{objects: Objects; resolveCurrentIssuer: ResolveCurrentBackgroundAuthorizationIssuerV2; dispose(): void}>;

/** One exact maintenance attempt; no semantic callback is admitted. */
export function createPostgresReflectionAuthorityObjectPort(input: ReflectionAuthorityObjectPortInput): ReflectionObjectPortResult<ReflectionAuthorityObjectPortV2> {
  if ("validateInput" in input || "validateOutput" in input) throw new TypeError("Reflection semantics requires its named object port");
  return createPostgresReflectionObjectPort(input);
}

/** Named semantic variant of the same custody, authenticated read and publication owner. */
export function createPostgresReflectionSemanticObjectPort(input: ReflectionSemanticObjectPortInput): ReflectionObjectPortResult<ReflectionSemanticObjectPortV2> {
  return createPostgresReflectionObjectPort(input);
}

function createPostgresReflectionObjectPort(input: ReflectionAuthorityObjectPortInput): ReflectionObjectPortResult<ReflectionAuthorityObjectPortV2>;
function createPostgresReflectionObjectPort(input: ReflectionSemanticObjectPortInput): ReflectionObjectPortResult<ReflectionSemanticObjectPortV2>;
function createPostgresReflectionObjectPort(input: ReflectionAuthorityObjectPortInput | ReflectionSemanticObjectPortInput): ReflectionObjectPortResult<ReflectionAuthorityObjectPortV2 | ReflectionSemanticObjectPortV2> {
  const semanticInput = "validateInput" in input ? input : undefined;
  assertVerifiedCryptoPostgresHandle(input.handle);
  const {crypto} = input;
  const context = inspectBackgroundAuthorizationResponseV2(input.responseBytes);
  const d = context.descriptor;
  requireIntegrity("namespaceRequirements" in d, "named Reflection descriptor required");
  requireIntegrity((d.source.kind === "reflection_semantic") === (semanticInput !== undefined), "Reflection purpose requires its named object port");
  const descriptorBytes = encodeBackgroundWorkDescriptorV2(d);
  requireIntegrity(equal(crypto.hash(descriptorBytes), context.descriptorHash), "descriptor hash conflicts");
  const responseHash = crypto.hash(input.responseBytes);
  const response = decodeBackgroundAuthorizationResponseV2(input.responseBytes);
  const credentialHash = crypto.hash(response.credentialBytes);
  response.credentialBytes.fill(0);
  const authorizationBytes = response.signerAuthorizationBytes;
  let disposed = false;
  let holding = false;
  let resolving = false;
  let published = false;
  let attached = false;
  let signerEvidenceChecked = false;
  let permit: Uint8Array | undefined;
  const active = (signal?: AbortSignal) => {signal?.throwIfAborted(); requireIntegrity(!disposed, "attempt disposed");};
  const matches = (candidate: BackgroundAuthorizationIssuerContextV2) => {
    const bytes = encodeBackgroundWorkDescriptorV2(candidate.descriptor);
    try {
      return equal(bytes, descriptorBytes) && equal(candidate.descriptorHash, context.descriptorHash)
        && Object.entries(context.issuer).every(([field, value]) => {
          const other = candidate.issuer[field as keyof typeof candidate.issuer];
          return value instanceof Uint8Array ? other instanceof Uint8Array && equal(value, other) : value === other;
        });
    } finally {bytes.fill(0);}
  };
  const copyContext = (): BackgroundAuthorizationIssuerContextV2 => ({
    descriptor: decodeAnyBackgroundProcessorWorkDescriptorV2(descriptorBytes), descriptorHash: Uint8Array.from(context.descriptorHash),
    issuer: {...context.issuer, headDigest: Uint8Array.from(context.issuer.headDigest), signingPublicKeyHash: Uint8Array.from(context.issuer.signingPublicKeyHash)},
  });
  const underAuthority = async <Value>(signal: AbortSignal | undefined, use: (held: CurrentProcessorHeldAuthority) => Promise<Value>) => {
    const copy = copyContext();
    try {return await input.withCurrentAuthority({context: copy, ...(signal === undefined ? {} : {signal}), use});}
    finally {wipe(copy);}
  };
  const resolveCurrentIssuer: ResolveCurrentBackgroundAuthorizationIssuerV2 = async candidate => {
    active();
    if (!matches(candidate)) return null;
    if (holding) {
      requireIntegrity(permit !== undefined, "commit authority cannot be borrowed");
      const key = Uint8Array.from(permit); permit = undefined; return key;
    }
    requireIntegrity(!resolving, "overlapping authority lookup"); resolving = true;
    try {return await underAuthority(undefined, held => Promise.resolve(Uint8Array.from(held.issuerSigningPublicKey)));}
    finally {resolving = false;}
  };
  const running = (held: CurrentProcessorHeldAuthority, claimId: string) => assertCurrentProcessorRunningRequest({
    executor: held.executor, crypto, context, descriptorBytes, responseHash, credentialHash, claimId,
  });
  const beforeAccess = async (signal: AbortSignal) => {
    active(signal);
    requireIntegrity(!holding && !resolving && !attached, "access outside active attempt");
    const allowed = await underAuthority(signal, async held => {
      const row = await running(held, input.claimId);
      if (!signerEvidenceChecked) {
        const evidence = await loadVerifiedCurrentProcessorSignerAuthorization(held.executor, crypto, authorizationBytes);
        try {
          requireIntegrity(evidence.requestId === d.requestId && evidence.recipientGeneration === d.recipientGeneration
            && equal(evidence.certificate.descriptorBytes, descriptorBytes) && equal(evidence.certificate.credentialHash, credentialHash)
            && evidence.certificate.credentialId === row.credential_id && equal(evidence.issuerPublicKey, held.issuerSigningPublicKey), "accepted signer evidence substituted");
          // This is append-only public signer history, checked once before any
          // body is opened. Current membership and request state remain per-use.
          signerEvidenceChecked = true;
        } finally {destroyVerifiedCurrentProcessorSignerEvidence(evidence);}
      }
      return true;
    });
    requireIntegrity(allowed === true, "current read authority unavailable"); active(signal);
  };
  const objects: ReflectionAuthorityObjectPortV2 = {
    validateRecordPayload: async request => {
      await beforeAccess(request.signal);
      requireIntegrity(request.recordRef === d.source.recordRef, "Record identity substituted");
      decodeRecordPayloadV1(request.plaintext);
      active(request.signal);
    },
    openObject: async request => {
      await beforeAccess(request.signal);
      const inputBinding = d.inputBindings.find(slot => slot.objectId === request.objectId && slot.namespaceId === request.namespaceId);
      const isInput = inputBinding !== undefined;
      const isOutput = published && d.outputSlots.some(slot => slot.objectId === request.objectId && slot.namespaceIds.includes(request.namespaceId));
      requireIntegrity(!holding && !attached && (isInput || isOutput), "object outside declared inventory");
      const namespaces = await executeTypedCryptoQuery(input.handle,
        cryptoTypedDb.select({namespace_id: objectCryptoNamespaceEnvelopes.namespaceId})
          .from(objectCryptoNamespaceEnvelopes).innerJoin(objectCryptoAccessHeads, and(
            eq(objectCryptoAccessHeads.objectId, objectCryptoNamespaceEnvelopes.objectId),
            eq(objectCryptoAccessHeads.accessRevision, objectCryptoNamespaceEnvelopes.accessRevision),
          )).where(eq(objectCryptoAccessHeads.objectId, request.objectId))
          .orderBy(asc(objectCryptoNamespaceEnvelopes.namespaceId)).limit(257));
      requireIntegrity(namespaces.length > 0 && namespaces.length <= 256, "invalid current envelope inventory");
      const namespaceIds = namespaces.map(row => row.namespace_id);
      requireIntegrity(namespaceIds.includes(request.namespaceId), "selected Namespace is not current");
      const saved = await readVerifiedDeviceWrappedAgentObject({handle: input.handle, crypto, objectId: request.objectId,
        expectedObjectType: inputBinding !== undefined && "objectType" in inputBinding && typeof inputBinding.objectType === "string" ? inputBinding.objectType : "nautilo.reflection.record.v1", expectedNamespaceIds: namespaceIds,
        resolveHistoricalAgentSignerAuthority: semanticInput?.resolveHistoricalAgentSignerAuthority ?? (() => null),
        ...(semanticInput?.resolveLiveShadowAgentSigner === undefined ? {} : {resolveLiveShadowAgentSigner: semanticInput.resolveLiveShadowAgentSigner})});
      requireIntegrity(saved !== null, "authenticated object unavailable");
      try {
        active(request.signal);
        const entry = saved.namespaceEnvelopes.find(value => value.namespaceId === request.namespaceId);
        requireIntegrity(entry !== undefined, "authenticated selected envelope absent");
        return {payload: decodeEncryptedPayloadV2(saved.payloadBytes), envelope: decodeNamespaceObjectEnvelopeV2(entry.envelopeBytes)};
      } finally {wipe(saved);}
    },
    withNamespaceKey: async (request, use) => {
      await beforeAccess(request.signal);
      const expected = d.namespaceRequirements.find(entry => entry.authority.namespaceId === request.authority.namespaceId)?.authority;
      requireIntegrity(expected !== undefined && request.keyClass === "ai" && Object.entries(expected).every(([field, value]) => {
        const other = request.authority[field as keyof typeof expected];
        return value instanceof Uint8Array ? other instanceof Uint8Array && equal(value, other) : value === other;
      }), "Namespace authority substituted");
      const current = await input.domainKeys.inspectForegroundNamespaceAuthority({namespaceId: expected.namespaceId, keyClass: "ai"});
      requireIntegrity(current.status === "ready", "Namespace bundle unavailable");
      try {
        active(request.signal);
        requireIntegrity(current.namespaceAccessRevision === expected.namespaceAccessRevision
          && current.namespaceKeyGeneration === expected.namespaceKeyGeneration && equal(current.namespaceHeadDigest, expected.namespaceHeadDigest)
          && current.domainId === expected.domainId && current.domainKeyGeneration === expected.domainKeyGeneration
          && current.domainAuthorizationRevision === expected.domainAuthorizationRevision && equal(current.domainHeadDigest, expected.domainHeadDigest)
          && current.bundleRevision === expected.bundleRevision && equal(current.bundleDigest, expected.bundleDigest), "Namespace bundle stale");
        let called = false;
        const result = await input.domainKeys.withOpenedForegroundNamespaceKey({authority: current, domainKey: request.domainKey,
          keyGeneration: request.generation, accessRevision: request.accessRevision, use: key => {
            active(request.signal); requireIntegrity(!called, "Namespace lender invoked twice"); called = true; return use(key);
          }});
        active(request.signal); requireIntegrity(called, "retained Namespace key unavailable");
        return result as Awaited<ReturnType<typeof use>>;
      } finally {wipe(current);}
    },
    publishOutput: async request => {
      active(request.signal);
      requireIntegrity((d.workKind === "reflection.authority_reproject" || semanticInput !== undefined && (d.workKind === "reflection.organization" || d.workKind === "reflection.dependency_rewrite")) && d.outputSlots.length === 1 && !holding && !resolving && !published && !attached
        && request.claimId === input.claimId && request.idempotencyId === d.idempotencyId, "publication outside attempt");
      const slot = d.outputSlots[0]!;
      const output = {...request, payloadBytes: Uint8Array.from(request.payloadBytes), manifestBytes: Uint8Array.from(request.manifestBytes),
        tombstoneManifestBytes: Uint8Array.from(request.tombstoneManifestBytes), signerAuthorizationBytes: Uint8Array.from(request.signerAuthorizationBytes),
        namespaceEnvelopes: request.namespaceEnvelopes.map(entry => ({namespaceId: entry.namespaceId, envelopeBytes: Uint8Array.from(entry.envelopeBytes)}))};
      holding = true;
      try {
        requireIntegrity(output.objectId === slot.objectId && equal(output.signerAuthorizationBytes, authorizationBytes)
          && JSON.stringify(output.namespaceEnvelopes.map(entry => entry.namespaceId)) === JSON.stringify(slot.namespaceIds), "output inventory substituted");
        const payload = decodeEncryptedPayloadV2(output.payloadBytes);
        try {requireIntegrity(payload.context.objectId === slot.objectId && payload.context.objectType === slot.objectType
          && payload.context.createdAt === slot.createdAt && payload.context.keyClass === "ai", "output payload context substituted");}
        finally {wipe(payload);}
        const envelopes = output.namespaceEnvelopes.map(entry => {
          const envelope = decodeNamespaceObjectEnvelopeV2(entry.envelopeBytes);
          const authority = d.namespaceRequirements.find(value => value.authority.namespaceId === entry.namespaceId)!.authority;
          try {requireIntegrity(envelope.context.objectId === slot.objectId && envelope.context.namespaceId === entry.namespaceId
            && envelope.context.keyClass === "ai" && envelope.context.keyGeneration === authority.namespaceKeyGeneration
            && envelope.context.bindingRevisionAtWrap === authority.namespaceAccessRevision, "output envelope context substituted");}
          finally {wipe(envelope);}
          return {...entry, envelopeHash: crypto.hash(entry.envelopeBytes)};
        });
        const result = await underAuthority(request.signal, async held => {
          const row = await running(held, request.claimId);
          const evidence = await loadVerifiedCurrentProcessorSignerAuthorization(held.executor, crypto, authorizationBytes);
          try {
            requireIntegrity(evidence.requestId === d.requestId && evidence.recipientGeneration === d.recipientGeneration
              && equal(evidence.certificate.descriptorBytes, descriptorBytes) && equal(evidence.certificate.credentialHash, credentialHash)
              && evidence.certificate.credentialId === row.credential_id && equal(evidence.issuerPublicKey, held.issuerSigningPublicKey), "accepted signer evidence substituted");
            const verify = (manifestBytes: Uint8Array) => verifyCommonObjectAccessManifest(crypto, {manifestBytes,
              resolveAgentRuntimeSignerPublicKey: () => null, resolveHistoricalHumanDeviceSigningPublicKey: () => null,
              resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
              resolveHistoricalCurrentIssuer: candidate => matches(candidate) ? evidence.issuerPublicKey : null,
              resolveProcessorSignerAuthorizationBytes: requested => requested.authorizationId === evidence.certificate.credentialId
                && equal(requested.authorizationHash, evidence.authorizationHash) ? authorizationBytes : null});
            const manifest = verify(output.manifestBytes);
            const tombstone = verify(output.tombstoneManifestBytes);
            try {
              const payloadHash = crypto.hash(output.payloadBytes);
              requireIntegrity(manifest.manifest.objectId === slot.objectId && manifest.manifest.accessRevision === 0
                && manifest.manifest.previousManifestHash === null && equal(manifest.manifest.payloadHash, payloadHash)
                && manifest.manifest.envelopeHashes.length === envelopes.length
                && [...envelopes].sort((a, b) => Buffer.compare(a.envelopeHash, b.envelopeHash))
                  .every((entry, i) => equal(entry.envelopeHash, manifest.manifest.envelopeHashes[i]!))
                && tombstone.manifest.objectId === slot.objectId && tombstone.manifest.accessRevision === 1
                && tombstone.manifest.previousManifestHash !== null && equal(tombstone.manifest.previousManifestHash, manifest.manifestHash)
                && equal(tombstone.manifest.payloadHash, payloadHash) && tombstone.manifest.envelopeHashes.length === 0, "signed output inventory conflicts");
              const exact: ExactNamespaceSetOutput = {objectId: slot.objectId, payloadBytes: output.payloadBytes, payloadHash,
                namespaceEnvelopes: envelopes, manifestBytes: output.manifestBytes, manifestHash: manifest.manifestHash,
                tombstoneManifestBytes: output.tombstoneManifestBytes, tombstoneManifestHash: tombstone.manifestHash};
              await held.executor.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 242))", [slot.objectId]);
              requireIntegrity(row.transform_committed_at === null, "persisted output requires fresh reconciliation");
              requireIntegrity(await readExistingOutput(held.executor, exact) === "absent", "output already exists without this commit");
              permit = held.issuerSigningPublicKey;
              let at: number;
              try {at = await request.authorizeCommit();} finally {permit = undefined;}
              requireIntegrity(at < d.expiresAt && row.claim_expires_at !== null && at < new Date(row.claim_expires_at as string | Date).getTime(), "claim expired before publication");
              active(request.signal);
              await insertExactOutput(held.executor, exact);
              const table = backgroundCryptoAuthorizationRequests;
              const marker = await executeTypedCryptoQuery(held.executor, cryptoTypedDb.update(table).set({transformCommitClaimId: request.claimId,
                transformCommitDescriptorHash: context.descriptorHash, transformCommitRecipientGeneration: d.recipientGeneration,
                transformCommitOutputCount: 1, transformCommittedAt: new Date(at)})
                .where(and(eq(table.requestId, d.requestId), eq(table.state, "running"), eq(table.claimId, request.claimId),
                  eq(table.descriptorHash, context.descriptorHash), isNull(table.transformCommittedAt))).returning({requestId: table.requestId}));
              requireIntegrity(marker.length === 1, "transform marker not stored");
              return true;
            } finally {
              for (const verified of [manifest, tombstone]) {
                if (verified.currentSignerAuthorization !== null) destroyVerifiedProcessorSignerAuthorizationV2(verified.currentSignerAuthorization);
                wipe(verified);
              }
            }
          } finally {destroyVerifiedCurrentProcessorSignerEvidence(evidence);}
        });
        requireIntegrity(result === true, "publication authority unavailable"); published = true;
      } finally {permit = undefined; holding = false; wipe(output);}
    },
    attach: async request => {
      active(request.signal);
      const outputId = d.workKind === "reflection.authority_reproject" ? d.outputSlots[0]!.objectId : d.inputBindings[0]!.objectId;
      requireIntegrity(request.claimId === input.claimId && !holding && !resolving && !attached && request.recordRef === d.source.recordRef && request.objectId === outputId
        && (d.workKind === "reflection.publication_reconcile" || published), "attachment outside attempt");
      holding = true;
      try {
        const result = await underAuthority(request.signal, async held => {
          const row = await running(held, request.claimId);
          requireIntegrity(d.workKind === "reflection.publication_reconcile" ? row.transform_committed_at === null
            : row.transform_committed_at !== null && row.transform_commit_claim_id === request.claimId
              && row.transform_commit_descriptor_hash instanceof Uint8Array && equal(row.transform_commit_descriptor_hash, context.descriptorHash), "attachment commit marker conflicts");
          let called = false;
          await (input as ReflectionAuthorityObjectPortInput).attach({recordRef: request.recordRef, objectId: request.objectId, plaintext: request.plaintext, claimId: request.claimId, signal: request.signal, held, authorizeCommit: async () => {
            requireIntegrity(!called, "attachment authorization reused"); called = true; permit = held.issuerSigningPublicKey;
            try {
              const at = await request.authorizeCommit();
              requireIntegrity(at < d.expiresAt && row.claim_expires_at !== null && at < new Date(row.claim_expires_at as string | Date).getTime(), "attachment lease expired");
              return at;
            } finally {permit = undefined;}
          }});
          requireIntegrity(called, "attachment skipped current authorization");
          active(request.signal); return true;
        });
        requireIntegrity(result === true, "attachment authority unavailable"); attached = true;
      } finally {permit = undefined; holding = false;}
    },
  };
  const semanticObjects: ReflectionSemanticObjectPortV2 | undefined = semanticInput === undefined ? undefined : {
    openObject: objects.openObject,
    withNamespaceKey: objects.withNamespaceKey,
    publishOutput: objects.publishOutput,
    validateInput: async request => {
      await beforeAccess(request.signal);
      requireIntegrity(d.inputBindings.some(binding => binding.objectId === request.objectId && binding.namespaceId === request.namespaceId
        && "objectType" in binding && binding.objectType === request.objectType), "semantic input validation outside inventory");
      await semanticInput.validateInput(request);
      active(request.signal);
    },
    validateOutput: async request => {
      await beforeAccess(request.signal);
      requireIntegrity(d.outputSlots.some(slot => slot.objectId === request.objectId), "semantic output validation outside inventory");
      await semanticInput.validateOutput(request);
      active(request.signal);
    },
    attach: async request => {
      active(request.signal);
      requireIntegrity(request.claimId === input.claimId && !holding && !resolving && !attached, "semantic attachment outside attempt");
      const empty = request.output === null;
      requireIntegrity(empty ? !published : published && d.outputSlots[0]?.objectId === request.output.objectId, "semantic attachment inventory conflicts");
      holding = true;
      try {
        const result = await underAuthority(request.signal, async held => {
          const row = await running(held, request.claimId);
          requireIntegrity(empty ? row.transform_committed_at === null : row.transform_committed_at !== null
            && row.transform_commit_claim_id === request.claimId && row.transform_commit_recipient_generation !== null && Number(row.transform_commit_recipient_generation) === d.recipientGeneration
            && row.transform_commit_output_count === 1 && row.transform_commit_descriptor_hash instanceof Uint8Array
            && equal(row.transform_commit_descriptor_hash, context.descriptorHash), "semantic attachment commit marker conflicts");
          let state: "idle" | "checking" | "checked" | "closed" = "idle";
          let checkedAt: number | undefined;
          let failure: Error | undefined;
          try {
            await semanticInput.attach({...request, held, authorizeCommit: async () => {
              active(request.signal);
              if (state !== "idle") {failure = new Error("Reflection semantic attachment authorization reused"); throw failure;}
              state = "checking"; permit = held.issuerSigningPublicKey;
              try {
                const at = await request.authorizeCommit();
                requireIntegrity(at < d.expiresAt && row.claim_expires_at !== null && at < new Date(row.claim_expires_at as string | Date).getTime(), "semantic attachment lease expired");
                active(request.signal); checkedAt = at; state = "checked"; return at;
              } catch (error) {failure = error instanceof Error ? error : new Error("Reflection semantic authorization failed"); throw failure;}
              finally {permit = undefined;}
            }});
            if (failure !== undefined) throw failure;
            requireIntegrity((state as string) === "checked" && checkedAt !== undefined, "semantic attachment skipped current authorization");
            active(request.signal);
            if (empty) {
              const table = backgroundCryptoAuthorizationRequests;
              const marker = await executeTypedCryptoQuery(held.executor, cryptoTypedDb.update(table).set({transformCommitClaimId: request.claimId,
                transformCommitDescriptorHash: context.descriptorHash, transformCommitRecipientGeneration: d.recipientGeneration,
                transformCommitOutputCount: 0, transformCommittedAt: new Date(checkedAt)})
                .where(and(eq(table.requestId, d.requestId), eq(table.state, "running"), eq(table.claimId, request.claimId),
                  eq(table.descriptorHash, context.descriptorHash), isNull(table.transformCommittedAt))).returning({requestId: table.requestId}));
              requireIntegrity(marker.length === 1, "semantic no-change marker not stored");
            }
            active(request.signal); return true;
          } finally {state = "closed";}
        });
        requireIntegrity(result === true, "semantic attachment authority unavailable"); attached = true;
      } finally {permit = undefined; holding = false;}
    },
  };
  return Object.freeze({objects: semanticObjects ?? objects, resolveCurrentIssuer, dispose() {
    disposed = true; permit = undefined; wipe(context); descriptorBytes.fill(0); responseHash.fill(0); credentialHash.fill(0); authorizationBytes.fill(0);
  }});
}
