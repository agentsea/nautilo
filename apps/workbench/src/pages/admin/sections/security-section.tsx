import { useState } from "react";
import { usePosture } from "../../../contexts/posture-context";
import { PostureModal } from "../../../components/security/posture-modal";
import { formatLevel, postureTone } from "../../../components/security/posture-colors";
import { useCan } from "../../../hooks/use-can";

export function SecuritySection() {
  const { posture, loading, error, refresh } = usePosture();
  const can = useCan();
  const canManageSecurity = can("manage_server_security");
  const canManageUncontainedHostCommands = can("manage_uncontained_host_commands");
  const canViewSecurity = canManageSecurity || canManageUncontainedHostCommands;
  const [open, setOpen] = useState(false);

  return (
    <section
      id="security"
      data-testid="admin-security-section"
      className="rounded-lg border border-border bg-background-panel"
      aria-labelledby="security-title"
    >
      <header className="border-b border-border px-5 py-3">
        <h2 id="security-title" className="text-sm font-semibold">
          Security
        </h2>
        <p className="mt-1 text-xs text-foreground-muted">
          Server sandbox posture and security policy.
        </p>
      </header>
      <div className="px-5 py-4">
        {canViewSecurity ? <div>
        {loading && posture === null ? (
          <p className="text-sm text-foreground-muted">Loading security posture…</p>
        ) : error && posture === null ? (
          <p className="text-sm text-error">{error}</p>
        ) : posture ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: postureTone(posture.securityLevel) }}
            />
            <span className="font-medium">{formatLevel(posture.securityLevel)}</span>
            <span className="text-foreground-muted">·</span>
            <span>{posture.deploymentMode}</span>
          </div>
        ) : (
          <p className="text-sm text-foreground-muted">Posture unavailable.</p>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          {posture ? (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="rounded-md border border-border bg-background-element px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:border-border-strong"
            >
              Manage server posture
            </button>
          ) : null}
        </div>
        </div> : null}
      </div>

      {open && posture ? (
        <PostureModal
          posture={posture}
          onClose={() => setOpen(false)}
          onRefresh={refresh}
        />
      ) : null}
    </section>
  );
}
