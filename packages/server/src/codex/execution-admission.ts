import type { HarnessExecutionAdmission } from "@nautilo/runtime";
import type { CodexDerivedBindingScope } from "./authority";
import type { CodexModelOutputContract } from "./model-output-contract";

/**
 * Server-private extension of the provider-neutral runtime admission.
 *
 * TypeScript's structural typing is intentionally not the authority check:
 * only this module can brand an admission.  The execution and binding ports
 * assert that brand before touching a Codex session.
 */
export interface CodexExecutionAdmission extends HarnessExecutionAdmission {
  readonly codex: {
    readonly scope: CodexDerivedBindingScope;
    readonly selectedModel: string | null;
    readonly outputContract: CodexModelOutputContract;
    readonly collaborationMode: "work" | "plan";
    /** Optional starting directory resolved and validated by the selected Desktop. */
    readonly workingDirectory: string | null;
    readonly bindingKind: "task";
  };
}

const admissions = new WeakSet<object>();

export type CreateCodexExecutionAdmissionInput = HarnessExecutionAdmission & {
  readonly codex: CodexExecutionAdmission["codex"];
};

/** Mint one immutable, private Codex admission after server authority succeeds. */
export function createCodexExecutionAdmission(
  input: CreateCodexExecutionAdmissionInput,
): CodexExecutionAdmission {
  const admission = Object.freeze({
    ...input,
    binding: Object.freeze({ ...input.binding }),
    workspace: Object.freeze({ ...input.workspace }),
    profile: Object.freeze({ ...input.profile }),
    posture: Object.freeze({ ...input.posture }),
    codex: Object.freeze({
      ...input.codex,
      scope: Object.freeze({
        ...input.codex.scope,
        workspace: Object.freeze({ ...input.codex.scope.workspace }),
      }),
    }),
  }) as CodexExecutionAdmission;
  admissions.add(admission);
  return admission;
}

export function isCodexExecutionAdmission(
  value: unknown,
): value is CodexExecutionAdmission {
  return typeof value === "object" && value !== null && admissions.has(value);
}

export function assertCodexExecutionAdmission(
  value: HarnessExecutionAdmission,
): asserts value is CodexExecutionAdmission {
  if (!isCodexExecutionAdmission(value)) {
    throw new TypeError("Codex execution admission was not server-authored");
  }
}
