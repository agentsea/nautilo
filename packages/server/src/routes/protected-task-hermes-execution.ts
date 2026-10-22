import type { HermesAcpSession } from "../acp/task-execution";
import type { HermesAcpTaskExecutionDeps } from "../acp/task-execution";
import type { ProductionProtectedTaskNativeExecutionInput } from "./protected-task-native-execution-composition";
import type { createProtectedTaskExternalRequests } from "./protected-task-external-requests";
import { createProtectedTaskExternalExecution, type ProtectedTaskExternalExecutionDependencies,
  type ProtectedTaskExternalExecutionFactory, type ProtectedTaskExternalProvider } from "./protected-task-external-execution";
import { createProtectedTaskAcpProvider } from "./protected-task-acp-execution";
import { sameProtectedTaskHermesSelection, type ProtectedTaskHermesSelection } from "./protected-task-hermes-selection";

type Input = Pick<ProductionProtectedTaskNativeExecutionInput, "db"> & Readonly<{
  relay: HermesAcpTaskExecutionDeps["relay"];
  mintId?: () => string;
}>;
export function createProtectedTaskHermesProvider(input: Input): ProtectedTaskExternalProvider<ProtectedTaskHermesSelection, HermesAcpSession> {
  return createProtectedTaskAcpProvider<ProtectedTaskHermesSelection>({ ...input, registrationId: "hermes-acp" },
    (current, selection) => sameProtectedTaskHermesSelection(current.hermesExecutionSelection, selection));
}
export function createProtectedTaskHermesExecution(input: ProductionProtectedTaskNativeExecutionInput & Input & Readonly<{
  requests: Pick<ReturnType<typeof createProtectedTaskExternalRequests>, "register">;
}>, overrides: Partial<ProtectedTaskExternalExecutionDependencies> = {}): ProtectedTaskExternalExecutionFactory<ProtectedTaskHermesSelection> {
  return createProtectedTaskExternalExecution({ ...input, provider: createProtectedTaskHermesProvider(input) }, overrides);
}
