/**
 * Small execution-admission boundary for an external agent harness.
 *
 * Descriptors deliberately contain only import-safe product data. A harness's
 * protocol client, transport, and other behaviour live behind a lazy driver
 * factory in the control-plane registry. The event spine is intentionally
 * provider-neutral; D453's native request variants remain Codex-shaped until a
 * second real harness proves a shared request language.
 */

import type { ClaudePermissionDetail } from "@nautilo/types";
export type HarnessCapabilityState = "supported" | "unsupported" | "unknown";

export type HarnessCapability =
  | "execution"
  | "resume"
  | "stop"
  | "steer"
  | "requests";

export type HarnessOperation =
  | "start"
  | "resume"
  | "stop"
  | "steer"
  | "respond_to_request";

export interface HarnessSetupDescriptor {
  readonly installation: "not_required" | "manual" | "on_demand";
  readonly activation: "automatic" | "user_initiated";
}

export interface HarnessIntegrationDescriptor {
  readonly authentication: "none" | "existing_session" | "interactive";
  /** Product model, not a support claim. `declaredCapabilities.resume` owns support. */
  readonly resume: "new_session_only" | "resume_existing_session" | "runtime_decides";
}

/**
 * Product-facing facts about a harness. Keep this serializable: in
 * particular, no factory, protocol client, callback, Error, or class instance
 * belongs here.
 */
export interface HarnessDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly setup: HarnessSetupDescriptor;
  readonly integration: HarnessIntegrationDescriptor;
  readonly declaredCapabilities: Readonly<Record<HarnessCapability, HarnessCapabilityState>>;
}

/** The declared product claim and the most recent driver probe stay distinct. */
export interface HarnessCapabilityStatus {
  readonly declared: HarnessCapabilityState;
  readonly probed: HarnessCapabilityState;
}

export type HarnessCapabilitySnapshot = Readonly<
  Record<HarnessCapability, HarnessCapabilityStatus>
>;

/**
 * Immutable Task/Run/Job facts shared by every admitted harness execution.
 * Provider-specific workspace, profile, and posture authority belongs in a
 * private extension; a second harness must never manufacture those facts.
 */
export interface HarnessTaskExecutionAdmission {
  readonly jobId: string;
  readonly taskId: string;
  readonly taskRunId: string;
  readonly ownerId: string;
  readonly requesterId: string;
  readonly roomId: string | null;
  readonly laneKey: string | null;
  readonly source: "room" | "agent";
  readonly parentTaskId: string | null;
  readonly prompt: string;
  readonly abortSignal: AbortSignal;
}

/**
 * Legacy Codex-compatible admission shape. Keep this exact extension until
 * its existing binding/session consumers migrate to provider-private input.
 */
export interface HarnessExecutionAdmission extends HarnessTaskExecutionAdmission {
  readonly binding: {
    readonly id: string;
    readonly generation: string;
  };
  readonly workspace: {
    readonly id: string;
    readonly currentFolderReceiptId: string;
    readonly pairingGeneration: string;
  };
  readonly profile: {
    readonly id: string;
    readonly generation: string;
  };
  readonly posture: {
    readonly id: string;
    readonly generation: string;
  };
}

export interface HarnessTurnReference {
  readonly bindingId: string;
  readonly bindingGeneration: string;
  readonly vendorSessionId: string | null;
  readonly vendorTurnId: string | null;
}

/**
 * Cross-layer frame and metadata budgets. Drivers must split, truncate, or
 * summarize individual transport values over these limits. A completed
 * assistant response may be reconstructed losslessly from multiple bounded
 * ordered frames and is therefore not capped by HARNESS_MAX_TEXT_BYTES.
 */
export const HARNESS_MAX_TEXT_BYTES = 64 * 1024;
export const HARNESS_MAX_IDENTIFIER_BYTES = 512;
export const HARNESS_MAX_SUMMARY_ENTRIES = 100;
export const HARNESS_MAX_USAGE_DIMENSIONS = 16;
export const HARNESS_MAX_REQUEST_OPTIONS = 20;

/**
 * Attribution carried by every semantic event and every pending request. All
 * identifier values are UTF-8 strings <= HARNESS_MAX_IDENTIFIER_BYTES.
 */
export interface HarnessAttribution {
  readonly bindingId: string;
  readonly bindingGeneration: string;
  readonly taskId: string;
  readonly roomId: string | null;
  readonly vendorSessionId: string | null;
  readonly vendorTurnId: string | null;
  readonly vendorItemId: string | null;
}

export type HarnessItemAttribution = HarnessAttribution & {
  readonly vendorItemId: string;
};

export interface HarnessEventBase {
  readonly attribution: HarnessAttribution;
}

export type HarnessTerminalStatus = "completed" | "failed" | "interrupted";

/** Stable semantic category, never an unbounded upstream error string. */
export type HarnessTerminalCode =
  | "authentication_required"
  | "invalid_request"
  | "process_lost"
  | "unavailable"
  | "upstream_failure"
  | "user_stop";

