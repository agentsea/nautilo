/**
 * Synchronous `/claim` entry boundary. Bootstrap calls this before React is
 * created or health is requested. It deliberately returns only redacted route
 * state; the fragment capability remains in the existing session handoff.
 */
import type { OwnerClaimCheckpoint, OwnerClaimFinish } from "./owner-claim-machine";
import {
  consumeOwnerClaimFragment,
  readOwnerClaimHandoff,
  type OwnerClaimHandoff,
} from "./owner-claim-handoff";
import {
  clearOwnerClaimTerminalMarker,
  readOwnerClaimTerminalMarker,
} from "./owner-claim-terminal";

export interface OwnerClaimRouteBootstrap {
  readonly capture: "captured" | "absent" | "invalid" | "storage-unavailable";
  readonly checkpoint: OwnerClaimCheckpoint | null;
  readonly finish: OwnerClaimFinish;
  readonly terminalRecovery: boolean;
}

function checkpointForStage(stage: OwnerClaimHandoff["stage"]): OwnerClaimCheckpoint {
  switch (stage) {
    case "preview": return "preview";
    case "awaiting-signup": return "awaiting-signup";
    case "awaiting-bind": return "awaiting-bind";
    case "profile": return "profile";
    default: return assertNever(stage);
  }
}

export function captureOwnerClaimRouteBootstrap(): OwnerClaimRouteBootstrap | null {
  if (typeof window === "undefined" || window.location.pathname !== "/claim") return null;
  const capture = consumeOwnerClaimFragment();
  const handoff = readOwnerClaimHandoff();
  const terminal = handoff === null ? readOwnerClaimTerminalMarker() : null;
  if (handoff !== null) clearOwnerClaimTerminalMarker();
  return {
    capture: handoff === null && capture.outcome !== "stored" ? capture.outcome : "captured",
    checkpoint: handoff === null ? null : checkpointForStage(handoff.stage),
    finish: handoff?.finish ?? terminal?.finish ?? "guide",
    terminalRecovery: terminal !== null,
  };
}

export function ownerClaimBootstrapFromSession(): OwnerClaimRouteBootstrap {
  const handoff = readOwnerClaimHandoff();
  const terminal = handoff === null ? readOwnerClaimTerminalMarker() : null;
  if (handoff !== null) clearOwnerClaimTerminalMarker();
  return {
    capture: handoff === null ? "absent" : "captured",
    checkpoint: handoff === null ? null : checkpointForStage(handoff.stage),
    finish: handoff?.finish ?? terminal?.finish ?? "guide",
    terminalRecovery: terminal !== null,
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled owner-claim handoff stage: ${String(value)}`);
}
