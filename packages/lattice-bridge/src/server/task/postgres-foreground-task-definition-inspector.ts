import { assertProtectedTaskOperationalMetadataProjectionV1 } from "@nautilo/types";
import { withCurrentHumanTaskMappedContentAuthority, type HumanTaskMappedContentAuthorityInput, type HeldHumanTaskMappedContentAuthority } from "./postgres-human-task-mapped-content-authority.ts";
import { PostgresHumanDeviceSignerHistory } from "../storage/postgres-human-device-signer-history.ts";
import { captureForegroundTaskDefinitionAuthor, createPostgresForegroundAgentAcceptedExecutionEvidenceResolver } from "../message/postgres-foreground-agent-signer.ts";
import { verifyConversationProductPostgresHandle } from "../message/postgres-conversation-product-store.ts";
import { isDeepStrictEqual } from "node:util";
import { and, eq, namespaceDomainKeyHeads, objectCryptoAccessHeads } from "@nautilo/db";
import { decryptObjectThroughNamespace, type LatticeCrypto } from "@nautilo/lattice-crypto";
import { decodeEncryptedPayloadV2, decodeNamespaceObjectEnvelopeV2,
  decodeObjectAccessManifestV5 } from "@nautilo/lattice-crypto/wire";
import type { AgentEntityCryptoInvocation } from "../../object/agent-entity-crypto.ts";
import type { TaskContentAuthorityV1 } from "../../task/task-content-authority-v1.ts";
import { deriveTaskContentCryptoObjectIdV1, taskContentRevisionObjectIdV1, fingerprintTaskContentAuthorityV1,
  fingerprintTaskContentNamespaceV1, sameTaskContentCoordinateV1, taskContentObjectTypeV1,
  type TaskContentProductStorePort, type TaskContentRevisionLifecycleV1, type VerifiedForegroundTaskDefinitionPublication,
  type TaskDefinitionContentCoordinateV1, type TaskContentCoordinateV1 } from "../../task/task-content-repository.ts";
import { decodeTaskDefinitionContent, encodeTaskDefinitionContent, encodeTaskPayloadV1,
  type DecodedTaskDefinitionContent, type TaskDefinitionContent, type TaskPayloadV1 } from "../../task/task-payload-v1.ts";
import { cryptoTypedDb, executeTypedCryptoQuery } from "../storage/postgres-lattice-storage.ts";
import { assertVerifiedCryptoPostgresHandle, withVerifiedCryptoPostgresTransaction,
  type CryptoPostgresHandle } from "../storage/postgres-lattice-storage.ts";
import { readDurableTaskContentPublication } from "./postgres-task-content-crypto-completion.ts";
import type { ResolveTaskDefinitionForegroundAuthorization } from "../storage/postgres-object-access-manifest-v5.ts";

/** This is an inspected existing object, never a newly prepared genesis. */
export type { VerifiedForegroundTaskDefinitionPublication } from "../../task/task-content-repository.ts";
type Durable = NonNullable<Awaited<ReturnType<typeof readDurableTaskContentPublication>>>;
type Custody = Readonly<{ coordinate: TaskContentCoordinateV1; authority: TaskContentAuthorityV1;
  durable: Durable; expectedPayload: Uint8Array; expectedRequestDigest?: Uint8Array;
  metadataOnly?: true; assertMetadataCurrent?(): void; mappedLifecycle?: TaskContentRevisionLifecycleV1; assertCurrent(): Promise<void> }>;
