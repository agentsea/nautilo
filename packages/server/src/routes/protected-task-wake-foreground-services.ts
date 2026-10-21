import {
  createProtectedTaskMemoryProjectionPort,
  protectedMemoryAuthorityFromEnvelope,
} from "@nautilo/agent";
import {
  ClassifiedDataOperationError,
  createDormantConversationShadowRepository,
  MEMORY_OBJECT_TYPE,
  type ProtectedAgentMemoryEmbeddingPort,
  type ProtectedMemoryAuthority,
} from "@nautilo/lattice-bridge";
import {
  attachPostgresForegroundJournalRepair,
  attachPostgresForegroundMemoryRepair,
  attachPostgresForegroundRecordRepair,
  bindConversationProductCanonicalTransactionRunner,
  createForegroundMessageHistoryRepairer,
  createPostgresConversationCryptoCompletion,
  createPostgresForegroundAgentSignerResolver,
  createPostgresForegroundJournalSelectionPort,
  loadPostgresForegroundJournalRepairSources,
  loadPostgresForegroundMemoryRepairSources,
  loadPostgresForegroundMessageRepairSources,
  loadPostgresForegroundRecordRepairSources,
  persistDeviceWrappedAgentObject,
  PostgresDomainKeyAuthorityRepository,
  PostgresHumanDeviceSignerHistory,
  PostgresLatticeStorage,
  readVerifiedDeviceWrappedAgentObject,
  restorePostgresForegroundJournalOrdinary,
  restorePostgresForegroundMemoryOrdinary,
  restorePostgresForegroundRecordOrdinary,
  validatePostgresForegroundJournalRepairSource,
  validatePostgresForegroundMemoryRepairSource,
  validatePostgresForegroundRecordRepairSource,
  verifyConversationProductPostgresHandle,
  verifyCryptoPostgresHandle,
  createPostgresForegroundMemoryPublication,
  type AgentMemoryPublicationBoundary,
  type TaskWakeLiveShadowCurrentWriter,
} from "@nautilo/lattice-bridge/server";
import {
  assertTaskRuntimeTemporarySignerForPreparation,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  canonicalProtectedTaskSemanticAuthorityRequirements,
  type PostgresJsBridgeConnection,
} from "@nautilo/db";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  createForegroundJournalHistoryRepairer,
  createForegroundMemoryHistoryRepairer,
  createForegroundRecordHistoryRepairer,
} from "@nautilo/runtime";
import {
  findActorByHandle,
  findActorByOwnerId,
  findOrCreateAccessNamespace,
} from "@nautilo/trust";

import {
  createForegroundMemoryAccessPort,
  createForegroundProtectedTaskMemoryProjection,
  createForegroundMemoryRepository,
  resolveForegroundMemoryNativeEntries,
  type ForegroundMemoryCurrentExactAccess,
  type ForegroundMemoryCurrentExactAccessOwner,
  type ForegroundMemoryCurrentProjectionOwner,
  type ForegroundMemoryProjectionDestination,
} from "./foreground-memory-repository";
import { createForegroundProductTransactionContext } from "./foreground-message-product-store";
import type {
  ProtectedTaskWakeForegroundServices,
  ProtectedTaskWakeForegroundServicesInput,
} from "./protected-task-wake-foreground-publication";

export type ProductionProtectedTaskWakeForegroundServicesInput =
  ProtectedTaskWakeForegroundServicesInput & Readonly<{
    crypto: LatticeCrypto;
    restricted: PostgresJsBridgeConnection;
    serverScope: string;
    wakeEffectRecovery(): void;
    embedding?: ProtectedAgentMemoryEmbeddingPort;
  }>;

function unavailable(message: string): never {
  throw new ClassifiedDataOperationError("authority", message);
}

function borrow(
  connection: Pick<PostgresJsBridgeConnection, "query">,
): PostgresJsBridgeConnection {
  const transaction: PostgresJsBridgeConnection["transaction"] = use =>
    use(connection);
  return Object.freeze({
    query: connection.query.bind(connection),
    transaction,
    transactionOnce: transaction,
  });
}

function sameMemoryAuthority(
  left: ProtectedMemoryAuthority,
  right: ProtectedMemoryAuthority,
): boolean {
  if (left.mode !== right.mode
    || left.subjectUserId !== right.subjectUserId
    || left.agentId !== right.agentId) return false;
  if (left.mode === "scope" && right.mode === "scope") {
    return left.scopeId === right.scopeId
      && left.originWritableNamespaceId === right.originWritableNamespaceId;
  }
  return left.mode === "namespace" && right.mode === "namespace"
    && left.writableNamespaceId === right.writableNamespaceId
    && left.readableNamespaceIds.length === right.readableNamespaceIds.length
    && left.readableNamespaceIds.every((id, index) =>
      id === right.readableNamespaceIds[index])
    && left.mutableNamespaceIds.length === right.mutableNamespaceIds.length
    && left.mutableNamespaceIds.every((id, index) =>
      id === right.mutableNamespaceIds[index]);
}

