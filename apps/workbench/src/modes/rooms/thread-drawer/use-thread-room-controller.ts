import { useCallback, useEffect, useReducer, useRef } from "react";
import type { ServerEvent, ThreadDetailResponse } from "@nautilo/types";
import { apiClient } from "../../../lib/api";
import {
  restoreSessionMessages,
  type StoredSessionMessageDto,
} from "../../../adapters/session-rehydrate";
import {
  errorMessage,
  initialThreadRoomControllerState,
  threadRoomReducer,
  type ThreadRoomAction,
  type ThreadRoomControllerState,
  type ThreadRoomIdResolver,
} from "./thread-room-controller";
import { useRoomMessageOperations, useThreadRoomEventRouter } from "../../../adapters/runtime-contexts";
import { readFileContext } from "../../../adapters/file-context-ref";

type ThreadHistoryResponse = {
  messages: readonly (StoredSessionMessageDto & { createdAt: string })[];
};

export interface ThreadRoomApi {
  getThreadDetail(roomId: string): Promise<ThreadDetailResponse>;
  readRoomMessages(roomId: string): Promise<ThreadHistoryResponse>;
  getRoomActiveJobs(roomId: string): Promise<{ jobIds: string[] }>;
  sendRoomMessage(
    roomId: string,
    body: {
      content: string;
      currentFolder: string | null;
      currentFolderRelayId: string | null;
      workspacePath: string | null;
      replyToMessageId?: number;
      mentionedHumanUserIds?: string[];
    },
  ): Promise<{ messageId: number | null; jobId: string | null }>;
  stopRoom(roomId: string): Promise<unknown>;
  markRoomRead(roomId: string): Promise<unknown>;
}

export interface UseThreadRoomControllerOptions {
  /** Null closes the visual view only; it never stops a child job. */
  roomId: string | null;
  visible: boolean;
  /** A false→true transition rehydrates canonical HTTP state after reconnect. */
  connected: boolean;
  api?: ThreadRoomApi;
}

export interface ThreadRoomController {
  state: ThreadRoomControllerState;
  dispatch(action: ThreadRoomAction): void;
  retryHydrate(): void;
  setDraft(draft: string): void;
  send(): Promise<void>;
  sendText(
    content: string,
    options?: {
      replyToMessageId?: number;
      mentionedHumanUserIds?: string[];
    },
  ): Promise<boolean>;
  markRead: () => Promise<boolean>;
  stop(): Promise<void>;
  ingestEvent(event: ServerEvent, resolveRoomId?: ThreadRoomIdResolver): void;
}

function requestId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

/**
 * Effects for the child-room state machine. Socket ownership stays outside:
 * Task 3.2 calls `ingestEvent` only after it has routed a ServerEvent to this
 * controller. This keeps hidden/switching drawers from accidentally owning
 * or stopping parent runtime work.
 */
