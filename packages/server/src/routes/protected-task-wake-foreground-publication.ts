import { isDeepStrictEqual } from "node:util";
import { bindProtectedCheckpointCellDataOperationOwner,
  ClassifiedDataOperationError, createDormantConversationShadowRepository,
  withProtectedTaskWakeForegroundSigner } from "@nautilo/lattice-bridge";
import { createPostgresConversationCryptoCompletion, createTaskWakeForegroundAgentTurnSession,
  PostgresHumanDeviceSignerHistory, PostgresLatticeStorage, verifyCryptoPostgresHandle,
  withNativeProtectedTaskRunResultV1, withNativeTaskWakeForegroundEntityCrypto } from "@nautilo/lattice-bridge/server";
import { agentId, namespaceId as cryptoNamespaceId, authorizationRevision as cryptoAuthorizationRevision, unixTimestamp, assertAuthenticTaskRuntimeRunResultReadEvidence,
  assertAuthenticTaskRuntimeWakeForegroundEvidence, assertTaskRuntimeTemporarySignerForPreparation,
  hasTaskRuntimeTemporarySigner } from "@nautilo/lattice-crypto";
import { eventBus, projectLiveShadowPublishedMessageEvent,
  runWithTaskWakeLiveShadowTurnSession } from "@nautilo/runtime";
import { protectedTaskSemanticAuthorityRequirementsDigest,
  sameProtectedTaskSemanticAuthorityRequirements } from "@nautilo/db";
import { createForegroundEntityCheckpointAuthorization } from "./foreground-agent-entity-crypto-gateway";
import { withProtectedTaskResultSignerHistory } from "./protected-task-result-signer-history";
import type { ProtectedTaskWakeScheduling, PostgresJsBridgeConnection } from "@nautilo/db";
import type { AgentEntityCryptoInvocation, DataOperationPolicyBinding, EncryptionDataOperationOwner,
  ProtectedTaskPublicationSignerAuthority, StrictShadowEnforcementPolicy } from "@nautilo/lattice-bridge";
import type { LiveShadowAgentTurnSession, LiveShadowAgentSessionFailureStage, NativeProtectedTaskRunResultOccurrenceV1,
  TaskWakeLiveShadowCurrentWriter, TaskWakeLiveShadowRuntimeSigner } from "@nautilo/lattice-bridge/server";
import type { LatticeCrypto, ResolveHistoricalAgentRuntimeSignerPublicationManager,
  TaskRuntimeWakeForegroundEvidence } from "@nautilo/lattice-crypto";
import type { JobExecutor, JobManager, ProtectedTaskWakeExecutionCandidate,
  ProtectedTaskWakeForegroundSource } from "@nautilo/runtime";
import type { ProtectedTaskOutputReadPublication } from "./protected-task-output-read-claim";
import type { ForegroundMemoryProjectionDestination } from "./foreground-memory-repository";
import type { ForegroundProtectedTaskProjectionDestinationPlanner } from "./foreground-memory-repository";
import type { ProtectedTaskProjectionAuthorityPlan } from "@nautilo/agent";
import type { ProtectedTaskWakeCheckpointBinding, ProtectedTaskWakeParkRequest,
  ProtectedTaskWakeParkResult } from "@nautilo/runtime";
import type { ProtectedTaskWakeCommittedPark } from "./protected-task-output-read-product";

export type ProtectedTaskWakeAdditionalProjectionAuthority = Readonly<{
  plan: Extract<ProtectedTaskProjectionAuthorityPlan, { kind: "additional_authority_v1" }>;
  destination: Readonly<{ destinationRoomId: string; namespaceId: string;
    destinationAuthorityDigest: Uint8Array }>;
  sourceEnvelopeDigest: Uint8Array;
  checkpointBinding: ProtectedTaskWakeCheckpointBinding;
}>;

export type ProtectedTaskWakePublication = Parameters<ProtectedTaskOutputReadPublication>[0] &
  Readonly<{ wakeEvidence: TaskRuntimeWakeForegroundEvidence }>;

