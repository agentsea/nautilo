import {
  resolveNautiloStorageRoot,
  validateNautiloInstanceIdValue,
} from "@nautilo/config";

/**
 * The clone source is deliberately not expressed with the product-wide
 * `default` alias. That alias means the canonical instance in ordinary CLI
 * parsing, while `default` remains a valid named instance for clone lineage.
 */
export type CloneSourceInput =
  | { readonly kind: "canonical-default" }
  | { readonly kind: "named"; readonly instanceId: string };

export type CloneSourceSelection =
  | {
      readonly kind: "canonical-default";
      readonly instanceId: "";
      readonly root: string;
    }
  | {
      readonly kind: "named";
      readonly instanceId: string;
      readonly root: string;
    };

export interface CloneTargetSelection {
  readonly instanceId: string;
  readonly root: string;
  readonly projectName: string;
}

function assertNamedInstanceId(instanceId: string, label: string): void {
  if (
    instanceId === "" ||
    instanceId !== instanceId.trim() ||
    validateNautiloInstanceIdValue(instanceId) !== null
  ) {
    throw new Error(`${label} must be a valid nonempty named-instance id`);
  }
}

/**
 * Parse a clone source without applying `default` / `(default)` aliases.
 * An empty identifier is the only string representation of the canonical
 * default; callers that need that meaning should prefer the explicit variant.
 */
export function parseCloneSource(instanceId: string): CloneSourceInput {
  if (instanceId === "") return { kind: "canonical-default" };
  assertNamedInstanceId(instanceId, "Clone source");
  return { kind: "named", instanceId };
}

export function selectCloneSource(
  userHome: string,
  input: CloneSourceInput,
): CloneSourceSelection {
  if (input.kind === "canonical-default") {
    return {
      kind: "canonical-default",
      instanceId: "",
      root: resolveNautiloStorageRoot(userHome, ""),
    };
  }
  assertNamedInstanceId(input.instanceId, "Clone source");
  return {
    kind: "named",
    instanceId: input.instanceId,
    root: resolveNautiloStorageRoot(userHome, input.instanceId),
  };
}

export function selectCloneTarget(
  userHome: string,
  instanceId: string,
): CloneTargetSelection {
  assertNamedInstanceId(instanceId, "Clone target");
  return {
    instanceId,
    root: resolveNautiloStorageRoot(userHome, instanceId),
    projectName: `nautilo-${instanceId}`,
  };
}

export function selectCloneMaterialization(input: {
  userHome: string;
  source: CloneSourceInput;
  targetId: string;
}): {
  source: CloneSourceSelection;
  target: CloneTargetSelection;
} {
  const source = selectCloneSource(input.userHome, input.source);
  const target = selectCloneTarget(input.userHome, input.targetId);
  if (source.kind === "named" && source.instanceId === target.instanceId) {
    throw new Error("--from and --to must differ");
  }
  return { source, target };
}
