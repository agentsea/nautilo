import { randomUUID } from "node:crypto";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { mergeMessagesPreservingInvariants } from "@nautilo/message-invariants";
import type { NautiloState } from "../agent/state";
import { parseOrdinaryContentAccessIntent } from "../tools/content-access-intent";
import {
  matchesOrdinaryContentAccessBinding,
  ordinaryShareApprovalContext,
  ordinaryShareExecutionIdentity,
  ordinaryShareOperationId,
  ORDINARY_CONTENT_ACCESS_RECOVERY,
  type OrdinaryContentAccessBinding,
  type OrdinaryContentAccessForState,
} from "../runtime/ordinary-content-access";

class SafePreparationFailure extends Error {}

/** Completed before post_model: interruption replay cannot refresh consent. */
export function createOrdinaryContentAccessPreflightNode(resolve?: OrdinaryContentAccessForState, isPinEnrolled?: (userId: string) => Promise<boolean>) {
  return async (initialState: NautiloState): Promise<Partial<NautiloState>> => {
    const selection = await resolve?.(initialState);
    if (selection?.mode !== "plaintext_only") return {
      ordinaryContentAccessBindings: {}, ordinaryContentAccessRejectedToolCallIds: [],
    };
    const last = [...initialState.messages].reverse().find((message) => AIMessage.isInstance(message));
    if (!last?.tool_calls?.length) return {
      ordinaryContentAccessBindings: {}, ordinaryContentAccessRejectedToolCallIds: [],
    };
    // A missing provider message id receives server identity at this checkpoint,
    // never at dispatch. Restart before this read-only checkpoint has no effect.
    const assistant = last.id ? last : new AIMessage({
      id: randomUUID(), content: last.content, tool_calls: last.tool_calls,
      additional_kwargs: last.additional_kwargs, response_metadata: last.response_metadata,
      ...(last.usage_metadata === undefined ? {} : { usage_metadata: last.usage_metadata }),
    });
    const state = assistant === last ? initialState : {
      ...initialState, messages: initialState.messages.map((message) => message === last ? assistant : message),
    };
    const bindings: Record<string, OrdinaryContentAccessBinding> = {};
    const rejected: string[] = [];
    const messages: ToolMessage[] = [];
    let enrollment: Promise<boolean> | undefined;
    const alreadyRejected = new Set([
      ...(state.modelRejectedToolCallIds ?? []), ...(state.projectionRejectedToolCallIds ?? []),
    ]);
    for (const call of assistant.tool_calls ?? []) {
      if (alreadyRejected.has(call.id ?? "")) continue;
      try {
        const intent = (() => {
          try { return parseOrdinaryContentAccessIntent(call, state.focusedResources ?? []); }
          catch (error) { throw new SafePreparationFailure(error instanceof Error ? error.message : ORDINARY_CONTENT_ACCESS_RECOVERY); }
        })();
        if (!intent) continue;
        const execution = ordinaryShareExecutionIdentity(state, call);
        if (!execution || !selection.port) throw new Error(ORDINARY_CONTENT_ACCESS_RECOVERY);
        const approvalContext = ordinaryShareApprovalContext(state, call);
        const prepared = await selection.port.prepare({
          execution, intent, approvalContext,
          operationIds: intent.objects.map((object, index) => ordinaryShareOperationId(execution, object, index)),
        });
        if (prepared.status === "error") throw new SafePreparationFailure(prepared.message);
        const pinEnrollmentRequired = isPinEnrolled !== undefined && Boolean(state.userId)
          ? !await (enrollment ??= isPinEnrolled(state.userId)) : false;
        const binding: OrdinaryContentAccessBinding = { execution, intent, approvalContext, prepared, pinEnrollmentRequired };
        if (!matchesOrdinaryContentAccessBinding(state, call, binding)) throw new Error(ORDINARY_CONTENT_ACCESS_RECOVERY);
        bindings[execution.toolCallId] = binding;
      } catch (error) {
        // Every failure is paired; valid siblings still enter normal approval.
        const callId = call.id ?? `ordinary-share-rejected:${randomUUID()}`;
        rejected.push(callId);
        messages.push(new ToolMessage({
          tool_call_id: callId, name: call.name, status: "error",
          content: JSON.stringify({ error: "content_access_preparation_failed", recovery: "prepare_new_call",
            message: error instanceof SafePreparationFailure ? error.message : ORDINARY_CONTENT_ACCESS_RECOVERY }),
          additional_kwargs: { nautilo_tool_status: "error" },
        }));
      }
    }
    return {
      messages: mergeMessagesPreservingInvariants(state.messages, messages),
      ordinaryContentAccessBindings: bindings,
      ordinaryContentAccessRejectedToolCallIds: rejected,
    };
  };
}
