import type { ToolCatalog } from "@nautilo/catalog";
import type { ConnectionProviderDescriptor } from "@nautilo/types";
import { compileConnectedAppOperationAdmissions } from "./admissions";
import { createConnectedAppActionTool } from "./connected-app-action";

const CONNECTED_APP_TAG = "connected-app";

/**
 * Replace the model-facing connected-app projection from one verified app
 * catalogue. The signed document supplies declarations only; every executable
 * factory and policy gate remains local Nautilo code.
 */
export function syncConnectedAppOperationTools(
  catalog: ToolCatalog,
  providers: readonly ConnectionProviderDescriptor[],
): readonly string[] {
  const activeProviders = providers.filter((provider) =>
    provider.lifecycle === "pilot" || provider.lifecycle === "available");
  const admissions = compileConnectedAppOperationAdmissions(activeProviders);
  const previous = catalog.query({ tag: CONNECTED_APP_TAG }).map((entry) => entry.name);
  const previousSet = new Set(previous);

  for (const admission of admissions) {
    if (catalog.has(admission.toolName) && !previousSet.has(admission.toolName)) {
      throw new Error(`connected app tool collides with existing tool: ${admission.toolName}`);
    }
    // Compile/factory-check every candidate before mutating the live catalogue.
    createConnectedAppActionTool(admission);
  }

  for (const name of previous) catalog.unregister(name);
  for (const admission of admissions) {
    catalog.register({
      name: admission.toolName,
      factory: (ctx) => createConnectedAppActionTool(admission, ctx),
      category: admission.category,
      discoveryCategories: admission.discoveryCategories,
      trustTier: "standard",
      impact: admission.impact,
      exposure: "discoverable",
      tags: [CONNECTED_APP_TAG, ...admission.tags],
      requiresApproval: admission.requiresApproval,
      ...(admission.approvalLevel ? { approvalLevel: admission.approvalLevel } : {}),
      resultScanPolicy: "always",
      connectedAppProviderId: admission.providerId,
      ...(admission.asyncLifecycle ? { asyncLifecycle: admission.asyncLifecycle } : {}),
    });
  }
  return admissions.map((admission) => admission.toolName);
}
