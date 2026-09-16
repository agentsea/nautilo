/** D513 Phase 3.3 — direct exact-client publication only; never a ServerEvent. */
import {
  UI_ACTION_EVENT_TTL_MS,
  parseGuideUserResultV1,
  parseUiActionEventV1,
} from "@nautilo/types";
import type { ClientActionBindingRegistry } from "./client-action-binding-registry";
import type { DurableToolResultLifecycleEvent } from "@nautilo/runtime";

type DirectSocket = {
  readyState: unknown;
  OPEN: unknown;
  send(payload: string): unknown;
};

function parseGuidanceEvent(
  event: DurableToolResultLifecycleEvent,
  now: number,
) {
  if (
    event.kind !== "tool_result_persisted"
    || event.toolName !== "guide_user"
    || event.trustedExecutionEntrypoint !== "foreground.main"
    || !event.turnId
  ) return null;

  try {
    const result = parseGuideUserResultV1(JSON.parse(event.content) as unknown);
    if (
      result.kind !== "guidance"
      || (result.presentation !== "reveal" && result.presentation !== "spotlight")
    ) return null;
    return parseUiActionEventV1({
      type: "ui.action.v1",
      actionId: result.actionId,
      target: result.target,
      presentation: result.presentation,
      expiresAt: new Date(now + UI_ACTION_EVENT_TTL_MS).toISOString(),
    }, now);
  } catch {
    // A malformed durable result preserves its card but cannot act.
    return null;
  }
}

/**
 * Consume before direct send. A socket failure is intentionally terminal: the
 * durable result remains visible, but this action is never restored or fanned
 * out to another tab, user, or Room.
 */
export function publishDurableGuideUserClientAction(
  registry: Pick<ClientActionBindingRegistry, "consumeOnce">,
  lifecycleEvent: DurableToolResultLifecycleEvent,
  now = Date.now(),
): boolean {
  const action = parseGuidanceEvent(lifecycleEvent, now);
  if (!action || !lifecycleEvent.turnId) return false;

  const binding = registry.consumeOnce(lifecycleEvent.turnId);
  if (!binding) return false;

  // Mobile has no qualified action renderer or target mappings yet. Consume
  // terminally so a durable guidance record can never become a later UI action.
  if (
    binding.initiatingClientSurface === "mobile.native"
    || binding.initiatingClientSurface === "mobile.web"
  ) return false;

  const socket = binding.socket as unknown as DirectSocket;
  if (
    socket.readyState !== socket.OPEN
    || typeof socket.send !== "function"
  ) return false;

  try {
    socket.send(JSON.stringify(action));
    return true;
  } catch {
    return false;
  }
}
