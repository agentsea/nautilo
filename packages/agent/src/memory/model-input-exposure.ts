import { AsyncLocalStorage } from "node:async_hooks";
import {
  parseModelInputExposureMetadataV1,
  normalizeRecordModelExposureDependenciesV1,
  RECORD_PAYLOAD_V1_LIMITS,
  type ModelInputExposureMetadataV1,
  type RecordPayloadModelExposureDependencyV1,
} from "@nautilo/reflection/payload";
import type {
  DurableModelExposureDependency,
} from "@nautilo/reflection/durable";

export const MODEL_INPUT_EXPOSURE_METADATA_KEY =
  "nautilo_memory_model_exposure" as const;

export type ModelInputExposure =
  | Readonly<{
      readonly status: "complete";
      readonly dependencies: readonly DurableModelExposureDependency[];
    }>
  | Readonly<{ readonly status: "incomplete" }>;

const exposures = new WeakMap<object, ModelInputExposure>();
const producerExposures = new WeakMap<object, ModelInputExposure>();
export interface AuthoredMemoryBriefExposure {
  readonly content: string;
  readonly exposure: ModelInputExposure;
}
const authoredExposureStorage = new AsyncLocalStorage<Readonly<{
  exposure: ModelInputExposure;
  memoryBrief?: AuthoredMemoryBriefExposure;
}>>();
const encoder = new TextEncoder();

function wireDependency(
  dependency: DurableModelExposureDependency,
): RecordPayloadModelExposureDependencyV1 {
  return dependency.kind === "record"
    ? {
        kind: "record",
        recordId: dependency.recordRef,
        observedProcessingGeneration:
          dependency.observedProcessingGeneration,
        terminalAuthorityLeafHandles:
          dependency.terminalAuthorityLeafHandles,
      }
    : {
        kind: "source",
        sourceKind: dependency.sourceKind,
        logicalObjectRef: dependency.logicalSourceRef,
        observedRevision: dependency.observedRevision ?? null,
        observedContentFingerprint:
          dependency.observedContentFingerprint ?? null,
        terminalAuthorityLeafHandle:
          dependency.terminalAuthorityLeafHandle,
      };
}

function durableDependency(
  dependency: RecordPayloadModelExposureDependencyV1,
): DurableModelExposureDependency {
  return dependency.kind === "record"
    ? Object.freeze({
        kind: "record" as const,
        recordRef: dependency.recordId,
        observedProcessingGeneration:
          dependency.observedProcessingGeneration,
        terminalAuthorityLeafHandles:
          Object.freeze([...dependency.terminalAuthorityLeafHandles]),
      })
    : Object.freeze({
        kind: "source" as const,
        sourceKind: dependency.sourceKind,
        logicalSourceRef: dependency.logicalObjectRef,
        ...(dependency.observedRevision === null
          ? {}
          : { observedRevision: dependency.observedRevision }),
        ...(dependency.observedContentFingerprint === null
          ? {}
          : {
              observedContentFingerprint:
                dependency.observedContentFingerprint,
            }),
        terminalAuthorityLeafHandle:
          dependency.terminalAuthorityLeafHandle,
      });
}

function normalizeComplete(
  dependencies: readonly DurableModelExposureDependency[],
): ModelInputExposure {
  try {
    // The same input can appear directly in history and in an AI row's
    // retained ancestry. Collapse only canonically identical observations;
    // conflicting versions cannot establish a complete current input set.
    const byReference = new Map<string, RecordPayloadModelExposureDependencyV1>();
    for (const dependency of dependencies) {
      const normalized = normalizeRecordModelExposureDependenciesV1([
        wireDependency(dependency),
      ])[0]!;
      const reference = normalized.kind === "record"
        ? JSON.stringify([normalized.kind, normalized.recordId])
        : JSON.stringify([normalized.kind, normalized.sourceKind, normalized.logicalObjectRef]);
      const prior = byReference.get(reference);
      if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(normalized)) {
        return Object.freeze({ status: "incomplete" as const });
      }
      byReference.set(reference, normalized);
    }
    const wire = normalizeRecordModelExposureDependenciesV1([...byReference.values()]);
    const serialized = JSON.stringify(wire);
    if (encoder.encode(serialized).byteLength > RECORD_PAYLOAD_V1_LIMITS.payloadBytes) {
      return Object.freeze({ status: "incomplete" as const });
    }
    return Object.freeze({
      status: "complete" as const,
      dependencies: Object.freeze(wire.map(durableDependency)),
    });
  } catch {
    return Object.freeze({ status: "incomplete" as const });
  }
}

function normalizeExposure(exposure: ModelInputExposure): ModelInputExposure {
  return exposure.status === "incomplete"
    ? Object.freeze({ status: "incomplete" as const })
    : normalizeComplete(exposure.dependencies);
}

/** Bind evidence minted by an authorized producer to this exact live object. */
export function bindModelInputExposure<T extends object>(
  target: T,
  exposure: ModelInputExposure,
): T {
  exposures.set(target, normalizeExposure(exposure));
  return target;
}