const custody = new WeakMap<VerifiedForegroundTaskDefinitionPublication, Custody>();
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
function read(proof: VerifiedForegroundTaskDefinitionPublication): Custody {
  const value = custody.get(proof);
  if (value === undefined) throw new TypeError("Foreground Task inspection proof is foreign or closed");
  value.assertMetadataCurrent?.();
  return value;
}
function checkLifecycle(value: Custody, lifecycle: TaskContentRevisionLifecycleV1): void {
  const mapped = value.mappedLifecycle;
  if (mapped !== undefined && (lifecycle.disposition !== "mapped" || lifecycle.completion !== "complete"
    || mapped.sequence !== lifecycle.sequence || mapped.operationId !== lifecycle.operationId
    || mapped.representation !== lifecycle.representation
    || !same(mapped.authorityFingerprint, lifecycle.authorityFingerprint)
    || !same(mapped.requiredNamespaceFingerprint, lifecycle.requiredNamespaceFingerprint)
    || !same(mapped.requestDigest, lifecycle.requestDigest)
    || !isDeepStrictEqual(mapped.historicalRepair, lifecycle.historicalRepair))) {
    throw new TypeError("Mapped Task inspection reservation changed");
  }
  if (!sameTaskContentCoordinateV1(value.coordinate, lifecycle.coordinate)
    || lifecycle.cryptoObjectId !== value.durable.objectId
    || lifecycle.namespaceId !== value.authority.namespaceId
    || lifecycle.requesterHumanId !== value.authority.requesterHumanId
    || (lifecycle.historicalRepair != null
      ? value.metadataOnly !== true || lifecycle.historicalRepair.version !== 2
        || lifecycle.historicalRepair.genesisManifestHash !== Array.from(value.durable.genesisManifestHash, byte => byte.toString(16).padStart(2, "0")).join("")
      // A mapped reservation retains its signed-request or semantic-operation
      // digest. The exact held snapshot above binds it independently of ciphertext.
      : !(value.metadataOnly === true && mapped !== undefined)
        && !same(lifecycle.requestDigest, value.expectedRequestDigest ?? value.durable.genesisManifestHash))) {
    throw new TypeError("Foreground Task inspection does not match its reservation");
  }
}
/** A mapped-only metadata proof never authorizes initial publication or content changes. */
export function isVerifiedMappedTaskContentMetadataProof(proof: VerifiedForegroundTaskDefinitionPublication): boolean {
  return read(proof).metadataOnly === true;
}
/** Public immutable history only: this proof confers no current read or write authority. */
export type VerifiedTaskDefinitionAccessLineage = Readonly<{ kind: "verified_task_definition_access_lineage" }>;
type DefinitionLineage = Readonly<{
  coordinate: TaskDefinitionContentCoordinateV1; objectId: string; namespaceId: string;
  head: number; genesisHash: string; payloadHash: string;
}>;
const definitionLineage = new WeakMap<VerifiedTaskDefinitionAccessLineage, DefinitionLineage>();
function mintDefinitionLineage(coordinate: TaskDefinitionContentCoordinateV1, durable: Durable): VerifiedTaskDefinitionAccessLineage {
  const proof = Object.freeze({ kind: "verified_task_definition_access_lineage" as const });
  definitionLineage.set(proof, Object.freeze({ coordinate: Object.freeze({ ...coordinate }),
    objectId: durable.objectId, namespaceId: durable.namespaceId, head: durable.accessRevision,
    genesisHash: Buffer.from(durable.genesisManifestHash).toString("hex"),
    payloadHash: Buffer.from(durable.payloadHash).toString("hex") }));
  return proof;
}
/** Recheck the detached history against the exact currently locked product coordinate. */
export function readVerifiedTaskDefinitionAccessLineage(proof: VerifiedTaskDefinitionAccessLineage, input: Readonly<{
  taskId: string; contentRevision: number; contentObjectId: string;
  contentNamespaceId: string; contentAccessRevision: number;
}>): readonly number[] {
  const value = definitionLineage.get(proof);
  if (value === undefined || value.coordinate.taskId !== input.taskId
    || value.coordinate.contentRevision !== input.contentRevision || value.objectId !== input.contentObjectId
    || value.namespaceId !== input.contentNamespaceId || value.head !== input.contentAccessRevision) {
    throw new TypeError("Task access lineage is foreign or no longer matches the mapped definition");
  }
  // The durable verifier authenticated every contiguous prefix and one immutable payload.
  return Object.freeze(Array.from({ length: value.head + 1 }, (_, revision) => revision));
}

