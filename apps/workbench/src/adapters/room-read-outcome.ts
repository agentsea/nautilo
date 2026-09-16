import { ApiError } from "@nautilo/api-client/browser";
import { classifyDataOperationFailure } from "@nautilo/lattice-bridge";
import { restoreSessionMessages, type RehydrateResult, type StoredSessionMessageDto } from "./session-rehydrate";

/** Preserve the transcript's existing auth/terminal/retry outcome contract
 * while loading through a policy-free data operation. No representation choice
 * or confidential-body fallback belongs in this presentation adapter. */
export async function restoreRoomReadOutcome(load: () => Promise<Readonly<{
  messages: readonly StoredSessionMessageDto[];
  pageInfo?: RehydrateResult["pageInfo"];
}>>): Promise<RehydrateResult> {
  try {
    const page = await load();
    return page.messages.length === 0
      ? { status: "empty", restored: null, pageInfo: page.pageInfo }
      : { status: "ok", restored: restoreSessionMessages(page.messages), pageInfo: page.pageInfo };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 401 || error.status === 403) return { status: "unauthorized", restored: null };
      if (error.status === 404) return { status: "not-found", restored: null };
    }
    if (classifyDataOperationFailure(error) === "key_waiting") {
      return { status: "failed", restored: null, failureClass: "key_waiting" };
    }
    return { status: "failed", restored: null };
  }
}
