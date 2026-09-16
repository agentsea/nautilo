import { randomUUID } from "node:crypto";
import type { AppToolRunnerContext } from "./app-tool-types";

/** Prefix for host-issued UI/app mutation transaction ids (not agent graph turns). */
export const APP_OPERATION_ID_PREFIX = "app:";

const APP_OPERATION_ID_RE =
  /^app:[^:]+:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True when `id` is a host-issued app operation transaction id (`app:<appId>:<uuid>`). */
export function isAppOperationId(id: string): boolean {
  return APP_OPERATION_ID_RE.test(id);
}

/** Allocate one auditable transaction id per UI/app-host logical operation. */
export function createAppOperationId(appId: string): string {
  return `${APP_OPERATION_ID_PREFIX}${appId}:${randomUUID()}`;
}

/**
 * UI/app-host invokes without an agent `turnId` receive exactly one app-operation
 * transaction id for the whole tool invocation (all host RPCs in that invoke).
 * Agent turns keep their real graph `turnId` and never get an app-operation id.
 */
export function ensureAppOperationContext(
  context: AppToolRunnerContext,
  appId: string,
): AppToolRunnerContext {
  if (typeof context.turnId === "string" && context.turnId.length > 0) {
    return context;
  }
  if (typeof context.appOperationId === "string" && context.appOperationId.length > 0) {
    return context;
  }
  return { ...context, appOperationId: createAppOperationId(appId) };
}
