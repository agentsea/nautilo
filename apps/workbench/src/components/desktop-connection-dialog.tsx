import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient } from "../lib/api";
import { DesktopConnectionGuide } from "./desktop-connection-guide";
import { createWorkbenchPortal as createPortal } from "./workbench-portals";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; serverUrl: string }
  | { status: "error" };

export function DesktopConnectionDialog({
  onClose,
  returnFocusTo,
}: {
  onClose: () => void;
  returnFocusTo: HTMLElement | null;
}) {
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const requestIdRef = useRef(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const loadServerUrl = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoadState({ status: "loading" });
    try {
      const status = await apiClient.getSetupStatus();
      if (requestId === requestIdRef.current) {
        setLoadState({ status: "ready", serverUrl: status.serverUrl });
      }
    } catch {
      if (requestId === requestIdRef.current) {
        setLoadState({ status: "error" });
      }
    }
  }, []);

  useEffect(() => {
    void loadServerUrl();
    return () => {
      requestIdRef.current += 1;
    };
  }, [loadServerUrl]);

  useEffect(() => {
    previousFocusRef.current =
      returnFocusTo ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    closeRef.current?.focus();
    return () => {
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [returnFocusTo]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => !element.closest("[hidden], [inert]"));
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="desktop-connection-dialog-title"
    >
      <div
        ref={dialogRef}
        className="w-full max-w-lg rounded-lg border border-border-strong bg-background-panel p-6 shadow-xl"
      >
        <div className="flex items-center justify-between gap-4">
          <h2
            id="desktop-connection-dialog-title"
            className="text-lg font-semibold text-primary"
          >
            Connect Desktop
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="rounded p-1 text-foreground-muted hover:text-foreground"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        {loadState.status === "loading" ? (
          <p className="mt-4 text-sm text-foreground-muted" role="status">
            Loading server address…
          </p>
        ) : loadState.status === "error" ? (
          <div className="mt-4">
            <p className="text-sm text-foreground-muted" role="alert">
              The server address is temporarily unavailable.
            </p>
            <button
              type="button"
              className="mt-3 rounded-md border border-border-strong px-3 py-2 text-sm text-primary hover:bg-background-muted"
              onClick={() => void loadServerUrl()}
            >
              Retry
            </button>
          </div>
        ) : (
          <DesktopConnectionGuide
            serverUrl={loadState.serverUrl}
            urlTestId="desktop-connection-url"
          />
        )}
      </div>
    </div>,
    document.body,
  );
}