/** Detached history discovery performs no crypto lock and grants no current authority. */
export async function inspectMappedTaskDefinitionAccessLineage(input: Readonly<{
  handle: CryptoPostgresHandle; crypto: LatticeCrypto; coordinate: TaskDefinitionContentCoordinateV1;
  objectId: string; namespaceId: string; requesterHumanId: string;
  mappedAccessRevision: number; expectedAgentId: string;
  resolveHistoricalAgentSignerAuthority: Parameters<typeof readDurableTaskContentPublication>[0]["resolveHistoricalAgentSignerAuthority"];
  resolveForegroundAgentAcceptedExecutionEvidence?: Parameters<typeof readDurableTaskContentPublication>[0]["resolveForegroundAgentAcceptedExecutionEvidence"];
  resolveHistoricalHumanDeviceSigningPublicKey?: Parameters<typeof readDurableTaskContentPublication>[0]["resolveHistoricalHumanDeviceSigningPublicKey"];
  resolveTaskDefinitionForegroundAuthorization?: Parameters<typeof readDurableTaskContentPublication>[0]["resolveTaskDefinitionForegroundAuthorization"];
}>): Promise<VerifiedTaskDefinitionAccessLineage | null> {
  assertVerifiedCryptoPostgresHandle(input.handle);
  const pinned = { ...input, coordinate: Object.freeze({ ...input.coordinate }) };
  return withVerifiedCryptoPostgresTransaction(input.handle, async handle => {
  const domains = await executeTypedCryptoQuery(handle, cryptoTypedDb.select({
    domainId: namespaceDomainKeyHeads.domainId,
  }).from(namespaceDomainKeyHeads).where(and(
    eq(namespaceDomainKeyHeads.namespaceId, pinned.namespaceId),
    eq(namespaceDomainKeyHeads.keyClass, "ai"),
  )).limit(2));
  const author = captureForegroundTaskDefinitionAuthor({
    resolveEvidence: pinned.resolveForegroundAgentAcceptedExecutionEvidence,
    resolveTaskDefinitionForegroundAuthorization:
      pinned.resolveTaskDefinitionForegroundAuthorization,
    subjectHumanId: pinned.requesterHumanId,
    namespaceId: pinned.namespaceId,
    domainId: domains.length === 1 ? domains[0]!.domain_id : null,
  });
  const durable = await readDurableTaskContentPublication({ ...pinned,
    executor: handle,
    resolveForegroundAgentAcceptedExecutionEvidence: author.resolveEvidence,
    resolveTaskDefinitionForegroundAuthorization:
      author.resolveTaskDefinitionForegroundAuthorization,
  });
  if (durable === null) return null;
  try {
    const genesis = decodeObjectAccessManifestV5(durable.genesisManifestBytes);
    const payload = decodeEncryptedPayloadV2(durable.payloadBytes);
    try {
      if (durable.accessRevision !== pinned.mappedAccessRevision || durable.namespaceId !== pinned.namespaceId
        || payload.context.objectType !== taskContentObjectTypeV1(pinned.coordinate) || payload.context.keyClass !== "ai"
        || payload.context.objectId !== pinned.objectId
        || (genesis.signer.kind === "human_device"
          ? genesis.signer.subjectHumanId !== pinned.requesterHumanId
          : genesis.signer.kind !== "agent_runtime"
            || genesis.signer.agentId !== pinned.expectedAgentId
              && !author.authorizes(genesis.signer))) return null;
      return mintDefinitionLineage(pinned.coordinate, durable);
    } finally { payload.ciphertext.fill(0); }
  } finally { for (const bytes of Object.values(durable)) if (bytes instanceof Uint8Array) bytes.fill(0); }
  });
}

/** Product mapping can consume only the live inspector's exact current head. */
export function readVerifiedForegroundTaskDefinitionAccessRevision(
  proof: VerifiedForegroundTaskDefinitionPublication,
  input: Readonly<{ lifecycle: TaskContentRevisionLifecycleV1; currentAuthority: TaskContentAuthorityV1; ordinaryPayload?: TaskPayloadV1 }>,
): number {
  const value = read(proof);
  checkLifecycle(value, input.lifecycle);
  if (!same(fingerprintTaskContentAuthorityV1(value.authority), fingerprintTaskContentAuthorityV1(input.currentAuthority))) {
    throw new TypeError("Foreground Task inspected authority changed");
  }
  if (input.ordinaryPayload !== undefined && value.metadataOnly !== true) {
    const ordinary = encodeTaskPayloadV1(input.ordinaryPayload);
    try {
      if (!same(ordinary, value.expectedPayload)) throw new TypeError("Foreground Task ordinary definition changed");
    } finally { ordinary.fill(0); }
  }
  return value.durable.accessRevision;
}

