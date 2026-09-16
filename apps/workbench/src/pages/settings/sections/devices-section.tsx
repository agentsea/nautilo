import { useCallback, useEffect, useState } from "react";
import type {
  RelayDeviceListResponse,
  RelayGroupedDevice,
} from "@nautilo/api-client/browser";
import { apiClient } from "../../../lib/api";
import { Button, StatusPill } from "../ui";
import { ResearchAvailability } from "./research-availability";

type PendingAction =
  | { kind: "revoke"; device: RelayGroupedDevice }
  | { kind: "cleanup"; expectedPairingCount: number };

function statusOf(error: unknown): number | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return error.status;
  }
  return null;
}

function loadErrorMessage(error: unknown): string {
  const status = statusOf(error);
  if (status === 404 || status === 405) {
    return "This server does not support truthful physical-device management yet. Update the server before managing paired devices here.";
  }
  if (status === 403) {
    return "Your session no longer allows access to your work-computer fleet. Sign in again and try once more.";
  }
  return "The current paired-device state could not be loaded. Check your connection and try again.";
}

function mutationErrorMessage(error: unknown): string {
  if (statusOf(error) === 409) {
    return "Pairings changed before this action completed. The latest server state has been requested; review it before trying again.";
  }
  return "The action did not complete. The latest server state has been requested; try again after reviewing it.";
}

function formatLatestActivity(lastSeenAt: string | null): string {
  if (!lastSeenAt) return "No connection reported";
  const timestamp = new Date(lastSeenAt);
  if (Number.isNaN(timestamp.getTime())) return "Connection time unavailable";
  return `Last seen ${timestamp.toLocaleString()}`;
}

function boundedValues(values: string[], maximum: number): {
  visible: string[];
  hiddenCount: number;
} {
  const unique = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  return { visible: unique.slice(0, maximum), hiddenCount: Math.max(0, unique.length - maximum) };
}

function PairingCount({ count }: { count: number }) {
  return (
    <StatusPill tone="muted">
      {count} {count === 1 ? "pairing" : "pairings"}
    </StatusPill>
  );
}

