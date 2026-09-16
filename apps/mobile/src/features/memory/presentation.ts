import { ApiError } from "@nautilo/api-client/browser";

export type MemoryAudience = {
  namespaceIds?: string[];
  accessList?: Array<{ displayName: string; userHandle: string }>;
  scopeOrigin?: "seed" | "scope";
  origin?: "seed" | "scope";
};

export type MemoryAccessPerson = { displayName: string; userHandle: string };

function normalizedHandle(handle: string | undefined): string {
  return handle?.trim().toLocaleLowerCase() ?? "";
}

/** People other than the signed-in requester who can see the memory. */
export function memoryAccessRecipients(
  accessList: readonly MemoryAccessPerson[],
  currentUserHandle: string | undefined,
): MemoryAccessPerson[] {
  const current = normalizedHandle(currentUserHandle);
  if (!current) return [...accessList];
  return accessList.filter(
    (person) => normalizedHandle(person.userHandle) !== current,
  );
}

export type MemoryActionAvailability = {
  canEdit: boolean;
  canArchive: boolean;
  canDelete: boolean;
  canManageAccess: boolean;
  limitation: string | null;
};

/**
 * The detail route projects these facts from the request envelope and the
 * memory's real attachments. Keep this local structural type so the mobile
 * feature can fail closed even while talking to an older server.
 */
export type MemoryActionAuthority = {
  canEdit: boolean;
  canArchive: boolean;
  canHardDelete: boolean;
  canManageAccess: boolean;
};

/**
 * These are advisory UI affordances only. Every action is still authorized by
 * the server, which is the source of truth when a capability changes.
 */
export function memoryActionAvailability(
  authority: MemoryActionAuthority | null | undefined,
  memoryMode: "namespace" | "scope" | null,
): MemoryActionAvailability {
  if (!authority) {
    return {
      canEdit: false,
      canArchive: false,
      canDelete: false,
      canManageAccess: false,
      limitation: "Memory actions are unavailable until the server confirms your access.",
    };
  }
  if (!authority.canEdit && !authority.canArchive && !authority.canHardDelete && !authority.canManageAccess) {
    return {
      canEdit: false,
      canArchive: false,
      canDelete: false,
      canManageAccess: false,
      limitation: "You can view this memory, but cannot change it from this context.",
    };
  }
  return {
    canEdit: authority.canEdit,
    canArchive: authority.canArchive,
    canDelete: authority.canHardDelete,
    canManageAccess: memoryMode === "namespace" && authority.canManageAccess,
    limitation:
      memoryMode === "scope" && !authority.canManageAccess
        ? "This memory belongs to a private context and cannot be shared from here."
        : null,
  };
}

export function memorySnippet(content: string, maxLength = 150): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) return "No content";
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

export function memoryTypeLabel(type: string): string {
  return type
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function memoryAudienceLabel(
  memory: MemoryAudience,
  memoryMode: "namespace" | "scope" | null,
  currentUserHandle?: string,
): string {
  if (memoryMode === "scope") {
    return memory.scopeOrigin === "seed" || memory.origin === "seed"
      ? "Saved from your private context"
      : "Private to your current context";
  }

  const people = memoryAccessRecipients(
    memory.accessList ?? [],
    currentUserHandle,
  )
    .map((entry) => entry.displayName || entry.userHandle)
    .filter(Boolean);
  if (people.length === 1) return `Shared with ${people[0]}`;
  if (people.length > 1) return `Shared with ${people.length} people`;
  if (memory.accessList !== undefined) return "Private memory";
  return (memory.namespaceIds?.length ?? 0) > 1 ? "Shared memory" : "Private memory";
}

export function formatMemoryTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "";
  const diff = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatMemoryDate(iso: string | null | undefined): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "Unknown";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function memoryErrorMessage(
  error: unknown,
  action: "load" | "search" | "detail" | "mutation",
): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Your session expired. Please sign in again.";
    if (error.status === 403) {
      return action === "mutation"
        ? "The server did not allow that memory change."
        : "You do not have permission to view memories.";
    }
    if (error.status === 404 && action === "detail") return "This memory is no longer available.";
    return error.message;
  }
  if (error instanceof Error && error.message) return error.message;
  return action === "search" ? "Could not search memories." : "Could not load memories.";
}
