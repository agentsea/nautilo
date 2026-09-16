import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  desktopAPI,
  isDesktop,
  type DesktopRemoteController,
  type DesktopRemotePairingChallenge,
  type DesktopRemoteControlReadiness,
} from "../../../lib/desktop";
import { Button, StatusPill } from "../ui";

function remainingLabel(expiresAt: string, now: number): string {
  const remaining = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
  if (remaining === 0) return "Expired";
  return `Expires in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
}

/** Electron wraps main-process API errors in an IPC Error, so preserve the
 * server's freshness requirement without exposing that implementation detail
 * in the human settings surface. */
function requiresFreshReauthentication(err: unknown): boolean {
  return err instanceof Error && err.message.includes("fresh_reauth_required");
}

const FRESH_AUTH_RECOVERY_COPY =
  "We couldn't confirm your sign-in for mobile controllers. Please try again. If this continues, sign out and sign back in on this desktop.";

class FreshReauthenticationFailed extends Error {}

async function withFreshReauthentication<T>(
  operation: () => Promise<T>,
): Promise<T | null> {
  try {
    return await operation();
  } catch (err) {
    if (!requiresFreshReauthentication(err) || !desktopAPI) throw err;
    const stepUp = await desktopAPI.auth.stepUp({ maxAgeSeconds: 60 });
    if ("error" in stepUp) return null;
    try {
      return await operation();
    } catch {
      throw new FreshReauthenticationFailed();
    }
  }
}

function controllerPairingSnapshot(controllers: DesktopRemoteController[]): string {
  return controllers
    .map((controller) => `${controller.bindingId}:${controller.lastSeenAt ?? ""}`)
    .sort()
    .join("|");
}

/**
 * D458 Wave 7 desktop pairing surface. The private relay token stays in the
 * relay process; this component only receives API-authored ceremony inputs.
 */
export function MobileAccessSection() {
  const bridge = desktopAPI?.remoteControl;
  const [readiness, setReadiness] = useState<DesktopRemoteControlReadiness | null>(null);
  const [controllers, setControllers] = useState<DesktopRemoteController[]>([]);
  const [challenge, setChallenge] = useState<DesktopRemotePairingChallenge | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmingPair, setConfirmingPair] = useState(false);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [pendingRevokeId, setPendingRevokeId] = useState<string | null>(null);
  const challengeControllerSnapshot = useRef("");

  const refresh = useCallback(async () => {
    if (!bridge) return;
    try {
      const [nextReadiness, nextControllers] = await Promise.all([
        bridge.getReadiness(),
        bridge.listControllers(),
      ]);
      setReadiness(nextReadiness);
      setControllers(nextControllers.controllers);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [bridge]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!challenge) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [challenge]);
  useEffect(() => {
    if (!challenge || !bridge) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      if (Date.parse(challenge.expiresAt) <= Date.now()) return;
      void bridge.listControllers().then((next) => {
        if (cancelled) return;
        setControllers(next.controllers);
        if (
          controllerPairingSnapshot(next.controllers) !==
          challengeControllerSnapshot.current
        ) {
          setChallenge(null);
        }
      }).catch(() => {
        // The ordinary Refresh path owns connectivity errors. Pairing status
        // polling is advisory and must not replace a useful challenge with an
        // unrelated transient error.
      });
    }, 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [bridge, challenge]);
  useEffect(() => {
    if (!pendingRevokeId) return;
    const timer = window.setTimeout(() => setPendingRevokeId(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [pendingRevokeId]);

  const expired = Boolean(challenge && Date.parse(challenge.expiresAt) <= now);
  const expiry = useMemo(
    () => (challenge ? remainingLabel(challenge.expiresAt, now) : null),
    [challenge, now],
  );

  async function createChallenge(): Promise<void> {
    if (!bridge) return;
    setBusy("challenge");
    try {
      const next = await withFreshReauthentication(() => bridge.createChallenge());
      if (!next) {
        setError(null);
        return;
      }
      challengeControllerSnapshot.current =
        controllerPairingSnapshot(controllers);
      setChallenge(next);
      setNow(Date.now());
      setError(null);
    } catch (err) {
      setError(
        err instanceof FreshReauthenticationFailed
          ? FRESH_AUTH_RECOVERY_COPY
          : "We couldn't create a pairing code. Check that this desktop is connected, then try again.",
      );
    } finally { setBusy(null); }
  }

  async function setKeepAwakePolicy(policy: DesktopRemoteControlReadiness["keepAwakePolicy"]): Promise<void> {
    if (!bridge) return;
    setBusy("wake");
    try {
      const result = await bridge.setKeepAwakePolicy(policy);
      if (!result.ok) throw new Error("Nautilo could not enable the temporary wake lock.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(null); }
  }

  async function rename(controller: DesktopRemoteController): Promise<void> {
    if (!bridge || !renameValue.trim()) return;
    setBusy(controller.bindingId);
    try {
      const result = await withFreshReauthentication(() =>
        bridge.renameController(controller.bindingId, renameValue.trim()),
      );
      if (!result) {
        setError(null);
        return;
      }
      setRenameId(null);
      await refresh();
    } catch (err) {
      setError(
        err instanceof FreshReauthenticationFailed
          ? FRESH_AUTH_RECOVERY_COPY
          : "We couldn't rename this phone. Please try again.",
      );
    }
    finally { setBusy(null); }
  }

  async function revoke(bindingId: string): Promise<void> {
    if (!bridge) return;
    setBusy(bindingId);
    try {
      const result = await withFreshReauthentication(() =>
        bridge.revokeController(bindingId),
      );
      if (!result) {
        setError(null);
        return;
      }
      setPendingRevokeId(null);
      await refresh();
    } catch (err) {
      setError(
        err instanceof FreshReauthenticationFailed
          ? FRESH_AUTH_RECOVERY_COPY
          : "We couldn't revoke this phone. Please try again.",
      );
    }
    finally { setBusy(null); }
  }

  if (!isDesktop || !bridge) return null;

  return (
    <section
      id="mobile-access"
      aria-labelledby="mobile-access-title"
      data-testid="mobile-controllers-section"
      className="rounded-md border border-border/60 bg-background-element/40"
    >
      <header className="border-b border-border/40 px-4 py-3">
        <h3 id="mobile-access-title" className="text-sm font-medium text-foreground">
          Mobile controllers
        </h3>
        <p className="mt-0.5 text-xs text-foreground-muted">
          Phones paired with your account that can use this Mac&apos;s approved local tools in ordinary chats.
        </p>
      </header>
      <div className="flex flex-col gap-4 p-4">
        {error && <p role="alert" className="mb-3 text-sm text-[var(--error)]">{error}</p>}
        {!readiness ? <p className="text-sm text-foreground-muted">Checking desktop readiness…</p> : (
          <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <StatusPill tone={readiness.relayReady ? "ok" : "muted"}>
              {readiness.relayReady ? "Desktop ready" : `Relay ${readiness.relayStatus}`}
            </StatusPill>
            <Button onClick={() => void refresh()} disabled={busy !== null}>Refresh</Button>
          </div>
          {readiness.macosLidClosedGuidance && (
            <p className="rounded-md border border-border/50 bg-background-muted/30 p-3 text-sm text-foreground-muted">
              {readiness.macosLidClosedGuidance}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            {confirmingPair ? (
              <div className="w-full rounded-md border border-border/60 bg-background-muted/30 p-4" data-testid="mobile-access-pairing-confirmation">
                <h3 className="font-medium">Confirm it’s you</h3>
                <p className="mt-1 text-sm text-foreground-muted">Pairing lets Nautilo Mobile use the local tools this Mac already exposes to your account.</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    variant="ghost"
                    onClick={() => { setConfirmingPair(false); setError(null); }}
                    disabled={busy !== null}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => { setConfirmingPair(false); void createChallenge(); }}
                    disabled={!readiness.relayReady || busy !== null}
                    loading={busy === "challenge"}
                  >
                    Continue
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="primary"
                onClick={() => { setConfirmingPair(true); setError(null); }}
                disabled={!readiness.relayReady || busy !== null}
              >
                Pair a phone
              </Button>
            )}
            <Button
              variant="ghost"
              onClick={() => void setKeepAwakePolicy(readiness.keepAwakePolicy === "off" ? "while_remote_enabled_and_on_external_power" : "off")}
              disabled={!readiness.relayReady || busy !== null}
              loading={busy === "wake"}
            >
              {readiness.keepAwakeEnabled ? "Turn off temporary wake lock" : "Keep this desktop awake while controlling"}
            </Button>
          </div>
          {challenge && (
            <div className="rounded-lg border border-border/60 p-4" data-testid="mobile-access-pairing-challenge">
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-medium">Pair your phone</h3>
                <StatusPill tone={expired ? "muted" : "ok"}>{expiry}</StatusPill>
              </div>
              {expired ? (
                <p className="mt-2 text-sm text-foreground-muted">This one-time pairing code expired. Create a new one to continue.</p>
              ) : (
                <>
                  <p className="mt-2 text-sm text-foreground-muted">Scan this QR code in Nautilo Mobile, or choose manual setup and enter the code below.</p>
                  <QRCodeSVG
                    aria-label="Scan this QR code with Nautilo Mobile"
                    className="mt-3 rounded bg-white p-2"
                    data-testid="mobile-access-qr"
                    includeMargin
                    level="M"
                    size={192}
                    value={challenge.deepLink}
                  />
                  {/* The exact server-authored QR payload remains available as an accessibility/manual fallback. */}
                  <code className="mt-3 block max-h-20 overflow-auto rounded bg-background-muted/50 p-2 text-xs break-all" data-testid="mobile-access-qr-payload">{challenge.deepLink}</code>
                  <p className="mt-3 text-xs font-medium uppercase tracking-wide text-foreground-muted">Manual code</p>
                  <code className="mt-1 block w-fit rounded bg-background-muted/50 px-3 py-2 text-lg tracking-[0.2em]" data-testid="mobile-access-manual-code">{challenge.manualCode}</code>
                </>
              )}
            </div>
          )}
          <div>
            <h3 className="mb-2 font-medium">Paired phones</h3>
            {controllers.length === 0 ? <p className="text-sm text-foreground-muted">No phones paired yet.</p> : (
              <div className="flex flex-col gap-2">
                {controllers.map((controller) => (
                  <div key={controller.bindingId} className="flex flex-wrap items-center justify-between gap-2 rounded border border-border/40 p-3 text-sm">
                    {renameId === controller.bindingId ? (
                      <span className="flex items-center gap-2"><input aria-label="Controller name" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} className="rounded border border-border bg-transparent px-2 py-1" /><Button variant="primary" disabled={busy !== null} onClick={() => void rename(controller)}>Save</Button><Button variant="ghost" onClick={() => setRenameId(null)}>Cancel</Button></span>
                    ) : <span>{controller.label ?? "Unnamed phone"}</span>}
                    <span className="flex items-center gap-2"><span className="text-xs text-foreground-muted">{controller.lastSeenAt ? `Last seen ${new Date(controller.lastSeenAt).toLocaleString()}` : "Not connected yet"}</span><Button variant="ghost" disabled={busy !== null} onClick={() => { setRenameId(controller.bindingId); setRenameValue(controller.label ?? ""); }}>Rename</Button>{pendingRevokeId === controller.bindingId ? <><span className="text-xs text-foreground-muted">Are you sure?</span><Button variant="primary" disabled={busy !== null} loading={busy === controller.bindingId} onClick={() => void revoke(controller.bindingId)}>Confirm revoke</Button><Button variant="ghost" disabled={busy !== null} onClick={() => setPendingRevokeId(null)}>Cancel</Button></> : <Button disabled={busy !== null} onClick={() => setPendingRevokeId(controller.bindingId)}>Revoke</Button>}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          </div>
        )}
      </div>
    </section>
  );
}
