import { useCallback, useEffect, useRef, useState } from "react";
import { ShieldAlert } from "lucide-react";
import {
  desktopAPI,
  type DesktopBrowserResearchIntervention,
} from "../lib/desktop";

export interface BrowserResearchSurfaceProps {
  intervention: DesktopBrowserResearchIntervention;
  onClose: () => void;
}

/**
 * In-app chrome for the exact anonymous research WebContentsView owned by main.
 * The page itself is a native child view positioned over `pageHost`; no second
 * navigation, persistent Browser profile, external window, or credential
 * preload is involved.
 */
export function BrowserResearchSurface({
  intervention,
  onClose,
}: BrowserResearchSurfaceProps) {
  const pageHost = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const attach = useCallback(() => {
    const element = pageHost.current;
    const api = desktopAPI?.browserResearch;
    if (!element || !api) return;
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    void api
      .attachSurface(intervention.id, {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      })
      .then((attached) => {
        if (!attached)
          setError("This temporary research session is no longer available.");
      });
  }, [intervention.id]);

  useEffect(() => {
    const element = pageHost.current;
    const api = desktopAPI?.browserResearch;
    if (!element || !api) {
      setError("The in-app research Browser is unavailable.");
      return;
    }
    attach();
    const observer = new ResizeObserver(attach);
    observer.observe(element);
    window.addEventListener("resize", attach);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", attach);
      void api.detachSurface(intervention.id);
    };
  }, [attach, intervention.id]);

  useEffect(() => {
    const subscribe = desktopAPI?.browserResearch?.onVerificationCleared;
    if (!subscribe) return;
    return subscribe(({ id }) => {
      if (id === intervention.id) {
        setError(null);
        setWorking(true);
      }
    });
  }, [intervention.id]);

  const decide = (decision: "alternate" | "cancel"): void => {
    const api = desktopAPI?.browserResearch;
    if (!api || working) return;
    setWorking(true);
    setError(null);
    void api[decision](intervention.id).then((result) => {
      if (!result.ok) {
        setWorking(false);
        setError(
          "This temporary research session expired or is no longer available.",
        );
        return;
      }
      onClose();
    });
  };

  const pause = (): void => {
    void desktopAPI?.browserResearch?.detachSurface(intervention.id);
    onClose();
  };

  return (
    <section
      className="grid h-full min-h-0 min-w-0 grid-rows-[48px_40px_1fr] overflow-hidden bg-background"
      data-testid="browser-research-surface"
    >
      <header className="flex items-center justify-between border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-2">
          <ShieldAlert
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-[var(--warning,#b58900)]"
          />
          <span className="truncate text-sm font-medium">
            Temporary research Browser
          </span>
          <span className="truncate text-xs text-foreground-muted">
            {intervention.host}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-foreground-muted">
            Genie continues automatically when verification clears.
          </span>
          <button
            type="button"
            className="rounded border border-border px-2 py-1 text-xs text-foreground-muted"
            disabled={working}
            onClick={pause}
          >
            Close
          </button>
        </div>
      </header>
      <div className="flex items-center justify-between gap-3 border-b border-border bg-background-panel px-4 text-xs">
        <span className="text-foreground-muted">
          Anonymous one-time session. Do not enter passwords or private account
          information.
        </span>
        <span className="flex shrink-0 gap-2">
          <button
            type="button"
            className="text-foreground hover:underline disabled:opacity-50"
            disabled={working}
            onClick={() => decide("alternate")}
          >
            Try another source
          </button>
          <button
            type="button"
            className="text-foreground-muted hover:underline disabled:opacity-50"
            disabled={working}
            onClick={() => decide("cancel")}
          >
            Stop research
          </button>
        </span>
      </div>
      <div ref={pageHost} className="relative min-h-0 min-w-0 bg-white">
        {working ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background px-6 text-center">
            <p className="text-sm text-foreground-muted">
              Verification complete — Genie is checking the page…
            </p>
          </div>
        ) : null}
        {error ? (
          <p
            role="alert"
            className="absolute inset-x-4 top-4 rounded border border-tool-error bg-background p-3 text-sm text-tool-error"
          >
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
