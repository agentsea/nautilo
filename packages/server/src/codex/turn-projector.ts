import type { RelayCodexEventMessage } from "@nautilo/relay";
import {
  HARNESS_MAX_TEXT_BYTES,
  type HarnessAttribution,
  type HarnessEvent,
  type HarnessItemAttribution,
} from "@nautilo/runtime";

export interface CodexTurnProjectorContext {
  readonly bindingId: string;
  readonly bindingGeneration: string;
  readonly taskId: string;
  readonly roomId: string | null;
}

type AssistantItem = {
  readonly itemId: string;
  readonly text: string;
  readonly phase: "commentary" | "final_answer" | null;
};

type TurnState = {
  readonly assistantItems: Map<string, AssistantItem>;
  readonly streamedText: Map<string, string>;
  closed: boolean;
  lastEventSequence: number;
};

/**
 * Pure, provider-specific lifecycle reducer. Relay validates transport scope
 * and bytes before this sees an event; this class decides only item precedence
 * and the bounded generic harness semantics emitted for one admitted binding.
 */
export class CodexTurnProjector {
  private readonly turns = new Map<string, TurnState>();

  constructor(private readonly context: CodexTurnProjectorContext) {}

  project(message: RelayCodexEventMessage): readonly HarnessEvent[] {
    if (!isTurnScoped(message) || !this.belongsToBinding(message)) return [];
    const state = this.stateFor(message.scope.threadId, message.scope.turnId);
    if (state.closed || message.eventSequence <= state.lastEventSequence) return [];
    state.lastEventSequence = message.eventSequence;

    const attribution = this.attribution(message);
    switch (message.event.kind) {
      case "message_delta":
        if (!hasItemId(message)) return [];
        state.streamedText.set(
          message.scope.itemId,
          `${state.streamedText.get(message.scope.itemId) ?? ""}${message.event.text}`,
        );
        return [{
          kind: "output_delta",
          attribution: this.itemAttribution(attribution, message.scope.itemId),
          text: bounded(message.event.text),
        }];
      case "assistant_item_completed": {
        if (!hasItemId(message)) return [];
        const completedText = message.event.text ?? state.streamedText.get(message.scope.itemId);
        if (!completedText?.trim()) return [];
        state.assistantItems.set(message.scope.itemId, {
          itemId: message.scope.itemId,
          text: completedText,
          phase: message.event.phase,
        });
        return [];
      }
      case "turn_completed": {
        state.closed = true;
        // Codex 0.139.0 commonly completes live turns with itemsView
        // "notLoaded" and an empty items array after already publishing the
        // authoritative agentMessage through item/completed. Only a full
        // terminal view may replace that ordered completed-item state.
        if (message.event.itemsView === "full") {
          state.assistantItems.clear();
          for (const item of message.event.assistantItems) {
            const completedText = item.text ?? state.streamedText.get(item.itemId);
            if (!completedText?.trim()) continue;
            state.assistantItems.set(item.itemId, {
              itemId: item.itemId,
              text: completedText,
              phase: item.phase,
            });
          }
        }
        const output: HarnessEvent[] = [];
        if (message.event.status === "completed") {
          const final = selectFinal(state.assistantItems.values());
          if (final) {
            output.push({
              kind: "assistant_completed",
              attribution: this.itemAttribution(attribution, final.itemId),
              text: final.text,
            });
          }
        }
        output.push(this.terminal(attribution, message.event.status));
        return output;
      }
      case "progress":
        return [{
          kind: "progress",
          attribution,
          message: bounded(`Codex ${message.event.phase}`),
        }];
      case "command_summary":
        return [{
          kind: "command_summary",
          attribution,
          commands: [{ summary: bounded(message.event.summary), status: "completed" }],
        }];
      case "patch_summary":
        return [{
          kind: "patch_summary",
          attribution,
          files: [],
          summary: bounded(message.event.summary),
        }];
      case "usage_status":
        return [{
          kind: "usage",
          attribution,
          dimensions: [{
            name: "codex_usage_status",
            value: message.event.state === "updated" ? 1 : message.event.state === "rate_limited" ? 2 : 3,
          }],
        }];
      case "turn_status":
        // The Desktop emits this only after it has received the upstream
        // app-server turn lifecycle notification.  Keep `queued` and
        // `running` distinct: acceptance of a Nautilo Task is not proof that
        // Codex has begun its turn. Terminal state remains owned by the
        // authoritative turn/completed frame below.
        if (message.event.state !== "queued" && message.event.state !== "running") {
          return [];
        }
        return [{
          kind: "progress",
          attribution,
          message: message.event.state === "running"
            ? "Codex turn started"
            : "Codex turn queued",
        }];
    }
  }

