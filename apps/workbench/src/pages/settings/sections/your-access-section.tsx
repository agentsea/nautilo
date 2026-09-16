import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { EffectiveAccessResponse } from "@nautilo/api-client";
import { apiClient } from "../../../lib/api";
import { useAuth } from "../../../hooks/use-auth";
import { useCan } from "../../../hooks/use-can";
import { ProvenanceDrawer } from "../../admin/access-control/provenance-drawer";

const UNCONTAINED_HOST_COMMANDS_GROUP =
  "uncontained_host_commands_grantees";
const UNCONTAINED_HOST_COMMANDS_ROLE = "uncontained_host_commands_grantee";
const SUPERUSER_OR_ABOVE = new Set(["owner", "admin", "superuser"]);

export function YourAccessSection() {
  const { viewer } = useAuth();
  const can = useCan();
  const [access, setAccess] = useState<EffectiveAccessResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const canOpenAdmin = can("manage_members") || can("manage_groups") || can("manage_roles");

  useEffect(() => {
    if (!viewer.isVerified) return;
    let cancelled = false;
    setLoading(true);
    void apiClient.accessControl.getMyEffectiveAccess()
      .then((result) => { if (!cancelled) setAccess(result); })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load your access.");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [viewer.isVerified]);

  if (!viewer.isVerified) return null;

  const uncontainedHostCommandsGroup = access?.groups.find(
    (group) => group.type === UNCONTAINED_HOST_COMMANDS_GROUP,
  );
  const uncontainedHostCommandsSource = uncontainedHostCommandsGroup
    ? access?.groupRoleFacts.find(
      (fact) =>
        fact.groupId === uncontainedHostCommandsGroup.id &&
        fact.roleSlug === UNCONTAINED_HOST_COMMANDS_ROLE,
    )
    : undefined;
  const hasUncontainedHostCommandsGrant =
    uncontainedHostCommandsSource !== undefined;
  const meetsUncontainedHostCommandsRoleFloor =
    access !== null && SUPERUSER_OR_ABOVE.has(access.highestRole ?? "");
  const researchToolsGranted = access?.capabilities.find(
    (capability) => capability.slug === "use_research_tools",
  )?.granted ?? false;

  return (
    <section id="your-access" aria-labelledby="your-access-title" className="rounded-lg border border-border bg-background-panel">
      <header className="border-b border-border px-5 py-3">
        <h2 id="your-access-title" className="text-sm font-semibold">Your access <span className="font-normal text-foreground-muted">(read-only)</span></h2>
        <p className="mt-1 text-xs text-foreground-muted">Signed in as {viewer.label}. Your identity and capability summary comes from the current auth viewer.</p>
      </header>
      <div className="space-y-4 px-5 py-4">
        {loading ? <p className="text-sm text-foreground-muted">Loading effective access…</p> : null}
        {error ? <p role="alert" className="text-sm text-[var(--error)]">{error}</p> : null}
        {access ? (
          <>
            <p className="text-sm">Canonical ladder: <strong>{access.highestRole ?? "None"}</strong></p>
            <section className="rounded-md border border-border bg-background-element p-3" aria-labelledby="research-tools-access-title">
              <h3 id="research-tools-access-title" className="text-sm font-semibold">Web research</h3>
              <p className="mt-1 text-sm">
                Research tools: <strong>{researchToolsGranted ? "Granted" : "Not granted"}</strong>
              </p>
              <p className="mt-1 text-xs text-foreground-muted">
                Connected work-computer availability appears under Devices. Server-wide provider policy is managed in Server admin.
              </p>
            </section>
            <section
              aria-labelledby="uncontained-host-commands-access-title"
              className="rounded-md border border-border bg-background-element p-3"
            >
              <h3 id="uncontained-host-commands-access-title" className="text-sm font-semibold">
                Uncontained host commands
              </h3>
              <p className="mt-1 text-sm">
                Positive grant: <strong>{hasUncontainedHostCommandsGrant ? "Granted" : "Not granted"}</strong>
              </p>
              {uncontainedHostCommandsSource ? (
                <p className="mt-1 text-sm text-foreground-muted">
                  Source: {uncontainedHostCommandsSource.groupLabel} → {uncontainedHostCommandsSource.roleLabel}
                </p>
              ) : null}
              <p className="mt-1 text-sm text-foreground-muted">
                Canonical role floor: {meetsUncontainedHostCommandsRoleFloor ? "Superuser-or-above" : "Below Superuser"}
              </p>
              <p className="mt-1 text-xs text-foreground-muted">
                This is read-only grant and role information. It does not evaluate server policy or activate uncontained commands.
              </p>
            </section>
            <ul className="divide-y divide-border rounded-md border border-border">
              {access.capabilities.map((capability) => (
                <li key={capability.slug} className="flex flex-wrap justify-between gap-2 px-3 py-2 text-sm">
                  <span className="font-mono">{capability.slug}</span>
                  <span className={capability.granted ? "text-[var(--success)]" : "text-foreground-muted"}>{capability.granted ? "Granted" : "Not granted"}</span>
                </li>
              ))}
            </ul>
            <button type="button" onClick={() => setDrawerOpen(true)} className="rounded border border-border px-3 py-1.5 text-sm hover:bg-background-element">
              Why do I have this access?
            </button>
            {drawerOpen ? <ProvenanceDrawer access={access} subject="I" onClose={() => setDrawerOpen(false)} /> : null}
          </>
        ) : null}
        {canOpenAdmin ? (
          <Link to="/admin/access-control" className="inline-flex rounded bg-primary px-3 py-1.5 text-sm font-medium text-[var(--on-primary)] hover:bg-primary-hover">
            Open access control
          </Link>
        ) : <p className="text-sm text-foreground-muted">Access-control administration is not granted for this caller.</p>}
      </div>
    </section>
  );
}
