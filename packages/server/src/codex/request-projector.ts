import type { RelayCodexRequestMessage } from "@nautilo/relay";
import type { HarnessApprovalDecision, HarnessAttribution, HarnessRequest } from "@nautilo/runtime";

export interface CodexRequestProjectorContext {
  readonly bindingId: string;
  readonly bindingGeneration: string;
  readonly taskId: string;
  readonly roomId: string | null;
  readonly ownerId: string;
}

const APPROVAL_DECISIONS = {
  accept: "approve",
  acceptForSession: "approve_for_session",
  decline: "deny",
  cancel: "cancel",
} as const satisfies Readonly<Record<string, HarnessApprovalDecision>>;

/**
 * Pure Codex-wire to generic-harness request translation. It preserves exact
 * semantic choices and keyed questions; response JSON remains driver-owned.
 */
export class CodexRequestProjector {
  constructor(private readonly context: CodexRequestProjectorContext) {}

  project(message: RelayCodexRequestMessage): HarnessRequest | null {
    if (!this.belongsToBinding(message)) return null;
    const attribution = this.attribution(message);
    const base = {
      requestId: message.scope.requestRef,
      // `requestRef` is a Nautilo correlation token. The native JSON-RPC id
      // is introduced by the lifecycle broker, not fabricated at this seam.
      vendorRequestId: null,
      attribution,
      ownerId: this.context.ownerId,
      expiresAt: message.request.expiresAt,
    } as const;

    if (message.request.kind === "command_approval") {
      return {
        ...base,
        kind: "command_approval_required",
        options: message.request.choices.map((choice) => APPROVAL_DECISIONS[choice]),
        reason: message.request.reason,
        command: message.request.command,
      };
    }
    if (message.request.kind === "network_approval") {
      return {
        ...base,
        kind: "network_approval_required",
        options: message.request.choices.map((choice) => APPROVAL_DECISIONS[choice]),
        reason: message.request.reason,
        network: message.request.network,
      };
    }
    if (message.request.kind === "file_change_approval") {
      return {
        ...base,
        kind: "file_change_approval_required",
        options: message.request.choices.map((choice) => APPROVAL_DECISIONS[choice]),
        reason: message.request.reason,
        grantRoot: message.request.grantRoot,
      };
    }
    if (message.request.kind === "permissions_approval") {
      return {
        ...base,
        kind: "permissions_approval_required",
        reason: message.request.reason,
        permissions: message.request.permissions,
      };
    }
    if (message.request.kind === "user_input") {
      return {
        ...base,
        kind: "user_input_required",
        questions: message.request.questions.map((question) => ({
          id: question.id,
          header: question.header,
          prompt: question.question,
          secret: question.isSecret,
          multiSelect: false,
          allowOther: question.isOther,
          options: question.options?.map((option) => ({
            // The relay proxy maps this opaque id back to Codex's exact label.
            id: option.id,
            label: option.label,
            description: option.description,
          })) ?? null,
        })),
        autoResolutionMs: message.request.autoResolutionMs,
      };
    }
    return null;
  }

  private belongsToBinding(message: RelayCodexRequestMessage): boolean {
    return message.scope.bindingId === this.context.bindingId &&
      String(message.scope.bindingGeneration) === this.context.bindingGeneration &&
      message.scope.taskId === this.context.taskId;
  }

  private attribution(message: RelayCodexRequestMessage): HarnessAttribution {
    return {
      bindingId: this.context.bindingId,
      bindingGeneration: this.context.bindingGeneration,
      taskId: this.context.taskId,
      roomId: this.context.roomId,
      vendorSessionId: message.scope.threadId,
      vendorTurnId: message.scope.turnId,
      vendorItemId: message.scope.itemId,
    };
  }
}