export function useThreadRoomController({
  roomId,
  visible,
  connected,
  api: injectedApi,
}: UseThreadRoomControllerOptions): ThreadRoomController {
  const sharedMessages = useRoomMessageOperations();
  const api = injectedApi ?? apiClient;
  const messageOperations = injectedApi ?? sharedMessages;
  const [state, dispatch] = useReducer(threadRoomReducer, initialThreadRoomControllerState);
  const hydrationEpoch = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const { registerThreadRoom } = useThreadRoomEventRouter();

  const hydrate = useCallback(async (targetRoomId: string): Promise<void> => {
    const epoch = ++hydrationEpoch.current;
    try {
      const [detail, history, jobs] = await Promise.all([
        api.getThreadDetail(targetRoomId),
        messageOperations.readRoomMessages(targetRoomId),
        api.getRoomActiveJobs(targetRoomId),
      ]);
      if (epoch !== hydrationEpoch.current) return;
      dispatch({
        type: "hydrated",
        roomId: targetRoomId,
        detail,
        messages: history.messages,
        runtimeMessages: restoreSessionMessages(history.messages),
        activeJobIds: jobs.jobIds,
      });
    } catch (cause) {
      if (epoch !== hydrationEpoch.current) return;
      dispatch({ type: "hydrate.failed", roomId: targetRoomId, error: errorMessage(cause) });
    }
  }, [api, messageOperations]);

  useEffect(() => {
    if (!roomId) {
      hydrationEpoch.current += 1;
      dispatch({ type: "close" });
      return;
    }
    dispatch({ type: "open", roomId, visible, connected });
  }, [connected, roomId, visible]);

  useEffect(() => {
    dispatch({ type: "visibility.changed", visible });
    dispatch({ type: "connection.changed", connected });
  }, [visible, connected]);

  useEffect(() => {
    if (!roomId || !connected) return;
    void hydrate(roomId);
  }, [roomId, connected, hydrate]);

  const retryHydrate = useCallback(() => {
    if (state.roomId && state.connected) void hydrate(state.roomId);
  }, [hydrate, state.connected, state.roomId]);

  const setDraft = useCallback((draft: string) => dispatch({ type: "draft.changed", draft }), []);

  const sendText = useCallback(async (
    rawContent: string,
    options?: {
      replyToMessageId?: number;
      mentionedHumanUserIds?: string[];
    },
  ): Promise<boolean> => {
    const current = stateRef.current;
    const targetRoomId = current.roomId;
    const content = rawContent.trim();
    // Do not let a child send race its canonical hydration or a close/switch.
    // Genie routing is the normal child-room Conductor/focus decision; a
    // thread is still a usable human conversation when no Genie is focused.
    if (!targetRoomId || current.phase !== "ready" || !current.detail || !content || current.send.status === "sending") return false;
    const id = requestId();
    dispatch({
      type: "send.started",
      requestId: id,
      content,
      createdAt: new Date().toISOString(),
      ...(options?.replyToMessageId !== undefined
        ? { replyToMessageId: options.replyToMessageId }
        : {}),
    });
    try {
      // Match the main composer: snapshot the renderer-owned file context at
      // send time, never when the child drawer opens. This preserves the
      // sending Human's current relay binding rather than deriving one from
      // the Room, parent, Agent, or another participant.
      const fileContext = readFileContext();
      const body = {
        content,
        ...fileContext,
        ...(options?.replyToMessageId !== undefined
          ? { replyToMessageId: options.replyToMessageId }
          : {}),
        ...(options?.mentionedHumanUserIds &&
        options.mentionedHumanUserIds.length > 0
          ? { mentionedHumanUserIds: options.mentionedHumanUserIds }
          : {}),
      };
      const result = await messageOperations.sendRoomMessage(targetRoomId, body);
      dispatch({
        type: "send.succeeded",
        requestId: id,
        messageId: result.messageId,
      });
      return true;
    } catch (cause) {
      dispatch({ type: "send.failed", requestId: id, error: errorMessage(cause) });
      return false;
    }
  }, [messageOperations]);

  const send = useCallback(async (): Promise<void> => {
    await sendText(stateRef.current.draft);
  }, [sendText]);

  const stop = useCallback(async (): Promise<void> => {
    const targetRoomId = state.roomId;
    if (!targetRoomId || state.stopping) return;
    dispatch({ type: "stop.started" });
    try {
      // Scope is intentionally the displayed child Room, never the parent.
      await api.stopRoom(targetRoomId);
      const jobs = await api.getRoomActiveJobs(targetRoomId);
      dispatch({ type: "stop.finished", activeJobIds: jobs.jobIds });
    } catch (cause) {
      dispatch({ type: "stop.failed", error: errorMessage(cause) });
    }
  }, [api, state.roomId, state.stopping]);

  const markRead = useCallback(async (): Promise<boolean> => {
    const current = stateRef.current;
    const targetRoomId = current.roomId;
    if (
      !targetRoomId ||
      current.phase !== "ready" ||
      !current.visible ||
      current.read.status === "marking"
    ) {
      return false;
    }
    dispatch({ type: "read.started", roomId: targetRoomId });
    try {
      await api.markRoomRead(targetRoomId);
      dispatch({ type: "read.finished", roomId: targetRoomId });
      return true;
    } catch {
      dispatch({ type: "read.failed", roomId: targetRoomId });
      return false;
    }
  }, [api]);

  const ingestEvent = useCallback((event: ServerEvent, resolveRoomId?: ThreadRoomIdResolver) => {
    dispatch({ type: "event.received", event, ...(resolveRoomId ? { resolveRoomId } : {}) });
  }, []);

  const ownsJobId = useCallback(
    (jobId: string) => stateRef.current.activeJobIds.includes(jobId),
    [],
  );

  useEffect(() => {
    if (!roomId) return;
    return registerThreadRoom({
      roomId,
      ...(state.parentRoomId ? { parentRoomId: state.parentRoomId } : {}),
      ...(state.anchor?.logicalMessageKey
        ? { anchorLogicalMessageKey: state.anchor.logicalMessageKey }
        : {}),
      ingestEvent,
      ownsJobId,
    });
  }, [
    ingestEvent,
    ownsJobId,
    registerThreadRoom,
    roomId,
    state.anchor?.logicalMessageKey,
    state.parentRoomId,
  ]);

  return {
    state,
    dispatch,
    retryHydrate,
    setDraft,
    send,
    sendText,
    markRead,
    stop,
    ingestEvent,
  };
}