export type InspectForegroundTaskDefinitionInput = Readonly<{
  handle: CryptoPostgresHandle; crypto: LatticeCrypto; taskId: string; expectedAgentId: string;
  contentRevision?: number;
  payload: TaskDefinitionContent; currentAuthority: TaskContentAuthorityV1; entities: AgentEntityCryptoInvocation;
  resolveForegroundAgentAcceptedExecutionEvidence?: Parameters<typeof readDurableTaskContentPublication>[0]["resolveForegroundAgentAcceptedExecutionEvidence"];
  resolveHistoricalAgentSignerAuthority: Parameters<typeof readDurableTaskContentPublication>[0]["resolveHistoricalAgentSignerAuthority"];
  resolveHistoricalHumanDeviceSigningPublicKey?: Parameters<typeof readDurableTaskContentPublication>[0]["resolveHistoricalHumanDeviceSigningPublicKey"];
  resolveTaskDefinitionForegroundAuthorization?: Parameters<typeof readDurableTaskContentPublication>[0]["resolveTaskDefinitionForegroundAuthorization"];
  assertCurrent(): void | Promise<void>;
}>;

/** Verify and compare plaintext only inside a fresh current foreground key loan. */
export async function withVerifiedForegroundTaskDefinitionPublication<Value>(input: InspectForegroundTaskDefinitionInput & Readonly<{
  /** Recovery of an edit retains its semantic request identity. Creation uses the genesis hash. */
  expectedRequestDigest?: Uint8Array;
  use(proof: VerifiedForegroundTaskDefinitionPublication): Promise<Value>;
}>): Promise<Readonly<{ status: "missing" | "unavailable" }> | Readonly<{ status: "verified"; value: Value }>> {
  const contentRevision = input.contentRevision ?? 1;
  if (!Number.isSafeInteger(contentRevision) || contentRevision < 1) throw new TypeError("Foreground Task definition revision is invalid");
  if (input.expectedRequestDigest !== undefined
    && (!(input.expectedRequestDigest instanceof Uint8Array) || input.expectedRequestDigest.length !== 32)) {
    throw new TypeError("Foreground Task expected request digest is invalid");
  }
  const expectedRequestDigest = input.expectedRequestDigest === undefined
    ? undefined : Uint8Array.from(input.expectedRequestDigest);
  try {
    return await inspectDefinition({ ...input,
      ...(expectedRequestDigest === undefined ? {} : { expectedRequestDigest }),
      coordinate: { kind: "definition", taskId: input.taskId, contentRevision },
      signerPolicy: "agent_creation",
      consume: plaintext => {
        const expected = encodeTaskDefinitionContent(input.payload);
        try {
          if (!same(plaintext, expected)) throw new TypeError("Foreground Task stored definition source changed");
        } finally { expected.fill(0); }
        const proof = Object.freeze({ kind: "verified_foreground_task_definition" as const });
        return Promise.resolve({ proof, use: () => input.use(proof) });
      } });
  } finally { expectedRequestDigest?.fill(0); }
}

export type OpenForegroundTaskDefinitionInput = Omit<InspectForegroundTaskDefinitionInput, "payload">;

/** Open one exact current foreground definition only for the supplied callback.
 * Plaintext bytes and the Namespace key loan are wiped before this returns. */
export async function withOpenForegroundTaskDefinition<Value>(input: OpenForegroundTaskDefinitionInput & Readonly<{
  use(content: DecodedTaskDefinitionContent): Promise<Value>;
}>): Promise<Readonly<{ status: "missing" | "unavailable" }> | Readonly<{ status: "opened"; value: Value }>> {
  const contentRevision = input.contentRevision ?? 1;
  if (!Number.isSafeInteger(contentRevision) || contentRevision < 1) throw new TypeError("Foreground Task definition revision is invalid");
  const result = await inspectDefinition({ ...input,
    coordinate: { kind: "definition", taskId: input.taskId, contentRevision },
    signerPolicy: "supported_current",
    consume: plaintext => Promise.resolve({ use: () => input.use(decodeTaskDefinitionContent(plaintext)) }),
  });
  return result.status === "verified" ? { status: "opened", value: result.value } : result;
}