/** Truthful, self-scoped work-computer fleet management (D480, M307). */
export function WorkComputersSection() {
  const [response, setResponse] = useState<RelayDeviceListResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<boolean> => {
    setLoading(true);
    try {
      const next = await apiClient.listGroupedRelayDevices();
      setResponse(next);
      setLoadError(null);
      return true;
    } catch (error) {
      // A failed refresh must not leave an old projection looking authoritative.
      setResponse(null);
      setLoadError(loadErrorMessage(error));
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function commitPendingAction(): Promise<void> {
    if (!pendingAction || busy) return;
    const action = pendingAction;
    setBusy(true);
    setMutationError(null);
    setNotice(null);

    try {
      const result = action.kind === "revoke"
        ? await apiClient.revokeGroupedRelayDevice(
          action.device.deviceManagementId,
          action.device.pairingCount,
        )
        : await apiClient.cleanupHistoricalRelayPairings(action.expectedPairingCount);
      const reconciled = await load();
      if (reconciled) {
        const subject = action.kind === "revoke" ? action.device.label : "Historical pairings";
        const count = result.affectedPairingCount;
        setNotice(`${subject}: ${count} ${count === 1 ? "pairing was" : "pairings were"} revoked.`);
      }
    } catch (error) {
      setMutationError(mutationErrorMessage(error));
      // A 409 or other lifecycle failure can still mean the screen is stale.
      await load();
    } finally {
      setPendingAction(null);
      setBusy(false);
    }
  }

  const devices = response?.devices ?? [];
  const historical = response?.historical;
  const isEmpty = response !== null && devices.length === 0 && historical?.pairingCount === 0;

  return (
    <section
      id="work-computers"
      aria-labelledby="work-computers-title"
      data-testid="work-computers-section"
      className="rounded-md border border-border/60 bg-background-element/40"
    >
      <header className="border-b border-border/40 px-4 py-3">
        <h3 id="work-computers-title" className="text-sm font-medium text-foreground">
          Work computers
        </h3>
        <p className="mt-0.5 text-xs text-foreground-muted">
          Computers paired with your account that can run filesystem and shell tools on your behalf. Revoke a computer to revoke all of its current pairings.
        </p>
      </header>
      <div className="p-4">
      {loading ? (
        <p className="text-sm text-foreground-muted">Loading paired-device state…</p>
      ) : loadError ? (
        <div className="space-y-3">
          <p className="text-sm text-[var(--error)]" role="alert">{loadError}</p>
          <Button onClick={() => void load()}>Try again</Button>
        </div>
      ) : isEmpty ? (
        <p className="text-sm text-foreground-muted">
          No devices paired yet. Sign into the Nautilo desktop app and it&apos;ll
          pair automatically on first launch.
        </p>
      ) : (
        <div className="space-y-4">
          {notice ? <p className="text-sm text-foreground-muted" role="status">{notice}</p> : null}
          {mutationError ? <p className="text-sm text-[var(--error)]" role="alert">{mutationError}</p> : null}

          {devices.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-wider text-foreground-muted">
                  <tr>
                    <th className="py-2 pr-3 text-left font-medium">Device</th>
                    <th className="py-2 pr-3 text-left font-medium">Profiles</th>
                    <th className="py-2 pr-3 text-left font-medium">Pairings</th>
                    <th className="py-2 pr-3 text-left font-medium">Latest activity</th>
                    <th className="py-2 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {devices.map((device) => {
                    const profiles = boundedValues(device.profiles, 3);
                    const capabilities = boundedValues(device.capabilities, 2);
                    const isPending = pendingAction?.kind === "revoke" &&
                      pendingAction.device.deviceManagementId === device.deviceManagementId;
                    return (
                      <tr key={device.deviceManagementId} className="border-t border-border/40 align-middle">
                        <td className="py-2 pr-3 text-foreground">{device.label}</td>
                        <td className="py-2 pr-3">
                          <div className="flex flex-wrap gap-1">
                            {profiles.visible.length > 0 ? profiles.visible.map((profile) => (
                              <StatusPill key={profile} tone="muted">{profile}</StatusPill>
                            )) : <span className="text-foreground-muted">No profile reported</span>}
                            {profiles.hiddenCount > 0 ? (
                              <StatusPill tone="muted">+{profiles.hiddenCount} more</StatusPill>
                            ) : null}
                            {capabilities.visible.map((capability) => (
                              <StatusPill key={capability} tone="muted">{capability}</StatusPill>
                            ))}
                            {capabilities.hiddenCount > 0 ? (
                              <StatusPill tone="muted">+{capabilities.hiddenCount} capabilities</StatusPill>
                            ) : null}
                          </div>
                        </td>
                        <td className="py-2 pr-3"><PairingCount count={device.pairingCount} /></td>
                        <td className="py-2 pr-3 text-foreground-muted">
                          {formatLatestActivity(device.lastSeenAt)}
                        </td>
                        <td className="py-2 text-right">
                          {isPending ? (
                            <span className="inline-flex flex-wrap items-center justify-end gap-2">
                              <span className="max-w-xs text-left text-xs text-foreground-muted">
                                Revoke {device.label}? This revokes exactly {device.pairingCount} {device.pairingCount === 1 ? "pairing" : "pairings"} currently associated with this device.
                              </span>
                              <Button variant="primary" onClick={() => void commitPendingAction()} disabled={busy} loading={busy}>
                                Confirm revoke
                              </Button>
                              <Button variant="ghost" onClick={() => setPendingAction(null)} disabled={busy}>
                                Cancel
                              </Button>
                            </span>
                          ) : (
                            <Button
                              onClick={() => setPendingAction({ kind: "revoke", device })}
                              disabled={busy}
                              ariaLabel={`Revoke ${device.label}`}
                            >
                              Revoke
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-foreground-muted">No current grouped devices are paired.</p>
          )}

          {historical && historical.pairingCount > 0 ? (
            <details className="rounded-md border border-border/60 bg-background-element p-3">
              <summary className="cursor-pointer text-sm font-medium text-foreground">
                Historical pairings ({historical.pairingCount})
              </summary>
              <div className="mt-3 space-y-3 text-sm text-foreground-muted">
                <p>
                  These older pairings cannot be safely identified as current physical devices. They are not shown as device rows or merged automatically.
                </p>
                {pendingAction?.kind === "cleanup" ? (
                  <div className="space-y-2">
                    <p>
                      Remove exactly {pendingAction.expectedPairingCount} eligible historical {pendingAction.expectedPairingCount === 1 ? "pairing" : "pairings"}? Older clients still using one will need to pair again.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="primary" onClick={() => void commitPendingAction()} disabled={busy} loading={busy}>
                        Confirm cleanup
                      </Button>
                      <Button variant="ghost" onClick={() => setPendingAction(null)} disabled={busy}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    onClick={() => setPendingAction({ kind: "cleanup", expectedPairingCount: historical.pairingCount })}
                    disabled={busy}
                  >
                    Clean up historical pairings
                  </Button>
                )}
              </div>
            </details>
          ) : null}
        </div>
      )}
      <ResearchAvailability />
      </div>
    </section>
  );
}
