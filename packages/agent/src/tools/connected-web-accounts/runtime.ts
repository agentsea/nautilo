import type { MemoryAccessEnvelope } from "@nautilo/trust";
import type {
  ConnectedWebAccountStatus,
  ConnectedWebOperationDriver,
  ConnectedWebOperationLifecycle,
  ConnectedWebOperationSafeActivity,
  ConnectedWebOperationSafeReceipt,
  ConnectedWebActivityPage,
  ConnectedWebOperationTerminalReadResult,
} from "@nautilo/types";

/**
 * D568 — server-injected execution seam for one private connected-web read.
 *
 * The account store, ownership check, browser profile, provider client, and
 * execution serialization all live in @nautilo/server. @nautilo/agent only
 * carries this deliberately small, provider-neutral contract so it cannot
 * accidentally acquire database or browser authority.
 */

export interface ConnectedWebAccountReadToolActorContext {
  /** Trusted initiating response preference; never a model argument. */
  readonly voiceMode?: boolean;
  /** Authenticated Human who owns the personal connected account. */
  readonly userId: string;
  /** Current Genie. The server re-checks that it is owned by userId. */
  readonly agentId: string;
  /** Current foreground Room; server verifies it is the owner's personal Room. */
  readonly roomId: string;
  /** A task/subagent calling Room is not supported for Phase 1 personal reads. */
  readonly callingRoomId: string | null;
  /** Existing resolved foreground authority; never synthesized by this tool. */
  readonly memoryAccessEnvelope: MemoryAccessEnvelope;
  /** Exact trusted tool-delivery identity when the invocation bridge has one. */
  readonly toolCallId?: string;
  /** Exact foreground LangGraph thread, never supplied as a model argument. */
  readonly currentThreadId?: string;
  /** Exact trusted turn, used to bind a durable admission to this invocation. */
  readonly turnId?: string;
  /** Trusted lane identity, or a server-derived foreground lane. */
  readonly laneKey?: string;
}

export interface ConnectedWebAccountReadToolInput {
  /** Set only by the task tool; old/read deliveries never acquire action authority. */
  readonly intent?: "task";
  /**
   * One Human-recognizable account selector: a label, service/origin, or exact
   * id. The server resolves it only inside the authenticated Human's accounts.
   */
  readonly account: string;
  /** Plain-language question or read instruction for that one account. */
  readonly request: string;
  /** Text is the normal read. Workspace requires an explicit Human request for a saved output. */
  readonly delivery: "text" | "workspace";
}

export interface ConnectedWebAccountReadFact {
  readonly label: string;
  readonly value: string;
}

/** A private Workspace artifact receipt; never a provider capability or URL. */
export interface ConnectedWebAccountReadOutput {
  readonly artifactId: string;
  readonly path: string;
  readonly mime: string;
  readonly bytes: number;
}

export type ConnectedWebAccountReadRecovery = "retry" | "reconnect" | "connect" | "none";

export type ConnectedWebAccountReadFailureCode =
  | "unavailable"
  | "not_found"
  | "ambiguous_account"
  | "not_connected"
  | "reconnect_required"
  | "authentication_required"
  | "cancelled"
  | "provider_unavailable"
  | "idempotency_conflict"
  | "invalid_result";

export type ConnectedWebAccountAuthenticationReason =
  | "not_connected"
  | "reconnect"
  | "sign_in"
  | "mfa"
  | "captcha";

/**
 * Safe, provider-neutral request for a foreground Human sign-in. The trusted
 * Workbench turns this into the protected browser journey; the model never
 * receives a live-view URL, profile reference, cookie, or credential field.
 */
export type ConnectedWebAccountAuthenticationIntervention =
  | Readonly<{
      kind: "authentication_required";
      mode: "connect";
      reason: "not_connected";
      /** Human-recognizable selector; Workbench resolves it against trusted presets. */
      target: Readonly<{ selector: string }>;
    }>
  | Readonly<{
      kind: "authentication_required";
      mode: "reconnect";
      reason: Exclude<ConnectedWebAccountAuthenticationReason, "not_connected">;
      account: Readonly<{
        id: string;
        label: string;
        service: string;
        origin: string;
      }>;
    }>;

/**
 * This is the only successful projection that may return to the model. It
 * deliberately has no browser, profile, run, live-view, provider, or opaque
 * execution identifiers. The server validates any hosted-agent response
 * before returning this shape.
 */