async function inspectDefinition<Value>(input:
  Omit<InspectForegroundTaskDefinitionInput, "taskId" | "payload"> & Readonly<{
    coordinate: TaskDefinitionContentCoordinateV1;
    expectedRequestDigest?: Uint8Array;
    signerPolicy: "agent_creation" | "supported_current";
    consume(plaintext: Uint8Array): Promise<Readonly<{
      proof?: VerifiedForegroundTaskDefinitionPublication;
      use(): Promise<Value>;
    }>>;
  }>): Promise<Readonly<{ status: "missing" | "unavailable" }> | Readonly<{ status: "verified"; value: Value }>> {
  assertVerifiedCryptoPostgresHandle(input.handle);
  const coordinate = Object.freeze({ ...input.coordinate });
  const objectId = deriveTaskContentCryptoObjectIdV1(coordinate);
  const authority = Object.freeze({ ...input.currentAuthority });
  const expectedAgentId = input.expectedAgentId;
  const assertCurrent = async () => { input.entities.signal.throwIfAborted(); await input.assertCurrent(); input.entities.signal.throwIfAborted(); };
  await assertCurrent();
  return withVerifiedCryptoPostgresTransaction(input.handle, async handle => {
      // The caller already holds the canonical product authority. Keep the inspected
      // access head stable through reservation and mapping, including rewrap races.
      await executeTypedCryptoQuery(handle, cryptoTypedDb.select({ objectId: objectCryptoAccessHeads.objectId })
        .from(objectCryptoAccessHeads).where(eq(objectCryptoAccessHeads.objectId, objectId)).for("share"));
      const author = captureForegroundTaskDefinitionAuthor({
        resolveEvidence: input.resolveForegroundAgentAcceptedExecutionEvidence,
        resolveTaskDefinitionForegroundAuthorization:
          input.resolveTaskDefinitionForegroundAuthorization,
        subjectHumanId: authority.requesterHumanId,
        namespaceId: authority.namespaceId,
        domainId: authority.domainId,
      });
      const durable = await readDurableTaskContentPublication({ ...input,
        executor: handle,
        objectId,
        resolveForegroundAgentAcceptedExecutionEvidence: author.resolveEvidence,
        resolveTaskDefinitionForegroundAuthorization:
          author.resolveTaskDefinitionForegroundAuthorization,
      });
      if (durable === null) return { status: "missing" as const };
      const payload = decodeEncryptedPayloadV2(durable.payloadBytes);
      const envelope = decodeNamespaceObjectEnvelopeV2(durable.envelopeBytes);
      try {
        const genesis = decodeObjectAccessManifestV5(durable.genesisManifestBytes);
        const signerMatches = genesis.signer.kind === "agent_runtime"
          ? genesis.signer.agentId === expectedAgentId
            || author.authorizes(genesis.signer)
          : input.signerPolicy === "supported_current" && genesis.signer.kind === "human_device"
            && genesis.signer.subjectHumanId === authority.requesterHumanId;
        if (!signerMatches
          || genesis.accessRevision !== 0 || genesis.previousManifestHash !== null
          || payload.context.objectType !== taskContentObjectTypeV1(coordinate)
          || payload.context.objectId !== objectId || payload.context.keyClass !== "ai"
          || durable.namespaceId !== authority.namespaceId
          || durable.bindingRevisionAtWrap !== authority.expectedAccessRevision) {
          throw new TypeError("Foreground Task stored definition identity or authority disagrees");
        }
        const opened = await input.entities.use({ operations: ["decrypt"], entity: {
          namespaceId: authority.namespaceId, keyGeneration: envelope.context.keyGeneration,
          accessRevision: envelope.context.bindingRevisionAtWrap,
        }, execute: async ({ namespaceKey, authority: current }) => {
          await assertCurrent();
          if (current.namespaceId !== authority.namespaceId || current.domainId !== authority.domainId
            || current.namespaceAccessRevision !== authority.expectedAccessRevision
            || current.namespaceKeyGeneration !== envelope.context.keyGeneration) {
            throw new TypeError("Foreground Task current private Namespace changed");
          }
          const plaintext = decryptObjectThroughNamespace(input.crypto, namespaceKey, envelope, payload);
          if (plaintext === null) throw new TypeError("Foreground Task stored definition cannot be opened");
          try {
            const consumed = await input.consume(plaintext);
            await assertCurrent();
            const proof = consumed.proof;
            if (proof === undefined) {
              const result = await consumed.use();
              await assertCurrent();
              return result;
            }
            const expectedPayload = Uint8Array.from(plaintext);
            const value: Custody = { coordinate, authority, durable, expectedPayload,
              ...(input.expectedRequestDigest === undefined ? {} : { expectedRequestDigest: input.expectedRequestDigest }),
              assertCurrent: async () => {
              read(proof); await assertCurrent(); read(proof);
            } };
            custody.set(proof, value);
            try {
              const result = await consumed.use();
              await assertCurrent();
              return result;
            } finally { custody.delete(proof); expectedPayload.fill(0); }
          } finally { plaintext.fill(0); }
        } });
        return opened.status === "executed" ? { status: "verified" as const, value: opened.value }
          : { status: "unavailable" as const };
      } finally {
        payload.ciphertext.fill(0); envelope.wrappedDek.fill(0);
        for (const bytes of Object.values(durable)) if (bytes instanceof Uint8Array) bytes.fill(0);
      }
  });
}

