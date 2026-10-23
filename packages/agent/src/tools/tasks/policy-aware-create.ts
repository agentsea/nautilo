import type {
  TaskToolCreateInput,
  TaskToolHarnessCreateInput,
  TaskToolHarnessCreateResult,
  TaskToolRuntime,
} from "./task-tool-runtime";

class ProtectedTaskCreationUnavailableError extends Error {
  constructor(kind: "native" | "harness") {
    super(`Protected ${kind === "harness" ? "harness " : ""}Task creation is unavailable.`);
    this.name = "ProtectedTaskCreationUnavailableError";
  }
}

/** Select the Task publication path from the current server policy on every call. */
export async function createTaskForCurrentContentPolicy(
  runtime: TaskToolRuntime,
  input: TaskToolCreateInput,
): ReturnType<TaskToolRuntime["createTask"]> {
  const ordinary = runtime.canUseLegacyTaskContent === undefined
    || await runtime.canUseLegacyTaskContent();
  if (ordinary) return runtime.createTask(input);
  if (runtime.createProtectedTask === undefined) {
    throw new ProtectedTaskCreationUnavailableError("native");
  }
  return runtime.createProtectedTask(input);
}

/** Harness Tasks obey the same publication policy as Native Tasks. */
export async function createHarnessTaskForCurrentContentPolicy(
  runtime: TaskToolRuntime,
  input: TaskToolHarnessCreateInput,
): Promise<TaskToolHarnessCreateResult> {
  const ordinary = runtime.canUseLegacyTaskContent === undefined
    || await runtime.canUseLegacyTaskContent();
  if (ordinary) {
    if (runtime.createHarnessTask === undefined) {
      throw new ProtectedTaskCreationUnavailableError("harness");
    }
    return runtime.createHarnessTask(input);
  }
  if (runtime.createProtectedHarnessTask === undefined) {
    throw new ProtectedTaskCreationUnavailableError("harness");
  }
  return runtime.createProtectedHarnessTask(input);
}