export interface ConnectedWebAccountReadSuccess {
  readonly ok: true;
  /** The hosted browser run itself reached Browser Use's completed state. */
  readonly status: "completed";
  readonly account: {
    readonly id: string;
    readonly label: string;
    readonly service: string;
    readonly origin: string;
  };
  /** Opaque Nautilo account reference for a separately owner-authorized page view. */
  readonly page: {
    readonly ref: string;
    readonly title: string;
    readonly origin: string;
  };
  /**
   * Null means the provider run completed but its untrusted structured answer
   * could not be projected safely. Completion is not rewritten as failure.
   */
  readonly read: {
    readonly answer: string;
    readonly facts: readonly ConnectedWebAccountReadFact[];
    readonly completeness: "complete" | "partial" | "unknown";
    readonly provenance: "authenticated_website" | "user_connected_website";
    readonly origin: string;
  } | null;
  /** Known cost is reported truthfully; null means no provider receipt exists. */
  readonly cost: {
    readonly currency: "USD";
    readonly amountUsd: number | null;
    readonly state: "actual" | "unknown";
  };
  /** Present only for an explicit workspace delivery request. */
  readonly outputs: readonly ConnectedWebAccountReadOutput[];
  /** More provider files existed than this first-house model projection admits. */
  readonly outputsTruncated: boolean;
}

/**
 * The initial async admission receipt. It proves only that one sealed,
 * server-owned operation is active; provider/browser/session coordinates and
 * terminal result material remain server-only.
 */
export interface ConnectedWebAccountReadActiveSuccess {
  readonly ok: true;
  readonly status: "active";
  readonly account: {
    readonly id: string;
    readonly label: string;
    readonly service: string;
    readonly origin: string;
  };
  readonly operation: ConnectedWebOperationSafeProjection;
}

export interface ConnectedWebAccountReadFailure {
  readonly ok: false;
  readonly code: ConnectedWebAccountReadFailureCode;
  readonly recovery: ConnectedWebAccountReadRecovery;
  /** Present only for the sealed Human sign-in journey. */
  readonly intervention?: ConnectedWebAccountAuthenticationIntervention;
}

export type ConnectedWebAccountReadResult =
  | ConnectedWebAccountReadSuccess
  | ConnectedWebAccountReadActiveSuccess
  | ConnectedWebAccountReadFailure;

/**
 * Safe per-turn capability context. This is intentionally smaller than the
 * Human-facing account projection: no provider profile, execution checkpoint,
 * live-view capability, timestamps, or other server coordinate can enter the
 * model prompt.
 */
export interface ConnectedWebAccountCapability {
  readonly label: string;
  readonly service: string;
  readonly origin: string;
  readonly status: Exclude<ConnectedWebAccountStatus, "connecting" | "revoked">;
}

export interface PublicBrowserReadInput {
  readonly intent?: "task";
  readonly url: string;
  readonly request: string;
}

export type PublicBrowserReadResult =
  | Readonly<{ ok: true; status: "active"; target: { url: string; origin: string }; operation: ConnectedWebOperationSafeProjection }>
  | ConnectedWebOperationTerminalReadResult
  | ConnectedWebAccountReadFailure;

export interface ConnectedWebAccountReadToolRuntime {
  /** Anonymous Browser Use, independent of saved website account authority. */
  publicAvailable?(): boolean;
  readPublic?(actor: ConnectedWebAccountReadToolActorContext, input: PublicBrowserReadInput): Promise<PublicBrowserReadResult>;
  /**
   * List the exact Human's usable/saved website capabilities only after the
   * same owned-Genie + foreground personal-Room authorization as a read.
   */
  listAvailable?(
    actor: ConnectedWebAccountReadToolActorContext,
  ): Promise<readonly ConnectedWebAccountCapability[]>;
  /**
   * Server-only execution. It must authorize exact Human account ownership
   * owned-Genie mirror, and foreground personal Room before looking up or
   * using any browser profile.
   */
  read(
    actor: ConnectedWebAccountReadToolActorContext,
    input: ConnectedWebAccountReadToolInput,
  ): Promise<ConnectedWebAccountReadResult>;
}

/**
 * D568 Phase 2's deliberately small external-write contract. A Genie has no
 * generic browser command surface: it can only ask to save one Human-named
 * item, and the server stamps effect/risk/approval facts independently.
 */