/** Reserve and map already verified bytes; this never encrypts or completes crypto. */
export async function publishVerifiedForegroundTaskDefinition(input: Readonly<{
  proof: VerifiedForegroundTaskDefinitionPublication; product: TaskContentProductStorePort;
  operationId: string; representation: "protected" | "dual";
  operationalMetadata: Parameters<TaskContentProductStorePort["reserveRevision"]>[0]["operationalMetadata"];
}>): Promise<"mapped" | "replayed"> {
  if (input.operationalMetadata !== null) assertProtectedTaskOperationalMetadataProjectionV1(input.operationalMetadata);
  // The classifier returns a frozen, branded projection; cloning loses that authority.
  input = { ...input };
  const value = read(input.proof);
  if (value.metadataOnly === true || value.coordinate.kind !== "definition") throw new TypeError("Mapped metadata proof cannot publish a definition");
  if (value.mappedLifecycle !== undefined) throw new TypeError("Mapped Task inspection cannot publish a creation");
  await value.assertCurrent();
  const existing = await input.product.getRevision(value.coordinate);
  await value.assertCurrent();
  let lifecycle: TaskContentRevisionLifecycleV1;
  if (existing !== null) {
    lifecycle = existing.lifecycle;
    checkLifecycle(value, lifecycle);
    if (lifecycle.disposition === "mapped" && (existing.product === null
      || existing.product.cryptoMappingState !== "verified"
      || existing.product.cryptoObjectId !== lifecycle.cryptoObjectId
      || existing.product.namespaceId !== lifecycle.namespaceId
      || existing.product.representation !== lifecycle.representation
      || !sameTaskContentCoordinateV1(existing.product.coordinate, lifecycle.coordinate))) {
      throw new TypeError("Foreground Task mapped creation no longer exists");
    }
    if (lifecycle.operationId !== input.operationId || lifecycle.representation !== input.representation
      || !isDeepStrictEqual(lifecycle.operationalMetadata, input.operationalMetadata)
      || !["active", "mapped"].includes(lifecycle.disposition)) throw new TypeError("Foreground Task reservation changed");
  } else {
    const reserved = await input.product.reserveRevision({ coordinate: value.coordinate, operationId: input.operationId,
      requesterHumanId: value.authority.requesterHumanId, namespaceId: value.authority.namespaceId,
      authorityFingerprint: fingerprintTaskContentAuthorityV1(value.authority),
      requiredNamespaceFingerprint: fingerprintTaskContentNamespaceV1(value.authority.namespaceId),
      representation: input.representation, requestDigest: Uint8Array.from(value.expectedRequestDigest ?? value.durable.genesisManifestHash),
      cryptoObjectId: value.durable.objectId, objectType: taskContentObjectTypeV1(value.coordinate), payloadVersion: 1,
      operationalMetadata: input.operationalMetadata });
    if (!("state" in reserved)) throw new Error("Foreground Task reservation is unavailable");
    lifecycle = reserved.state.lifecycle;
    checkLifecycle(value, lifecycle);
  }
  await value.assertCurrent(); read(input.proof);
  if (lifecycle.completion !== "complete") {
    const complete = await input.product.markCryptoComplete({ coordinate: value.coordinate,
      cryptoObjectId: value.durable.objectId, leaseToken: null });
    if (complete !== "applied" && complete !== "duplicate") throw new Error("Foreground Task completion is unavailable");
  }
  await value.assertCurrent();
  const mapped = await input.product.compareAndSwapCryptoMapping({ coordinate: value.coordinate,
    cryptoObjectId: value.durable.objectId, expectedAuthorityFingerprint: lifecycle.authorityFingerprint,
    expectedRepresentation: input.representation, leaseToken: null, foregroundDefinitionProof: input.proof });
  if (mapped !== "applied" && mapped !== "duplicate") throw new Error("Foreground Task mapping is unavailable");
  await value.assertCurrent(); read(input.proof);
  return mapped === "duplicate" ? "replayed" : "mapped";
}

