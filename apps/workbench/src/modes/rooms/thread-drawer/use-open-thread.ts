import { useCallback } from "react";
import { useDrawer } from "./drawer-state.tsx";
import {
  createSubthread,
  findExistingSubthread,
  ThreadRequestError,
} from "./api";

export type OpenThreadResult =
  | { opened: true }
  | { opened: false; reason: "not_visible" | "failed" };

export interface OpenThreadApi {
  findExistingSubthread: typeof findExistingSubthread;
  createSubthread: typeof createSubthread;
}

const defaultThreadApi: OpenThreadApi = {
  findExistingSubthread,
  createSubthread,
};

export function useOpenThread(api: OpenThreadApi = defaultThreadApi) {
  const drawer = useDrawer();

  return useCallback(
    async (
      parentRoomId: string | null,
      parentMessageId: number,
    ): Promise<OpenThreadResult> => {
      if (!parentRoomId) return { opened: false, reason: "not_visible" };

      try {
        let subthreadRoomId = await api.findExistingSubthread(
          parentRoomId,
          parentMessageId,
        );

        if (!subthreadRoomId) {
          const result = await api.createSubthread(parentRoomId, parentMessageId);
          subthreadRoomId = result.subthreadRoomId;
        }

        drawer.open({
          kind: "thread",
          parentRoomId,
          subthreadRoomId,
          anchorMessageId: parentMessageId,
        });
        return { opened: true };
      } catch (error) {
        return {
          opened: false,
          reason:
            error instanceof ThreadRequestError && error.status === 404
              ? "not_visible"
              : "failed",
        };
      }
    },
    [api, drawer],
  );
}
