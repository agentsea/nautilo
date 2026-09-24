import { useRef, useState } from "react";
import { X } from "lucide-react";
import { ApiError } from "@nautilo/api-client/browser";
import type { ModerationCommand, ModerationReceipt } from "@nautilo/types";
import { apiClient } from "../../../lib/api";
import { Button } from "../../settings/ui";
import { ModerationMemberSearch, type ModerationMember } from "./moderation-member-search";
import { ModerationPersonControls, moderationError } from "./moderation-person-controls";

type Outcome = { person: ModerationMember; command?: ModerationCommand; receipt?: ModerationReceipt; error?: string };

/** Bulk presentation over the canonical per-person commands. Every result has
 * its own authority revision and stable retry identity; successes are not replayed. */
export function ModerationMembers({ enabled, canBan, canKick }: { enabled: boolean; canBan: boolean; canKick: boolean }) {
  const [selected, setSelected] = useState<ModerationMember[]>([]);
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const [action, setAction] = useState<"ban" | "kick" | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [inspectionBusy, setInspectionBusy] = useState(false);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const running = useRef(false);
  const unresolved = outcomes.some(item => item.command && !item.receipt);
  const locked = busy || unresolved || inspectionBusy;
  const actionCount = outcomes.length || selected.length;
  const apply = async () => {
    if (running.current || !action || !reason.trim()) return;
    running.current = true; setBusy(true);
    const work: Outcome[] = outcomes.length ? outcomes.map(item => ({ ...item })) : selected.map(person => ({ person }));
    setOutcomes([...work]);
    try {
      for (const item of work) {
        if (item.receipt) continue;
        delete item.error;
        try {
          if (!item.command) {
            const current = await apiClient.getModerationPerson({ userId: item.person.userId });
            if (!current.person.allowedActions.includes(action) || current.person.protectedTarget) {
              item.error = "Your permissions do not allow this action for this member.";
              setOutcomes(work.map(row => ({ ...row }))); continue;
            }
            item.command = { operationId: crypto.randomUUID(), targetUserId: item.person.userId, roomId: null,
              action, reason: reason.trim(), ...(action === "ban" ? { deleteCommunityMessages: true } : {}),
              privateNote: null, expiresAt: null, targetRevision: current.person.targetRevision,
              restrictionId: null, restrictionRevision: null };
            setOutcomes(work.map(row => ({ ...row })));
          }
          item.receipt = await apiClient.applyModeration(item.command);
          setSelected(current => current.filter(person => person.userId !== item.person.userId));
          setRemovedIds(current => current.includes(item.person.userId) ? current : [...current, item.person.userId]);
        } catch (cause) {
          item.error = moderationError(cause);
          if (cause instanceof ApiError && [400, 403, 404, 409].includes(cause.status)) delete item.command;
        }
        setOutcomes(work.map(row => ({ ...row })));
      }
    } finally { setBusy(false); running.current = false; }
  };
  const reset = () => { setAction(null); setOutcomes([]); setReason(""); };
  return <div className="space-y-4">
    <header><h3 className="font-medium">Find members</h3>
      <p className="text-sm text-foreground-muted">Search names or @handles. Add members, then keep searching to build your selection.</p></header>
    <ModerationMemberSearch activeOnly excludedIds={removedIds} disabled={locked || action !== null} selectedIds={selected.map(person => person.userId)} onSelect={person => {
      setSelected(current => current.some(item => item.userId === person.userId) ? current : [...current, person]); setInspecting(null);
    }} />
    <div className="flex items-center justify-between gap-2"><h4 className="text-sm font-medium">Selected members ({selected.length})</h4>
      <Button variant="ghost" disabled={locked || action !== null || !selected.length} onClick={() => { setSelected([]); setInspecting(null); }}>Clear selection</Button></div>
    <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto" aria-label="Selected members">
      {selected.map(person => <div key={person.userId} className="flex items-center gap-2 rounded border border-border px-3 py-2 text-sm">
        <span>{person.displayName}{person.handle && <span className="text-foreground-muted"> @{person.handle}</span>}</span>
        <button type="button" disabled={locked || action !== null} aria-label={`Remove ${person.displayName} from selection`}
          title="Remove from selection"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-border bg-background-element text-foreground hover:bg-background-panel focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40"
          onClick={() => { setSelected(current => current.filter(item => item.userId !== person.userId)); if (inspecting === person.userId) setInspecting(null); }}><X className="h-4 w-4" aria-hidden="true" /></button>
      </div>)}
      {!selected.length && <p className="text-sm text-foreground-muted">Add a member from the search results.</p>}
    </div>
    {!action && <div className="flex flex-wrap gap-2">
      {canKick && <Button disabled={!enabled || !selected.length || locked} onClick={() => { setAction("kick"); setInspecting(null); }}>Kick selected ({selected.length})</Button>}
      {canBan && <Button disabled={!enabled || !selected.length || locked} onClick={() => { setAction("ban"); setInspecting(null); }}>Ban selected ({selected.length})</Button>}
      {selected.length === 1 && <Button disabled={locked} onClick={() => setInspecting(selected[0].userId)}>View member access</Button>}
    </div>}
    {inspecting && !action && <ModerationPersonControls userId={inspecting} enabled={enabled} onUnresolvedChange={setInspectionBusy} />}
    {action && <form className="space-y-3 rounded border border-border p-4" onSubmit={event => { event.preventDefault(); void apply(); }}>
      <h4 className="font-medium">{outcomes.length ? `${action === "ban" ? "Ban" : "Kick"} results (${actionCount})` : `${action === "ban" ? "Ban" : "Kick"} ${actionCount} selected ${actionCount === 1 ? "member" : "members"}?`}</h4>
      <p className="text-sm">{action === "ban" ? "Withdraws Server access and permanently removes their messages in community/group Rooms and those Rooms’ threads. Private conversations are preserved."
        : "Removes these accounts from the Server. They may request to join again. Message history stays."}</p>
      <label className="block text-sm">Reason (required)
        <textarea rows={3} required disabled={busy || outcomes.length > 0} value={reason} onChange={event => setReason(event.target.value)}
          className="mt-1 w-full rounded border border-border bg-background-panel p-2" /></label>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={!enabled || busy || !reason.trim() || (outcomes.length > 0 && outcomes.every(item => item.receipt))}>
          {busy ? "Applying…" : outcomes.length ? "Retry unresolved members" : action === "ban" ? `Ban ${actionCount} & delete messages` : `Kick ${actionCount}`}
        </Button>
        <Button disabled={locked} onClick={() => {
          const completed = new Set(outcomes.filter(item => item.receipt).map(item => item.person.userId));
          setSelected(current => current.filter(person => !completed.has(person.userId))); reset();
        }}>{outcomes.length ? "Done" : "Cancel"}</Button>
      </div>
      {outcomes.length > 0 && <div role="status" className="max-h-64 space-y-2 overflow-y-auto">
        {outcomes.map(item => <div key={item.person.userId} className="border-t border-border pt-2 text-sm">
          <p className="font-medium">{item.person.displayName}{item.person.handle ? ` (@${item.person.handle})` : ""}</p>
          {item.receipt && item.error && <p>{item.error}</p>}
          <p>{item.receipt ? action === "ban" ? "Ban saved." : "Kick saved." : item.error ?? "Waiting…"}</p>
          {item.receipt?.messageCleanup === "pending" && <><p>Community message removal is pending. Some messages may remain visible until cleanup finishes.</p>
            <Button disabled={busy || !item.command} onClick={() => {
              if (!item.command) return;
              setBusy(true);
              void apiClient.applyModeration(item.command).then(receipt => {
                setOutcomes(current => current.map(row => row.person.userId === item.person.userId ? { ...row, receipt } : row));
              }).catch(cause => { setOutcomes(current => current.map(row => row.person.userId === item.person.userId ? { ...row, error: moderationError(cause) } : row)); })
                .finally(() => setBusy(false));
            }}>Retry message removal</Button>
          </>}
          {item.receipt?.messageCleanup === "complete" && <p>Community/group messages removed. Private conversations preserved.</p>}
          {item.receipt && !item.receipt.converged && <p>Connection and running-work cleanup is pending.</p>}
          {item.receipt && !item.receipt.auditRecorded && <p>Audit recovery is pending.</p>}
          {item.command && !item.receipt && <p>Result unconfirmed. Retry resolves the same operation safely.</p>}
        </div>)}
      </div>}
    </form>}
  </div>;
}
