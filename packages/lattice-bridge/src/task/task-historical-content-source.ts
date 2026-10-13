import type { ProtectedTaskPublicationPlanRequestV1 } from "@nautilo/api-client/browser";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  classifyProtectedTaskMetadataV1,
  type ProtectedTaskOperationalMetadataProjectionV1,
} from "@nautilo/types";

import {
  encodeTaskOperationalFieldsV1,
  fingerprintTaskOperationalMetadataV1,
} from "./task-operational-fields-digest-v1.ts";
import {
  encodeTaskPayloadV1,
  encodeTaskRunResultPayloadV1,
  type TaskPayloadV1,
  type TaskRunResultPayloadV1,
} from "./task-payload-v1.ts";

const SOURCE_DIGEST_DOMAIN_V1 = "nautilo/task-historical-content-source/v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TASK_STATUSES = [
  "pending", "running", "awaiting", "paused", "completed", "cancelled", "errored",
] as const;
const RUN_RESULT_STATUSES = ["completed", "cancelled", "errored"] as const;
const encoder = new TextEncoder();

export type TaskHistoricalOperationalFieldsV1 = Extract<
  ProtectedTaskPublicationPlanRequestV1,
  { operation: "create" }
>["task"];

type TaskHistoricalSourceCommonV1 = Readonly<{
  taskId: string;
  requesterHumanId: string;
  sourceRevision: 0;
  taskCreatedAt: Date;
  taskUpdatedAt: Date;
  taskStatus: typeof TASK_STATUSES[number];
  metadata: unknown;
  operationalFields: TaskHistoricalOperationalFieldsV1;
}>;

export type TaskHistoricalDefinitionSourceV1 = TaskHistoricalSourceCommonV1 & Readonly<{
  kind: "definition";
  activeRun: boolean;
  parentTaskId: string | null;
  taskLastError: string | null;
  prompt: string;
  expectedOutput: string | null;
}>;

export type TaskHistoricalRunResultSourceV1 = TaskHistoricalSourceCommonV1 & Readonly<{
  kind: "run_result";
  taskRunId: string;
  runStartedAt: Date;
  runCompletedAt: Date;
  runStatus: typeof RUN_RESULT_STATUSES[number];
  resultText: string | null;
  lastError: string | null;
}>;

export type TaskHistoricalContentSourceV1 =
  | TaskHistoricalDefinitionSourceV1
  | TaskHistoricalRunResultSourceV1;

export type TaskHistoricalContentSourceUnsupportedReasonV1 =
  | "invalid_source"
  | "nested_task"
  | "task_last_error"
  | "metadata"
  | "operational_fields"
  | "payload";

type SupportedHistoricalSourceV1<
  Kind extends TaskHistoricalContentSourceV1["kind"],
  Payload,
> = Readonly<{
  status: "supported";
  kind: Kind;
  payload: Payload;
  operationalMetadata: ProtectedTaskOperationalMetadataProjectionV1;
  operationalFieldsDigest: Uint8Array;
  sourcePayloadHash: Uint8Array;
  sourceDigest: Uint8Array;
}>;

export type TaskHistoricalContentSourceClassificationV1 =
  | SupportedHistoricalSourceV1<"definition", TaskPayloadV1>
  | SupportedHistoricalSourceV1<"run_result", TaskRunResultPayloadV1>
  | Readonly<{
      status: "unsupported";
      reason: TaskHistoricalContentSourceUnsupportedReasonV1;
    }>
  | Readonly<{ status: "no_content" }>
  | Readonly<{ status: "waiting_parent"; reason: "active_definition" }>;