/** Read process-trusted evidence only. Object fields are deliberately ignored. */
export function readModelInputExposure(
  target: object,
): ModelInputExposure | undefined {
  return exposures.get(target);
}

export function copyModelInputExposure<T extends object>(
  source: object,
  target: T,
): T {
  const exposure = exposures.get(source);
  if (exposure !== undefined) exposures.set(target, exposure);
  return target;
}

export function unionModelInputExposures(
  inputs: readonly object[],
  additional: readonly ModelInputExposure[] = [],
): ModelInputExposure {
  const values = [
    ...inputs.map((input) => exposures.get(input)),
    ...additional,
  ];
  if (
    values.some((value) => value === undefined || value.status === "incomplete")
  ) {
    return Object.freeze({ status: "incomplete" });
  }
  return normalizeComplete(values.flatMap((value) =>
    value?.status === "complete" ? value.dependencies : []
  ));
}

function encodedExposure(exposure: ModelInputExposure): ModelInputExposureMetadataV1 {
  return exposure.status === "incomplete"
    ? { version: 1, status: "incomplete" }
    : {
        version: 1,
        status: "complete",
        dependencies: exposure.dependencies.map(wireDependency),
      };
}

/** Return durable JSON only for a live object carrying trusted evidence. */
export function encodeModelInputExposureForMetadata(
  target: object,
): ModelInputExposureMetadataV1 | undefined {
  const exposure = exposures.get(target);
  return exposure === undefined ? undefined : encodedExposure(exposure);
}

/** Persist an explicit incomplete marker when no trusted producer bound one. */
export function modelInputExposureMetadataForPersistence(
  target: object,
): ModelInputExposureMetadataV1 {
  return encodedExposure(
    exposures.get(target) ?? Object.freeze({ status: "incomplete" }),
  );
}

function parsePersistedExposure(value: unknown): ModelInputExposure | null {
  const parsed = parseModelInputExposureMetadataV1(value);
  return parsed === null ? null : parsed.status === "incomplete"
    ? Object.freeze({ status: "incomplete" })
    : Object.freeze({
        status: "complete" as const,
        dependencies: Object.freeze(parsed.dependencies.map(durableDependency)),
      });
}

/**
 * Rebind persisted metadata only after the caller has reopened the exact
 * current row under canonical content and authority checks.
 */
export function bindModelInputExposureFromAuthorizedPersistedPayload<
  T extends object,
>(target: T, value: unknown): boolean {
  const exposure = parsePersistedExposure(value);
  if (exposure === null) return false;
  exposures.set(target, exposure);
  return true;
}

/** Declare evidence on an exact process-owned producer instance. */
export function declareModelInputExposureProducer<T extends object>(
  producer: T,
  exposure: ModelInputExposure,
): T {
  producerExposures.set(producer, normalizeExposure(exposure));
  return producer;
}

export function readDeclaredModelInputExposureProducer(
  producer: object,
): ModelInputExposure | undefined {
  return producerExposures.get(producer);
}

/** Scope exact authored prompt evidence to one authorized foreground turn. */
export function runWithAuthoredModelInputExposure<Value>(
  exposure: ModelInputExposure,
  callback: () => Value,
  memoryBrief?: AuthoredMemoryBriefExposure,
): Value {
  return authoredExposureStorage.run({ exposure: normalizeExposure(exposure),
    ...(memoryBrief === undefined ? {} : { memoryBrief: Object.freeze({
      content: memoryBrief.content, exposure: normalizeExposure(memoryBrief.exposure),
    }) }),
  }, callback);
}

export function getAuthoredModelInputExposure():
  | ModelInputExposure
  | undefined {
  return authoredExposureStorage.getStore()?.exposure;
}

/** Match exact rendered bytes; graph/checkpoint fields cannot mint a receipt. */
export function getAuthoredMemoryBriefExposure(content: string): ModelInputExposure | undefined {
  const receipt = authoredExposureStorage.getStore()?.memoryBrief;
  return receipt?.content === content ? receipt.exposure : undefined;
}

/**
 * Keep the trusted authored-input scope active while a lazy graph iterator is
 * doing work. Creating an async iterable inside an ALS scope is insufficient:
 * graph execution starts on each `next()` call.
 */
export async function* iterateWithAuthoredModelInputExposure<Value>(
  exposure: ModelInputExposure,
  iterable: AsyncIterable<Value>,
  memoryBrief?: AuthoredMemoryBriefExposure,
): AsyncGenerator<Value> {
  const iterator = iterable[Symbol.asyncIterator]();
  try {
    while (true) {
      const step = await runWithAuthoredModelInputExposure(
        exposure,
        () => iterator.next(),
        memoryBrief,
      );
      if (step.done) return;
      yield step.value;
    }
  } finally {
    if (iterator.return) {
      await runWithAuthoredModelInputExposure(
        exposure,
        () => iterator.return!(),
        memoryBrief,
      );
    }
  }
}

export type { DurableModelExposureDependency };
