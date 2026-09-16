import type { ConnectionVaultToolAuditPayload } from "@nautilo/types";
import type { ConnectionScope, VaultBackend } from "@nautilo/types";

import type { ToolContext } from "@nautilo/catalog";

let activeVault: VaultBackend | null = null;

export function setConnectionVaultBackend(vault: VaultBackend | null): void {
  activeVault = vault;
}

export function getConnectionVaultBackend(): VaultBackend | null {
  return activeVault;
}

export type ConnectionVaultAuditSinkInput = ConnectionVaultToolAuditPayload & {
  readonly actorId: string | null;
  readonly ip: string;
  readonly userAgent?: string | undefined;
};

let auditSink: ((evt: ConnectionVaultAuditSinkInput) => void) | null = null;

export function setConnectionVaultAuditSink(
  sink: ((evt: ConnectionVaultAuditSinkInput) => void) | null,
): void {
  auditSink = sink;
}

export function emitConnectionVaultAudit(
  context: ToolContext | undefined,
  payload: ConnectionVaultToolAuditPayload,
): void {
  if (!auditSink) return;
  const envelope = context?.["memoryAccessEnvelope"] as
    | { actorId?: string }
    | null
    | undefined;
  const actorId =
    (typeof context?.["auditActorId"] === "string" ? context["auditActorId"] : null) ??
    (envelope && typeof envelope.actorId === "string" ? envelope.actorId : null);
  const meta = context?.["securityAuditClientMeta"] as
    | { ip?: string; userAgent?: string }
    | null
    | undefined;
  const ip = typeof meta?.ip === "string" ? meta.ip : "";
  const userAgent = typeof meta?.userAgent === "string" ? meta.userAgent : undefined;
  auditSink({ ...payload, actorId, ip, userAgent });
}

export function resolveConnectionScope(context: {
  readonly agentId?: string | undefined;
  readonly userId?: string | undefined;
  readonly memoryAccessEnvelope?: {
    readonly agentId?: string | undefined;
    readonly readableNamespaces?: readonly string[] | undefined;
    readonly writableNamespaces?: readonly string[] | undefined;
  } | null | undefined;
}): ConnectionScope {
  const envelope = context.memoryAccessEnvelope;
  const agentId = envelope?.agentId ?? context.agentId ?? "";
  const writable = envelope?.writableNamespaces ?? [];

  return {
    agentId,
    // M082: same as HTTP `connections` route — default NS = attachment target.
    defaultNamespaceId: writable[0] ?? null,
    readableNamespaceIds: envelope?.readableNamespaces ?? [],
  };
}
