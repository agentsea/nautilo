import { apiClient } from "./api";
import { workbenchFetch } from "./admission-fetch";
import { MemoryHardDeleteConflictError } from "@nautilo/api-client/browser";
import type {
  MemoryDetailResponse,
  MemoryListResponse,
  MemorySearchResponse,
} from "@nautilo/api-client/browser";
export { MemoryHardDeleteConflictError } from "@nautilo/api-client/browser";
export type {
  MemoryAccessEntry,
  MemoryDetail,
  MemoryDetailResponse,
  MemoryListItem,
  MemoryListResponse,
  MemoryMode,
  MemorySearchResponse,
  MemorySearchResult,
} from "@nautilo/api-client/browser";

export interface MemoryBriefResponse {
  brief: string;
}

function authHeaders(): HeadersInit {
  const token = apiClient.getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function parseError(res: Response, fallback: string): Promise<never> {
  let detail = fallback;
  try {
    const json = (await res.json()) as { error?: string };
    if (json.error) detail = json.error;
  } catch {
    /* ignore */
  }
  throw new Error(detail);
}

export async function fetchMemories(opts?: {
  cursor?: string;
  limit?: number;
  includeArchive?: boolean;
  room?: string;
  person?: string;
  audience?: "private";
}): Promise<MemoryListResponse> {
  const params = new URLSearchParams();
  if (opts?.cursor) params.set("cursor", opts.cursor);
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts?.includeArchive) params.set("includeArchive", "true");
  if (opts?.room) params.set("room", opts.room);
  if (opts?.person) params.set("person", opts.person);
  if (opts?.audience) params.set("audience", opts.audience);
  const qs = params.toString();
  const res = await workbenchFetch(`/api/memory${qs ? `?${qs}` : ""}`, { headers: authHeaders() });
  if (!res.ok) await parseError(res, "Failed to load memories");
  return (await res.json()) as MemoryListResponse;
}

export async function searchMemories(opts: {
  q: string;
  mode: "text" | "semantic";
  limit?: number;
  includeArchive?: boolean;
}): Promise<MemorySearchResponse> {
  const params = new URLSearchParams({ q: opts.q, mode: opts.mode === "semantic" ? "vector" : "text" });
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.includeArchive) params.set("includeArchive", "true");
  const res = await workbenchFetch(`/api/memory/search?${params}`, { headers: authHeaders() });
  if (!res.ok) await parseError(res, "Failed to search memories");
  return (await res.json()) as MemorySearchResponse;
}

export async function fetchMemory(id: string): Promise<MemoryDetailResponse> {
  const res = await workbenchFetch(`/api/memory/${encodeURIComponent(id)}`, { headers: authHeaders() });
  if (!res.ok) await parseError(res, "Failed to load memory");
  return (await res.json()) as MemoryDetailResponse;
}

export async function updateMemory(
  id: string,
  input: { content?: string; importance?: number; namespaceId?: string },
): Promise<MemoryDetailResponse> {
  const res = await workbenchFetch(`/api/memory/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(input),
  });
  if (!res.ok) await parseError(res, "Failed to update memory");
  return (await res.json()) as MemoryDetailResponse;
}

export async function archiveMemory(id: string): Promise<void> {
  const res = await workbenchFetch(`/api/memory/${encodeURIComponent(id)}?mode=archive`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) await parseError(res, "Failed to archive memory");
}

export async function hardDeleteMemory(
  id: string,
  opts?: { confirmShared?: boolean },
): Promise<void> {
  const params = new URLSearchParams({ mode: "hard" });
  if (opts?.confirmShared) params.set("confirmShared", "true");
  const res = await workbenchFetch(`/api/memory/${encodeURIComponent(id)}?${params}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (res.status === 409) {
    const body = (await res.json()) as {
      error?: string;
      namespaceCount: number;
      namespaceIds: string[];
      hint?: string;
    };
    throw new MemoryHardDeleteConflictError(body);
  }
  if (!res.ok) await parseError(res, "Failed to delete memory");
}

export async function fetchPromptBriefReadOnly(): Promise<MemoryBriefResponse> {
  const res = await workbenchFetch("/api/memory/brief/readonly", { headers: authHeaders() });
  if (!res.ok) await parseError(res, "Failed to load prompt brief");
  return (await res.json()) as MemoryBriefResponse;
}

export async function grantMemory(
  id: string,
  target: { roomId: string } | { userHandle: string },
): Promise<{ status: string; namespaceId?: string; roomLabel?: string; minted?: boolean }> {
  const body = "roomId" in target ? { room_id: target.roomId } : { user_handle: target.userHandle };
  const res = await workbenchFetch(`/api/memory/${encodeURIComponent(id)}/grant`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) await parseError(res, "Failed to grant access");
  return (await res.json()) as { status: string; namespaceId?: string; roomLabel?: string; minted?: boolean };
}

export async function revokeMemory(
  id: string,
  userHandle: string,
): Promise<{ status: string; reHomed: number; skipped: string[] }> {
  const res = await workbenchFetch(`/api/memory/${encodeURIComponent(id)}/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ user_handle: userHandle }),
  });
  if (!res.ok) await parseError(res, "Failed to revoke access");
  return (await res.json()) as { status: string; reHomed: number; skipped: string[] };
}

export async function makeMemoryPrivate(
  id: string,
): Promise<{ status: string; skipped: string[] }> {
  const res = await workbenchFetch(`/api/memory/${encodeURIComponent(id)}/make_private`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({}),
  });
  if (!res.ok) await parseError(res, "Failed to make memory private");
  return (await res.json()) as { status: string; skipped: string[] };
}
