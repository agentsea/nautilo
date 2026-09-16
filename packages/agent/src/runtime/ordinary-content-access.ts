import { createHash } from "node:crypto";
import { AIMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import { getToolCatalog } from "@nautilo/catalog";
import { fromRuntimeConfig } from "@nautilo/config";
import { coerceHybridSensitivity } from "@nautilo/security";
import type { ChatArtifactRef, ProveItToolInfo } from "@nautilo/types";
import type { ContentAccessAdmission, ContentAccessCommand, ContentAccessFailure, ContentAccessReceipt } from "@nautilo/trust";
import type { NautiloState } from "../agent/state";
import type { OrdinaryContentAccessIntent } from "../tools/content-access-intent";

export interface OrdinaryContentAccessExecutionResult {
  readonly status: "success" | "error";
  readonly receipts: readonly ContentAccessReceipt[];
  readonly artifacts: readonly ChatArtifactRef[];
  readonly failure?: ContentAccessFailure;
  readonly recovery?: "prepare_new_call" | "retry_same_call";
  readonly message: string;
  /** Exact ordinary ask_peer recipient; a mutable handle is never contact authority. */
  readonly peerActorId?: string;
}

/** A call-bound capability supplied only by the admitted invocation context. */
export interface OrdinaryContentAccessExecution {
  commit(): Promise<OrdinaryContentAccessExecutionResult>;
}

export interface OrdinaryShareExecutionIdentity {
  readonly graphThreadId: string;
  readonly laneKey: string;
  readonly turnId: string;
  readonly assistantMessageId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly callDigest: string;
}

export interface OrdinaryContentAccessPreparedOperation {
  readonly admission: ContentAccessAdmission;
  readonly command: ContentAccessCommand;
  readonly previewToken: string;
  readonly expiresAt: number;
  /** Model-facing identity is distinct from the canonical internal object id. */
  readonly sourceObject: { readonly kind: "memory" | "artifact"; readonly id: string };
  readonly artifact?: ChatArtifactRef;
}

export interface OrdinaryContentAccessPrepared {
  readonly status: "prepared";
  readonly operations: readonly OrdinaryContentAccessPreparedOperation[];
  /** Public projection only: never place prepared authority in this object. */
  readonly preview: ProveItToolInfo;
}

export interface OrdinaryContentAccessPreparationFailure {
  readonly status: "error";
  readonly message: string;
}

/** Instance/identity-bound by Server composition; Agent does not select a DB. */
export interface OrdinaryContentAccessPort {
  prepare(input: Readonly<{
    execution: OrdinaryShareExecutionIdentity;
    intent: OrdinaryContentAccessIntent;
    operationIds: readonly string[];
    approvalContext: string;
  }>): Promise<OrdinaryContentAccessPrepared | OrdinaryContentAccessPreparationFailure>;
  commit(operation: OrdinaryContentAccessPreparedOperation): Promise<ContentAccessReceipt | ContentAccessFailure>;
  /** Current permission and original revision proof, never receipt authority. */
  verifyPeerContact?(operation: OrdinaryContentAccessPreparedOperation): Promise<boolean>;
}

export type OrdinaryContentAccessSelection =
  | Readonly<{ mode: "plaintext_only"; port?: OrdinaryContentAccessPort }>
  | Readonly<{ mode: "unchanged" }>;
export type OrdinaryContentAccessForState = (state: NautiloState) => OrdinaryContentAccessSelection | Promise<OrdinaryContentAccessSelection>;

/** Schema/description projection only; never supplies an execution capability. */
export async function ordinaryContentAccessToolContextForState(state: NautiloState, resolve?: OrdinaryContentAccessForState): Promise<Readonly<{ ordinaryContentAccessRequired: boolean }>> {
  return { ordinaryContentAccessRequired: (await resolve?.(state))?.mode === "plaintext_only" };
}

/** Durable data, not a process-local capability and never a model argument. */
export interface OrdinaryContentAccessBinding {
  readonly execution: OrdinaryShareExecutionIdentity;
  readonly intent: OrdinaryContentAccessIntent;
  readonly approvalContext: string;
  readonly prepared: OrdinaryContentAccessPrepared;
  /** Preserve the existing enrollment interrupt's position across every resume. */
  readonly pinEnrollmentRequired: boolean;
}

export const ORDINARY_CONTENT_ACCESS_RECOVERY =
  "Content access approval is missing, stale, or no longer matches this call. Prepare a new tool call for the same requested content and target, then obtain its current approval. Do not reuse this approval or ask the Human to repeat those details.";

/** Preserve the approved checkpoint when publication needs exact recovery. */
export class OrdinaryContentAccessRetryRequiredError extends Error {
  constructor() {
    super("Content access requires recovery of the same prepared operation; no replacement grant or peer contact is authorized.");
    this.name = "OrdinaryContentAccessRetryRequiredError";
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]),
  );
  return value;
}

