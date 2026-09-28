import type { AIMessage } from "@langchain/core/messages";

/** Stop incomplete output from being accepted or used to execute tools. */
export class ModelOutputLimitError extends Error {
  override readonly name = "ModelOutputLimitError";
  constructor() {
    super("The model reached its output limit before finishing. Ask it to continue or retry the task.");
  }
}

export function modelResponseReachedOutputLimit(message: AIMessage): boolean {
  const metadata = message.response_metadata;
  const details = metadata["incomplete_details"];
  // Anthropic streaming puts terminal stop information in additional_kwargs.
  const additional = message.additional_kwargs;
  return metadata["finish_reason"] === "length"
    || metadata["stop_reason"] === "max_tokens"
    || additional["stop_reason"] === "max_tokens"
    || (metadata["status"] === "incomplete" && details !== null && typeof details === "object"
      && "reason" in details && details.reason === "max_output_tokens");
}