export interface ConnectedWebAccountActionToolInput {
  readonly account: string;
  readonly action: "save_item";
  readonly target: string;
  /** Exact LangGraph delivery identity, injected by the trusted tools node. */
  readonly deliveryId: string;
}

export type ConnectedWebAccountActionResult =
  | Readonly<{
      ok: true;
      status: "completed";
      account: { readonly id: string; readonly label: string; readonly service: string; readonly origin: string };
      action: "save_item";
      target: string;
      receipt: { readonly executionRef: string; readonly effectState: "observed"; readonly postcondition: string; readonly evidenceCode: string; readonly cost: { readonly amountUsd: number | null; readonly state: "actual" | "unknown" } };
    }>
  | Readonly<{
      ok: false;
      code: "unavailable" | "not_found" | "ambiguous_account" | "not_connected" | "reconnect_required" | "authentication_required" | "cancelled" | "failed" | "provider_unavailable" | "invalid_result" | "ambiguous" | "idempotency_conflict" | "approval_required";
      recovery: "connect" | "reconnect" | "none";
      intervention?: ConnectedWebAccountAuthenticationIntervention;
    }>;

export interface ConnectedWebAccountActionToolRuntime {
  act(
    actor: ConnectedWebAccountReadToolActorContext,
    input: ConnectedWebAccountActionToolInput,
  ): Promise<ConnectedWebAccountActionResult>;
  /** Resume/cancel only the exact delivery that parked for Human auth. */
  resumeAfterAuthentication?(
    actor: ConnectedWebAccountReadToolActorContext,
    input: { readonly deliveryId: string },
  ): Promise<ConnectedWebAccountActionResult>;
  cancelAuthentication?(
    actor: ConnectedWebAccountReadToolActorContext,
    input: { readonly deliveryId: string },
  ): Promise<ConnectedWebAccountActionResult>;
}

/**
 * D568's provider-neutral supervision seam. The server owns every provider,
 * browser, lease, intent, and effect coordinate; this contract admits only an
 * already-authorized foreground actor and a typed control request.
 */
export type ConnectedWebOperationControl =
  | "inspect"
  | "continue"
  | "check_later"
  | "steer"
  | "take_control"
  | "release_control"
  | "stop";

export interface ConnectedWebOperationToolActorContext extends ConnectedWebAccountReadToolActorContext {
  /** Exact trusted tool delivery, never supplied as a model argument. */
  readonly toolCallId: string;
  /** Exact foreground LangGraph thread, never supplied as a model argument. */
  readonly currentThreadId: string;
  /** Exact trusted turn, used by server-side delivery authorization. */
  readonly turnId: string;
  /** Present only when the caller already carries a trusted lane identity. */
  readonly laneKey?: string;
}

export type ConnectedWebOperationToolInput =
  | Readonly<{ operation: "inspect"; operationId: string; expectedControlEpoch: number; activityBefore?: number }>
  | Readonly<{ operation: "continue"; operationId: string; expectedControlEpoch: number }>
  | Readonly<{
      operation: "check_later";
      operationId: string;
      expectedControlEpoch: number;
      dueAt: string;
    }>
  | Readonly<{
      operation: "steer";
      operationId: string;
      expectedControlEpoch: number;
      instruction: string;
    }>
  | Readonly<{ operation: "take_control"; operationId: string; expectedControlEpoch: number }>
  | Readonly<{ operation: "release_control"; operationId: string; expectedControlEpoch: number }>
  | Readonly<{ operation: "stop"; operationId: string; expectedControlEpoch: number }>;

/** The only active/terminal operation projection that may return to a Genie. */
export interface ConnectedWebOperationSafeProjection {
  readonly operationId: string;
  readonly driver: ConnectedWebOperationDriver;
  readonly lifecycle: ConnectedWebOperationLifecycle;
  readonly controlEpoch: number;
  readonly activity: ConnectedWebOperationSafeActivity;
  readonly receipt: ConnectedWebOperationSafeReceipt | null;
  /** Durable, provider-free terminal text result; present only for a completed read operation. */
  readonly result?: ConnectedWebAccountReadSuccess | ConnectedWebOperationTerminalReadResult | null;
  readonly activityLog?: ConnectedWebActivityPage;
}

export type ConnectedWebOperationToolResult =
  | Readonly<{
      ok: true;
      accepted: ConnectedWebOperationControl;
      operation: ConnectedWebOperationSafeProjection;
    }>
  | Readonly<{
      ok: false;
      code: "unavailable" | "not_found" | "forbidden" | "conflict" | "invalid_result";
      recovery: "none" | "human_authentication";
    }>;

