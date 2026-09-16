import type { ProtectedMemoryAuthority } from "@nautilo/lattice-bridge";
import {
  isScopeMemoryEnvelope,
  type MemoryAccessEnvelope,
} from "@nautilo/trust";

export function protectedMemoryAuthorityFromEnvelope(
  envelope: MemoryAccessEnvelope | null | undefined,
): ProtectedMemoryAuthority | null {
  const subjectUserId = envelope?.ownerId.trim() ?? "";
  if (!envelope || !subjectUserId || !envelope.agentId) return null;
  if (isScopeMemoryEnvelope(envelope)) {
    const origin = "originWritableNamespaceId" in envelope
      && typeof envelope.originWritableNamespaceId === "string"
      ? envelope.originWritableNamespaceId.trim()
      : "";
    if (!origin) return null;
    return {
      mode: "scope",
      subjectUserId,
      agentId: envelope.agentId,
      scopeId: envelope.scopeId,
      originWritableNamespaceId: origin,
    };
  }
  if (envelope.writableNamespaces.length > 1) return null;
  return {
    mode: "namespace",
    subjectUserId,
    agentId: envelope.agentId,
    readableNamespaceIds: [...envelope.readableNamespaces].sort(),
    mutableNamespaceIds: [...envelope.mutableNamespaces].sort(),
    writableNamespaceId: envelope.writableNamespaces[0]?.trim() || null,
  };
}
