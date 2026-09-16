export class MemoryAuthorityResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryAuthorityResolutionError";
  }
}

export type ResolveRequiredMemoryNamespaceIdsInput = Readonly<{
  readonly namespaceIds: readonly string[];
  readonly scopeOrigins: readonly ("seed" | "scope")[];
  readonly originWritableNamespaceId: string | null;
}>;

export function resolveRequiredMemoryNamespaceIds(
  input: ResolveRequiredMemoryNamespaceIdsInput,
): readonly string[] {
  if (!Array.isArray(input.namespaceIds) || !Array.isArray(input.scopeOrigins)) {
    throw new MemoryAuthorityResolutionError(
      "Memory attachment authority must be represented by arrays",
    );
  }
  const namespaceIds = input.namespaceIds.map((value) => {
    if (
      typeof value !== "string"
      || value.length > 128
      || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(value)
    ) {
      throw new MemoryAuthorityResolutionError(
        "Memory Namespace authority contains an invalid identifier",
      );
    }
    return value;
  });
  const hasScopeOrigin = input.scopeOrigins.some((origin) => {
    if (origin !== "seed" && origin !== "scope") {
      throw new MemoryAuthorityResolutionError(
        "Memory scope origin is unsupported",
      );
    }
    return origin === "scope";
  });
  const originNamespaceId = input.originWritableNamespaceId;
  if (hasScopeOrigin && originNamespaceId === null) {
    throw new MemoryAuthorityResolutionError(
      "scope-origin Memory is missing its exact writable Namespace",
    );
  }
  if (!hasScopeOrigin && originNamespaceId !== null) {
    throw new MemoryAuthorityResolutionError(
      "Memory retains a stale scope-origin Namespace",
    );
  }
  if (originNamespaceId !== null) {
    if (
      originNamespaceId.length > 128
      || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(originNamespaceId)
    ) {
      throw new MemoryAuthorityResolutionError(
        "Memory scope-origin Namespace is invalid",
      );
    }
    namespaceIds.push(originNamespaceId);
  }
  const required = [...new Set(namespaceIds)].sort();
  if (required.length === 0) {
    throw new MemoryAuthorityResolutionError(
      "Memory has no retained Namespace authority",
    );
  }
  return Object.freeze(required);
}
