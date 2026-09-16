import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Costs dashboard — call-type taxonomy for `llm_usage_events.call_type`.
 * Keep in sync with the DB column doc and the workbench legend.
 */
export type UsageCallType =
  | "chat"
  | "subagent"
  | "conductor"
  | "room_stenographer"
  | "room_reflection"
  | "room_event_compaction"
  | "embedding"
  | "image_gen"
  | "memory_flush"
  | "memory_review"
  | "web_search"
  | "session_search"
  | "title"
  | "capability_probe"
  | "soul"
  | "other";

/** Frozen foreground tuple; model remains canonical while metadata records the provider route. */
export interface UsageModelControlMetadata {
  canonicalModelId: string;
  effectiveModelId: string;
  requestedReasoningEffort?: string;
  effectiveReasoningEffort?: string;
  servingProfileId?: string;
  servingSelector?: string;
}

/**
 * Ambient attribution for whatever LLM call runs inside the wrapped scope.
 * The usage callback handler reads this at `handleLLMEnd` so we know which
 * user / room / call-type to attribute the tokens to without threading
 * arguments through every provider factory.
 */
export interface UsageContext {
  callType: UsageCallType;
  userId?: string | null;
  roomId?: string | null;
  /** Extra breadcrumbs stored on the usage row's metadata (agentId, turnId…). */
  metadata?: Record<string, unknown>;
  modelControl?: UsageModelControlMetadata;
}

const storage = new AsyncLocalStorage<UsageContext>();

/** Run `fn` with an ambient usage-attribution context. */
export function runWithUsageContext<T>(ctx: UsageContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Current ambient usage context, if a call site established one. */
export function getUsageContext(): UsageContext | undefined {
  return storage.getStore();
}

/**
 * Usage rows store `room_id` as a nullable UUID. Orphan/background calls use
 * an empty room string in graph state, which must mean "no room" rather than
 * reaching Postgres as an invalid UUID.
 */
export function normalizeUsageRoomId(roomId: string | null | undefined): string | null {
  return typeof roomId === "string" && roomId.trim().length > 0 ? roomId : null;
}
