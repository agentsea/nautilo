import { useSyncExternalStore } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  endServerGuideSession,
  isServerGuideSessionActive,
  subscribeToServerGuideSession,
} from "../lib/server-guide-session";

export function ServerGuideCompanion() {
  const location = useLocation();
  const navigate = useNavigate();
  const guideSessionActive = useSyncExternalStore(
    subscribeToServerGuideSession,
    isServerGuideSessionActive,
    () => false,
  );

  if (
    location.pathname === "/help/server"
    || !guideSessionActive
  ) {
    return null;
  }

  return (
    <nav
      aria-label="Server setup navigation"
      className="flex min-w-0 items-center gap-2"
      data-testid="server-guide-companion"
    >
      <span className="hidden shrink-0 text-xs font-medium text-foreground-muted sm:inline">
        Server setup
      </span>
      <button
        type="button"
        className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-[var(--on-primary)] hover:bg-primary-hover"
        onClick={() => void navigate("/help/server")}
      >
        Back to guide
      </button>
      <button
        type="button"
        className="shrink-0 rounded-md border border-border-strong px-3 py-1.5 text-xs text-foreground hover:bg-background-muted"
        onClick={() => {
          endServerGuideSession();
        }}
      >
        Exit setup
      </button>
    </nav>
  );
}
