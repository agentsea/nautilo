import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import type { ViewerRole } from "@nautilo/types";
import { useAuth } from "../hooks/use-auth";
import { isDesktop } from "../lib/desktop";
import { endServerGuideSession } from "../lib/server-guide-session";
import { rememberMobileInterfaceChoice } from "../lib/interface-preference";
import { DesktopConnectionDialog } from "./desktop-connection-dialog";

function roleToneClass(role: ViewerRole): string {
  switch (role) {
    case "owner":
    case "admin":
      return "bg-[var(--success)]/20 text-[var(--success)]";
    case "superuser":
      return "bg-primary/20 text-primary";
    case "member":
      return "bg-[var(--warning)]/20 text-[var(--warning)]";
    case "contributor":
      return "bg-primary/10 text-primary";
    case "guest":
    case "stranger":
    case "anonymous":
      return "bg-foreground-muted/20 text-foreground-muted";
  }
}

/**
 * Verified-user account affordance: Settings link + Sign out (Logto).
 */
export function WorkbenchAccountMenu(props: { variant: "header" | "rail" }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [desktopDialogOpen, setDesktopDialogOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const accountButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (rootRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const label = auth.viewer.label;
  const initial = label.trim().charAt(0).toUpperCase() || "·";
  const groups = auth.groups ?? [];

  async function onSignOut() {
    setError(null);
    setBusy(true);
    try {
      await auth.session.signOut();
      endServerGuideSession();
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign out failed");
    } finally {
      setBusy(false);
    }
  }

  function onSettings() {
    setOpen(false);
    setError(null);
    void navigate("/settings");
  }

  function onServerGuide() {
    setOpen(false);
    setError(null);
    void navigate("/help/server");
  }

  function onConnectDesktop() {
    setOpen(false);
    setError(null);
    setDesktopDialogOpen(true);
  }

  // D206 — quick path from the account avatar to the avatar editor.
  // Hash-based deep link (settings-page.tsx supports `#profile`).
  function onEditProfilePicture() {
    setOpen(false);
    setError(null);
    void navigate("/settings#profile");
  }

  const menu = open ? (
    <div
      role="menu"
      className="absolute z-50 min-w-[11rem] rounded-md border border-border bg-background py-1 text-sm shadow-lg"
      style={
        props.variant === "rail"
          ? { left: "calc(100% + 0.5rem)", bottom: 0 }
          : { left: 0, top: "calc(100% + 0.25rem)" }
      }
    >
      {/* D365 — group/role label lives here in the dropdown (not stacked
          under the rail avatar, where it bled past the 48px column). */}
      <div className="border-b border-border px-3 py-2">
        <p className="truncate text-xs font-medium text-foreground">{label}</p>
        {groups.length > 0 ? (
          <p className="truncate text-[11px] text-foreground-muted">
            {groups.map((g) => g.label).join(" · ")}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        role="menuitem"
        className="block w-full px-3 py-2 text-left text-foreground hover:bg-[var(--primary-muted)]"
        onClick={onEditProfilePicture}
      >
        Edit profile picture
      </button>
      {auth.viewer.role === "owner" || auth.viewer.role === "admin" ? (
        <button
          type="button"
          role="menuitem"
          className="block w-full px-3 py-2 text-left text-foreground hover:bg-[var(--primary-muted)]"
          onClick={onServerGuide}
        >
          Server Guide
        </button>
      ) : null}
      <button
        type="button"
        role="menuitem"
        className="block w-full px-3 py-2 text-left text-foreground hover:bg-[var(--primary-muted)]"
        onClick={onConnectDesktop}
      >
        Connect Desktop
      </button>
      <button
        type="button"
        role="menuitem"
        className="block w-full px-3 py-2 text-left text-foreground hover:bg-[var(--primary-muted)]"
        onClick={onSettings}
      >
        Settings
      </button>
      {!isDesktop ? (
        <a
          href="/mobile/"
          role="menuitem"
          className="block w-full px-3 py-2 text-left text-foreground hover:bg-[var(--primary-muted)]"
          onClick={rememberMobileInterfaceChoice}
        >
          Open Mobile
        </a>
      ) : null}
      <button
        type="button"
        role="menuitem"
        disabled={busy}
        className="block w-full px-3 py-2 text-left text-foreground hover:bg-[var(--primary-muted)] disabled:opacity-50"
        onClick={() => void onSignOut()}
      >
        {busy ? "Signing out…" : "Sign out"}
      </button>
      {error ? (
        <p className="border-t border-border px-3 py-2 text-xs text-[var(--error)]">
          {error}
        </p>
      ) : null}
    </div>
  ) : null;

  if (props.variant === "header") {
    // D303 — single-row pill, vertically centered so it lines up with the
    // NAUTILO wordmark. The group/role ("Owners") is NOT stacked under the pill
    // here (it hung below the header baseline and read as misaligned); it stays
    // available in the account dropdown (D365 — rail footer copy removed; it
    // bled past the 48px column).
    return (
      <>
        <div ref={rootRef} className="relative ml-2">
          <button
            ref={accountButtonRef}
            type="button"
            className="inline-flex items-center gap-1 rounded-full bg-[var(--success)]/20 px-2 py-0.5 text-xs font-medium text-[var(--success)] hover:bg-[var(--success)]/30"
            aria-expanded={open}
            aria-haspopup="menu"
            title="Account menu"
            onClick={() => {
              setError(null);
              setOpen((v) => !v);
            }}
          >
            <span>{`✓ ${label}`}</span>
            <ChevronDown className="h-3 w-3 shrink-0 opacity-80" aria-hidden />
          </button>
          {menu}
        </div>
        {desktopDialogOpen ? (
          <DesktopConnectionDialog
            onClose={() => setDesktopDialogOpen(false)}
            returnFocusTo={accountButtonRef.current}
          />
        ) : null}
      </>
    );
  }

  return (
    <>
      <div
        ref={rootRef}
        className="relative flex flex-col items-center justify-center gap-0.5"
      >
        <button
          ref={accountButtonRef}
          type="button"
          title={`Account — ${label}`}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={`Account menu, signed in as ${label}`}
          className={[
            "flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-accent",
            roleToneClass(auth.viewer.role),
          ].join(" ")}
          onClick={() => {
            setError(null);
            setOpen((v) => !v);
          }}
        >
          {initial}
        </button>
        {menu}
      </div>
      {desktopDialogOpen ? (
        <DesktopConnectionDialog
          onClose={() => setDesktopDialogOpen(false)}
          returnFocusTo={accountButtonRef.current}
        />
      ) : null}
    </>
  );
}
