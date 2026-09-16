import { DynamicStructuredTool } from "@langchain/core/tools";
import type { ToolContext } from "@nautilo/catalog";
import { connectedAppActorFromContext, getConnectedAppActionRuntime } from "./runtime";
import type { ConnectedAppOperationAdmission } from "./admissions";

/** One provider-neutral factory; admissions supply the exact model schema. */
export function createConnectedAppActionTool(
  admission: ConnectedAppOperationAdmission,
  context?: ToolContext,
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: admission.toolName,
    description: admission.description,
    schema: admission.inputSchema,
    func: async (input: Record<string, unknown>, _runManager, config): Promise<string> => {
      const runtime = getConnectedAppActionRuntime();
      if (!runtime) throw new Error("CONNECTED_APP_RUNTIME_UNAVAILABLE");
      const actor = connectedAppActorFromContext(context);
      if (!actor) throw new Error("CONNECTED_APP_NAMESPACE_REQUIRED");
      const receipt = await runtime.execute({
        ...actor,
        providerId: admission.providerId,
        operationId: admission.sourceActionId,
        effect: admission.effect,
        input,
        signal: config?.signal,
      });
      return JSON.stringify(receipt);
    },
  });
}
