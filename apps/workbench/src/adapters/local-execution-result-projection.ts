import { projectToolResultTextForDisplay } from "../components/tool-argument-preview";
import { preserveComputerUseResultForCard } from "../components/tool-card/renderers/computer-use";
import { preserveConnectedAppResultForCard } from "../components/tool-card/renderers/connected-app-receipt";
import { preserveLocalExecutionResultForCard } from "../components/tool-card/renderers/exec-command";

/** Keep validated native receipts intact before generic transcript redaction. */
export function projectToolResultForCard(toolName: string, result: string | undefined): string | undefined {
  return preserveComputerUseResultForCard(toolName, result)
    ?? preserveConnectedAppResultForCard(toolName, result)
    ?? preserveLocalExecutionResultForCard(toolName, result)
    ?? projectToolResultTextForDisplay(result);
}
