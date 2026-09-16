import { setRuntimeStatementObserver } from "@nautilo/db";
import { incrementDbStatementCountForActiveRequest } from "./request-telemetry";

/**
 * Wire the M212 runtime postgres.js statement observer to the active
 * request-scoped telemetry context via AsyncLocalStorage.
 *
 * Uses a single process-local registration so concurrent requests never
 * race on per-request observer replacement. Returns cleanup for app shutdown.
 */
export function bindRuntimeStatementObserverToRequestTelemetry(): () => void {
  return setRuntimeStatementObserver((_role) => {
    incrementDbStatementCountForActiveRequest();
  });
}
