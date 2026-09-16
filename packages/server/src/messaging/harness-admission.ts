/**
 * Facts which exist only after the ordinary Task observer has persisted a
 * TaskRun.  Codex reuses this lifecycle; it never owns a parallel Task
 * dispatcher.
 */
export interface CanonicalHarnessTaskFacts {
  readonly taskId: string;
  readonly taskRunId: string;
  readonly parentTaskId: string | null;
  readonly source: "room" | "agent";
}

/**
 * Selected harness executors link and terminalize the canonical TaskRun.
 * Stop/abort remain owned by the ordinary Job lifecycle, so neither method
 * converts an interrupted turn into a failure.
 */
export interface HarnessTaskRunLifecyclePort {
  linkJob(input: CanonicalHarnessTaskFacts & { readonly jobId: string }): Promise<void>;
  complete(
    input: CanonicalHarnessTaskFacts & {
      readonly jobId: string;
      readonly resultText: string;
    },
  ): Promise<void>;
  fail(
    input: CanonicalHarnessTaskFacts & {
      readonly jobId: string;
      readonly code: string;
    },
  ): Promise<void>;
}
