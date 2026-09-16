import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiClient } from "../../lib/api";
import {
  createBrowserContentAccessPendingOperations,
  type BrowserContentAccessPendingOperations,
  type PendingContentAccessOperation,
} from "../../lib/content-access-pending-operations";

interface PendingRecoveryClient {
  commitContentAccess(
    command: PendingContentAccessOperation["command"],
    previewToken: string,
    options: { roomId: string; signal?: AbortSignal },
  ): Promise<unknown>;
}

interface SettledPartialReceipt {
  operationId: string;
  originalStateChanged: boolean;
  relatedChangedCount: number;
  skippedCount: number;
}

function settledPartialReceipt(value: unknown, expectedOperationId: string): SettledPartialReceipt | null {
  if (!value || typeof value !== "object") return null;
  const receipt = value as Record<string, unknown>;
  if (receipt.outcome !== "partial"
    || receipt.operationId !== expectedOperationId
    || typeof receipt.originalStateChanged !== "boolean"
    || !Number.isSafeInteger(receipt.attachedCount)
    || !Number.isSafeInteger(receipt.detachedCount)
    || !Number.isSafeInteger(receipt.skippedCount)
    || (receipt.attachedCount as number) < 0
    || (receipt.detachedCount as number) < 0
    || (receipt.skippedCount as number) < 0) return null;
  return {
    operationId: receipt.operationId,
    originalStateChanged: receipt.originalStateChanged,
    relatedChangedCount: (receipt.attachedCount as number) + (receipt.detachedCount as number),
    skippedCount: receipt.skippedCount as number,
  };
}

function recovery(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const value = (error as { recovery?: unknown }).recovery;
  return typeof value === "string" ? value : null;
}