/** One exact adopted Job; the owner retains its queued/running/terminal proof progression. */
export type ProtectedTaskWakePublicationLifecycle = Readonly<{
  scheduling: ProtectedTaskWakeScheduling;
  loadCurrentResult(): Promise<NativeProtectedTaskRunResultOccurrenceV1 | null>;
  assertCurrent(): Promise<void>;
  dispose?(): void;
  start: ProtectedTaskWakeExecutionCandidate["start"];
  settle: ProtectedTaskWakeExecutionCandidate["settle"];
  park(input: Readonly<{ request: ProtectedTaskWakeParkRequest;
    destination: ProtectedTaskWakeAdditionalProjectionAuthority["destination"] }>):
    Promise<ProtectedTaskWakeParkResult & Readonly<{ receipt?: ProtectedTaskWakeCommittedPark }>>;
  withProjectionDestination: ForegroundProtectedTaskProjectionDestinationPlanner;
  withCurrentWriter<Value>(input: Readonly<{
    signer: TaskWakeLiveShadowRuntimeSigner;
    resolveHistoricalSignerPublicationManager: ResolveHistoricalAgentRuntimeSignerPublicationManager;
    projectionDestination?: ForegroundMemoryProjectionDestination;
    use(writer: TaskWakeLiveShadowCurrentWriter): Promise<Value>;
  }>): Promise<Value | null>;
}>;

export type ProtectedTaskWakeForegroundContext = Omit<ProtectedTaskWakeForegroundSource,
  "evidence" | "scheduling" | "result"> & Readonly<{
  enforcementPolicy: StrictShadowEnforcementPolicy;
  dataOperationPolicy: DataOperationPolicyBinding;
}>;
export type ProtectedTaskWakeForegroundContextOwner = <Value>(input: Readonly<{
  publication: ProtectedTaskWakePublication;
  scheduling: ProtectedTaskWakeScheduling;
  signal: AbortSignal;
  use(context: ProtectedTaskWakeForegroundContext): Promise<Value>;
}>) => Promise<Value>;

export type ProtectedTaskWakeForegroundServices = Required<Pick<LiveShadowAgentTurnSession,
  "protectForegroundHistory" | "protectForegroundJournal" | "protectForegroundRecords"
  | "protectForegroundMemories" | "createForegroundMemoryRepository"
  | "createForegroundMemoryAccessPort" | "createForegroundMemoryProjectionPort">>;

export type ProtectedTaskWakeForegroundServicesInput = Readonly<{
  publication: ProtectedTaskWakePublication;
  lifecycle: ProtectedTaskWakePublicationLifecycle;
  context: ProtectedTaskWakeForegroundContext;
  entities: AgentEntityCryptoInvocation;
  signer: ProtectedTaskPublicationSignerAuthority;
  resolveHistoricalSignerPublicationManager: ResolveHistoricalAgentRuntimeSignerPublicationManager;
  onAdditionalProjectionAuthority?(capture: ProtectedTaskWakeAdditionalProjectionAuthority): void;
}>;

export type ProtectedTaskWakeForegroundPublicationInput = Readonly<{
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  owner: EncryptionDataOperationOwner;
  serverScope: string;
  jobManager: Pick<JobManager, "adoptProtectedTaskWakeJob">;
  executor: JobExecutor;
  onDiagnostic?(stage: LiveShadowAgentSessionFailureStage, error: unknown): void;
  createLifecycle(publication: ProtectedTaskWakePublication): Promise<ProtectedTaskWakePublicationLifecycle | null>;
  withForegroundContext: ProtectedTaskWakeForegroundContextOwner;
  createProtectedServices(input: ProtectedTaskWakeForegroundServicesInput): Promise<ProtectedTaskWakeForegroundServices>;
}>;

