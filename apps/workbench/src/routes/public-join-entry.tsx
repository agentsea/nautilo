import { Navigate, useLocation } from "react-router-dom";
import { PreAuthShell } from "../components/pre-auth-shell";
import { useAuth } from "../hooks/use-auth";

const INVITE_TOKEN = /^inv_[A-Za-z0-9_-]{32}$/u;

/** Resolve the stable public entry only after Workbench has hydrated auth. */
export function PublicJoinEntry() {
  const auth = useAuth();
  const location = useLocation();
  if (auth.session.state === "unknown" || auth.session.state === "signing-in") {
    return (
      <PreAuthShell title="Opening Community" scrim="page">
        <p className="text-sm text-foreground-muted">Checking your sign-in…</p>
      </PreAuthShell>
    );
  }
  if (auth.session.state === "signed-in") return <Navigate to="/" replace />;

  const token = new URLSearchParams(location.search).get("invite");
  if (token && INVITE_TOKEN.test(token)) {
    return <Navigate to={`/redeem/${encodeURIComponent(token)}`} replace />;
  }
  return (
    <PreAuthShell title="Invitation unavailable" scrim="page">
      <p className="text-sm text-foreground-muted">
        Ask the server owner for a current invitation.
      </p>
    </PreAuthShell>
  );
}