function unsupported(
  reason: TaskHistoricalContentSourceUnsupportedReasonV1,
): Extract<TaskHistoricalContentSourceClassificationV1, { status: "unsupported" }> {
  return Object.freeze({ status: "unsupported", reason });
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function validCommon(source: TaskHistoricalContentSourceV1): boolean {
  return UUID.test(source.taskId)
    && UUID.test(source.requesterHumanId)
    && source.sourceRevision === 0
    && validDate(source.taskCreatedAt)
    && validDate(source.taskUpdatedAt)
    && source.taskUpdatedAt.getTime() >= source.taskCreatedAt.getTime()
    && TASK_STATUSES.includes(source.taskStatus);
}

function hex(value: Uint8Array): string {
  return Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("");
}

function sourceDigest(
  source: TaskHistoricalContentSourceV1,
  operationalFieldsDigest: Uint8Array,
  metadataDigest: Uint8Array,
  payloadHash: Uint8Array,
): Uint8Array {
  const common = [
    SOURCE_DIGEST_DOMAIN_V1,
    source.kind,
    source.requesterHumanId,
    source.taskId,
    source.sourceRevision,
    source.taskCreatedAt.toISOString(),
    source.taskUpdatedAt.toISOString(),
    source.taskStatus,
  ] as const;
  const tuple = source.kind === "definition"
    ? [...common, hex(operationalFieldsDigest), hex(metadataDigest), hex(payloadHash)]
    : [...common, source.taskRunId, source.runStartedAt.toISOString(),
        source.runCompletedAt.toISOString(), source.runStatus,
        hex(operationalFieldsDigest), hex(metadataDigest), hex(payloadHash)];
  const bytes = encoder.encode(JSON.stringify(tuple));
  try {
    return sha256(bytes);
  } finally {
    bytes.fill(0);
  }
}

/**
 * Classify and fingerprint one exact ordinary historical Task source without
 * inferring device, Namespace, policy, or publication authority.
 */
export function classifyTaskHistoricalContentSourceV1(
  source: TaskHistoricalContentSourceV1,
): TaskHistoricalContentSourceClassificationV1 {
  if (!validCommon(source)) return unsupported("invalid_source");
  if (source.kind === "definition") {
    if (typeof source.activeRun !== "boolean") return unsupported("invalid_source");
    if (source.parentTaskId !== null) return unsupported("nested_task");
    if (source.activeRun || source.taskStatus === "running" || source.taskStatus === "awaiting") {
      return Object.freeze({ status: "waiting_parent", reason: "active_definition" });
    }
    if (source.taskLastError !== null) return unsupported("task_last_error");
  } else if (!UUID.test(source.taskRunId)
    || !validDate(source.runStartedAt) || !validDate(source.runCompletedAt)
    || source.runCompletedAt.getTime() < source.runStartedAt.getTime()
    || !RUN_RESULT_STATUSES.includes(source.runStatus)) {
    return unsupported("invalid_source");
  } else if (source.resultText === null && source.lastError === null) {
    return Object.freeze({ status: "no_content" });
  }

  const metadata = classifyProtectedTaskMetadataV1(source.metadata);
  if (metadata.status === "unsupported") return unsupported("metadata");

  let operationalFieldsDigest: Uint8Array;
  try {
    const bytes = encodeTaskOperationalFieldsV1("create", source.operationalFields);
    try {
      operationalFieldsDigest = sha256(bytes);
    } finally {
      bytes.fill(0);
    }
  } catch {
    return unsupported("operational_fields");
  }

  const payload = source.kind === "definition"
    ? Object.freeze({
        formatVersion: 1 as const,
        prompt: source.prompt,
        expectedOutput: source.expectedOutput,
        protectedMetadata: metadata.protectedContent,
      })
    : Object.freeze({
        formatVersion: 1 as const,
        resultText: source.resultText,
        lastError: source.lastError,
      });
  let payloadBytes: Uint8Array;
  try {
    payloadBytes = source.kind === "definition"
      ? encodeTaskPayloadV1(payload as TaskPayloadV1)
      : encodeTaskRunResultPayloadV1(payload as TaskRunResultPayloadV1);
  } catch {
    operationalFieldsDigest.fill(0);
    return unsupported("payload");
  }

  const sourcePayloadHash = sha256(payloadBytes);
  const metadataDigest = fingerprintTaskOperationalMetadataV1(metadata.operational);
  try {
    return Object.freeze({
      status: "supported" as const,
      kind: source.kind,
      payload,
      operationalMetadata: metadata.operational,
      operationalFieldsDigest,
      sourcePayloadHash,
      sourceDigest: sourceDigest(
        source,
        operationalFieldsDigest,
        metadataDigest,
        sourcePayloadHash,
      ),
    }) as TaskHistoricalContentSourceClassificationV1;
  } finally {
    payloadBytes.fill(0);
    metadataDigest.fill(0);
  }
}