function unavailable(message: string): never {
  throw new ClassifiedDataOperationError("authority", message);
}
function wipe(value: unknown): void {
  if (value instanceof Uint8Array) value.fill(0);
  else if (value !== null && typeof value === "object") for (const child of Object.values(value)) wipe(child);
}

type TurnInput = Readonly<{
  publication: ProtectedTaskWakePublication;
  lifecycle: ProtectedTaskWakePublicationLifecycle;
  context: ProtectedTaskWakeForegroundContext;
  assertCurrent(): Promise<void>;
  onAdditionalProjectionAuthority?(capture: ProtectedTaskWakeAdditionalProjectionAuthority): void;
}>;
export type ProtectedTaskWakeForegroundPublicationDependencies = Readonly<{
  withSession<Value>(input: TurnInput,
    use: (session: LiveShadowAgentTurnSession, source: ProtectedTaskWakeForegroundSource) => Promise<Value>): Promise<Value>;
}>;

function withCommittedWakeRealtimePublication(input: Readonly<{
  session: LiveShadowAgentTurnSession;
  evidence: TaskRuntimeWakeForegroundEvidence;
  scheduling: ProtectedTaskWakeScheduling;
  representationMode: "shadow_encryption" | "full_encryption";
  onDiagnostic?(stage: LiveShadowAgentSessionFailureStage, error: unknown): void;
}>): LiveShadowAgentTurnSession {
  return Object.freeze({
    ...input.session,
    async publishMessage(request: Parameters<LiveShadowAgentTurnSession["publishMessage"]>[0]) {
      const result = await input.session.publishMessage(request);
      if (result.status !== "protected") return result;
      // Notification is downstream of the durable protected commit. A broken
      // realtime listener must not reclassify or retry that committed effect.
      try {
        const projection = result.value.protectedMessage.projection;
        const expectedLane = `room:${projection.roomId}`;
        if (
          input.scheduling.roomId !== projection.roomId
          || input.scheduling.laneKey !== expectedLane
        ) throw new TypeError("Wake committed Message Room changed");
        const event = projectLiveShadowPublishedMessageEvent({
          message: result.value,
          representationMode: input.representationMode,
          sharedAgentPlanBytesBase64url: null,
          operationId: input.evidence.invocation.operationId,
          laneKey: expectedLane,
        });
        if (event.type !== "message.shadow_durable") {
          throw new TypeError("Wake committed Message notification is invalid");
        }
        eventBus.emit(event);
      } catch (error) {
        // Authenticated history remains canonical and will converge on reload.
        try { input.onDiagnostic?.("assistant_message", error); } catch { /* diagnostic only */ }
      }
      return result;
    },
  });
}