/** Semantic output reconstructed from bounded frames; raw provider notifications never cross this seam. */
export type HarnessEvent =
  | (HarnessEventBase & {
      readonly kind: "output_delta";
      readonly attribution: HarnessAttribution;
      /** Ephemeral preview only; UTF-8 byte length <= HARNESS_MAX_TEXT_BYTES. */
      readonly text: string;
    }
  )
  | (HarnessEventBase & {
      readonly kind: "assistant_completed";
      readonly attribution: HarnessAttribution;
      /** Complete durable candidate reconstructed from bounded ordered frames. */
      readonly text: string;
    })
  | (HarnessEventBase & {
      readonly kind: "progress";
      /** UTF-8 byte length <= HARNESS_MAX_TEXT_BYTES. */
      readonly message: string;
    })
  | (HarnessEventBase & {
      readonly kind: "command_summary";
      /** Bounded to HARNESS_MAX_SUMMARY_ENTRIES; each string <= HARNESS_MAX_TEXT_BYTES. */
      readonly commands: readonly {
        readonly summary: string;
        readonly status: "completed" | "failed" | "running";
      }[];
    })
  | (HarnessEventBase & {
      readonly kind: "patch_summary";
      /** Bounded to HARNESS_MAX_SUMMARY_ENTRIES; paths and summary <= HARNESS_MAX_TEXT_BYTES. */
      readonly files: readonly {
        readonly path: string;
        readonly change: "added" | "modified" | "deleted";
      }[];
      readonly summary: string;
    })
  | (HarnessEventBase & {
      readonly kind: "usage";
      /** Bounded to HARNESS_MAX_USAGE_DIMENSIONS. */
      readonly dimensions: readonly {
        readonly name: string;
        readonly value: number;
      }[];
    })
  | (HarnessEventBase & {
      readonly kind: "terminal";
      readonly status: HarnessTerminalStatus;
      readonly code?: HarnessTerminalCode;
      /** UTF-8 byte length <= HARNESS_MAX_TEXT_BYTES when present. */
      readonly message?: string;
    });

export interface HarnessRequestBase {
  /** UTF-8 byte length <= HARNESS_MAX_IDENTIFIER_BYTES. */
  readonly requestId: string;
  /** Upstream request identity when the harness provides one; UTF-8 <= HARNESS_MAX_IDENTIFIER_BYTES. */
  readonly vendorRequestId: string | null;
  readonly attribution: HarnessAttribution;
  readonly ownerId: string;
  readonly expiresAt: string | null;
}

/** Base decision for operations that Codex itself may allow, deny, or cancel. */
export type HarnessApprovalDecision =
  | "approve"
  | "approve_for_session"
  | "deny"
  | "cancel";

/** A browser-safe indication that exact host-local detail was intentionally withheld. */
export type HarnessHostLocalDetailState = "not_provided" | "host_local_only";
export type HarnessCommandActionKind = "read" | "list_files" | "search" | "unknown";

export interface HarnessPermissionGrants {
  /** Grant only the network capability offered in the paired request. */
  readonly network: boolean;
  /** Grant only the file-system capability offered in the paired request. */
  readonly fileSystem: boolean;
}

/** Opaque target-owned permission choice. Labels and hints never grant authority. */
export interface HarnessPermissionOption {
  readonly id: string;
  readonly label: string;
  readonly semanticHint: string | null;
}

export interface HarnessInputQuestion {
  /** Driver-stable question identity; UTF-8 <= HARNESS_MAX_IDENTIFIER_BYTES. */
  readonly id: string;
  /** Short surface label; UTF-8 <= HARNESS_MAX_TEXT_BYTES. */
  readonly header: string;
  /** Human-facing question; UTF-8 <= HARNESS_MAX_TEXT_BYTES. */
  readonly prompt: string;
  readonly secret: boolean;
  /** Whether more than one listed option may be selected. */
  readonly multiSelect: boolean;
  readonly allowOther: boolean;
  /** null means free text; otherwise bounded to HARNESS_MAX_REQUEST_OPTIONS. */
  readonly options: readonly {
    readonly id: string;
    readonly label: string;
    readonly description: string | null;
  }[] | null;
}

