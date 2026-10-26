import {
  HUMAN_TASK_PUBLICATION_REQUEST_MAX_TTL_MS_V1,
  LATTICE_LIMITS,
} from "@nautilo/lattice-crypto/wire-limits";
import { z } from "zod";
import {
  taskOperationalCreateV1Schema,
  taskOperationalUpdateV1Schema,
} from "./protected-task.ts";

const portableId = z.string().min(1).max(LATTICE_LIMITS.idBytes)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u);
const canonicalTaskId = z.string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveCounter = counter.min(1);
const canonicalIsoTimestamp = z.string().datetime({ offset: true }).refine(
  (value) => new Date(value).toISOString() === value,
  { message: "timestamp must use canonical ISO form" },
);
const digestBase64url = z.string().length(43).regex(/^[A-Za-z0-9_-]{43}$/u);
const boundedBase64url = z.string().min(1)
  .max(Math.ceil(LATTICE_LIMITS.plaintextBytes * 4 / 3))
  .regex(/^[A-Za-z0-9_-]+$/u)
  .refine((value) => value.length % 4 !== 1, {
    message: "value must be canonical unpadded base64url",
  });

export const taskOrdinaryFallbackPlanCreateRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  operationId: portableId,
  task: taskOperationalCreateV1Schema,
}).strict();

export const taskOrdinaryFallbackPlanUpdateRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  operationId: portableId,
  task: taskOperationalUpdateV1Schema,
}).strict();

const taskOrdinaryFallbackPlanBaseV1Schema = z.object({
  formatVersion: z.literal(1),
  reason: z.literal("target_encryption_not_ready"),
  operationId: portableId,
  taskId: canonicalTaskId,
  sourceDigestBase64url: digestBase64url,
  operationalFieldsDigestBase64url: digestBase64url,
  expectedContentRevision: counter,
  expectedCryptoAccessRevision: counter,
  expectedUpdatedAt: canonicalIsoTimestamp.nullable(),
  policyRevision: positiveCounter,
  subjectHumanId: portableId,
  committerDeviceId: portableId,
  committerDeviceSigningKeyGeneration: positiveCounter,
  hostAuthorizationRevision: counter,
  planIssuedAt: counter,
  planDeadlineAt: counter,
  planDigestBase64url: digestBase64url,
}).strict();

export const taskOrdinaryFallbackCreatePlanV1Schema =
  taskOrdinaryFallbackPlanBaseV1Schema.extend({
    purpose: z.literal("task.ordinary_fallback.create"),
    expectedContentRevision: z.literal(0),
    expectedCryptoAccessRevision: z.literal(0),
    expectedUpdatedAt: z.null(),
  }).strict().refine((value) => value.planDeadlineAt > value.planIssuedAt
    && value.planDeadlineAt - value.planIssuedAt
      <= HUMAN_TASK_PUBLICATION_REQUEST_MAX_TTL_MS_V1, {
    message: "Task ordinary fallback plan deadline is invalid",
    path: ["planDeadlineAt"],
  });

export const taskOrdinaryFallbackUpdatePlanV1Schema =
  taskOrdinaryFallbackPlanBaseV1Schema.extend({
    purpose: z.literal("task.ordinary_fallback.update"),
    expectedUpdatedAt: canonicalIsoTimestamp,
  }).strict().refine((value) => value.planDeadlineAt > value.planIssuedAt
    && value.planDeadlineAt - value.planIssuedAt
      <= HUMAN_TASK_PUBLICATION_REQUEST_MAX_TTL_MS_V1, {
    message: "Task ordinary fallback plan deadline is invalid",
    path: ["planDeadlineAt"],
  });

export const taskOrdinaryFallbackPlanV1Schema = z.union([
  taskOrdinaryFallbackCreatePlanV1Schema,
  taskOrdinaryFallbackUpdatePlanV1Schema,
]);

const taskOrdinaryFallbackPublicationBaseV1Schema = z.object({
  requestVersion: z.literal(1),
  representation: z.literal("ordinary_fallback"),
  operationId: portableId,
  taskId: canonicalTaskId,
  authenticatedRequestDigestBase64url: digestBase64url,
  ordinaryPayloadBytesBase64url: boundedBase64url,
  signedOrdinaryFallbackRequestBytesBase64url: boundedBase64url,
}).strict();

export const taskOrdinaryFallbackPreparedCreateRequestV1Schema =
  taskOrdinaryFallbackPublicationBaseV1Schema.extend({
    task: taskOperationalCreateV1Schema,
  }).strict();

export const taskOrdinaryFallbackPreparedUpdateRequestV1Schema =
  taskOrdinaryFallbackPublicationBaseV1Schema.extend({
    task: taskOperationalUpdateV1Schema,
  }).strict();

export type TaskOrdinaryFallbackPlanCreateRequestV1 = z.infer<
  typeof taskOrdinaryFallbackPlanCreateRequestV1Schema
>;
export type TaskOrdinaryFallbackPlanUpdateRequestV1 = z.infer<
  typeof taskOrdinaryFallbackPlanUpdateRequestV1Schema
>;
export type TaskOrdinaryFallbackCreatePlanV1 = z.infer<
  typeof taskOrdinaryFallbackCreatePlanV1Schema
>;
export type TaskOrdinaryFallbackUpdatePlanV1 = z.infer<
  typeof taskOrdinaryFallbackUpdatePlanV1Schema
>;
export type TaskOrdinaryFallbackPlanV1 = z.infer<
  typeof taskOrdinaryFallbackPlanV1Schema
>;
export type TaskOrdinaryFallbackPreparedCreateRequestV1 = z.infer<
  typeof taskOrdinaryFallbackPreparedCreateRequestV1Schema
>;
export type TaskOrdinaryFallbackPreparedUpdateRequestV1 = z.infer<
  typeof taskOrdinaryFallbackPreparedUpdateRequestV1Schema
>;
