import type { McpServer, NewMcpServer } from "@nautilo/db";

export interface McpInsertFields {
  readonly name: string;
  readonly transportKind: McpServer["transportKind"];
  readonly transport: Record<string, unknown>;
  readonly envPassthrough?: readonly string[] | null | undefined;
  readonly namespaceId?: string | null | undefined;
  readonly includeTools?: readonly string[] | null | undefined;
  readonly excludeTools?: readonly string[] | null | undefined;
  readonly trustTier?: string | null | undefined;
}

export function buildMcpInsertRow(
  fields: McpInsertFields,
  host: "server" | `relay-${string}`,
): Omit<NewMcpServer, "id" | "createdAt" | "updatedAt"> {
  return {
    name: fields.name,
    host,
    transportKind: fields.transportKind,
    transport: fields.transport,
    enabled: false,
    ...(fields.envPassthrough ? { envPassthrough: [...fields.envPassthrough] } : {}),
    ...(fields.namespaceId !== undefined ? { namespaceId: fields.namespaceId } : {}),
    ...(fields.includeTools ? { includeTools: [...fields.includeTools] } : {}),
    ...(fields.excludeTools ? { excludeTools: [...fields.excludeTools] } : {}),
    ...(fields.trustTier !== undefined ? { trustTier: fields.trustTier } : {}),
  };
}
