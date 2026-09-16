/**
 * M067D — deterministic ChatModel for LangGraph integration tests.
 * Consumes a scripted queue of responses in order (one per `invoke`).
 */

import { AIMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChatModel } from "@nautilo/agent";

export interface StubScript {
  /** One entry per model.invoke call; consumed in order. */
  responses: Array<
    | {
        type: "text";
        /** Plain string or provider-style text blocks (tests multimodal content path). */
        content: string | ReadonlyArray<{ type: "text"; text: string }>;
      }
    | { type: "tool_call"; name: string; args: Record<string, unknown>; id?: string }
    | { type: "error"; error: Error }
  >;
}

export function createStubProvider(script: StubScript): {
  asChatModel: () => ChatModel;
  invocations: Array<{ messages: BaseMessage[] }>;
  remaining: number;
} {
  const invocations: Array<{ messages: BaseMessage[] }> = [];
  const queue = [...script.responses];

  const invokeImpl = (messages: BaseMessage[]): Promise<AIMessage> => {
    invocations.push({ messages });
    const next = queue.shift();
    if (!next) {
      return Promise.reject(
        new Error("Stub script exhausted — more model.invoke calls than scripted responses"),
      );
    }
    if (next.type === "error") return Promise.reject(next.error);
    if (next.type === "text") {
      const c = next.content;
      const content = typeof c === "string" ? c : [...c];
      return Promise.resolve(new AIMessage({ content }));
    }
    const id = next.id ?? `stub-tool-${invocations.length}`;
    return Promise.resolve(
      new AIMessage({
        content: "",
        tool_calls: [
          {
            type: "tool_call",
            id,
            name: next.name,
            args: next.args,
          },
        ],
      }),
    );
  };

  const asChatModel = (): ChatModel => {
    const model: ChatModel = {
      invoke: (messages, _options) => invokeImpl(messages as BaseMessage[]),
      bindTools(_tools, _options) {
        return model;
      },
    };
    return model;
  };

  return {
    asChatModel,
    invocations,
    get remaining() {
      return queue.length;
    },
  };
}
