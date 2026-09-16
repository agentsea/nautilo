import type {BackgroundAuthorizationIssuerContextV2} from "@nautilo/lattice-crypto/background";
import type {CurrentProcessorHeldAuthority, WithCurrentProcessorPublicationAuthority} from "../storage/postgres-current-processor-transform-object-port.ts";
import type {StenographerAuthorizationWaitPort} from "./postgres-stenographer-authorization-wait.ts";
import {ClassifiedDataOperationError} from "../../transition/encryption-data-operation-owner.ts";
import type {ProcessorTransformCapability, ProcessorTransformInput} from "@nautilo/lattice-crypto";
import type {
  DataOperationFailureClass,
  DataOperationPublicationContext,
  EncryptionDataOperationOwner,
} from "../../transition/encryption-data-operation-owner.ts";

/** Preparation has queued exact work but has not opened bodies or run a model. */
export class StenographerAuthorizationWaitingError extends ClassifiedDataOperationError {
  constructor(readonly reason: "device" | "authority", readonly prepareFallback?: () => Promise<boolean>) {
    super("key_waiting", `Stenographer is waiting for ${reason}`);
  }
}

/** Borrow persisted outputs first, then hold current authority through the product
 * commit. A post-borrow check alone cannot roll back an already committed sibling. */
export function withVerifiedStenographerOrdinarySiblings<Result>(input: Readonly<{
  capability: ProcessorTransformCapability;
  context: BackgroundAuthorizationIssuerContextV2;
  withCurrentAuthority: WithCurrentProcessorPublicationAuthority;
  signal: AbortSignal;
  attach(held: CurrentProcessorHeldAuthority, outputs: readonly ProcessorTransformInput[]): Promise<Result>;
}>): Promise<Result> {
  if (input.capability.withPublishedOutputs === undefined) {
    throw new ClassifiedDataOperationError("unsupported", "Verified Stenographer output borrowing is unavailable");
  }
  return input.capability.withPublishedOutputs(async outputs => {
    input.signal.throwIfAborted();
    const result = await input.withCurrentAuthority({context: input.context, signal: input.signal,
      use: async held => {
        input.signal.throwIfAborted();
        if (held.product === undefined) throw new Error("Stenographer siblings require the held product transaction");
        const value = await input.attach(held, outputs);
        input.signal.throwIfAborted();
        return {value};
      }});
    if (result === null) throw new ClassifiedDataOperationError("stale", "Stenographer attachment authority changed");
    return result.value;
  });
}

export interface StenographerAttemptBoundary {
  readonly signal: AbortSignal;
  assertCurrent(): Promise<void>;
  publish<Result>(operation: () => Promise<Result>): Promise<Result>;
}

export type StenographerOperationOutcome =
  | Readonly<{
    readonly status: "completed";
    readonly processed: true;
    readonly metrics?: Readonly<Record<string, number | string>>;
  }>
  | Readonly<{
    readonly status: "prepared_rebuild";
    readonly processed: true;
    readonly roomId: string;
  }>
  | Readonly<{
    readonly status: "waiting";
    readonly processed: true;
    readonly reason: "device" | "authority" | "publication_reconciliation";
  }>
  | Readonly<{
    readonly status: "unavailable";
    readonly processed: false;
  }>
  | Readonly<{
    readonly status: "failed" | "cancelled";
    readonly processed: true;
  }>;

export type StenographerExtractionLane = "live" | "historical" | "rebuild";

/** Publication provenance only; adapters cannot use it to select a data path. */
export type StenographerPublicationContext = DataOperationPublicationContext & Readonly<{
  ordinaryFallbackReason?: "device" | "authority";
}>;

export type StenographerPreparedOperation = Readonly<{
  publish(
    context: StenographerPublicationContext,
  ): Promise<StenographerOperationOutcome>;
}>;

type StenographerAdapterInput<Input> = Omit<Input, "attempt"> & Readonly<{
  signal: AbortSignal;
}>;

export interface StenographerExtractionIntent {
  readonly roomId: string;
  readonly lane: StenographerExtractionLane;
  readonly modelId: string;
  readonly now: Date;
  readonly attempt: StenographerAttemptBoundary;
}

export interface StenographerCompactionIntent {
  readonly roomId: string;
  readonly modelId: string;
  readonly now: Date;
  readonly attempt: StenographerAttemptBoundary;
}

export interface StenographerRebuildIntent {
  readonly now: Date;
  readonly attempt: StenographerAttemptBoundary;
}

