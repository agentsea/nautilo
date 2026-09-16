import type {
  ConnectionMetadata,
  ConnectionScope,
  SecretCategory,
} from "@nautilo/types";

function allowUserRead(
  meta: ConnectionMetadata,
  scope: ConnectionScope,
): boolean {
  if (meta.category !== "user") {
    return false;
  }
  if (meta.namespace_id === null || meta.agent_id === null) {
    return scope.allowMigrationNullNamespaces === true;
  }
  return (
    scope.readableNamespaceIds.includes(meta.namespace_id) &&
    meta.agent_id === scope.agentId
  );
}

export function connectionReadable(
  meta: ConnectionMetadata,
  scope: ConnectionScope,
): boolean {
  return allowUserRead(meta, scope);
}

export function targetRowAllowedForWrite(input: {
  readonly category: SecretCategory;
  readonly namespace_id: string | null;
  readonly agent_id: string | null;
  readonly scope: ConnectionScope;
}): boolean {
  const { namespace_id, agent_id, scope } = input;
  if (namespace_id === null || agent_id === null) {
    return scope.allowMigrationNullNamespaces === true;
  }
  if (namespace_id !== scope.defaultNamespaceId) {
    return false;
  }
  return (
    scope.readableNamespaceIds.includes(namespace_id) &&
    agent_id === scope.agentId
  );
}
