import type {
  ComputerUseContextScope,
  ComputerUseTargetEvidence,
} from "./native-context-registry.js";

/** Provider-neutral request shape for the Cua semantic observation lane. */
export interface ComputerObserveRequest {
  readonly scope: ComputerUseContextScope;
  readonly operation: "desktop_state";
  readonly maxWindows?: number;
  /** Host-only cancellation, never a model argument or retained context fact. */
  readonly signal?: AbortSignal;
  readonly continuation?: { readonly version: 1; readonly context: string; readonly reference: string };
}

/** Provider-neutral request shape shared by Cua focus handling. */
export interface ComputerDoFocusRequest {
  readonly scope: ComputerUseContextScope;
  readonly signal?: AbortSignal;
  readonly operation: Readonly<{
    kind: "focus";
    target: Readonly<{ context: string; reference: string }>;
  }>;
}

export type ComputerObserveResult =
  | {
    readonly ok: true;
    readonly observation: DesktopStateObservation;
    readonly visionImage?: Readonly<{ mime: "image/png"; bytes: Uint8Array }>;
  }
  | { readonly ok: false; readonly code: string; readonly error: string; readonly outcome: ComputerUseOperationOutcome };

/** Content-free operational truth emitted by every native operation. */
export interface ComputerUseOperationOutcome {
  readonly version: 1;
  readonly phase: "observe" | "resolve_target" | "pre_effect_dispatch" | "post_effect_verification";
  readonly retrySafety: "safe" | "observe_before_retry" | "never";
  readonly stateChangeCertainty: "not_applicable" | "not_changed" | "changed" | "unknown";
  readonly providerCondition?: "ready" | "malformed_response" | "permission_required" | "cancelled" | "unknown";
  readonly targetCondition?: "current" | "unavailable" | "stale" | "unknown";
  readonly externalInterference?: "user_input";
  readonly recovery: readonly (
    | "retry_same_request"
    | "observe_again"
    | "request_access"
    | "focus_target"
    | "do_not_replay"
    | "open_computer_use_settings"
    | "reconnect_desktop"
  )[];
  readonly requiredCapability?: "provider_narrowing_or_cursor";
}

/** Compact semantic Cua desktop observation. Native identifiers stay local. */
export interface DesktopStateObservation {
  readonly version: 1;
  readonly operation: "desktop_state";
  readonly context: string;
  readonly completeness: "complete" | "partial";
  readonly discovered: number;
  readonly returned: number;
  readonly omitted: number;
  readonly boundary: { readonly kind: "none" | "response_limit" | "provider_limit" | "permission_limit"; readonly retryable: boolean };
  readonly uninspected: { readonly applications: number; readonly knownWindows: number; readonly windowCountExact: boolean } | null;
  readonly continuation: { readonly version: 1; readonly reference: string } | null;
  readonly alternatives: readonly { readonly kind: "observe_again" | "request_access" | "focus_target"; readonly available: boolean }[];
  readonly targets: readonly { readonly target: { readonly version: 1; readonly context: string; readonly reference: string }; readonly evidence: ComputerUseTargetEvidence }[];
  readonly applicationTargets: {
    readonly discovered: number;
    readonly returned: number;
    readonly omitted: number;
    readonly targets: readonly { readonly target: { readonly version: 1; readonly context: string; readonly reference: string }; readonly evidence: ComputerUseTargetEvidence }[];
  };
  readonly screenSnapshot?: {
    readonly target: { readonly version: 1; readonly context: string; readonly reference: string };
    readonly evidence: { readonly kind: "screen" };
    readonly metadata: {
      readonly format: "png";
      readonly nativeDimensions: { readonly width: number; readonly height: number };
      readonly presentedDimensions: { readonly width: number; readonly height: number };
      readonly display: { readonly coordinateSpace: "desktop_pixels"; readonly origin: { readonly x: number; readonly y: number } };
    };
  };
  readonly outcome: ComputerUseOperationOutcome;
}
