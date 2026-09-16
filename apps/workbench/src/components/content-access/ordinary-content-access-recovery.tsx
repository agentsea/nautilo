import { useCallback, useEffect, useRef, useState } from "react";

import { apiClient } from "../../lib/api";

type RecoveryCoordinate = Awaited<
  ReturnType<typeof apiClient.discoverAllOrdinaryContentAccessRecoveries>
>[number];

export interface OrdinaryContentAccessRecoveryClient {
  discoverAllOrdinaryContentAccessRecoveries(
    options: { roomId: string; signal?: AbortSignal },
  ): Promise<RecoveryCoordinate[]>;
  recoverOrdinaryContentAccess(
    coordinate: RecoveryCoordinate,
    options: { roomId: string; signal?: AbortSignal },
  ): Promise<{ outcome: "completed" | "busy" | "unavailable" | "retry_required" }>;
}

interface RecoverySnapshot {
  readonly scopeKey: string;
  readonly recoveries: readonly RecoveryCoordinate[];
}

function coordinateKey(coordinate: RecoveryCoordinate): string {
  return [
    coordinate.originalJobId,
    coordinate.checkpointId,
    coordinate.turnId,
    coordinate.toolCallId,
    coordinate.agentId,
  ].join("\0");
}

/**
 * Room-scoped recovery for an ordinary sharing result whose terminal state was
 * not visible to the foreground client. Coordinates remain opaque: this
 * component never reconstructs or resends the original command or chat input.
 */
export function OrdinaryContentAccessRecoveryNotice({
  roomId,
  scopeKey,
  discoveryGeneration,
  foregroundRunning,
  client = apiClient,
}: Readonly<{
  roomId: string;
  scopeKey: string;
  discoveryGeneration: number;
  foregroundRunning: boolean;
  client?: OrdinaryContentAccessRecoveryClient;
}>) {
  const [snapshot, setSnapshot] = useState<RecoverySnapshot>({
    scopeKey,
    recoveries: [],
  });
  const [rediscoveryGeneration, setRediscoveryGeneration] = useState(0);
  const [submittingKey, setSubmittingKey] = useState<string | null>(null);
  const discoveryRequestGenerationRef = useRef(0);
  const scopeGenerationRef = useRef(0);
  const recoveryControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setSubmittingKey(null);
    return () => {
      recoveryControllerRef.current?.abort();
      recoveryControllerRef.current = null;
      scopeGenerationRef.current += 1;
    };
  }, [roomId, scopeKey]);

  useEffect(() => {
    const controller = new AbortController();
    const requestGeneration = ++discoveryRequestGenerationRef.current;
    void client.discoverAllOrdinaryContentAccessRecoveries({
      roomId,
      signal: controller.signal,
    }).then((recoveries) => {
      if (controller.signal.aborted || requestGeneration !== discoveryRequestGenerationRef.current) return;
      setSnapshot({ scopeKey, recoveries });
    }).catch(() => {
      // A failed read is not evidence that an earlier recovery was superseded.
      // Keep an already admitted same-scope notice and wait for a lifecycle hint.
    });
    return () => {
      controller.abort();
      discoveryRequestGenerationRef.current += 1;
    };
  }, [client, discoveryGeneration, rediscoveryGeneration, roomId, scopeKey]);

  const recoveries = snapshot.scopeKey === scopeKey ? snapshot.recoveries : [];

  const checkAndContinue = useCallback((coordinate: RecoveryCoordinate) => {
    if (submittingKey !== null || foregroundRunning) return;
    const expectedKey = coordinateKey(coordinate);
    const controller = new AbortController();
    recoveryControllerRef.current = controller;
    const scopeGeneration = scopeGenerationRef.current;
    setSubmittingKey(expectedKey);
    void client.recoverOrdinaryContentAccess(coordinate, {
      roomId,
      signal: controller.signal,
    }).then((result) => {
      if (scopeGeneration !== scopeGenerationRef.current) return;
      if (recoveryControllerRef.current === controller) {
        recoveryControllerRef.current = null;
      }
      setSubmittingKey(null);
      if (result.outcome === "completed" || result.outcome === "unavailable") {
        setRediscoveryGeneration((generation) => generation + 1);
      }
      // retry_required retains the exact coordinate for an explicit retry.
    }).catch(() => {
      if (scopeGeneration !== scopeGenerationRef.current) return;
      if (recoveryControllerRef.current === controller) {
        recoveryControllerRef.current = null;
      }
      setSubmittingKey(null);
      // The POST may have reached the server. Re-read durable discovery truth;
      // a failed refresh still leaves the same admitted coordinate visible.
      setRediscoveryGeneration((generation) => generation + 1);
    });
  }, [client, foregroundRunning, roomId, submittingKey]);

  if (recoveries.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="ordinary-content-access-recovery"
      className="fixed bottom-28 left-1/2 z-50 max-w-md -translate-x-1/2 px-4"
    >
      <div className="flex flex-col gap-1 rounded-xl border border-border/60 bg-background-muted/95 px-3 py-2 text-[11px] text-foreground-muted shadow-sm backdrop-blur-sm">
        {recoveries.map((coordinate) => {
          const key = coordinateKey(coordinate);
          return (
            <div key={key} className="flex items-center gap-2">
              <span>Sharing outcome needs verification</span>
              <button
                type="button"
                onClick={() => checkAndContinue(coordinate)}
                disabled={submittingKey !== null || foregroundRunning}
                className="font-medium text-foreground underline underline-offset-2 hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submittingKey === key ? "Checking…" : "Check and continue"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
