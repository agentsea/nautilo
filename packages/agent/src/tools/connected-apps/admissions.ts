import { z } from "zod";
import type {
  ConnectedAppOperationContract,
  ConnectedAppProviderId,
  ConnectedAppReconciliation,
  ConnectionProviderDescriptor,
  ToolApprovalLevel,
  ToolCategory,
  ToolImpactLevel,
} from "@nautilo/types";

/** A local executable view of one operation declared by the signed catalogue. */
export type ConnectedAppOperationAdmission = {
  readonly toolName: string;
  readonly providerId: ConnectedAppProviderId;
  readonly sourceActionId: string;
  readonly description: string;
  readonly category: ToolCategory;
  readonly discoveryCategories: readonly ToolCategory[];
  readonly impact: ToolImpactLevel;
  readonly effect: "read" | "write";
  readonly requiresApproval: boolean;
  readonly approvalLevel?: ToolApprovalLevel;
  readonly asyncLifecycle?: ConnectedAppOperationContract["asyncLifecycle"];
  readonly resultPresentation?: ConnectedAppOperationContract["resultPresentation"];
  readonly artifactInput?: ConnectedAppOperationContract["artifactInput"];
  readonly inputSchema: z.ZodType<Record<string, unknown>>;
  readonly outputSchema: z.ZodType<unknown>;
  readonly reconciliationOperationId?: string;
  readonly reconciliationInput?: (output: unknown) => Record<string, unknown> | null;
  readonly reconciliationConfirms?: (output: unknown, reconciliationOutput: unknown) => boolean;
  readonly tags: readonly string[];
};

function pointer(value: unknown, path: string): unknown {
  let current = value;
  for (const encoded of path.slice(1).split("/")) {
    if (!current || typeof current !== "object") return undefined;
    const segment = encoded.replace(/~1/gu, "/").replace(/~0/gu, "~");
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function reconciliationInput(
  reconciliation: ConnectedAppReconciliation,
  output: unknown,
): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};
  for (const [key, mapping] of Object.entries(reconciliation.followupInput)) {
    if (mapping.kind === "literal") {
      result[key] = mapping.value;
      continue;
    }
    const value = pointer(output, mapping.pointer);
    if (value === undefined) return null;
    result[key] = value;
  }
  return result;
}

function reconciliationConfirms(
  reconciliation: ConnectedAppReconciliation,
  output: unknown,
  followup: unknown,
): boolean {
  const expected = pointer(output, reconciliation.sourcePointer);
  if (expected === undefined) return false;
  if (reconciliation.kind === "exact_field") {
    return Object.is(expected, pointer(followup, reconciliation.followupPointer));
  }
  const collection = pointer(followup, reconciliation.collectionPointer);
  return Array.isArray(collection) && collection.some((item) =>
    Object.is(expected, pointer(item, reconciliation.itemPointer)));
}

/**
 * Compile signed JSON-Schema contracts into local Zod executable guards.
 * This deliberately has no provider or action knowledge: the verified signed
 * catalogue is the only operation authority.
 */
export function compileConnectedAppOperationAdmissions(
  providers: readonly ConnectionProviderDescriptor[],
): readonly ConnectedAppOperationAdmission[] {
  return providers.flatMap((provider) => provider.operations.map((operation) => {
    let inputSchema = z.fromJSONSchema(operation.inputSchema) as z.ZodType<Record<string, unknown>>;
    for (const rule of operation.inputRules ?? []) {
      const previous = inputSchema;
      inputSchema = previous.superRefine((value, context) => {
        if (rule.fields.filter((field) => value[field] !== undefined).length > 1) {
          context.addIssue({ code: "custom", message: `${rule.fields.join(" and ")} cannot be used together` });
        }
      });
    }
    const outputSchema = z.fromJSONSchema(operation.outputSchema);
    return {
      toolName: operation.toolName,
      providerId: provider.id,
      sourceActionId: operation.sourceActionId,
      description: operation.description,
      category: operation.category,
      discoveryCategories: operation.discoveryCategories,
      impact: operation.impact,
      effect: operation.effect,
      requiresApproval: operation.requiresApproval,
      ...(operation.approvalLevel ? { approvalLevel: operation.approvalLevel } : {}),
      ...(operation.asyncLifecycle ? { asyncLifecycle: operation.asyncLifecycle } : {}),
      ...(operation.resultPresentation ? { resultPresentation: operation.resultPresentation } : {}),
      ...(operation.artifactInput ? { artifactInput: operation.artifactInput } : {}),
      inputSchema,
      outputSchema,
      ...(operation.reconciliation ? {
        reconciliationOperationId: operation.reconciliation.followupOperationId,
        reconciliationInput: (output: unknown) => reconciliationInput(operation.reconciliation!, output),
        reconciliationConfirms: (output: unknown, followup: unknown) =>
          reconciliationConfirms(operation.reconciliation!, output, followup),
      } : {}),
      tags: operation.tags,
    } satisfies ConnectedAppOperationAdmission;
  }));
}
