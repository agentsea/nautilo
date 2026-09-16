import type { NautiloApiClient } from "@nautilo/api-client/browser";

type ThreadApi = Pick<NautiloApiClient, "listSubthreads" | "createSubthread">;

/** Find the one canonical child Room anchored to this parent message. */
async function findMobileSubthread(
  api: ThreadApi,
  parentRoomId: string,
  anchorMessageId: number,
): Promise<string | null> {
  const payload = await api.listSubthreads(parentRoomId);
  return payload.subthreads.find((thread) => thread.anchorMessageId === anchorMessageId)?.id ?? null;
}

/** Resolve an existing child or create it through the canonical server endpoint. */
export async function openMobileSubthread(
  api: ThreadApi,
  parentRoomId: string,
  anchorMessageId: number,
): Promise<string> {
  const existing = await findMobileSubthread(api, parentRoomId, anchorMessageId);
  if (existing) return existing;
  const payload = await api.createSubthread(parentRoomId, anchorMessageId);
  if (!payload.subthreadRoomId) throw new Error("Could not open this thread.");
  return payload.subthreadRoomId;
}
