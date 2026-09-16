import { computerObserveInputSchema } from "@nautilo/computer-use-contracts/native";
import type { ComputerUseContextRegistry, ComputerUseContextScope } from "./native-context-registry.js";
import {
  COMPUTER_USE_WORKSTATION_STATE_RESOURCE,
  type ComputerUseResourceClaim,
} from "./resource-coordinator.js";

/** Resolve physical identity locally; opaque model references are never lock keys. */
export function nativeObservationResourceClaims(
  argumentsValue: unknown,
  scope: ComputerUseContextScope,
  registry: Pick<ComputerUseContextRegistry, "resolveTarget" | "resolveScreenSnapshot"> | undefined,
): readonly ComputerUseResourceClaim[] {
  const parsed = computerObserveInputSchema.safeParse(argumentsValue);
  let window: Readonly<{ pid?: number; windowId?: number }> | undefined;
  if (parsed.success && registry !== undefined) {
    const input = parsed.data;
    if (input.operation === "window_state") {
      const resolved = registry.resolveTarget(input.target.context, scope, input.target.reference);
      if (resolved.ok) window = resolved.data.providerTarget;
    } else if (input.operation === "window_region") {
      const resolved = registry.resolveScreenSnapshot(input.target.context, scope, input.target.reference);
      if (resolved.ok) {
        try {
          if (resolved.data.providerSnapshot.kind !== "desktop") window = resolved.data.providerSnapshot;
        } finally {
          resolved.data.pngBytes.fill(0);
        }
      }
    }
  }
  if (window?.pid !== undefined && window.windowId !== undefined) {
    return [
      { key: COMPUTER_USE_WORKSTATION_STATE_RESOURCE, mode: "read" },
      { key: `native-window:${scope.providerGeneration}:${window.pid}:${window.windowId}`, mode: "write" },
    ];
  }
  // Inventory replacement, app refresh/aggregate traversal and continuation
  // alter context-wide publication state. They exclude consumers throughout
  // acquisition AND publication; the handler revalidates after admission.
  return [{ key: COMPUTER_USE_WORKSTATION_STATE_RESOURCE, mode: "write" }];
}