/** Room-level reachability for an exact submitted operation after its object disappears. */
export function PendingContentAccessRecoveryNotice({
  serverOrigin,
  userId,
  roomId,
  authGeneration,
  client = apiClient,
  pendingStore,
}: Readonly<{
  serverOrigin: string;
  userId: string;
  roomId: string;
  authGeneration: number;
  client?: PendingRecoveryClient;
  pendingStore?: BrowserContentAccessPendingOperations;
}>) {
  const store = useMemo(() => pendingStore ?? createBrowserContentAccessPendingOperations({
    serverOrigin,
    userId,
    roomId,
  }), [pendingStore, roomId, serverOrigin, userId]);
  const scopeKey = `${serverOrigin}\0${userId}\0${roomId}\0${authGeneration}`;
  const [snapshot, setSnapshot] = useState<Readonly<{
    scopeKey: string;
    operations: readonly PendingContentAccessOperation[];
    activelyDispatching: boolean;
    error: string | null;
    settledPartials: readonly SettledPartialReceipt[];
  }>>({ scopeKey, operations: [], activelyDispatching: false, error: null, settledPartials: [] });
  const [busyOperationId, setBusyOperationId] = useState<string | null>(null);
  const scopeGenerationRef = useRef(0);
  const requestAbortRef = useRef<AbortController | null>(null);

  useEffect(() => () => {
    scopeGenerationRef.current += 1;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
  }, [authGeneration, roomId, serverOrigin, userId]);

  const refresh = useCallback(() => {
    try {
      const operations = store.list();
      setSnapshot((current) => ({
        scopeKey,
        operations,
        activelyDispatching: operations.some((operation) => store.isActivelyDispatching(operation)),
        error: null,
        settledPartials: current.scopeKey === scopeKey ? current.settledPartials : [],
      }));
    } catch (caught) {
      setSnapshot({
        scopeKey,
        operations: [],
        activelyDispatching: false,
        error: caught instanceof Error
          ? caught.message
          : "Saved access recovery details could not be verified.",
        settledPartials: [],
      });
    }
  }, [scopeKey, store]);

  useEffect(() => {
    refresh();
    return store.subscribe(refresh);
  }, [authGeneration, refresh, store]);

  const checkPreviousChange = useCallback((operation: PendingContentAccessOperation) => {
    if (snapshot.scopeKey !== scopeKey || snapshot.activelyDispatching) return;
    if (busyOperationId !== null
      || !snapshot.operations.some((candidate) => candidate.command.operationId === operation.command.operationId
        && candidate.previewToken === operation.previewToken)) return;
    const controller = new AbortController();
    const scopeGeneration = scopeGenerationRef.current;
    requestAbortRef.current = controller;
    setBusyOperationId(operation.command.operationId);
    setSnapshot((current) => current.scopeKey === scopeKey
      ? { ...current, error: null }
      : current);
    void store.execute(
      operation,
      () => client.commitContentAccess(operation.command, operation.previewToken, {
        roomId,
        signal: controller.signal,
      }),
      (caught) => recovery(caught) === "prepare_again",
    ).then((result) => {
      if (scopeGeneration !== scopeGenerationRef.current) return;
      refresh();
      const partial = settledPartialReceipt(result, operation.command.operationId);
      if (partial) {
        setSnapshot((current) => current.scopeKey === scopeKey ? {
          ...current,
          settledPartials: [
            ...current.settledPartials.filter((item) => item.operationId !== partial.operationId),
            partial,
          ],
        } : current);
      }
    }).catch((caught: unknown) => {
      if (scopeGeneration !== scopeGenerationRef.current) return;
      refresh();
      if (recovery(caught) !== "prepare_again") {
        setSnapshot((current) => current.scopeKey === scopeKey ? {
          ...current,
          error: caught instanceof Error
            ? caught.message
            : "The previous access change could not be verified. Try checking the same change again.",
        } : current);
      }
    }).finally(() => {
      if (scopeGeneration !== scopeGenerationRef.current) return;
      if (requestAbortRef.current === controller) requestAbortRef.current = null;
      setBusyOperationId(null);
    });
  }, [busyOperationId, client, refresh, roomId, scopeKey, snapshot, store]);

  const current = snapshot.scopeKey === scopeKey
    ? snapshot
    : { scopeKey, operations: [], activelyDispatching: false, error: null, settledPartials: [] };

  if (current.operations.length === 0 && current.error === null && current.settledPartials.length === 0) return null;

  return (
    <div role={current.error ? "alert" : "status"} aria-live="polite"
      data-testid="pending-content-access-recovery"
      className="fixed bottom-36 left-1/2 z-50 max-w-md -translate-x-1/2 px-4">
      <div className="flex items-center gap-2 rounded-full border border-border/60 bg-background-muted/95 px-3 py-1.5 text-[11px] text-foreground-muted shadow-sm backdrop-blur-sm">
        <div>{current.activelyDispatching
          ? "An access change is being applied."
          : current.error ?? (current.operations.length > 0
            ? current.operations.length > 1
              ? `Previous access changes need verification (${current.operations.length}). Retrying checks each original result and finishes only that same approved change if needed.`
              : "A previous access change needs verification. Retrying checks the original result and finishes the same approved change if needed."
            : null)}
          {current.settledPartials.map((partial) => <div key={partial.operationId}>
            The previous access change finished partially. The original item {partial.originalStateChanged ? "was updated" : "was not updated"}. {partial.relatedChangedCount} related access {partial.relatedChangedCount === 1 ? "link was" : "links were"} changed. The receipt reports {partial.skippedCount} skipped related {partial.skippedCount === 1 ? "item" : "items"}; some access remains.
          </div>)}
        </div>
        {current.operations.length > 0 && !current.activelyDispatching ? <div className="flex gap-2">
          {current.operations.map((operation, index) => <button key={operation.command.operationId}
            type="button" disabled={busyOperationId !== null}
            onClick={() => checkPreviousChange(operation)}
            aria-label={current.operations.length > 1 ? `Retry previous change ${index + 1}` : "Retry previous change"}
            className="font-medium text-foreground underline underline-offset-2 hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50">
            {busyOperationId === operation.command.operationId ? "Retrying…" : current.operations.length > 1 ? `Retry change ${index + 1}` : "Retry previous change"}
          </button>)}
        </div> : null}
      </div>
    </div>
  );
}