export interface ConnectedWebOperationToolRuntime {
  /**
   * Server-only control. It re-checks owner, initiating Genie, exact Room,
   * thread, lane, delivery, and epoch before changing durable operation state.
   */
  manage(
    actor: ConnectedWebOperationToolActorContext,
    input: ConnectedWebOperationToolInput,
  ): Promise<ConnectedWebOperationToolResult>;
}

/**
 * The direct browser surface is deliberately a separate runtime from
 * operation management.  In particular it is not a relay/browser_* alias:
 * its only authority is an already-issued operation id and control epoch.
 */
export type ConnectedWebOperationDirectCommand =
  | Readonly<{ kind: "snapshot" }>
  | Readonly<{ kind: "click"; ref: string }>
  | Readonly<{ kind: "type"; ref: string; text: string; clear?: boolean }>
  | Readonly<{ kind: "press"; key: string }>
  | Readonly<{ kind: "open"; url: string }>
  | Readonly<{ kind: "back" }>
  | Readonly<{ kind: "forward" }>
  | Readonly<{ kind: "reload" }>
  | Readonly<{ kind: "hover"; ref: string }>
  | Readonly<{ kind: "double_click"; ref: string }>
  | Readonly<{ kind: "drag"; from: string; to: string }>
  | Readonly<{ kind: "select"; ref: string; values: readonly string[] }>
  | Readonly<{ kind: "set_checked"; ref: string; checked: boolean }>
  | Readonly<{ kind: "scroll_into_view"; ref: string }>
  | Readonly<{ kind: "wait_for"; ref: string }>
  | Readonly<{ kind: "wait"; milliseconds: number }>
  | Readonly<{ kind: "read"; ref: string }>
  | Readonly<{ kind: "get"; what: "box" | "value" | "attr" | "title" | "url"; ref?: string; name?: string }>;

export interface ConnectedWebOperationDirectToolInput {
  readonly operationId: string;
  readonly expectedControlEpoch: number;
  readonly command: ConnectedWebOperationDirectCommand;
}

export type ConnectedWebOperationDirectToolResult =
  | Readonly<{
      ok: true;
      command: Readonly<{ text: string; truncated: boolean }>;
      operation: ConnectedWebOperationSafeProjection;
    }>
  | Readonly<{ ok: false; code: "unavailable" | "not_found" | "forbidden" | "conflict" | "invalid_result"; recovery: "none" }>;

export interface ConnectedWebOperationDirectToolRuntime {
  control(
    actor: ConnectedWebOperationToolActorContext,
    input: ConnectedWebOperationDirectToolInput,
  ): Promise<ConnectedWebOperationDirectToolResult>;
}

let runtime: ConnectedWebAccountReadToolRuntime | null = null;
let actionRuntime: ConnectedWebAccountActionToolRuntime | null = null;
let operationRuntime: ConnectedWebOperationToolRuntime | null = null;
let directOperationRuntime: ConnectedWebOperationDirectToolRuntime | null = null;

export function setConnectedWebAccountReadToolRuntime(
  next: ConnectedWebAccountReadToolRuntime | null,
): void {
  runtime = next;
}

export function getConnectedWebAccountReadToolRuntime(): ConnectedWebAccountReadToolRuntime | null {
  return runtime;
}

export function resetConnectedWebAccountReadToolRuntimeForTests(): void {
  runtime = null;
  actionRuntime = null;
  operationRuntime = null;
  directOperationRuntime = null;
}

export function setConnectedWebAccountActionToolRuntime(next: ConnectedWebAccountActionToolRuntime | null): void {
  actionRuntime = next;
}

export function getConnectedWebAccountActionToolRuntime(): ConnectedWebAccountActionToolRuntime | null {
  return actionRuntime;
}

export function setConnectedWebOperationToolRuntime(next: ConnectedWebOperationToolRuntime | null): void {
  operationRuntime = next;
}

export function getConnectedWebOperationToolRuntime(): ConnectedWebOperationToolRuntime | null {
  return operationRuntime;
}

export function setConnectedWebOperationDirectToolRuntime(next: ConnectedWebOperationDirectToolRuntime | null): void {
  directOperationRuntime = next;
}

export function getConnectedWebOperationDirectToolRuntime(): ConnectedWebOperationDirectToolRuntime | null {
  return directOperationRuntime;
}
