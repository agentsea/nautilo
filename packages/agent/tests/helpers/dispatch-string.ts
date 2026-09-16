import type { ToolMessage } from "@langchain/core/messages";

/**
 * Integration tests call `dispatchFileCommand` directly; only `read` on
 * image/PDF paths returns a ToolMessage. Narrow to string for assertions.
 */
export function expectDispatchString(result: string | ToolMessage): string {
  if (typeof result !== "string") {
    throw new Error(
      "dispatchFileCommand returned ToolMessage — pass non-multimodal paths or assert multimodal separately",
    );
  }
  return result;
}