  private belongsToBinding(message: Extract<RelayCodexEventMessage, { readonly scope: { readonly bindingId: string } }>): boolean {
    return message.scope.bindingId === this.context.bindingId &&
      String(message.scope.bindingGeneration) === this.context.bindingGeneration &&
      message.scope.taskId === this.context.taskId;
  }

  private attribution(
    message: Extract<RelayCodexEventMessage, { readonly scope: { readonly threadId: string; readonly turnId: string } }>,
  ): HarnessAttribution {
    return {
      bindingId: this.context.bindingId,
      bindingGeneration: this.context.bindingGeneration,
      taskId: this.context.taskId,
      roomId: this.context.roomId,
      vendorSessionId: message.scope.threadId,
      vendorTurnId: message.scope.turnId,
      vendorItemId: null,
    };
  }

  private itemAttribution(
    attribution: HarnessAttribution,
    itemId: string,
  ): HarnessItemAttribution {
    return { ...attribution, vendorItemId: itemId };
  }

  private stateFor(threadId: string, turnId: string): TurnState {
    const key = `${threadId}\u0000${turnId}`;
    let state = this.turns.get(key);
    if (!state) {
      state = {
        assistantItems: new Map(),
        streamedText: new Map(),
        closed: false,
        lastEventSequence: -1,
      };
      this.turns.set(key, state);
    }
    return state;
  }

  private terminal(
    attribution: HarnessAttribution,
    state: "completed" | "failed" | "interrupted" | "uncertain",
  ): HarnessEvent {
    if (state === "completed") return { kind: "terminal", attribution, status: "completed" };
    if (state === "interrupted") return { kind: "terminal", attribution, status: "interrupted", code: "user_stop" };
    return {
      kind: "terminal",
      attribution,
      status: "failed",
      code: state === "uncertain" ? "process_lost" : "upstream_failure",
    };
  }
}

function isTurnScoped(
  message: RelayCodexEventMessage,
): message is Extract<RelayCodexEventMessage, { readonly scope: { readonly threadId: string; readonly turnId: string; readonly bindingId: string } }> {
  return "threadId" in message.scope && "turnId" in message.scope && "bindingId" in message.scope;
}

function hasItemId(
  message: RelayCodexEventMessage,
): message is Extract<RelayCodexEventMessage, { readonly scope: { readonly itemId: string } }> {
  return "itemId" in message.scope;
}

function selectFinal(items: Iterable<AssistantItem>): AssistantItem | undefined {
  const observed = [...items].filter((item) => item.text.trim().length > 0);
  return [...observed].reverse().find((item) => item.phase === "final_answer") ?? observed.at(-1);
}

function bounded(value: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= HARNESS_MAX_TEXT_BYTES) return value;
  const suffix = "...";
  const contentLimit = HARNESS_MAX_TEXT_BYTES - encoder.encode(suffix).byteLength;
  let byteLength = 0;
  let end = 0;
  for (const codePoint of value) {
    const nextByteLength = encoder.encode(codePoint).byteLength;
    if (byteLength + nextByteLength > contentLimit) break;
    byteLength += nextByteLength;
    end += codePoint.length;
  }
  return `${value.slice(0, end)}${suffix}`;
}
