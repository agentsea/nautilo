import { useCallback, useSyncExternalStore } from "react";
import { ApiError } from "@nautilo/api-client/browser";
import type { ConnectedWebOperationProjection } from "@nautilo/types";
import { apiClient } from "../../../lib/api";

type OperationState = {
  value: ConnectedWebOperationProjection | null;
  status: "loading" | "available" | "unavailable";
};
const emptyState: OperationState = { value: null, status: "loading" };
type Observation = {
  state: OperationState;
  retry?: () => void;
  listeners: Set<() => void>;
  timer?: ReturnType<typeof setTimeout>;
};
// Shared while the exact card/header/body is mounted, including replacement
// within one React commit. Never persistent and never stores live/CDP URLs.
const observations = new Map<string, Observation>();
const OPERATION_POLL_INTERVAL_MS = 2_000;

export function publishConnectedWebOperation(value: ConnectedWebOperationProjection): void {
  const entry = observations.get(value.operationId);
  if (!entry) return;
  // Terminal truth cannot regress if a slow poll races a Stop response.
  if (entry.state.value?.lifecycle === "terminal" && value.lifecycle !== "terminal") return;
  // A response from the previous driver cannot overwrite a newer takeover.
  if (entry.state.value && value.controlEpoch < entry.state.value.controlEpoch) return;
  entry.state = { value, status: "available" };
  for (const notify of entry.listeners) notify();
}

export function useConnectedWebOperation(operationId: string | null): OperationState & { retry: () => void } {
  const subscribe = useCallback((notify: () => void) => {
    if (!operationId) return () => {};
    let entry = observations.get(operationId);
    const fresh = !entry;
    if (!entry) {
      entry = { state: emptyState, listeners: new Set() };
      observations.set(operationId, entry);
    }
    entry.listeners.add(notify);
    const current = entry;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      if (current.timer) clearTimeout(current.timer);
      try {
        const next = await apiClient.getConnectedWebOperation(operationId);
        if (observations.get(operationId) !== current || next.operationId !== operationId) return;
        publishConnectedWebOperation(next);
        if (current.state.value?.lifecycle === "terminal") return;
      } catch (error) {
        if (observations.get(operationId) !== current) return;
        if (current.state.value?.lifecycle === "terminal") return;
        current.state = { value: current.state.value, status: "unavailable" };
        for (const listener of current.listeners) listener();
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return;
      } finally {
        inFlight = false;
      }
      if (observations.get(operationId) === current) current.timer = setTimeout(() => void poll(), OPERATION_POLL_INTERVAL_MS);
    };
    if (fresh) { current.retry = () => void poll(); void poll(); }
    return () => {
      current.listeners.delete(notify);
      // The transcript replaces old cards while streaming a later tool call.
      // Let that commit re-subscribe before discarding its owner observation:
      // otherwise every streamed chunk resets activity and disables controls
      // until another HTTP response arrives. A real unmount still releases it
      // at the end of this microtask, without a retention timer or global cache.
      queueMicrotask(() => {
        if (current.listeners.size === 0 && observations.get(operationId) === current) {
          if (current.timer) clearTimeout(current.timer);
          observations.delete(operationId);
        }
      });
    };
  }, [operationId]);
  const snapshot = useCallback(() => operationId ? observations.get(operationId)?.state ?? emptyState : emptyState, [operationId]);
  const state = useSyncExternalStore(subscribe, snapshot, () => emptyState);
  const retry = useCallback(() => { if (operationId) observations.get(operationId)?.retry?.(); }, [operationId]);
  return { ...state, retry };
}
