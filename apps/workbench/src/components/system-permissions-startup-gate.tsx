import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  desktopAPI,
  isDesktop,
  type DesktopSystemPermissionsAPI,
} from "../lib/desktop";
import {
  normalizeSystemPermissionsSnapshot,
  SystemPermissionsSection,
  type LoadedSystemPermissionsSnapshot,
  type PermissionCardConnection,
} from "./system-permissions-section";

type GateMode = "checking" | "open" | "dismissed";

function requiredPermissionsReady(snapshot: LoadedSystemPermissionsSnapshot): boolean {
  return ["accessibility", "screen-recording"].every(
    (id) => snapshot.permissions.find((permission) => permission.id === id)?.state === "granted",
  );
}

/**
 * App-owned macOS permission onboarding. Missing required permissions open one
 * Nautilo dialog over the ordinary workspace. The Human may finish setup now
 * or dismiss it and keep using Nautilo without Computer Use; Settings retains
 * the complete checklist for later recovery.
 */
export function SystemPermissionsStartupGate({
  children,
  permissions = isDesktop ? desktopAPI?.systemPermissions : undefined,
  computerUse = isDesktop ? desktopAPI?.computerUse : undefined,
  isDesktopShell = isDesktop,
}: {
  children: ReactNode;
  permissions?: DesktopSystemPermissionsAPI;
  computerUse?: PermissionCardConnection;
  isDesktopShell?: boolean;
}) {
  const [mode, setMode] = useState<GateMode>(
    isDesktopShell && permissions ? "checking" : "dismissed",
  );
  const [savingPreference, setSavingPreference] = useState(false);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  const [neverShowAutomatically, setNeverShowAutomatically] = useState(false);
  const dismissRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isDesktopShell || !permissions) {
      setMode("dismissed");
      return;
    }
    let cancelled = false;
    let latestSnapshot: LoadedSystemPermissionsSnapshot | null | undefined;
    let preferenceLoaded = permissions.onboardingPreference === undefined;
    let showAutomatically = true;
    const reconcile = () => {
      if (cancelled || !preferenceLoaded || latestSnapshot === undefined) return;
      if (latestSnapshot?.platform === "other") {
        setMode("dismissed");
        return;
      }
      const needsSetup = latestSnapshot === null || !requiredPermissionsReady(latestSnapshot);
      setMode((current) => {
        if (current === "dismissed") return current;
        if (needsSetup && showAutomatically) return "open";
        // Once onboarding is visible, let its own Cua check finish and require
        // an explicit Continue or Not now action instead of flashing closed.
        return current === "open" ? current : "dismissed";
      });
    };
    const applySnapshot = (value: unknown) => {
      if (cancelled) return;
      latestSnapshot = normalizeSystemPermissionsSnapshot(value);
      reconcile();
    };

    const unsubscribe = permissions.onStatusChanged(applySnapshot);
    void permissions.status().then(applySnapshot).catch(() => {
      latestSnapshot = null;
      reconcile();
    });
    if (permissions.onboardingPreference) {
      void permissions.onboardingPreference().then((preference) => {
        if (cancelled) return;
        showAutomatically = preference.version === 1 && preference.showAutomatically;
        setNeverShowAutomatically(!showAutomatically);
        preferenceLoaded = true;
        reconcile();
      }).catch(() => {
        if (cancelled) return;
        // A corrupt or unreadable preference must not permanently hide setup.
        showAutomatically = true;
        preferenceLoaded = true;
        reconcile();
      });
    }
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [isDesktopShell, permissions]);

  useEffect(() => permissions?.onGuidedSetupRequested?.(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setPreferenceError(null);
    setMode("open");
  }), [permissions]);

  const updateAutomaticPreference = async (neverShow: boolean) => {
    if (!permissions?.setOnboardingPreference || savingPreference) return;
    const previous = neverShowAutomatically;
    setNeverShowAutomatically(neverShow);
    setSavingPreference(true);
    setPreferenceError(null);
    try {
      await permissions.setOnboardingPreference(!neverShow);
    } catch {
      setNeverShowAutomatically(previous);
      setPreferenceError("Nautilo could not save that preference. You can still choose Not now.");
    } finally {
      setSavingPreference(false);
    }
  };

  useEffect(() => {
    if (mode !== "open") return;
    dismissRef.current?.focus();
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMode("dismissed");
    };
    window.addEventListener("keydown", dismissOnEscape);
    return () => {
      window.removeEventListener("keydown", dismissOnEscape);
      returnFocusRef.current?.focus();
      returnFocusRef.current = null;
    };
  }, [mode]);

  return <>
    {children}
    {mode === "open" ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4 py-6 backdrop-blur-sm">
      <div className="max-h-full w-full max-w-3xl overflow-y-auto rounded-xl border border-border-strong bg-background-panel p-5 shadow-2xl"
        role="dialog" aria-modal="true" aria-labelledby="system-permissions-startup-title" aria-describedby="system-permissions-startup-description">
        <div className="mb-4 flex items-start justify-between gap-4 px-1">
          <div>
            <p className="text-xs font-semibold tracking-[0.24em] text-primary">NAUTILO</p>
            <h1 id="system-permissions-startup-title" className="mt-2 text-xl font-semibold text-foreground">Prepare this Mac</h1>
            <p id="system-permissions-startup-description" className="mt-1 text-sm text-foreground-muted">Set up the Mac permissions used by Nautilo Desktop. Accessibility and Screen Recording are required for Computer Use; Microphone is optional.</p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <button ref={dismissRef} type="button" onClick={() => setMode("dismissed")}
              className="rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground-muted hover:bg-background-element hover:text-foreground">
              Not now
            </button>
            {permissions?.setOnboardingPreference ? <label className="flex items-center gap-2 text-xs text-foreground-muted">
              <input type="checkbox" checked={neverShowAutomatically} disabled={savingPreference}
                onChange={(event) => void updateAutomaticPreference(event.currentTarget.checked)} />
              Don’t show automatically again
            </label> : null}
          </div>
        </div>
        <SystemPermissionsSection
            permissions={permissions}
            computerUse={computerUse}
            isDesktopShell={isDesktopShell}
            continueLabel="Continue to Nautilo"
            onContinue={() => setMode("dismissed")}
          />
        {preferenceError ? <p className="mt-3 px-1 text-xs text-[var(--error)]" role="alert">{preferenceError}</p> : null}
      </div>
    </div> : null}
  </>;
}
