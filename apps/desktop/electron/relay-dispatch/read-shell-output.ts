import {
  dispatchRetainedOutputArtifact,
  type RetainedOutputArtifactDispatchResult,
  type RunShellOutputArtifactStore,
  type RunShellOutputOwnerBinding,
} from "../run-shell-output-continuity";

/** Reads the existing capture; no shell preparation or execution is involved. */
export function dispatchReadShellOutput(
  args: Record<string, unknown>,
  owner: RunShellOutputOwnerBinding | undefined,
  store: RunShellOutputArtifactStore | undefined,
): RetainedOutputArtifactDispatchResult {
  const { operation, ...fields } = args;
  if (operation !== "page" && operation !== "search") return { ok: false, reason: "invalid" };
  return dispatchRetainedOutputArtifact({
    output_artifact: operation === "page" ? fields : args,
  }, owner, store);
}
