/**
 * D508 local qualification observation seam.
 *
 * Playwright may install the code-owned global below with `addInitScript`
 * before Workbench bootstrap. It is intentionally not configured by query
 * strings, environment, server data, or a user-facing setting. Production has
 * no callback and therefore receives the coordinator's no-op sink.
 */
import {
  NOOP_OWNER_CLAIM_COORDINATOR_EVENT_SINK,
  type OwnerClaimCoordinatorEventSink,
  type OwnerClaimCoordinatorTraceEvent,
} from "./owner-claim-coordinator";

export const OWNER_CLAIM_QUALIFICATION_EVENT_SINK_GLOBAL =
  "__NAUTILO_D508_OWNER_CLAIM_EVENT_SINK__" as const;

export type OwnerClaimQualificationEventSink = (
  event: OwnerClaimCoordinatorTraceEvent,
) => void;

declare global {
  // Qualification-only. `addInitScript` installs this before the page's
  // module graph runs; no product code writes it or exposes it to a Human.
  var __NAUTILO_D508_OWNER_CLAIM_EVENT_SINK__: OwnerClaimQualificationEventSink | undefined;
}

/**
 * Resolve the pre-bootstrap qualification callback once. A malformed or
 * throwing harness callback cannot alter claim execution: it is treated as a
 * no-op and receives a fresh frozen copy of the coordinator's five-field
 * redacted trace event.
 */
export function ownerClaimQualificationEventSink(): OwnerClaimCoordinatorEventSink {
  const callback = globalThis.__NAUTILO_D508_OWNER_CLAIM_EVENT_SINK__;
  if (typeof callback !== "function") return NOOP_OWNER_CLAIM_COORDINATOR_EVENT_SINK;

  return (event) => {
    try {
      callback(Object.freeze({
        operationId: event.operationId,
        phase: event.phase,
        commandKind: event.commandKind,
        result: event.result,
        navigationIntent: event.navigationIntent,
      }));
    } catch {
      // Qualification observation cannot become production control flow.
    }
  };
}