/** D453 Codex-native request projection carried through the generic execution stream. */
export type HarnessRequest =
  | (HarnessRequestBase & {
      readonly kind: "command_approval_required";
      /** Exact bounded base choices offered by the harness. */
      readonly options: readonly HarnessApprovalDecision[];
      readonly reason: HarnessHostLocalDetailState;
      readonly command: {
        readonly detail: HarnessHostLocalDetailState;
        readonly actionKinds: readonly HarnessCommandActionKind[];
      };
    })
  | (HarnessRequestBase & {
      readonly kind: "network_approval_required";
      readonly options: readonly HarnessApprovalDecision[];
      readonly reason: HarnessHostLocalDetailState;
      readonly network: {
        readonly host: string;
        readonly protocol: "http" | "https" | "socks5Tcp" | "socks5Udp";
      };
    })
  | (HarnessRequestBase & {
      readonly kind: "file_change_approval_required";
      readonly options: readonly HarnessApprovalDecision[];
      readonly reason: HarnessHostLocalDetailState;
      readonly grantRoot: HarnessHostLocalDetailState;
    })
  | (HarnessRequestBase & {
      readonly kind: "permissions_approval_required";
      readonly reason: HarnessHostLocalDetailState;
      readonly permissions: {
        readonly network: { readonly enabled: boolean | null } | null;
        readonly fileSystem: {
          readonly readPathCount: number;
          readonly writePathCount: number;
          readonly entryCount: number;
          readonly pathDetail: HarnessHostLocalDetailState;
        } | null;
      };
    })
  | (HarnessRequestBase & {
      readonly kind: "user_input_required";
      /** One upstream request may contain multiple independently keyed questions. */
      readonly questions: readonly HarnessInputQuestion[];
      /** Upstream-directed automatic response window, when the provider offered one. */
      readonly autoResolutionMs: number | null;
    })
  | (HarnessRequestBase & {
      readonly kind: "permission_selection_required";
      readonly options: readonly HarnessPermissionOption[];
      readonly detail?: ClaudePermissionDetail;
      readonly tool: {
        readonly title: string | null;
        readonly kind: string | null;
      };
    })
  ;

export type HarnessRequestResponse =
  | {
      readonly kind: "command_approval_required" | "network_approval_required" | "file_change_approval_required";
      readonly requestId: string;
      /** Authenticated owner supplied by the server response endpoint. */
      readonly ownerId: string;
      readonly decision: HarnessApprovalDecision;
    }
  | {
      readonly kind: "permissions_approval_required";
      readonly requestId: string;
      /** Authenticated owner supplied by the server response endpoint. */
      readonly ownerId: string;
      /** Only a subset of the paired offered permissions may be true. */
      readonly grants: HarnessPermissionGrants;
      readonly scope: "turn" | "session";
    }
  | {
      readonly kind: "user_input_required";
      readonly requestId: string;
      /** Authenticated owner supplied by the server response endpoint. */
      readonly ownerId: string;
      /** Exact question ids mapped to bounded answer lists. */
      readonly answers: Readonly<Record<string, readonly string[]>>;
    }
  | {
      readonly kind: "permission_selection_required";
      readonly requestId: string;
      readonly ownerId: string;
      readonly outcome:
        | { readonly kind: "selected"; readonly optionId: string }
        | { readonly kind: "cancelled" };
    }
  ;

/** Every harness can execute an already-admitted turn. Other operations are capability-gated. */
export interface HarnessExecution {
  start(admission: HarnessExecutionAdmission): AsyncIterable<HarnessExecutionOutput>;
  resume?(turn: HarnessTurnReference): AsyncIterable<HarnessExecutionOutput>;
  stop?(turn: HarnessTurnReference): Promise<void>;
  steer?(input: HarnessTurnReference & { readonly text: string }): Promise<void>;
  respond?(
    response: HarnessRequestResponse,
    invocationAuthority?: import("@nautilo/trust").AcceptedInvocationAuthority,
  ): Promise<void>;
}

/** Requests are distinct from events but ride the same admitted execution stream. */
export type HarnessExecutionOutput = HarnessEvent | HarnessRequest;

export interface HarnessDriver {
  readonly execution: HarnessExecution;
  /**
   * A lazy driver may learn a capability only after touching its host. Omitted
   * entries deliberately remain `unknown`, never silently become unsupported.
   */
  probeCapabilities?(): Promise<Readonly<Partial<Record<HarnessCapability, HarnessCapabilityState>>>>;
}

export interface HarnessRegistration {
  readonly descriptor: HarnessDescriptor;
  readonly createDriver: () => Promise<HarnessDriver> | HarnessDriver;
}

export type HarnessControlPlaneErrorCode =
  | "harness_duplicate_id"
  | "harness_unknown_id"
  | "harness_factory_failed"
  | "harness_invalid_driver"
  | "harness_capability_unsupported"
  | "harness_capability_unknown"
  | "harness_operation_unsupported";

/** Stable machine-readable failures for product code and fake-driver tests. */
export class HarnessControlPlaneError extends Error {
  readonly code: HarnessControlPlaneErrorCode;
  readonly harnessId: string;
  readonly capability: HarnessCapability | null;
  readonly operation: HarnessOperation | null;

  constructor(input: {
    readonly code: HarnessControlPlaneErrorCode;
    readonly harnessId: string;
    readonly message: string;
    readonly capability?: HarnessCapability;
    readonly operation?: HarnessOperation;
    readonly cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "HarnessControlPlaneError";
    this.code = input.code;
    this.harnessId = input.harnessId;
    this.capability = input.capability ?? null;
    this.operation = input.operation ?? null;
  }
}