function sessionOwner(input: ProtectedTaskWakeForegroundPublicationInput):
  ProtectedTaskWakeForegroundPublicationDependencies["withSession"] {
  return async (turn, use) => {
    const { publication, lifecycle, context, assertCurrent } = turn;
    const { wakeEvidence: evidence, partitions, signal } = publication;
    const foregroundDomains = Object.freeze([...new Map([
      ...partitions.foregroundDomains,
      ...(partitions.additionalMutationDomains ?? []),
    ].map(entry => [entry.domainId, entry] as const)).values()]);
    const namespaceId = lifecycle.scheduling.namespaceId;
    const namespace = evidence.namespaceRequirements.find(value => value.namespaceId === namespaceId);
    const domain = partitions.foregroundDomains.find(value => value.domainId === namespace?.domainId);
    if (namespace === undefined || domain === undefined) unavailable("Wake destination foreground authority is missing");
    const handle = await verifyCryptoPostgresHandle(input.restricted);
    const storage = new PostgresLatticeStorage(handle);
    const history = new PostgresHumanDeviceSignerHistory({ handle, crypto: input.crypto });
    return withNativeProtectedTaskRunResultV1({ restricted: input.restricted, crypto: input.crypto,
      serverScope: input.serverScope, evidence: publication.evidence, domains: partitions.resultDomains, signal,
      loadCurrentResult: lifecycle.loadCurrentResult,
      resolveHistoricalAgentSignerAuthority: history.resolveAgentRuntimeSignerManager,
      execute: async (result, assertCurrentResult) => {
        const assertAllCurrent = async () => {
          try { await assertCurrent(); await assertCurrentResult(); }
          catch (error) { input.onDiagnostic?.("agent_input", error); throw error; }
        };
        return withNativeTaskWakeForegroundEntityCrypto({ restricted: input.restricted, crypto: input.crypto,
          serverScope: input.serverScope, evidence, domains: foregroundDomains, signal,
          assertCurrentTaskAuthority: assertAllCurrent,
          execute: async entities => {
            const useSigner = async (
              signer: ProtectedTaskPublicationSignerAuthority,
              resolveHistoricalSignerPublicationManager:
                ResolveHistoricalAgentRuntimeSignerPublicationManager,
            ) => {
              const temporary = signer.signerPublication === null;
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
              try {
                // A fresh certified Runtime has revision zero. A continuation
                // retains the revision authenticated by its locked capsule.
                const retainedRevision = context.continuation === undefined
                  ? signer.agentAuthorizationRevision
                  : context.checkpointBinding.initialAgentAuthorizationRevision;
                if (temporary
                  ? (context.continuation === undefined && retainedRevision !== 0
                    || retainedRevision < 0)
                  : retainedRevision < 1
                    || retainedRevision > signer.agentAuthorizationRevision) {
                  unavailable("Wake retained capsule signer authority changed");
                }
                const signedContext: ProtectedTaskWakeForegroundContext = Object.freeze({
                  ...context,
                  checkpointBinding: Object.freeze({ ...context.checkpointBinding,
                    initialAgentAuthorizationRevision: retainedRevision }),
                });
                const borrowed = await entities.useCurrentSet({ operations: ["decrypt", "encrypt"],
                  namespaceIds: [namespaceId], execute: async items => {
                    const item = items[0];
                    if (items.length !== 1 || item === undefined) unavailable("Wake Namespace key is unavailable");
                    const current = item.authority;
                    const services = await input.createProtectedServices({ publication, lifecycle, context: signedContext, entities, signer,
                      ...(turn.onAdditionalProjectionAuthority === undefined ? {} : {
                        onAdditionalProjectionAuthority: turn.onAdditionalProjectionAuthority,
                      }),
                      resolveHistoricalSignerPublicationManager });
                    for (const method of ["protectForegroundHistory", "protectForegroundJournal", "protectForegroundRecords",
                      "protectForegroundMemories", "createForegroundMemoryRepository", "createForegroundMemoryAccessPort",
                      "createForegroundMemoryProjectionPort"] as const) {
                      if (typeof services[method] !== "function") unavailable("Wake protected content service is missing");
                    }
                    const writerSigner: TaskWakeLiveShadowRuntimeSigner = {
                      agentAuthorizationRevision: signer.agentAuthorizationRevision,
                      runtimeGeneration: signer.runtime.generation,
                      signerKeyId,
                      signerPublicKey,
                      ...(certified === undefined ? {} : {
                        signerAuthorizationHash: certified.certificateHash,
                      }),
                    };
                    const checkpoint = createForegroundEntityCheckpointAuthorization({
                      crypto: input.crypto,
                      entities,
                      namespaceId,
                      namespaceAccessRevision: current.namespaceAccessRevision,
                      namespaceKeyGeneration: current.namespaceKeyGeneration,
                      domainId: current.domainId,
                      agentAuthorizationRevision:
                        signer.agentAuthorizationRevision,
                      authorizationDeadlineAt: evidence.expiresAt,
                      entrypointId: "foreground.main",
                    });
                    const session = createTaskWakeForegroundAgentTurnSession({ crypto: input.crypto, evidence,
                      ...(taskRuntimeSigner === undefined ? {} : { taskRuntimeSigner }),
                      ...(input.onDiagnostic === undefined ? {} : { onDiagnostic: input.onDiagnostic }),
                      publication: { agentAuthorizationRevision: cryptoAuthorizationRevision(writerSigner.agentAuthorizationRevision), agentSignerKeyId: writerSigner.signerKeyId,
                        agentSignerPublicKey: writerSigner.signerPublicKey, recipientAgentId: agentId(evidence.signerAgentId),
                        operationId: evidence.invocation.operationId, sessionId: evidence.episodeId,
                        roomId: evidence.sourceRoomId, namespaceId: cryptoNamespaceId(namespaceId), policyRevision: evidence.policyRevision,
                        hostAuthorizationRevision: cryptoAuthorizationRevision(evidence.hostAuthorizationRevision), deadlineAt: unixTimestamp(evidence.expiresAt),
                        namespaceHeadDigest: current.namespaceHeadDigest,
                        namespacePublicationDigest: current.namespacePublicationDigest,
                        namespacePublicationSetDigest: current.namespacePublicationSetDigest,
                        namespaceAudienceFingerprint: current.namespaceAudienceFingerprint },
                      representationMode: publication.plan.intent.representation === "protected" ? "full_encryption" : "shadow_encryption",
                      namespace: { namespaceId, accessRevision: current.namespaceAccessRevision,
                        keyGeneration: current.namespaceKeyGeneration, headDigest: current.namespaceHeadDigest.slice(),
                        publicationDigest: current.namespacePublicationDigest.slice(), publicationSetDigest: current.namespacePublicationSetDigest.slice(),
                        audienceFingerprint: current.namespaceAudienceFingerprint.slice(), aiKey: item.namespaceKey.slice() },
                      // The session destroys its owned inputs before the enclosing
                      // grant owner performs the final authority recheck.
                      runtime: { ...signer.runtime, key: signer.runtime.key.slice() },
                      grantId: evidence.requestId, grantDigest: evidence.authorizationDigest.slice(),
                      recipientKeyId: evidence.recipientKeyId, authorizationSignal: entities.signal,
                      checkpoint: Object.freeze({
                        ...checkpoint,
                        crypto: bindProtectedCheckpointCellDataOperationOwner({
                          owner: input.owner,
                          crypto: checkpoint.crypto,
                        }),
                      }),
                      ...services,
                      withCurrentTranscriptAuthority: async sink => {
                        await assertAllCurrent();
                        const result = await lifecycle.withCurrentWriter({ signer: writerSigner,
                          resolveHistoricalSignerPublicationManager,
                          use: async writer => {
                            // Commit crypto independently before the product mapping FK is checked.
                            // Its prepared write resolver still borrows this held current writer.
                            const completion = createPostgresConversationCryptoCompletion({ handle, crypto: input.crypto,
                              commonManifestExpectedAgentId: evidence.signerAgentId,
                              resolveCurrentWriteAuthorization: () => Promise.resolve(null),
                              resolveHistoricalSigner: history.resolveHistoricalObjectSigner,
                              resolveHistoricalAgentSignerAuthority: history.resolveAgentRuntimeSignerManager,
                              resolveLiveShadowAgentSigner: principal => principal.agentId === evidence.signerAgentId
                                && principal.runtimeGeneration === writerSigner.runtimeGeneration
                                && principal.signerKeyId === writerSigner.signerKeyId
                                ? Uint8Array.from(writerSigner.signerPublicKey) : null });
                            const value = await sink({ product: writer.productStore,
                              conversation: createDormantConversationShadowRepository({ product: writer.productStore, crypto: completion }),
                              resolveCurrentDeviceWrappedAgentObjectAuthorization: writer.resolveCurrentAgentObjectWrite });
                            signal.throwIfAborted();
                            assertAuthenticTaskRuntimeWakeForegroundEvidence(evidence);
                            return { value };
                          } });
                        if (result === null) unavailable("Wake transcript publication authority changed");
                        return result.value;
                      },
                    });
                    try {
                      const { enforcementPolicy: _policy, dataOperationPolicy: _binding, ...facts } = signedContext;
                      const source: ProtectedTaskWakeForegroundSource = { ...facts, evidence,
                        scheduling: lifecycle.scheduling, result };
                      return await use(session, source);
                    } finally { session.destroy(); }
                  } });
                if (borrowed.status !== "executed") unavailable("Wake Namespace custody is unavailable");
                return borrowed.value;
              } finally {
                certified?.certificateHash.fill(0);
              }
            };
            const openSigner = (
              expectedAgentAuthorizationRevision: number,
              signerHistory: Readonly<{
                resolveHistoricalRuntimeCommitter: Parameters<
                  typeof withProtectedTaskWakeForegroundSigner
                >[0]["resolveHistoricalRuntimeCommitter"];
                resolveHistoricalSignerPublicationManager:
                  ResolveHistoricalAgentRuntimeSignerPublicationManager;
              }>,
            ) => withProtectedTaskWakeForegroundSigner({ crypto: input.crypto, storage,
              evidence, namespaceId, domain, expectedAgentAuthorizationRevision,
              ...signerHistory,
              execute: signer => useSigner(
                signer,
                signerHistory.resolveHistoricalSignerPublicationManager,
              ),
            });
            if (hasTaskRuntimeTemporarySigner(evidence)) {
              const signed = await openSigner(0, {
                resolveHistoricalRuntimeCommitter: () => null,
                resolveHistoricalSignerPublicationManager: () => null,
              });
              if (signed.status !== "executed") unavailable("Wake HIVE signer custody is unavailable");
              return signed.value;
            }
            const state = await storage.getAgentRuntimeAtomicState(evidence.signerAgentId);
            let authorizationRevision: number;
            let runtimeGeneration: number;
            try {
              if (state === null) unavailable("Wake Runtime signer is unavailable");
              authorizationRevision = state.runtime.authorizationRevision;
              runtimeGeneration = state.runtime.runtimeGeneration;
            } finally { wipe(state); }
            const signed = await withProtectedTaskResultSignerHistory({ handle, crypto: input.crypto,
              agentId: evidence.signerAgentId, domainId: domain.domainId, domainEpoch: domain.domainKeyGeneration,
              expectedAgentAuthorizationRevision: authorizationRevision, expectedRuntimeGeneration: runtimeGeneration,
              use: signerHistory => openSigner(authorizationRevision, signerHistory),
            });
            if (signed.status !== "executed") unavailable("Wake HIVE signer custody is unavailable");
            return signed.value;
          },
        });
      },
    });
  };
}

