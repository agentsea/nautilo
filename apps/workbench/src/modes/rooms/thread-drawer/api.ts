import type { CreateSubthreadResponse, SubthreadSummary } from "@nautilo/types";
import { workbenchFetch } from "../../../lib/admission-fetch";
import { apiClient } from "../../../lib/api";

/**
 * D111's list/create endpoints predate their API-client wrappers. Keep this
 * narrow bridge authenticated with the same bearer source as `apiClient`; all
 * newer thread calls (history, send, responder, read state) use public client
 * methods directly.
 */
export class ThreadRequestError extends Error {
  constructor(public readonly status: number) {
    super(`Thread request failed: ${status}`);
    this.name = "ThreadRequestError";
  }
}

async function authenticatedThreadRequest(path: string, init?: RequestInit): Promise<Response> {
  const token = apiClient.getToken();
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await workbenchFetch(path, { ...init, headers });
  if (!response.ok) {
    throw new ThreadRequestError(response.status);
  }
  return response;
}

export async function findExistingSubthread(
  parentRoomId: string,
  anchorMessageId: number,
): Promise<string | null> {
  const res = await authenticatedThreadRequest(
    `/api/rooms/${encodeURIComponent(parentRoomId)}/subthreads`,
  );
  const data = (await res.json()) as { subthreads: SubthreadSummary[] };
  const match = data.subthreads.find((s) => s.anchorMessageId === anchorMessageId);
  return match?.id ?? null;
}

export async function createSubthread(
  parentRoomId: string,
  anchorMessageId: number,
): Promise<{ subthreadRoomId: string }> {
  const res = await authenticatedThreadRequest(
    `/api/rooms/${encodeURIComponent(parentRoomId)}/messages/${anchorMessageId}/subthreads`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({}),
    },
  );
  return (await res.json()) as CreateSubthreadResponse;
}
