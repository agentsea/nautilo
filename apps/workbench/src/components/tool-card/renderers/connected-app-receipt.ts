import { ConnectedAppToolReceiptSchema, type ConnectedAppToolReceipt } from "@nautilo/types";

function operationToolName(operationId: string): string {
  return operationId.replace(/\./gu, "_");
}

/** Parse only a complete connected-app receipt for this exact admitted tool. */
export function parseConnectedAppReceipt(
  toolName: string,
  raw: string | undefined,
): ConnectedAppToolReceipt | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = ConnectedAppToolReceiptSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success || operationToolName(parsed.data.operationId) !== toolName
      || !parsed.data.operationId.startsWith(`${parsed.data.providerId}.`)) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/**
 * Keep a validated receipt intact for a sealed native renderer. Generic tool
 * cards still receive the bounded transcript projection; this narrow escape
 * hatch prevents that projection from erasing nested provider schema/records
 * before the renderer can select the safe fields it owns.
 */
export function preserveConnectedAppResultForCard(
  toolName: string | undefined,
  raw: string | undefined,
): string | undefined {
  return typeof toolName === "string" && parseConnectedAppReceipt(toolName, raw) !== null
    ? raw
    : undefined;
}
