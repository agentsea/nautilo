import { useEffect, useState } from "react";
import type { AccessControlMutationOperation } from "@nautilo/api-client";
import { useAccessControl } from "./access-control-context";

const NONDELEGABLE = new Set(["manage_server_settings", "manage_server_security"]);
const slugify = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function RolesTab({ onReview, previewPending = false }: { onReview: (operation: AccessControlMutationOperation) => void; previewPending?: boolean }) {
  const { catalogue, loading, error, canDelegate, refresh } = useAccessControl();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState("");
  const [capabilities, setCapabilities] = useState<string[]>([]);
  useEffect(() => { if (!catalogue && refresh) void refresh(); }, [catalogue, refresh]);
  if (loading || !catalogue && !error) return <p className="p-6 text-sm text-foreground-muted">Loading Permission sets…</p>;
  if (error || !catalogue) return <p role="alert" className="p-6 text-sm text-[var(--error)]">{error ?? "Could not load Permission sets."}</p>;
  const selected = catalogue.roles.find((role) => role.id === selectedId) ?? null;
  const system = catalogue.roles.filter((role) => role.isSystem);
  const custom = catalogue.roles.filter((role) => !role.isSystem);
  const openEditor = (role?: typeof catalogue.roles[number]) => {
    setCreating(!role); setSelectedId(role?.id ?? null); setLabel(role?.label ?? ""); setCapabilities([...role?.capabilitySlugs ?? []]);
  };
  const toggle = (capability: string) => setCapabilities((current) => current.includes(capability) ? current.filter((item) => item !== capability) : [...current, capability]);
  return <section id="access-control-roles-panel" role="tabpanel" aria-labelledby="access-control-tab-roles" className="min-h-0 flex-1 overflow-y-auto p-6">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">Permission sets</h2><p className="mt-1 text-sm text-foreground-muted">Custom Permission sets are orthogonal to the canonical ladder.</p></div><button type="button" disabled={previewPending} onClick={() => openEditor()} className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-[var(--on-primary)] disabled:opacity-50">New custom Permission set</button></div>
    <RoleList title="Built-in — protected definitions" roles={system} onSelect={(role) => setSelectedId(role.id)} />
    <RoleList title="Custom — user-managed, not ladder-ranked" roles={custom} onSelect={openEditor} />
    {selected?.isSystem ? <aside className="mt-6 rounded border border-border p-4"><h3 className="font-semibold">{selected.label}</h3><p className="mt-1 text-sm text-foreground-muted">Protected built-in Permission set. Its bundle is catalogue-managed and read-only.</p><CapabilityNames values={selected.capabilitySlugs} /></aside> : null}
    {(creating || (selected && !selected.isSystem)) ? <aside className="mt-6 rounded border border-border p-4"><h3 className="font-semibold">{creating ? "New custom Permission set" : `Edit ${selected?.label}`}</h3><label className="mt-3 block text-sm">Label<input disabled={previewPending} value={label} onChange={(event) => setLabel(event.target.value)} className="mt-1 block w-full rounded border border-border bg-background px-2 py-1.5" /></label>{creating ? <p className="mt-1 text-xs text-foreground-muted">Slug: {slugify(label) || "derived-from-label"}</p> : null}<fieldset className="mt-4"><legend className="font-medium">Permissions</legend><p className="mt-1 text-xs text-foreground-muted">Choose only from the server catalogue; free-text permissions are not supported.</p><div className="mt-2 space-y-2">{catalogue.capabilities.map((capability) => { const disabled = previewPending || NONDELEGABLE.has(capability.slug) || !canDelegate(capability.slug); return <label key={capability.slug} className={`flex gap-2 text-sm ${disabled ? "text-foreground-muted" : ""}`}><input type="checkbox" checked={capabilities.includes(capability.slug)} disabled={disabled} onChange={() => toggle(capability.slug)} /><span className="font-mono">{capability.slug}</span>{disabled ? <span className="text-xs">— {NONDELEGABLE.has(capability.slug) ? "protected and nondelegable" : "you do not hold this Permission"}</span> : null}</label>; })}</div></fieldset><div className="mt-5 flex flex-wrap gap-2"><button type="button" disabled={previewPending || !label.trim()} onClick={() => onReview(creating ? { kind: "role.create", label: label.trim(), slug: slugify(label), capabilities } : { kind: "role.set_capabilities", roleId: selected!.id, capabilities })} className="rounded bg-primary px-3 py-1.5 text-sm text-[var(--on-primary)] disabled:opacity-50">Review change</button>{!creating ? <><button type="button" disabled={previewPending || !label.trim()} onClick={() => onReview({ kind: "role.rename", roleId: selected!.id, label: label.trim() })} className="rounded border border-border px-3 py-1.5 text-sm disabled:opacity-50">Review rename</button><button type="button" disabled={previewPending} onClick={() => onReview({ kind: "role.delete", roleId: selected!.id })} className="rounded border border-[var(--error)] px-3 py-1.5 text-sm text-[var(--error)] disabled:opacity-50">Delete…</button></> : null}</div></aside> : null}
  </section>;
}

function RoleList({ title, roles, onSelect }: { title: string; roles: { id: string; slug: string; label: string; capabilitySlugs: readonly string[]; isSystem: boolean; groupCount: number }[]; onSelect: (role: { id: string; slug: string; label: string; capabilitySlugs: readonly string[]; isSystem: boolean; groupCount: number }) => void }) {
  return <section className="mt-6"><h3 className="text-sm font-semibold uppercase text-foreground-muted">{title}</h3><ul className="mt-2 divide-y divide-border rounded-md border border-border">{roles.map((role) => <li key={role.id}><button type="button" onClick={() => onSelect(role)} className="w-full px-3 py-3 text-left hover:bg-background-element"><span className="font-medium">{role.label}</span> <span className="ml-2 font-mono text-xs text-foreground-muted">{role.slug}</span><CapabilityNames values={role.capabilitySlugs} /></button></li>)}</ul></section>;
}
function CapabilityNames({ values }: { values: readonly string[] }) { return <p className="mt-1 font-mono text-xs text-foreground-muted">{values.length ? values.join(", ") : "No capabilities"}</p>; }
