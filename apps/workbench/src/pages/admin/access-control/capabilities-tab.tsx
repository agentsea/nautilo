import { useEffect } from "react";
import { useAccessControl } from "./access-control-context";

export function CapabilitiesTab() {
  const { catalogue, loading, error, refresh } = useAccessControl();
  useEffect(() => { if (!catalogue && refresh) void refresh(); }, [catalogue, refresh]);
  if (loading || !catalogue && !error) return <p className="p-6 text-sm text-foreground-muted">Loading Permissions catalog…</p>;
  if (error) return <p role="alert" className="p-6 text-sm text-[var(--error)]">{error}</p>;
  return (
    <section id="access-control-capabilities-panel" role="tabpanel" aria-labelledby="access-control-tab-capabilities" className="min-h-0 flex-1 overflow-y-auto p-6">
      <h2 className="text-xl font-semibold">Permissions catalog</h2>
      <p className="mt-1 text-sm text-foreground-muted">Canonical catalog. Permissions are assigned to custom Permission sets only through controlled selection.</p>
      <ul className="mt-6 divide-y divide-border rounded-md border border-border">
        {catalogue?.capabilities.map((capability) => <li key={capability.slug} className="p-3"><p className="font-mono text-sm">{capability.slug}</p><p className="mt-1 text-sm text-foreground-muted">{capability.description || "No description provided."}</p><p className="mt-1 text-xs text-foreground-muted">{capability.category}</p></li>)}
      </ul>
    </section>
  );
}