/** Repair existing mapped content before a fresh grant captures its access head. */
export async function refreshHumanMappedTaskContentAccessHead(
  input: HumanTaskMappedContentAuthorityInput & Readonly<{
    resolveTaskDefinitionForegroundAuthorization?: (
      evidence: Parameters<ResolveTaskDefinitionForegroundAuthorization>[0],
      context: HeldHumanTaskMappedContentAuthority,
    ) => ReturnType<ResolveTaskDefinitionForegroundAuthorization>;
    /** Runs under the current Human/Task/claim locks; proof expires before the outer commit. */
    withMappedHead?(input: Readonly<{ context: HeldHumanTaskMappedContentAuthority;
      proof: VerifiedForegroundTaskDefinitionPublication; lineage: VerifiedTaskDefinitionAccessLineage | null;
      lifecycle: TaskContentRevisionLifecycleV1; currentAccessRevision: number;
    }>): Promise<void>;
  }>,
): Promise<"applied" | "duplicate" | "unavailable"> {
  const result = await withCurrentHumanTaskMappedContentAuthority({ ...input, use: async context => {
    const state = structuredClone(context.state);
    const { lifecycle, product } = state;
    const authority = context.currentAuthority;
    if (lifecycle.completion !== "complete" || lifecycle.disposition !== "mapped"
      || product === null || product.cryptoMappingState !== "verified" || product.cryptoObjectId !== lifecycle.cryptoObjectId
      || !sameTaskContentCoordinateV1(product.coordinate, lifecycle.coordinate) || product.namespaceId !== lifecycle.namespaceId
      || product.representation !== lifecycle.representation || product.cryptoRequiredNamespaceFingerprint === null
      || !same(product.cryptoRequiredNamespaceFingerprint, lifecycle.requiredNamespaceFingerprint)
      || lifecycle.requesterHumanId !== authority.requesterHumanId || lifecycle.namespaceId !== authority.namespaceId
      || (lifecycle.historicalRepair != null && lifecycle.historicalRepair.version !== 2)
      || lifecycle.cryptoObjectId !== taskContentRevisionObjectIdV1({ coordinate: lifecycle.coordinate,
        namespaceId: lifecycle.namespaceId, historicalRepair: lifecycle.historicalRepair ?? null })) return "unavailable" as const;
    const history = new PostgresHumanDeviceSignerHistory({ handle: context.handle, crypto: input.crypto });
    await executeTypedCryptoQuery(context.handle, cryptoTypedDb.select({ objectId: objectCryptoAccessHeads.objectId })
      .from(objectCryptoAccessHeads).where(eq(objectCryptoAccessHeads.objectId, lifecycle.cryptoObjectId)).for("share"));
    const suppliedTaskDefinitionAuthorization =
      input.resolveTaskDefinitionForegroundAuthorization;
    const resolveTaskDefinitionForegroundAuthorization =
      suppliedTaskDefinitionAuthorization === undefined
        ? undefined
        : async (
            evidence: Parameters<
              ResolveTaskDefinitionForegroundAuthorization
            >[0],
          ) => {
            context.assertCurrent();
            const signerPublicKey = await suppliedTaskDefinitionAuthorization(
              evidence,
              context,
            );
            try {
              context.assertCurrent();
              return signerPublicKey;
            } catch (cause) {
              signerPublicKey?.fill(0);
              throw cause;
            }
          };
    const author = captureForegroundTaskDefinitionAuthor({
      resolveEvidence: createPostgresForegroundAgentAcceptedExecutionEvidenceResolver({
        product: await verifyConversationProductPostgresHandle(context.product), crypto: input.crypto,
        rejectInvalidSelectedEvidence: true,
      }),
      resolveTaskDefinitionForegroundAuthorization:
        resolveTaskDefinitionForegroundAuthorization,
      subjectHumanId: authority.requesterHumanId,
      namespaceId: lifecycle.namespaceId,
      domainId: authority.domainId,
    });
    const durable = await readDurableTaskContentPublication({ executor: context.handle, crypto: input.crypto,
      objectId: lifecycle.cryptoObjectId, resolveHistoricalAgentSignerAuthority: history.resolveAgentRuntimeSignerManager,
      resolveForegroundAgentAcceptedExecutionEvidence: author.resolveEvidence,
      resolveTaskDefinitionForegroundAuthorization:
        author.resolveTaskDefinitionForegroundAuthorization,
    });
    if (durable === null) return "unavailable" as const;
    const payload = decodeEncryptedPayloadV2(durable.payloadBytes);
    const envelope = decodeNamespaceObjectEnvelopeV2(durable.envelopeBytes);
    try {
      const genesis = decodeObjectAccessManifestV5(durable.genesisManifestBytes);
      const historical = lifecycle.historicalRepair;
      const signerMatches = genesis.signer.kind === "human_device"
        ? genesis.signer.subjectHumanId === authority.requesterHumanId
          && (historical == null || genesis.signer.committerDeviceId === historical.publisherDeviceId)
        : historical == null && genesis.signer.kind === "agent_runtime"
          && (genesis.signer.agentId === context.expectedAgentId
            || author.authorizes(genesis.signer));
      if (!signerMatches || genesis.objectId !== lifecycle.cryptoObjectId || genesis.accessRevision !== 0
        || genesis.previousManifestHash !== null || payload.context.objectId !== lifecycle.cryptoObjectId
        || payload.context.objectType !== taskContentObjectTypeV1(lifecycle.coordinate) || payload.context.keyClass !== "ai"
        || durable.namespaceId !== authority.namespaceId || durable.bindingRevisionAtWrap !== authority.expectedAccessRevision
        || envelope.context.keyGeneration !== context.namespaceKeyGeneration
        || durable.accessRevision < product.cryptoAccessRevision) throw new TypeError("Mapped Task metadata access proof disagrees");
      const proof = Object.freeze({ kind: "verified_foreground_task_definition" as const });
      const value: Custody = { coordinate: lifecycle.coordinate, authority, durable, metadataOnly: true, assertMetadataCurrent: context.assertCurrent,
        expectedPayload: new Uint8Array(), mappedLifecycle: lifecycle, assertCurrent: () => { context.assertCurrent(); read(proof); return Promise.resolve(); } };
      checkLifecycle(value, lifecycle);
      custody.set(proof, value);
      try {
        context.assertCurrent();
        const mapped = await context.store.compareAndSwapCryptoMapping({ coordinate: lifecycle.coordinate,
          cryptoObjectId: lifecycle.cryptoObjectId, expectedAuthorityFingerprint: lifecycle.authorityFingerprint,
          expectedRepresentation: lifecycle.representation, leaseToken: null, mappedMetadataProof: proof });
        context.assertCurrent();
        if (mapped !== "applied" && mapped !== "duplicate") return "unavailable" as const;
        await input.withMappedHead?.({ context, proof, lifecycle: structuredClone(lifecycle),
          currentAccessRevision: durable.accessRevision,
          lineage: lifecycle.coordinate.kind === "definition" ? mintDefinitionLineage(lifecycle.coordinate, durable) : null });
        context.assertCurrent();
        return mapped;
      } finally { custody.delete(proof); }
    } finally {
      payload.ciphertext.fill(0); envelope.wrappedDek.fill(0);
      for (const bytes of Object.values(durable)) if (bytes instanceof Uint8Array) bytes.fill(0);
    }
  } });
  return result ?? "unavailable";
}