export interface StenographerLegacyConversionIntent {
  readonly now: Date;
  readonly attempt: StenographerAttemptBoundary;
}

export type StenographerExtractionAdapterInput =
  StenographerAdapterInput<StenographerExtractionIntent>;
export type StenographerCompactionAdapterInput =
  StenographerAdapterInput<StenographerCompactionIntent>;
export type StenographerRebuildAdapterInput =
  StenographerAdapterInput<StenographerRebuildIntent>;
export type StenographerLegacyConversionAdapterInput =
  StenographerAdapterInput<StenographerLegacyConversionIntent>;

/**
 * One lazy representation implementation. It may claim and open bodies and
 * invoke the model, but returns publication as a closure so the owner can
 * revalidate the selected policy immediately before the attempt publishes.
 */
export interface StenographerIntentAdapter {
  prepareNextOutputRepair?(input: StenographerRebuildAdapterInput): Promise<StenographerPreparedOperation>;
  prepareExtraction(
    input: StenographerExtractionAdapterInput,
  ): Promise<StenographerPreparedOperation>;
  prepareCompaction(
    input: StenographerCompactionAdapterInput,
  ): Promise<StenographerPreparedOperation>;
  prepareNextRebuild(
    input: StenographerRebuildAdapterInput,
  ): Promise<StenographerPreparedOperation>;
  prepareLegacyConversion(
    input: StenographerLegacyConversionAdapterInput,
  ): Promise<StenographerPreparedOperation>;
}

export interface StenographerDataOperationPort {
  runNextOutputRepair?(input: StenographerRebuildIntent): Promise<StenographerOperationOutcome>;
  runExtraction(
    input: StenographerExtractionIntent,
  ): Promise<StenographerOperationOutcome>;
  runCompaction(
    input: StenographerCompactionIntent,
  ): Promise<StenographerOperationOutcome>;
  runNextRebuild(
    input: StenographerRebuildIntent,
  ): Promise<StenographerOperationOutcome>;
  runLegacyConversion(
    input: StenographerLegacyConversionIntent,
  ): Promise<StenographerOperationOutcome>;
}

type FailureClassifier = (error: unknown) => DataOperationFailureClass;

interface StenographerAdapters {
  readonly ordinary?: StenographerIntentAdapter;
  readonly protected?: StenographerIntentAdapter;
  readonly dual?: StenographerIntentAdapter;
}

function selected(
  adapter: StenographerIntentAdapter | undefined,
  attempt: StenographerAttemptBoundary,
  prepare: (
    adapter: StenographerIntentAdapter,
  ) => Promise<StenographerPreparedOperation>,
): (() => Promise<StenographerPreparedOperation>) | undefined {
  if (adapter === undefined) return undefined;
  return async () => {
    await attempt.assertCurrent();
    return prepare(adapter);
  };
}

/**
 * Lattice-owned Stenographer operation boundary. Runtime supplies concrete
 * family adapters; only this owner selects which lazy representation can run.
 */