/** Adopt one already-durable Room Job while the fresh independent grant stays callback-live. */
export function createProtectedTaskWakeForegroundPublication(input: ProtectedTaskWakeForegroundPublicationInput,
  overrides: Partial<ProtectedTaskWakeForegroundPublicationDependencies> = {}): ProtectedTaskOutputReadPublication {
  const withSession = overrides.withSession ?? sessionOwner(input);
  return async value => {
    const evidence = value.wakeEvidence;
    if (evidence === undefined) unavailable("Wake foreground evidence is required");
    assertAuthenticTaskRuntimeWakeForegroundEvidence(evidence);
    assertAuthenticTaskRuntimeRunResultReadEvidence(value.evidence);
    if (value.plan.intent.invocation.kind !== "wake" || value.record.workKind !== "task.delivery_wake"
      || value.record.snapshot.state !== "running" || value.record.snapshot.claimId !== evidence.claimId
      || value.record.purpose !== "task.delivery_wake" || value.evidence.workKind !== "task.delivery_wake"
      || value.evidence.messageWrite !== null
      || evidence.requestId !== value.record.snapshot.requestId || evidence.workId !== value.record.snapshot.workId
      || evidence.requestId !== value.evidence.requestId || evidence.claimId !== value.evidence.claimId
      || evidence.policyRevision !== value.plan.intent.expectedPolicyRevision
      || evidence.signerAgentId !== value.plan.intent.agentId
      || !isDeepStrictEqual(evidence.invocation, value.plan.intent.invocation)
      || !isDeepStrictEqual(evidence.invocation, value.evidence.invocation)) unavailable("Wake publication coordinate changed");
    const { namespace: resultNamespace, ...result } = value.evidence.result;
    if (!isDeepStrictEqual(result, value.plan.intent.result)
      || resultNamespace.namespaceId !== value.plan.intent.contentNamespaceId
      || evidence.requesterHumanId !== value.plan.intent.requesterHumanId) unavailable("Wake result coordinate changed");
    const publication: ProtectedTaskWakePublication = { ...value, wakeEvidence: evidence };
    let parkedOutcome: Readonly<{ status: "parked"; receipt: ProtectedTaskWakeCommittedPark }> | undefined;
    const run = async (representation: "protected" | "dual") => {
      if (value.plan.intent.representation !== representation) unavailable("Wake publication mode changed");
      const lifecycle = await input.createLifecycle(publication);
      if (lifecycle === null || lifecycle.scheduling.jobState !== "queued") unavailable("Wake Job is not safely queued");
      let active = true;
      let settled = false;
      let turnCompleted = false;
      let invoked = false;
      let capturedProjection: ProtectedTaskWakeAdditionalProjectionAuthority | null = null;
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const completed = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      // A rejection can precede adoption's async return (e.g. immediate refusal).
      void completed.catch(() => undefined);
      const assertCurrent = async () => {
        if (!active) unavailable("Wake publication scope closed");
        value.signal.throwIfAborted();
        assertAuthenticTaskRuntimeWakeForegroundEvidence(evidence);
        assertAuthenticTaskRuntimeRunResultReadEvidence(value.evidence);
        await value.assertCurrentClaim();
        await lifecycle.assertCurrent();
        value.signal.throwIfAborted();
      };
      const release = () => {
        if (!active) return;
        active = false;
        if ((settled || parkedOutcome !== undefined) && turnCompleted) resolve();
        else reject(new ClassifiedDataOperationError("cancelled", "Wake foreground custody ended before completed settlement"));
      };
      const candidate: ProtectedTaskWakeExecutionCandidate = {
        start: async jobId => { await assertCurrent(); return lifecycle.start(jobId); },
        settle: async (jobId, requested) => {
          await assertCurrent();
          const result = await lifecycle.settle(jobId, requested);
          settled = result.kind !== "rejected" && result.status === "completed" && requested === "completed";
          return result;
        },
        run: async work => {
          if (invoked) unavailable("Wake candidate is one-shot");
          invoked = true;
          await assertCurrent();
          const result = await input.withForegroundContext({ publication, scheduling: lifecycle.scheduling, signal: value.signal,
            use: async context => {
              if (context.enforcementPolicy.mode === "plaintext_only"
                || context.enforcementPolicy.revision !== evidence.policyRevision
                || (context.enforcementPolicy.mode === "encrypted_only") !== (representation === "protected")) {
                unavailable("Wake foreground policy changed");
              }
              return withSession({ publication, lifecycle, context, assertCurrent,
                onAdditionalProjectionAuthority: capture => {
                  capturedProjection = Object.freeze({
                    plan: Object.freeze({ ...capture.plan,
                      requestDigest: Uint8Array.from(capture.plan.requestDigest),
                      semanticAuthorityRequirements: structuredClone(capture.plan.semanticAuthorityRequirements) }),
                    destination: Object.freeze({ ...capture.destination,
                      destinationAuthorityDigest: Uint8Array.from(capture.destination.destinationAuthorityDigest) }),
                    sourceEnvelopeDigest: Uint8Array.from(capture.sourceEnvelopeDigest),
                    checkpointBinding: Object.freeze({ ...capture.checkpointBinding,
                      retainedSourceNamespaceIds: Object.freeze([...capture.checkpointBinding.retainedSourceNamespaceIds]),
                      sourceEnvelopeDigest: Uint8Array.from(capture.checkpointBinding.sourceEnvelopeDigest) }),
                  });
                },
              }, (session, source) => {
                const authorizationSignal = session.authorizationSignal;
                if (authorizationSignal === undefined) unavailable("Wake session cancellation is missing");
                const realtimeSession = withCommittedWakeRealtimePublication({
                  session,
                  evidence,
                  scheduling: lifecycle.scheduling,
                  representationMode: representation === "protected"
                    ? "full_encryption"
                    : "shadow_encryption",
                  ...(input.onDiagnostic === undefined ? {} : {
                    onDiagnostic: input.onDiagnostic,
                  }),
                });
                return runWithTaskWakeLiveShadowTurnSession({ source, session: realtimeSession,
                  enforcementPolicy: context.enforcementPolicy, dataOperationPolicy: context.dataOperationPolicy,
                  work: () => work({ ownerId: lifecycle.scheduling.ownerId, requestorId: lifecycle.scheduling.requestorId,
                    agentId: lifecycle.scheduling.agentId, roomId: lifecycle.scheduling.roomId,
                    graphThreadId: lifecycle.scheduling.graphThreadId, threadId: lifecycle.scheduling.graphThreadId,
                    turnId: evidence.invocation.operationId, message: "" }, authorizationSignal, {
                      park: async request => {
                        await assertCurrent();
                        const capture = capturedProjection;
                        if (capture === null || parkedOutcome !== undefined
                          || request.effectDisposition !== "not_started_v1"
                          || request.additionalAuthorizationRequestId !== capture.plan.authorizationRequestId
                          || request.operationId !== capture.plan.operationId
                          || !Buffer.from(request.requestDigest).equals(Buffer.from(capture.plan.requestDigest))
                          || !sameProtectedTaskSemanticAuthorityRequirements(request.semanticAuthorityRequirements,
                            capture.plan.semanticAuthorityRequirements)
                          || !isDeepStrictEqual(request.checkpointBinding, source.checkpointBinding)
                          || !Buffer.from(capture.sourceEnvelopeDigest).equals(Buffer.from(source.checkpointBinding.sourceEnvelopeDigest))
                          || !isDeepStrictEqual(capture.checkpointBinding, source.checkpointBinding)
                          || request.checkpointThreadId !== `protected-task-wake:${lifecycle.scheduling.jobId}`) {
                          return { status: "stale" };
                        }
                        const requiredDigest = protectedTaskSemanticAuthorityRequirementsDigest(
                          capture.plan.semanticAuthorityRequirements,
                        );
                        try {
                          if (!Buffer.from(requiredDigest).equals(Buffer.from(request.requiredAuthorityDigest))) {
                            return { status: "stale" };
                          }
                        } finally { requiredDigest.fill(0); }
                        const result = await lifecycle.park({ request, destination: capture.destination });
                        if (result.status === "stale" || result.receipt === undefined) return { status: "stale" };
                        parkedOutcome = Object.freeze({ status: "parked", receipt: result.receipt });
                        return { status: result.status };
                      },
                    }),
                });
              });
            } }).catch(error => {
              input.onDiagnostic?.("agent_input", error);
              throw error;
            });
          turnCompleted = true;
          return result;
        },
        onIneligible: release,
      };
      const abort = () => { if (!invoked) release(); };
      value.signal.addEventListener("abort", abort, { once: true });
      try {
        await assertCurrent();
        const adopted = await input.jobManager.adoptProtectedTaskWakeJob({ scheduling: lifecycle.scheduling,
          reference: evidence.invocation.reference, executor: input.executor, candidate });
        if (adopted.status !== "adopted") release();
        await completed;
      } finally {
        value.signal.removeEventListener("abort", abort);
        release();
        lifecycle.dispose?.();
      }
    };
    await input.owner.runMutation({ protected: () => run("protected"), dual: () => run("dual") });
    return parkedOutcome;
  };
}