export function ordinaryContentAccessDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function ordinaryShareExecutionIdentity(state: NautiloState, call: ToolCall): OrdinaryShareExecutionIdentity | null {
  const assistant = [...state.messages].reverse().find((message) => AIMessage.isInstance(message));
  if (!state.langgraphThreadId || !state.approvalLaneKey || !state.turnId || !assistant?.id || !call.id) return null;
  if (assistant.tool_calls?.filter((candidate) => candidate.id === call.id).length !== 1) return null;
  return {
    graphThreadId: state.langgraphThreadId,
    laneKey: state.approvalLaneKey,
    turnId: state.turnId,
    assistantMessageId: assistant.id,
    toolCallId: call.id,
    toolName: call.name,
    callDigest: ordinaryContentAccessDigest({ name: call.name, args: call.args }),
  };
}

/** The model call id is correlation only; trusted durable execution scopes it. */
export function ordinaryShareOperationId(execution: OrdinaryShareExecutionIdentity, object: OrdinaryContentAccessPreparedOperation["sourceObject"], index: number): string {
  const hex = ordinaryContentAccessDigest({ domain: "nautilo/ordinary-content-access/v1", execution, object, index });
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Normalized by the existing security owner, not accepted as raw consent. */
export function ordinaryShareApprovalContext(state: NautiloState, call: ToolCall): string {
  const catalog = getToolCatalog();
  return ordinaryContentAccessDigest({
    domain: "nautilo/ordinary-share-approval/v1",
    level: fromRuntimeConfig().nautilo_security_level,
    sensitivity: coerceHybridSensitivity(call.args?.["sensitivity"]),
    toolPolicy: catalog?.getToolPolicy(call.name) ?? null,
    shareArtifactPolicy: call.name === "ask_peer" ? catalog?.getToolPolicy("share_artifact") ?? null : null,
    actorRole: state.actorRole,
    toolAccess: state.memoryAccessEnvelope?.toolPolicy[call.name] ?? null,
    artifactAccess: call.name === "ask_peer" ? state.memoryAccessEnvelope?.toolPolicy["share_artifact"] ?? null : null,
    entrypoint: state.trustedExecutionEntrypoint ?? null,
  });
}

export function matchesOrdinaryContentAccessBinding(state: NautiloState, call: ToolCall, binding: OrdinaryContentAccessBinding | undefined): binding is OrdinaryContentAccessBinding {
  const execution = ordinaryShareExecutionIdentity(state, call);
  if (!binding || !execution || ordinaryContentAccessDigest(execution) !== ordinaryContentAccessDigest(binding.execution)
    || binding.approvalContext !== ordinaryShareApprovalContext(state, call)) return false;
  return binding.prepared.operations.length === binding.intent.objects.length
    && binding.prepared.operations.every((operation, index) => {
      const object = binding.intent.objects[index];
      const principal = operation.admission.principal;
      return object !== undefined
        && operation.sourceObject.kind === object.kind && operation.sourceObject.id === object.id
        && operation.command.operationId === ordinaryShareOperationId(execution, object, index)
        && operation.admission.audienceContract === "invoking_room"
        && operation.admission.approvalContext === binding.approvalContext
        && principal.kind === "agent" && principal.userId === state.userId
        && principal.actorId === state.memoryAccessEnvelope?.actorId
        && principal.agentId === state.agentId && principal.sourceRoomId === state.roomId;
    });
}

function ordinaryContentAccessFailure(message = ORDINARY_CONTENT_ACCESS_RECOVERY): OrdinaryContentAccessExecutionResult {
  return { status: "error", receipts: [], artifacts: [], recovery: "prepare_new_call", message };
}

/** Construct only after invocation-service's exact server admission succeeds. */
export function bindOrdinaryContentAccessExecution(state: NautiloState, call: ToolCall, binding: OrdinaryContentAccessBinding | undefined, port: OrdinaryContentAccessPort | undefined): OrdinaryContentAccessExecution {
  return Object.freeze({
    async commit(): Promise<OrdinaryContentAccessExecutionResult> {
      if (!port || !matchesOrdinaryContentAccessBinding(state, call, binding)) return ordinaryContentAccessFailure();
      let peerActorId: string | undefined;
      if (call.name === "ask_peer") {
        for (const operation of binding.prepared.operations) {
          const change = operation.command.change;
          if (binding.intent.target.kind !== "person" || operation.command.object.kind !== "artifact"
            || change.kind !== "grant_people" || change.selectedActorIds.length !== 1
            || !change.selectedActorIds[0]
            || (peerActorId !== undefined && peerActorId !== change.selectedActorIds[0])) return ordinaryContentAccessFailure();
          peerActorId = change.selectedActorIds[0];
        }
        if (peerActorId === undefined) return ordinaryContentAccessFailure();
      }
      const receipts: ContentAccessReceipt[] = [];
      const artifacts: ChatArtifactRef[] = [];
      for (const operation of binding.prepared.operations) {
        // The coordinator authenticates and checks replay before expiry/current
        // authority. Do not prevent recovery of a historical success here.
        let result: ContentAccessReceipt | ContentAccessFailure;
        try { result = await port.commit(operation); }
        catch {
          return { status: "error", receipts, artifacts, recovery: "retry_same_call",
            message: "Content access outcome is uncertain. Recover this exact prepared operation; do not prepare a replacement grant or contact the peer." };
        }
        if ("receiptPersisted" in result || !["applied", "already_applied"].includes(result.outcome)) {
          const retrySame = "receiptPersisted" in result && result.recovery !== "prepare_again";
          return { status: "error", receipts: "receiptPersisted" in result ? receipts : [...receipts, result], artifacts, ...( "receiptPersisted" in result ? { failure: result } : {}),
            recovery: retrySame ? "retry_same_call" : "prepare_new_call",
            message: retrySame
              ? "Recover this exact prepared operation before attempting any new grant or peer contact. Its outcome is not a completed grant."
              : ORDINARY_CONTENT_ACCESS_RECOVERY };
        }
        receipts.push(result);
        if (operation.artifact) artifacts.push(operation.artifact);
      }
      if (call.name === "ask_peer") {
        for (const operation of binding.prepared.operations) {
          let canContact = false;
          try { canContact = await port.verifyPeerContact?.(operation) ?? false; } catch { /* Fail closed without changing the completed receipts. */ }
          if (!canContact) return { status: "error", receipts, artifacts, recovery: "prepare_new_call",
            message: "The access operation completed, but current recipient access and the approved Artifact revision could not be verified. The peer was not contacted. Do not treat a historical receipt as current access; prepare a new approved call if contact is still requested." };
        }
      }
      return { status: "success", receipts, artifacts, ...(peerActorId === undefined ? {} : { peerActorId }),
        message: "Content access grant completed; existing content identity is preserved." };
    },
  });
}
