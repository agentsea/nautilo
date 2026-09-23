import {
  taskContentSummaryV1Schema,
  taskOperationalCreateV1Schema,
  taskOperationalUpdateV1Schema,
} from "@nautilo/api-client";
import {
  decodeTaskPayloadV1,
  encodeTaskPayloadV1,
  type TaskPayloadV1,
} from "@nautilo/lattice-bridge";
import type { TaskOperationRequestV1 } from "@nautilo/types";
import { z } from "zod";
import { boundedForegroundShadowValue } from "./foreground-shadow-ipc-validation";

const taskPayload = z.unknown().transform((raw, context) => {
  try {
    const bytes = encodeTaskPayloadV1(raw as TaskPayloadV1);
    try {
      return decodeTaskPayloadV1(bytes);
    } finally {
      bytes.fill(0);
    }
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error
      ? error.message : "Task payload is invalid" });
    return z.NEVER;
  }
});

const taskOperationRequestV1Schema = z.discriminatedUnion("operation", [
  z.object({
    version: z.literal(1),
    operation: z.literal("list"),
    query: z.object({
      status: z.string().min(1).max(256).optional(),
      includeTerminal: z.boolean().optional(),
      recentTerminalLimit: z.number().int().nonnegative().safe().optional(),
    }).strict().optional(),
  }).strict(),
  z.object({
    version: z.literal(1),
    operation: z.literal("open"),
    task: taskContentSummaryV1Schema,
  }).strict(),
  z.object({
    version: z.literal(1),
    operation: z.literal("create"),
    payload: taskPayload,
    task: taskOperationalCreateV1Schema,
  }).strict(),
  z.object({
    version: z.literal(1),
    operation: z.literal("update"),
    current: taskContentSummaryV1Schema,
    payload: taskPayload,
    task: taskOperationalUpdateV1Schema,
  }).strict(),
]);

export function parseTaskOperationRequestV1(raw: unknown): TaskOperationRequestV1 {
  const parsed = taskOperationRequestV1Schema.parse(raw);
  return boundedForegroundShadowValue(parsed, "Task operation") as TaskOperationRequestV1;
}
