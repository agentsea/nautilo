/**
 * Workbench toast primitive (D057 2a.10 / D059 Phase 3.5).
 *
 * Singleton currentToast, auto-dismiss with per-variant defaults, and a new
 * show() replacing the current toast. Rendered
 * via ReactDOM.createPortal onto document.body and styled with the
 * workbench's CSS custom properties so it tracks theme automatically.
 *
 * Additional behavior:
 *   - optional `action: { label, onClick }` renders an inline button
 *     (we use it for the prolonged-disconnect toast's "Reload").
 *   - `duration: 0` disables auto-dismiss (toast stays until dismiss()
 *     is called or another show() replaces it).
 *
 * Why no animation library: the toast has a ~200ms fade in/out that
 * is trivial with CSS transitions; pulling in framer-motion for one
 * overlay would be silly.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import { createWorkbenchPortal as createPortal } from "./workbench-portals";
import { createPortal as createRecoveryPortal } from "react-dom";
import { ConnectionRecoveryPortalContext } from "./footer/connection-recovery-portal";

export type ToastVariant = "error" | "warning" | "success" | "info";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  /** Only non-sensitive connection recovery may remain interactive while
   * admission pauses the workspace. Ordinary product toasts stay gated. */
  recovery?: "connection";
  title?: string;
  message: string;
  variant: ToastVariant;
  /**
   * Auto-dismiss after N ms. Defaults per variant. Pass 0 to disable
   * auto-dismiss (toast stays until dismiss() or replaced by show()).
   */
  duration?: number;
  /**
   * Optional action button (e.g. "Reload"). Rendered inline at the end
   * of the toast body.
   */
  action?: ToastAction;
}

export interface ToastContextValue {
  show: (options: ToastOptions) => void;
  error: (err: unknown) => void;
  dismiss: () => void;
}

// Canonical Workbench per-variant defaults.
const DEFAULT_DURATIONS: Record<ToastVariant, number> = {
  error: 8_000,
  warning: 6_000,
  success: 3_000,
  info: 4_000,
};

const ToastContext = createContext<ToastContextValue | null>(null);
const ToastStateContext = createContext<ToastOptions | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a <ToastProvider>");
  }
  return ctx;
}

export function ToastProvider({ children }: PropsWithChildren) {
  const [current, setCurrent] = useState<ToastOptions | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const dismiss = useCallback(() => {
    clearTimer();
    setCurrent(null);
  }, [clearTimer]);

  const show = useCallback((options: ToastOptions) => {
    clearTimer();
    setCurrent(options);
    const duration = options.duration ?? DEFAULT_DURATIONS[options.variant];
    // duration === 0 → manual dismiss only. Any positive value schedules
    // auto-dismiss; any negative value is treated as 0 (ignored).
    if (duration > 0) {
      timerRef.current = setTimeout(() => {
        setCurrent(null);
        timerRef.current = null;
      }, duration);
    }
  }, [clearTimer]);

  const error = useCallback((err: unknown) => {
    const message =
      err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : "An unknown error has occurred";
    show({ variant: "error", message });
  }, [show]);

  // Clear timers on unmount so dev-mode hot-reload doesn't leak them.
  useEffect(() => () => clearTimer(), [clearTimer]);

  const value = useMemo<ToastContextValue>(
    () => ({ show, error, dismiss }),
    [show, error, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      <ToastStateContext.Provider value={current}>{children}</ToastStateContext.Provider>
    </ToastContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const VARIANT_BORDER: Record<ToastVariant, string> = {
  error: "var(--error)",
  warning: "var(--warning)",
  success: "var(--success)",
  info: "var(--info, var(--accent, #7aa2f7))",
};

/**
 * Renders the current toast via portal. Mount exactly ONCE inside the
 * app tree so document.body has a stable portal target. Safe to render
 * unconditionally: renders null when no toast is active.
 */
export function Toast() {
  const current = useContext(ToastStateContext);
  const recoveryHost = useContext(ConnectionRecoveryPortalContext);
  const { dismiss } = useToast();
  const [mounted, setMounted] = useState(false);

  // SSR/first-render safety: only create portals client-side.
  useEffect(() => setMounted(true), []);

  if (!mounted || !current) return null;
  if (current.recovery === "connection" && recoveryHost !== null) {
    return createRecoveryPortal(<ToastBody toast={current} dismiss={dismiss} />, recoveryHost);
  }
  return createPortal(<ToastBody toast={current} dismiss={dismiss} />, document.body);
}

function ToastBody({ toast, dismiss }: { toast: ToastOptions; dismiss: () => void }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        top: "calc(env(safe-area-inset-top, 0px) + 16px)",
        right: "16px",
        maxWidth: "min(60ch, calc(100vw - 32px))",
        background: "var(--background-panel, #161c2c)",
        color: "var(--foreground, #d6deeb)",
        borderRadius: "8px",
        padding: "10px 32px 10px 14px",
        borderLeft: `3px solid ${VARIANT_BORDER[toast.variant]}`,
        boxShadow:
          "0 2px 8px rgba(0,0,0,0.25), 0 0 0 1px var(--border, rgba(255,255,255,0.08))",
        fontSize: "13px",
        lineHeight: 1.45,
        zIndex: 10_000,
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        // Fade-in on mount. React mounts the body only when `_current`
        // transitions from null → ToastOptions, so a fresh element gets
        // a fresh transition.
        animation: "nautilo-toast-fade-in 180ms ease-out",
      }}
    >
      {/* Inline keyframe — keeps the toast self-contained without
          polluting global CSS. */}
      <style>
        {`@keyframes nautilo-toast-fade-in {
            from { opacity: 0; transform: translateY(-4px); }
            to   { opacity: 1; transform: translateY(0); }
          }`}
      </style>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        style={{
          position: "absolute",
          top: "6px",
          right: "6px",
          background: "transparent",
          border: "1px solid var(--border, rgba(255,255,255,0.15))",
          color: "var(--foreground-muted, #8892b0)",
          borderRadius: "4px",
          padding: "0 5px",
          fontSize: "16px",
          lineHeight: 1,
          cursor: "pointer",
          minWidth: "22px",
          minHeight: "22px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        ×
      </button>
      {toast.title && (
        <div style={{ fontWeight: 600, fontSize: "13px" }}>{toast.title}</div>
      )}
      <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{toast.message}</div>
      {toast.action && (
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "8px",
            marginTop: "4px",
          }}
        >
          <button
            type="button"
            onClick={toast.action.onClick}
            style={{
              background: "transparent",
              border: `1px solid ${VARIANT_BORDER[toast.variant]}`,
              color: "var(--foreground, #d6deeb)",
              borderRadius: "4px",
              padding: "3px 10px",
              fontSize: "12px",
              cursor: "pointer",
            }}
          >
            {toast.action.label}
          </button>
        </div>
      )}
    </div>
  );
}
