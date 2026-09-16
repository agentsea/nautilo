import type { TaskExecutionRouteSelector } from "@nautilo/runtime";
import { HarnessControlPlane } from "@nautilo/runtime";
import {
  CodexHarnessAdmissionFailure,
} from "./harness-admission";
import {
  createCodexHarnessRegistration,
  type CodexHarnessPorts,
  CODEX_HARNESS_ID,
} from "./harness-driver";
import type {
  TaskHarnessExecutionRouteRegistration,
} from "../harness/task-execution-route";
import { TaskHarnessExecutionRouteProviderFailure } from "../harness/task-execution-route";

const CODEX_PUBLIC_SELECTION_FAILURES = Object.freeze([
  "CODEX_NOT_ENABLED",
  "CODEX_PROFILE_UNAVAILABLE",
  "CODEX_EXECUTION_FAILED",
]);

/**
 * Server composition seam for the optional Codex harness. It intentionally
 * requires a real execution port: Task 3.2 registers and selects a driver,
 * while later tasks own Codex admission, queueing, bindings, projection, and
 * requests.
 */
export function createCodexHarnessControlPlane(
  ports: CodexHarnessPorts,
): HarnessControlPlane {
  return new HarnessControlPlane([createCodexHarnessRegistration(ports)]);
}

/**
 * Preserve the complete Codex selector as provider-owned while allowing the
 * generic Task router to select it by its reviewed identifier. Construction
 * remains lazy: Native Tasks and other registrations do not create Codex
 * admission machinery.
 */
export function createCodexTaskHarnessExecutionRouteRegistration(
  createSelector: () => TaskExecutionRouteSelector,
): TaskHarnessExecutionRouteRegistration {
  return {
    harnessId: CODEX_HARNESS_ID,
    publicFailureCodes: CODEX_PUBLIC_SELECTION_FAILURES,
    createSelector: () => {
      const selector = createSelector();
      return {
        select: async ({ facts }) => {
          try {
            return await selector(facts);
          } catch (error) {
            if (error instanceof CodexHarnessAdmissionFailure) {
              throw new TaskHarnessExecutionRouteProviderFailure(error.code);
            }
            throw error;
          }
        },
      };
    },
  };
}
