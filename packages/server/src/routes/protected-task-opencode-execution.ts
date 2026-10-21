import type { HermesAcpSession } from "../acp/task-execution";
import type { OpenCodeAcpTaskExecutionDeps } from "../acp/opencode-task-execution";
import type { ProductionProtectedTaskNativeExecutionInput } from "./protected-task-native-execution-composition";
import type { createProtectedTaskExternalRequests } from "./protected-task-external-requests";
import { createProtectedTaskExternalExecution, type ProtectedTaskExternalExecutionDependencies,
  type ProtectedTaskExternalExecutionFactory, type ProtectedTaskExternalProvider } from "./protected-task-external-execution";
import { createProtectedTaskAcpProvider } from "./protected-task-acp-execution";
import { sameProtectedTaskOpenCodeSelection, type ProtectedTaskOpenCodeSelection } from "./protected-task-opencode-selection";

type Input = Pick<ProductionProtectedTaskNativeExecutionInput, "db"> & Readonly<{
  relay: OpenCodeAcpTaskExecutionDeps["relay"];
  mintId?: () => string;
}>;
export function createProtectedTaskOpenCodeProvider(input: Input): ProtectedTaskExternalProvider<ProtectedTaskOpenCodeSelection, HermesAcpSession> {
  return createProtectedTaskAcpProvider<ProtectedTaskOpenCodeSelection>({ ...input, registrationId: "opencode-acp" },
    (current, selection) => sameProtectedTaskOpenCodeSelection(current.opencodeExecutionSelection, selection));
}
export function createProtectedTaskOpenCodeExecution(input: ProductionProtectedTaskNativeExecutionInput & Input & Readonly<{
  requests: Pick<ReturnType<typeof createProtectedTaskExternalRequests>, "register">;
}>, overrides: Partial<ProtectedTaskExternalExecutionDependencies> = {}): ProtectedTaskExternalExecutionFactory<ProtectedTaskOpenCodeSelection> {
  return createProtectedTaskExternalExecution({ ...input, provider: createProtectedTaskOpenCodeProvider(input) }, overrides);
}