export function createStenographerDataOperationPort(input: Readonly<{
  readonly owner: EncryptionDataOperationOwner;
  readonly ordinary?: StenographerIntentAdapter;
  readonly protected?: StenographerIntentAdapter;
  readonly dual?: StenographerIntentAdapter;
  readonly classifyFailure?: FailureClassifier;
  readonly authorizationWait?: Pick<StenographerAuthorizationWaitPort, "clear">;
}>): StenographerDataOperationPort {
  const adapters: StenographerAdapters = input;
  const run = (
    attempt: StenographerAttemptBoundary,
    prepare: (
      adapter: StenographerIntentAdapter,
    ) => Promise<StenographerPreparedOperation>,
    waitLane?: Readonly<{roomId: string; lane: StenographerExtractionLane | "compaction"}>,
  ): Promise<StenographerOperationOutcome> => {
    let waiting: StenographerAuthorizationWaitingError | undefined;
    let dualFailed = false;
    const ordinaryPreparation = selected(adapters.ordinary, attempt, prepare);
    const ordinary = ordinaryPreparation === undefined ? undefined : async () => {
      if (waiting?.prepareFallback !== undefined && !await waiting.prepareFallback()) throw waiting;
      const prepared = await ordinaryPreparation();
      // Only the central owner can reach ordinary after a permitted dual failure.
      const ordinaryFallbackReason = dualFailed ? waiting?.reason ?? "authority" : undefined;
      return {publish: (context: DataOperationPublicationContext) => prepared.publish({
        ...context, ...(ordinaryFallbackReason === undefined ? {} : {ordinaryFallbackReason}),
      })};
    };
    const protectedOperation = selected(adapters.protected, attempt, prepare);
    const dualPreparation = selected(adapters.dual, attempt, prepare);
    const dual = dualPreparation === undefined ? undefined : async () => {
      try {return await dualPreparation();}
      catch (error) {
        dualFailed = true;
        if (error instanceof StenographerAuthorizationWaitingError) waiting = error;
        throw error;
      }
    };
    let publicationStarted = false;
    return input.owner.mutate({
      ...(ordinary === undefined ? {} : { ordinary }),
      ...(protectedOperation === undefined
        ? {}
        : { protected: protectedOperation }),
      ...(dual === undefined ? {} : { dual }),
      publish: (prepared, context) => {
        publicationStarted = true;
        return attempt.publish(() => prepared.publish(context));
      },
      ...(input.classifyFailure === undefined
        ? {}
        : { classifyFailure: input.classifyFailure }),
    }).catch((error: unknown) => {
      if (!publicationStarted && error instanceof StenographerAuthorizationWaitingError) {
        return Object.freeze({status: "waiting" as const, processed: true as const, reason: error.reason});
      }
      throw error;
    }).then(async outcome => {
      if (outcome.status !== "waiting" && waitLane !== undefined) {
        // Product completion is already durable. A status-write outage must
        // not turn it into another model attempt; eligibility filters also
        // suppress obsolete waits until the next metadata pass clears them.
        await input.authorizationWait?.clear(waitLane).catch(() => {});
      }
      return outcome;
    });
  };

  return Object.freeze({
    runNextOutputRepair: (intent: StenographerRebuildIntent) =>
      run(intent.attempt, adapter => adapter.prepareNextOutputRepair?.({now: intent.now, signal: intent.attempt.signal})
        ?? Promise.resolve({publish: () => Promise.resolve({status: "unavailable" as const, processed: false as const})})),
    runExtraction: (intent: StenographerExtractionIntent) =>
      run(intent.attempt, (adapter) => adapter.prepareExtraction({
        roomId: intent.roomId,
        lane: intent.lane,
        modelId: intent.modelId,
        now: intent.now,
        signal: intent.attempt.signal,
      }), {roomId: intent.roomId, lane: intent.lane}),
    runCompaction: (intent: StenographerCompactionIntent) =>
      run(intent.attempt, (adapter) => adapter.prepareCompaction({
        roomId: intent.roomId,
        modelId: intent.modelId,
        now: intent.now,
        signal: intent.attempt.signal,
      }), {roomId: intent.roomId, lane: "compaction"}),
    runNextRebuild: (intent: StenographerRebuildIntent) =>
      run(intent.attempt, (adapter) => adapter.prepareNextRebuild({
        now: intent.now,
        signal: intent.attempt.signal,
      })),
    runLegacyConversion: (intent: StenographerLegacyConversionIntent) =>
      run(intent.attempt, (adapter) => adapter.prepareLegacyConversion({
        now: intent.now,
        signal: intent.attempt.signal,
      })),
  });
}

interface StenographerCandidates {
  extraction(input: Readonly<{lane: "live" | "historical"; now: Date}>): Promise<readonly string[]>;
  compaction(input: Readonly<{now: Date}>): Promise<readonly string[]>;
  initializeHistorical(input: Readonly<{now: Date}>): Promise<void>;
}

/** Keep plaintext-only discovery independent of crypto storage initialization. */
export function createStenographerCandidateDataOperationPort(input: Readonly<{
  owner: EncryptionDataOperationOwner;
  ordinary: StenographerCandidates;
  protected(): Promise<StenographerCandidates>;
}>): StenographerCandidates {
  const select = async (run: (port: StenographerCandidates) => Promise<readonly string[]>) => {
    const result = await input.owner.read({
      ordinary: () => run(input.ordinary),
      protected: async () => run(await input.protected()),
      consumeOrdinary: (ids) => ids,
      consumeProtected: (ids) => ids,
    });
    return result.value;
  };
  return {
    extraction: (request) => select((port) => port.extraction(request)),
    compaction: (request) => select((port) => port.compaction(request)),
    initializeHistorical: (request) => input.owner.metadata(() => input.ordinary.initializeHistorical(request)),
  };
}
