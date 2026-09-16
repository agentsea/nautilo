import { computerUseHostToolDefinition, projectComputerUseHostToolResult } from "../../config/computer-use-catalogue/host-tool-admission";

/** Full Host bytes are retained only in the non-provider sidecar. */
export const COMPUTER_RESULT_DURABLE_SIDECAR_KEY = "nautilo_host_computer_result_v1";

/** Agent validates an exact signed descriptor result; non-Host tools retain their own output. */
export function projectSemanticComputerResult(toolName: string, scannedText: string): string {
  if (computerUseHostToolDefinition(toolName) === null) return scannedText;
  try {
    const projected = projectComputerUseHostToolResult(toolName, JSON.parse(scannedText));
    if (projected !== null) return projected;
  } catch { /* compact fail-closed result below */ }
  return JSON.stringify({
    version: 1, ok: false, settlement: "failed",
    presentation: { label: "Computer Use", summary: "Computer Use result was not recognized. Observe the current state before continuing." },
  });
}

export function computerResultDurableSidecar(toolName: string, scannedText: string): Record<string, unknown> {
  return computerUseHostToolDefinition(toolName) === null ? {} : { [COMPUTER_RESULT_DURABLE_SIDECAR_KEY]: scannedText };
}

export function durableComputerResultText(message: Readonly<{ name?: string; additional_kwargs?: Record<string, unknown> }>): string | null {
  if (message.name === undefined || computerUseHostToolDefinition(message.name) === null) return null;
  const value = message.additional_kwargs?.[COMPUTER_RESULT_DURABLE_SIDECAR_KEY];
  return typeof value === "string" ? value : null;
}
