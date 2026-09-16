import type {
  DurableRecordEnvelope,
  DurableRecordSemanticFields,
} from "@nautilo/reflection/durable";

import {
  decodeRecordPayloadV1,
  encodeRecordPayloadV1,
  type RecordPayloadV1,
} from "../record-payload-v1";

export function encodeDurableRecordEnvelope(
  envelope: DurableRecordEnvelope,
): Uint8Array {
  return encodeRecordPayloadV1({
    formatVersion: 1,
    posture: "derived",
    observedContentFingerprint: envelope.semantic.observedContentFingerprint,
    sourceOwnedKind: envelope.semantic.sourceOwnedKind ?? null,
    observedLogicalObjectRef: envelope.semantic.observedLogicalObjectRef ?? null,
    observedRevision: envelope.semantic.observedRevision ?? null,
    statement: envelope.semantic.statement,
    sourceDependencies: envelope.semantic.sourceDependencies.map((source) => ({
      sourceKind: source.sourceKind,
      logicalObjectRef: source.logicalSourceRef,
      observedRevision: source.observedRevision ?? null,
      observedContentFingerprint: source.observedContentFingerprint ?? null,
      terminalAuthorityLeafHandle: source.terminalAuthorityLeafHandle,
      authorityBearing: source.authorityBearing,
    })),
    anchors: envelope.semantic.anchors,
    childRecordIds: envelope.semantic.childRecordRefs,
    producer: envelope.semantic.producer,
    terminalAuthorityLeafHandles: envelope.semantic.terminalAuthorityLeafHandles,
    ...(envelope.semantic.modelExposureDependencies === undefined
      ? {}
      : {
          modelExposureDependencies: envelope.semantic.modelExposureDependencies.map(
            (dependency) => dependency.kind === "record"
              ? {
                  kind: "record" as const,
                  recordId: dependency.recordRef,
                  observedProcessingGeneration:
                    dependency.observedProcessingGeneration,
                  terminalAuthorityLeafHandles:
                    dependency.terminalAuthorityLeafHandles,
                }
              : {
                  kind: "source" as const,
                  sourceKind: dependency.sourceKind,
                  logicalObjectRef: dependency.logicalSourceRef,
                  observedRevision: dependency.observedRevision ?? null,
                  observedContentFingerprint:
                    dependency.observedContentFingerprint ?? null,
                  terminalAuthorityLeafHandle:
                    dependency.terminalAuthorityLeafHandle,
                },
          ),
        }),
  });
}

export function decodeDurableRecordEnvelope(input: Readonly<{
  recordRef: string;
  lifecycle: DurableRecordEnvelope["lifecycle"];
  structuralHeight: number;
  processingGeneration: number;
  payloadBytes: Uint8Array;
}>): DurableRecordEnvelope {
  const payload: RecordPayloadV1 = decodeRecordPayloadV1(input.payloadBytes);
  const semantic: DurableRecordSemanticFields = {
    observedContentFingerprint: payload.observedContentFingerprint,
    posture: payload.posture,
    statement: payload.statement,
    sourceDependencies: payload.sourceDependencies.map((source) => ({
      sourceKind: source.sourceKind,
      logicalSourceRef: source.logicalObjectRef,
      ...(source.observedRevision === null
        ? {}
        : { observedRevision: source.observedRevision }),
      ...(source.observedContentFingerprint === null
        ? {}
        : { observedContentFingerprint: source.observedContentFingerprint }),
      terminalAuthorityLeafHandle: source.terminalAuthorityLeafHandle,
      authorityBearing: source.authorityBearing,
    })),
    anchors: payload.anchors,
    childRecordRefs: payload.childRecordIds,
    producer: payload.producer,
    terminalAuthorityLeafHandles: payload.terminalAuthorityLeafHandles,
    ...(payload.modelExposureDependencies === undefined
      ? {}
      : {
          modelExposureDependencies: payload.modelExposureDependencies.map(
            (dependency) => dependency.kind === "record"
              ? {
                  kind: "record" as const,
                  recordRef: dependency.recordId,
                  observedProcessingGeneration:
                    dependency.observedProcessingGeneration,
                  terminalAuthorityLeafHandles:
                    dependency.terminalAuthorityLeafHandles,
                }
              : {
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
                },
          ),
        }),
    ...(payload.sourceOwnedKind === null
      ? {}
      : { sourceOwnedKind: payload.sourceOwnedKind }),
    ...(payload.observedLogicalObjectRef === null
      ? {}
      : { observedLogicalObjectRef: payload.observedLogicalObjectRef }),
    ...(payload.observedRevision === null
      ? {}
      : { observedRevision: payload.observedRevision }),
  };
  return {
    recordRef: input.recordRef,
    semantic,
    lifecycle: input.lifecycle,
    structuralHeight: input.structuralHeight,
    processingGeneration: input.processingGeneration,
  };
}