/**
 * Builds the seven foreground content services for one protected wake. The
 * returned ports retain only invocation-local approval/capsule state. Every
 * product or crypto operation borrows a fresh current writer and completes
 * before that writer is released.
 */
export function createProtectedTaskWakeForegroundServices(
  input: ProductionProtectedTaskWakeForegroundServicesInput,
): Promise<ProtectedTaskWakeForegroundServices> {
  const { publication, lifecycle, context, entities, signer } = input;
  let committedCryptoPromise: ReturnType<typeof verifyCryptoPostgresHandle> | undefined;
  const committedCrypto = () => committedCryptoPromise ??= verifyCryptoPostgresHandle(input.restricted);
  const evidence = publication.wakeEvidence;
  if (context.enforcementPolicy.mode === "plaintext_only"
    || context.memoryAccessEnvelope.ownerId !== lifecycle.scheduling.requestorId
    || context.memoryAccessEnvelope.agentId !== lifecycle.scheduling.agentId) {
    unavailable("Wake foreground service identity changed");
  }
  const memoryAuthority = protectedMemoryAuthorityFromEnvelope(
    context.memoryAccessEnvelope,
  );
  if (memoryAuthority === null || memoryAuthority.mode !== "namespace") {
    unavailable("Wake foreground service identity changed");
  }
  const checkpointBinding = context.checkpointBinding;
  if (checkpointBinding.sourceEnvelopeDigest.length !== 32
    || !Number.isSafeInteger(checkpointBinding.initialPolicyRevision)
    || checkpointBinding.initialPolicyRevision < 1
    || !Number.isSafeInteger(
      checkpointBinding.initialAgentAuthorizationRevision,
    )
    || checkpointBinding.initialAgentAuthorizationRevision < 0) {
    unavailable("Wake foreground checkpoint binding changed");
  }
  const plannedAdditional = publication.plan.additionalMutationDestination;
  const grantedAdditional = evidence.additionalMutationDestination;
  if ((plannedAdditional === undefined) !== (grantedAdditional === undefined)
    || plannedAdditional !== undefined && grantedAdditional !== undefined
      && (plannedAdditional.roomId !== grantedAdditional.roomId
        || plannedAdditional.namespaceId
          !== grantedAdditional.namespace.namespaceId
        || plannedAdditional.semanticDigest !== grantedAdditional.semanticDigest
        || grantedAdditional.namespace.operations.length !== 1
        || grantedAdditional.namespace.operations[0] !== "encrypt"
        || grantedAdditional.namespace.expectedPolicyRevision
          !== evidence.policyRevision)
    || grantedAdditional !== undefined
      && evidence.namespaceRequirements.some(requirement =>
        requirement.namespaceId === grantedAdditional.namespace.namespaceId)) {
    unavailable("Wake projection destination authority changed");
  }
  const currentSemanticAuthorityRequirements =
    canonicalProtectedTaskSemanticAuthorityRequirements(
      [...evidence.namespaceRequirements.filter(requirement =>
        publication.plan.foregroundNamespaceIds.includes(requirement.namespaceId)),
      ...(grantedAdditional === undefined ? [] : [grantedAdditional.namespace])]
        .map(requirement => Object.freeze({
        namespaceId: requirement.namespaceId,
        operations: Object.freeze([...requirement.operations]),
      })).sort((left, right) => left.namespaceId < right.namespaceId ? -1
        : left.namespaceId > right.namespaceId ? 1 : 0),
    );
  const retainedSourceNamespaceIds = Object.freeze([
    ...publication.plan.foregroundNamespaceIds,
  ].sort());
  if (retainedSourceNamespaceIds.length
      !== checkpointBinding.retainedSourceNamespaceIds.length
    || retainedSourceNamespaceIds.some((namespaceId, index) =>
      namespaceId !== checkpointBinding.retainedSourceNamespaceIds[index])) {
    unavailable("Wake foreground checkpoint binding changed");
  }
  const temporary = signer.signerPublication === null;
  if (temporary
    ? (context.continuation === undefined
      && checkpointBinding.initialAgentAuthorizationRevision !== 0
      || checkpointBinding.initialAgentAuthorizationRevision < 0)
    : checkpointBinding.initialAgentAuthorizationRevision < 1) {
    unavailable("Wake foreground checkpoint binding changed");
  }
  const certified = temporary
    ? assertTaskRuntimeTemporarySignerForPreparation(
        input.crypto,
        evidence,
        signer.runtime,
        signer.temporarySigner,
      )
    : undefined;
  const signerKeyId = temporary
    ? certified!.signerKeyId
    : signer.signerPublication.signerKeyId;
  const signerPublicKey = temporary
    ? signer.temporarySigner.signerPublicKey
    : signer.signerPublication.signerPublicKey;
  const taskRuntimeSigner = temporary
    ? Object.freeze({ evidence, signer: signer.temporarySigner })
    : undefined;
  const sourceRepresentationMode = context.enforcementPolicy.mode === "encrypted_only"
    ? "protected-only" as const
    : "ordinary-and-protected" as const;
  const writerSigner = Object.freeze({
    agentAuthorizationRevision: signer.agentAuthorizationRevision,
    runtimeGeneration: signer.runtime.generation,
    signerKeyId,
    signerPublicKey: Uint8Array.from(signerPublicKey),
    ...(certified === undefined ? {} : {
      signerAuthorizationHash: certified.certificateHash,
    }),
  });
  const publicationFacts = Object.freeze({
    operationId: evidence.invocation.operationId,
    grantId: evidence.requestId,
    grantDigest: Uint8Array.from(evidence.authorizationDigest),
    recipientKeyId: evidence.recipientKeyId,
    runtime: signer.runtime,
    signerKeyId,
    signerPublicKey: Uint8Array.from(signerPublicKey),
    agentAuthorizationRevision: signer.agentAuthorizationRevision,
    policyRevision: evidence.policyRevision,
    ...(taskRuntimeSigner === undefined ? {} : { taskRuntimeSigner }),
  });
  const writerStore = new AsyncLocalStorage<Readonly<{
    writer: TaskWakeLiveShadowCurrentWriter;
    active: boolean;
    projectionDestination?: ForegroundMemoryProjectionDestination;
  }>>();

  const withWriter = async <Value>(
    use: (writer: TaskWakeLiveShadowCurrentWriter) => Promise<Value>,
  ): Promise<Value> => {
    const retained = writerStore.getStore();
    if (retained !== undefined) {
      if (!retained.active) unavailable("Wake foreground writer authority escaped");
      await retained.writer.assertCurrent();
      const value = await use(retained.writer);
      await retained.writer.assertCurrent();
      return value;
    }
    const result = await lifecycle.withCurrentWriter<Readonly<{ value: Value }>>({
      signer: writerSigner,
      resolveHistoricalSignerPublicationManager:
        input.resolveHistoricalSignerPublicationManager,
      use: async writer => {
        const scope = { writer, active: true };
        try {
          return await writerStore.run(scope, async () =>
            Object.freeze({ value: await use(writer) }));
        } finally {
          scope.active = false;
        }
      },
    });
    if (result === null) unavailable("Wake foreground writer authority changed");
    return result.value;
  };

  const currentProjectionOwner: ForegroundMemoryCurrentProjectionOwner =
    async request => {
      const { destination, targetAuthority } = request;
      const additionalDestination = publication.plan.additionalMutationDestination;
      const isAdditionalDestination = additionalDestination !== undefined
        && additionalDestination.roomId === destination.roomId
        && additionalDestination.namespaceId === destination.namespaceId;
      const namespace = isAdditionalDestination
        ? grantedAdditional?.namespace
        : evidence.namespaceRequirements.find(requirement =>
          requirement.namespaceId === destination.namespaceId);
      const expectedOperations = isAdditionalDestination
        ? ["encrypt"] as const
        : ["decrypt", "encrypt"] as const;
      if (
        targetAuthority.mode !== "namespace"
        || targetAuthority.subjectUserId !== context.memoryAccessEnvelope.ownerId
        || targetAuthority.agentId !== lifecycle.scheduling.agentId
        || targetAuthority.writableNamespaceId !== destination.namespaceId
        || targetAuthority.readableNamespaceIds.length !== 1
        || targetAuthority.readableNamespaceIds[0] !== destination.namespaceId
        || targetAuthority.mutableNamespaceIds.length !== 1
        || targetAuthority.mutableNamespaceIds[0] !== destination.namespaceId
        || namespace === undefined
        || namespace.expectedPolicyRevision !== context.enforcementPolicy.revision
        || namespace.expectedPolicyRevision !== evidence.policyRevision
        || namespace.operations.length !== expectedOperations.length
        || namespace.operations.some((operation, index) =>
          operation !== expectedOperations[index])
      ) return null;
      const retained = writerStore.getStore();
      if (retained?.projectionDestination !== undefined) {
        const held = retained.projectionDestination;
        if (held.roomId !== destination.roomId
          || held.namespaceId !== destination.namespaceId
          || held.label !== destination.label
          || held.kind !== destination.kind
          || held.memberCount !== destination.memberCount
          || held.audienceFingerprint !== destination.audienceFingerprint) {
          return null;
        }
        const assertCurrent = async () => {
          if (!retained.active) {
            unavailable("Wake projection writer authority escaped");
          }
          await retained.writer.assertCurrent();
          if (!retained.active) {
            unavailable("Wake projection writer authority escaped");
          }
        };
        await assertCurrent();
        const value = await request.use(assertCurrent);
        await assertCurrent();
        return value;
      }
      const resolveHistoricalSignerPublicationManager =
        input.resolveHistoricalSignerPublicationManager;
      return lifecycle.withCurrentWriter({
        signer: writerSigner,
        resolveHistoricalSignerPublicationManager:
          resolveHistoricalSignerPublicationManager,
        projectionDestination: destination,
        use: async writer => {
          const scope = { writer, active: true,
            projectionDestination: destination };
          try {
            return await writerStore.run(scope, async () => {
              const assertCurrent = async () => {
                if (!scope.active) {
                  unavailable("Wake projection writer authority escaped");
                }
                await writer.assertCurrent();
                if (!scope.active) {
                  unavailable("Wake projection writer authority escaped");
                }
              };
              await assertCurrent();
              const value = await request.use(assertCurrent);
              await assertCurrent();
              return value;
            });
          } finally {
            scope.active = false;
          }
        },
      });
    };

  type HeldMemoryPublication = Extract<AgentMemoryPublicationBoundary, {
    withCurrentPublication: unknown;
  }>;
  const withCurrentMemoryPublication: NonNullable<
    HeldMemoryPublication["withCurrentPublication"]
  > = async request => {
    if (!sameMemoryAuthority(request.authority, memoryAuthority)) {
      unavailable("Wake Memory product authority changed");
    }
    return withWriter(async writer => {
      await writer.assertCurrent();
      const receipt = await request.use(() => writer.assertCurrent());
      await writer.assertCurrent();
      return receipt;
    });
  };

  const resolveLiveSigner = (principal: Readonly<{
    agentId: string;
    runtimeGeneration: number;
    signerKeyId: string;
  }>) => principal.agentId === evidence.signerAgentId
      && principal.runtimeGeneration === signer.runtime.generation
      && principal.signerKeyId === signerKeyId
    ? Uint8Array.from(signerPublicKey)
    : null;

  const createReadSignerResolver = (
    product: Awaited<ReturnType<typeof verifyConversationProductPostgresHandle>>,
  ) => {
    const resolveForegroundSigner = createPostgresForegroundAgentSignerResolver({
      product,
      crypto: input.crypto,
    });
    return async (principal: Parameters<typeof resolveLiveSigner>[0]) =>
      resolveLiveSigner(principal) ?? resolveForegroundSigner(principal);
  };

  const persistWakeMemoryObject = (
    prepared: Parameters<typeof persistDeviceWrappedAgentObject>[0]["prepared"],
  ) => withWriter(async writer => persistDeviceWrappedAgentObject({
    handle: await committedCrypto(),
    crypto: input.crypto,
    prepared,
    resolveCurrentAuthorization:
      writer.resolveCurrentForegroundEntityObjectWrite,
  }));

  const readWakeMemoryObject = (
    request: Omit<Parameters<typeof readVerifiedDeviceWrappedAgentObject>[0],
      "handle" | "crypto" | "resolveLiveShadowAgentSigner"
      | "resolveHistoricalAgentSignerAuthority">,
  ) => withWriter(async writer => {
    const product = borrow(writer.product);
    const restricted = borrow(writer.restricted);
    const [productHandle, cryptoHandle] = await Promise.all([
      verifyConversationProductPostgresHandle(product),
      verifyCryptoPostgresHandle(restricted),
    ]);
    const history = new PostgresHumanDeviceSignerHistory({
      handle: cryptoHandle,
      crypto: input.crypto,
    });
    const namespaceKeys = new PostgresDomainKeyAuthorityRepository(
      restricted,
      input.crypto,
      input.serverScope,
    );
    return readVerifiedDeviceWrappedAgentObject({
      handle: cryptoHandle,
      crypto: input.crypto,
      ...request,
      resolveNativeNamespaceEntries: coordinates =>
        resolveForegroundMemoryNativeEntries(namespaceKeys, coordinates),
      resolveLiveShadowAgentSigner: createReadSignerResolver(productHandle),
      resolveHistoricalAgentSignerAuthority:
        history.resolveAgentRuntimeSignerManager,
    });
  });

  const currentExactAccessOwner: ForegroundMemoryCurrentExactAccessOwner = async use =>
    withWriter(async writer => {
      const product = borrow(writer.product);
      const restricted = borrow(writer.restricted);
      const [productContext, productHandle, cryptoHandle] = await Promise.all([
        createForegroundProductTransactionContext({
          userId: context.memoryAccessEnvelope.ownerId,
          agentId: lifecycle.scheduling.agentId,
        }),
        verifyConversationProductPostgresHandle(product),
        verifyCryptoPostgresHandle(restricted),
      ]);
      const history = new PostgresHumanDeviceSignerHistory({
        handle: cryptoHandle,
        crypto: input.crypto,
      });
      const namespaceKeys = new PostgresDomainKeyAuthorityRepository(
        restricted,
        input.crypto,
        input.serverScope,
      );
      const resolveReadSigner = createReadSignerResolver(productHandle);
      const read = (request: Omit<Parameters<
        typeof readVerifiedDeviceWrappedAgentObject
      >[0], "handle" | "crypto" | "resolveLiveShadowAgentSigner"
        | "resolveHistoricalAgentSignerAuthority">) =>
        readVerifiedDeviceWrappedAgentObject({
          handle: cryptoHandle,
          crypto: input.crypto,
          ...request,
          resolveNativeNamespaceEntries: coordinates =>
            resolveForegroundMemoryNativeEntries(namespaceKeys, coordinates),
          resolveLiveShadowAgentSigner: resolveReadSigner,
          resolveHistoricalAgentSignerAuthority:
            history.resolveAgentRuntimeSignerManager,
        });
      const current: ForegroundMemoryCurrentExactAccess = Object.freeze({
        productContext,
        assertCurrentAuthority: () => writer.assertCurrent(),
        exact: Object.freeze({
          handle: cryptoHandle,
          namespaceKeys,
          resolveHistoricalAgentSignerAuthority:
            history.resolveAgentRuntimeSignerManager,
          resolveLiveShadowAgentSigner: resolveReadSigner,
          resolveCurrentAgentSigner: resolveLiveSigner,
          read: async (request: Parameters<
            ForegroundMemoryCurrentExactAccess["exact"]["read"]
          >[0]) => {
            const verified = await read({
              ...request,
              expectedObjectType: MEMORY_OBJECT_TYPE,
            });
            return verified?.nativeEntries === undefined
              ? null
              : { ...verified, nativeEntries: verified.nativeEntries };
          },
        }),
      });
      return use(current);
    });

  const protectForegroundHistory: ProtectedTaskWakeForegroundServices[
    "protectForegroundHistory"
  ] = request => withWriter(async writer => {
    const product = borrow(writer.product);
    const restricted = borrow(writer.restricted);
    const [cryptoHandle, productHandle] = await Promise.all([
      verifyCryptoPostgresHandle(restricted),
      verifyConversationProductPostgresHandle(product),
    ]);
    const storage = new PostgresLatticeStorage(cryptoHandle);
    const history = new PostgresHumanDeviceSignerHistory({
      handle: cryptoHandle,
      crypto: input.crypto,
    });
    const resolveReadSigner = createReadSignerResolver(productHandle);
    const completion = createPostgresConversationCryptoCompletion({
      handle: await committedCrypto(),
      crypto: input.crypto,
      commonManifestExpectedAgentId: evidence.signerAgentId,
      resolveCurrentWriteAuthorization: () => Promise.resolve(null),
      resolveHistoricalSigner: history.resolveHistoricalObjectSigner,
      resolveHistoricalAgentSignerAuthority:
        history.resolveAgentRuntimeSignerManager,
      resolveLiveShadowAgentSigner: resolveReadSigner,
    });
    const conversation = createDormantConversationShadowRepository({
      product: writer.productStore,
      crypto: completion,
    });
    return createForegroundMessageHistoryRepairer({
      crypto: input.crypto,
      commonManifestHandle: cryptoHandle,
      cryptoCompletion: completion,
      storage,
      entities,
      product: writer.productStore,
      conversation,
      contextNamespaceId: lifecycle.scheduling.namespaceId,
      sourceRepresentationMode,
      publication: {
        ...publicationFacts,
        withCurrentPublication: current => current.use({
          product: writer.productStore,
          resolveCurrentAuthorization:
            writer.resolveCurrentForegroundEntityObjectWrite,
        }),
      },
      loadSources: selection => loadPostgresForegroundMessageRepairSources({
        product: productHandle,
        ...selection,
      }),
      resolveHistoricalHumanSigner: history.resolveHistoricalObjectSigner,
      resolveLiveShadowAgentSigner: resolveReadSigner,
      resolveHistoricalAgentSignerAuthority:
        history.resolveAgentRuntimeSignerManager,
    }).protect(request);
  });

  const protectForegroundJournal: ProtectedTaskWakeForegroundServices[
    "protectForegroundJournal"
  ] = request => withWriter(async writer => {
    const product = borrow(writer.product);
    const restricted = borrow(writer.restricted);
    const [productHandle, cryptoHandle] = await Promise.all([
      verifyConversationProductPostgresHandle(product),
      verifyCryptoPostgresHandle(restricted),
    ]);
    const history = new PostgresHumanDeviceSignerHistory({
      handle: cryptoHandle,
      crypto: input.crypto,
    });
    const resolveReadSigner = createReadSignerResolver(productHandle);
    const canonical = bindConversationProductCanonicalTransactionRunner(
      productHandle,
      { transaction: callback => callback(writer.transaction, product) },
    );
    return createForegroundJournalHistoryRepairer({
      crypto: input.crypto,
      entities,
      room: { roomId: lifecycle.scheduling.roomId,
        namespaceId: lifecycle.scheduling.namespaceId },
      sourceRepresentationMode,
      publication: publicationFacts,
      selection: createPostgresForegroundJournalSelectionPort({
        product: productHandle,
      }),
      loadSources: (snapshot, mode) =>
        loadPostgresForegroundJournalRepairSources({ product: productHandle,
          snapshot, representationMode: mode ?? sourceRepresentationMode }),
      persist: async prepared => persistDeviceWrappedAgentObject({ handle: await committedCrypto(),
        crypto: input.crypto, prepared,
        resolveCurrentAuthorization: writer.resolveCurrentForegroundEntityObjectWrite }),
      read: value => readVerifiedDeviceWrappedAgentObject({ handle: cryptoHandle,
        crypto: input.crypto, ...value,
        resolveLiveShadowAgentSigner: resolveReadSigner,
        resolveHistoricalAgentSignerAuthority: history.resolveAgentRuntimeSignerManager }),
      validateExisting: value => validatePostgresForegroundJournalRepairSource({
        product: productHandle, ...value }),
      attach: value => attachPostgresForegroundJournalRepair({
        product: productHandle, ...value }),
      ...(sourceRepresentationMode === "protected-only" ? {} : {
        restoreOrdinary: value => restorePostgresForegroundJournalOrdinary({
          canonical, ...value }),
      }),
    }).protect(request);
  });

  const protectForegroundRecords: ProtectedTaskWakeForegroundServices[
    "protectForegroundRecords"
  ] = request => withWriter(async writer => {
    const product = borrow(writer.product);
    const restricted = borrow(writer.restricted);
    const [productHandle, cryptoHandle] = await Promise.all([
      verifyConversationProductPostgresHandle(product),
      verifyCryptoPostgresHandle(restricted),
    ]);
    const history = new PostgresHumanDeviceSignerHistory({
      handle: cryptoHandle,
      crypto: input.crypto,
    });
    const resolveReadSigner = createReadSignerResolver(productHandle);
    const canonical = bindConversationProductCanonicalTransactionRunner(
      productHandle,
      { transaction: callback => callback(writer.transaction, product) },
    );
    return createForegroundRecordHistoryRepairer({
      crypto: input.crypto,
      entities,
      sourceRepresentationMode,
      publication: publicationFacts,
      loadSources: (records, mode) => loadPostgresForegroundRecordRepairSources({
        product: productHandle, records,
        representationMode: mode ?? sourceRepresentationMode }),
      persist: async prepared => persistDeviceWrappedAgentObject({ handle: await committedCrypto(),
        crypto: input.crypto, prepared,
        resolveCurrentAuthorization: writer.resolveCurrentForegroundEntityObjectWrite }),
      read: value => readVerifiedDeviceWrappedAgentObject({ handle: cryptoHandle,
        crypto: input.crypto, ...value,
        resolveLiveShadowAgentSigner: resolveReadSigner,
        resolveHistoricalAgentSignerAuthority: history.resolveAgentRuntimeSignerManager }),
      validateExisting: value => validatePostgresForegroundRecordRepairSource({
        product: productHandle, ...value }),
      attach: value => attachPostgresForegroundRecordRepair({
        product: productHandle, ...value }),
      ...(sourceRepresentationMode === "protected-only" ? {} : {
        restoreOrdinary: value => restorePostgresForegroundRecordOrdinary({
          canonical, ...value }),
      }),
    }).protect(request);
  });

  const protectForegroundMemories: ProtectedTaskWakeForegroundServices[
    "protectForegroundMemories"
  ] = request => withWriter(async writer => {
    const product = borrow(writer.product);
    const restricted = borrow(writer.restricted);
    const [productHandle, cryptoHandle] = await Promise.all([
      verifyConversationProductPostgresHandle(product),
      verifyCryptoPostgresHandle(restricted),
    ]);
    const history = new PostgresHumanDeviceSignerHistory({
      handle: cryptoHandle,
      crypto: input.crypto,
    });
    const resolveReadSigner = createReadSignerResolver(productHandle);
    const canonical = bindConversationProductCanonicalTransactionRunner(
      productHandle,
      { transaction: callback => callback(writer.transaction, product) },
    );
    return createForegroundMemoryHistoryRepairer({
      crypto: input.crypto,
      entities,
      sourceRepresentationMode,
      publication: publicationFacts,
      loadSources: (memories, mode) => loadPostgresForegroundMemoryRepairSources({
        product: productHandle, crypto: input.crypto, memories,
        representationMode: mode ?? sourceRepresentationMode }),
      persist: async prepared => persistDeviceWrappedAgentObject({ handle: await committedCrypto(),
        crypto: input.crypto, prepared,
        resolveCurrentAuthorization: writer.resolveCurrentForegroundEntityObjectWrite }),
      read: value => readVerifiedDeviceWrappedAgentObject({ handle: cryptoHandle,
        crypto: input.crypto, ...value,
        resolveLiveShadowAgentSigner: resolveReadSigner,
        resolveHistoricalAgentSignerAuthority: history.resolveAgentRuntimeSignerManager }),
      validateExisting: value => validatePostgresForegroundMemoryRepairSource({
        product: productHandle, ...value }),
      attach: value => attachPostgresForegroundMemoryRepair({
        product: productHandle, ...value }),
      ...(sourceRepresentationMode === "protected-only" ? {} : {
        restoreOrdinary: value => restorePostgresForegroundMemoryOrdinary({
          canonical, ...value }),
      }),
    }).protect(request);
  });

  const domain = {
    subjectUserId: context.memoryAccessEnvelope.ownerId,
    agentId: lifecycle.scheduling.agentId,
    entrypointId: "foreground.main" as const,
    crypto: input.crypto,
    entities,
    publication: {
      authorizationOperationId: evidence.invocation.operationId,
      grantId: evidence.requestId,
      grantDigest: evidence.authorizationDigest,
      recipientKeyId: evidence.recipientKeyId,
      runtime: signer.runtime,
      signerKeyId,
      signerPublicKey,
      agentAuthorizationRevision: signer.agentAuthorizationRevision,
      ...(taskRuntimeSigner === undefined ? {} : { taskRuntimeSigner }),
    },
    persist: persistWakeMemoryObject,
    read: readWakeMemoryObject,
  };

  const withCurrentProjectionSource = async <Value>(
    use: (assertCurrent: () => Promise<void>) => Promise<Value>,
  ): Promise<Value | null> => withWriter(async writer => {
    const assertCurrent = () => writer.assertCurrent();
    await assertCurrent();
    const value = await use(assertCurrent);
    await assertCurrent();
    return value;
  });

  const createProtectedProjection = async (
    envelope: Parameters<ProtectedTaskWakeForegroundServices[
      "createForegroundMemoryProjectionPort"
    ]>[0],
  ) => {
    const handoff = await createForegroundProtectedTaskMemoryProjection({
      envelope,
      policy: context.enforcementPolicy,
      domain,
      publication: {
        forReservation: proof => ({
          recover: request => withWriter(async writer => {
            const product = borrow(writer.product);
            const handle = await committedCrypto();
            const productHandle = await verifyConversationProductPostgresHandle(product);
            const history = new PostgresHumanDeviceSignerHistory({ handle, crypto: input.crypto });
            return createPostgresForegroundMemoryPublication({ handle, crypto: input.crypto,
              resolveCurrentAuthorization: writer.resolveCurrentForegroundEntityObjectWrite,
              resolveHistoricalAgentSignerAuthority: history.resolveAgentRuntimeSignerManager,
              resolveLiveShadowAgentSigner: createReadSignerResolver(productHandle),
            }).forReservation(proof).recover(request);
          }),
          persist: (prepared, source) => withWriter(async writer => {
            const product = borrow(writer.product);
            const handle = await committedCrypto();
            const productHandle = await verifyConversationProductPostgresHandle(product);
            const history = new PostgresHumanDeviceSignerHistory({ handle, crypto: input.crypto });
            return createPostgresForegroundMemoryPublication({ handle, crypto: input.crypto,
              resolveCurrentAuthorization: writer.resolveCurrentForegroundEntityObjectWrite,
              resolveHistoricalAgentSignerAuthority: history.resolveAgentRuntimeSignerManager,
              resolveLiveShadowAgentSigner: createReadSignerResolver(productHandle),
            }).forReservation(proof).persist(prepared, source);
          }),
        }),
      },
      wakeEffectRecovery: input.wakeEffectRecovery,
      withCurrentPublication: withCurrentMemoryPublication,
      withCurrentProjection: currentProjectionOwner,
      withCurrentSource: withCurrentProjectionSource,
      planDestination: request => lifecycle.withProjectionDestination(request),
      task: Object.freeze({
        taskId: lifecycle.scheduling.taskId,
        taskRunId: lifecycle.scheduling.taskRunId,
        graphThreadId: lifecycle.scheduling.graphThreadId,
      }),
      originalCapsuleBinding: Object.freeze({
        policyRevision: checkpointBinding.initialPolicyRevision,
        agentAuthorizationRevision:
          checkpointBinding.initialAgentAuthorizationRevision,
      }),
      ...(context.continuation === undefined ? {} : {
        continuedAdditionalAuthority: Object.freeze({
          authorizationRequestId:
            context.continuation.resume.authorizationRequestId,
          effectDisposition: "not_started_v1" as const,
          operationId: context.continuation.resume.operationId,
          requestDigest:
            Uint8Array.from(context.continuation.resume.requestDigest),
          requiredAuthorityDigest:
            Uint8Array.from(context.continuation.resume.requiredAuthorityDigest),
        }),
      }),
      currentSemanticAuthorityRequirements,
      onAdditionalAuthority: (plan, destination) => {
        if (input.onAdditionalProjectionAuthority === undefined) return;
        input.onAdditionalProjectionAuthority(Object.freeze({
          plan: Object.freeze({
            ...plan,
            requestDigest: Uint8Array.from(plan.requestDigest),
            semanticAuthorityRequirements:
              canonicalProtectedTaskSemanticAuthorityRequirements(
                plan.semanticAuthorityRequirements,
              ),
          }),
          destination: Object.freeze({
            ...destination,
            destinationAuthorityDigest:
              Uint8Array.from(destination.destinationAuthorityDigest),
          }),
          sourceEnvelopeDigest:
            Uint8Array.from(checkpointBinding.sourceEnvelopeDigest),
          checkpointBinding: Object.freeze({
            retainedSourceNamespaceIds: Object.freeze([
              ...checkpointBinding.retainedSourceNamespaceIds,
            ]),
            sourceEnvelopeDigest:
              Uint8Array.from(checkpointBinding.sourceEnvelopeDigest),
            initialPolicyRevision: checkpointBinding.initialPolicyRevision,
            initialAgentAuthorizationRevision:
              checkpointBinding.initialAgentAuthorizationRevision,
          }),
        }));
      },
    });
    return createProtectedTaskMemoryProjectionPort(handoff);
  };

  return Promise.resolve(Object.freeze({
    protectForegroundHistory,
    protectForegroundJournal,
    protectForegroundRecords,
    protectForegroundMemories,
    createForegroundMemoryRepository: (
      envelope: Parameters<ProtectedTaskWakeForegroundServices[
        "createForegroundMemoryRepository"
      ]>[0],
    ) => createForegroundMemoryRepository({
      envelope,
      policy: context.enforcementPolicy,
      resolvePolicy: () => Promise.resolve(context.enforcementPolicy),
      wakeEffectRecovery: input.wakeEffectRecovery,
      ...(input.embedding === undefined ? {} : { embedding: input.embedding }),
      domain,
      withCurrentPublication: withCurrentMemoryPublication,
    }),
    createForegroundMemoryAccessPort: (
      envelope: Parameters<ProtectedTaskWakeForegroundServices[
        "createForegroundMemoryAccessPort"
      ]>[0],
    ) => createForegroundMemoryAccessPort({
      envelope,
      domain: { ...domain, read: () => Promise.resolve(null) },
      withCurrentExactAccess: currentExactAccessOwner,
      resolveGrantUserNamespace: async ({ authority, userHandle }) => {
        const requester = await findActorByOwnerId(authority.subjectUserId);
        const target = await findActorByHandle(
          userHandle.replace(/^@/u, "").toLowerCase(),
        );
        if (requester === null || target === null || target.kind !== "user"
          || target.actorId === requester.id) return null;
        const destination = await findOrCreateAccessNamespace(
          [requester.id, target.actorId],
          { requesterUserId: authority.subjectUserId,
            requesterActorId: requester.id },
        );
        return authority.writableNamespaceId === destination.namespaceId
            || authority.mutableNamespaceIds.includes(destination.namespaceId)
          ? destination.namespaceId : null;
      },
    }),
    createForegroundMemoryProjectionPort: createProtectedProjection,
  }));
}
