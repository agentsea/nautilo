import { useCallback, useEffect, useState } from "react";
import { ApiError } from "@nautilo/api-client/browser";
import type { ModerationCommand, ModerationReceipt } from "@nautilo/types";
import { apiClient } from "../../../lib/api";
import { Button } from "../../settings/ui";

import { ModerationMemberSearch } from "./moderation-member-search";

type PersonResult = Awaited<ReturnType<typeof apiClient.getModerationPerson>>;
export function moderationError(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  const messages: Record<string, string> = {
    forbidden_scope: "You no longer have permission to do this.",
    protected_target: "Your permissions do not allow moderating this person.",
    target_unavailable: "That person or request is unavailable. Refresh and try again.",
    stale_revision: "This changed while you were reviewing it. Refresh and review the current state.",
    moderation_disabled: "Enable moderation before using these controls.",
    active_ban: "This account is banned. Approval cannot override the ban.",
    admission_withdrawn: "This request predates removal from the Server. A fresh request is required.",
    rate_limited: "Too many requests. Please wait a moment and try again.",
  };
  return messages[code] ?? "Could not complete the request. Check its status before trying again.";
}

export function ModerationPersonControls({ userId, enabled, initialAction, onUnresolvedChange, onComplete }: {
  userId?: string; enabled: boolean; initialAction?: "ban" | "kick"; onUnresolvedChange?: (unresolved: boolean) => void;
  onComplete?: (receipt: ModerationReceipt, displayName: string) => void;
}) {
  const [result, setResult] = useState<PersonResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ action: "ban" | "kick" | "lift"; restrictionId?: string; revision?: number } | null>(null);
  const [reason, setReason] = useState("");
  const [command, setCommand] = useState<ModerationCommand | null>(null);
  const [savedCommand, setSavedCommand] = useState<ModerationCommand | null>(null);
  const [receipt, setReceipt] = useState<ModerationReceipt | null>(null);
  const load = useCallback(async (target: { userId: string } | { handle: string }, selectInitial = false) => {
    setBusy(true); setError(null); setResult(null);
    try {
      const found = await apiClient.getModerationPerson(target);
      setResult(found);
      if (selectInitial && initialAction && enabled && found.person.allowedActions.includes(initialAction)) setSelection({ action: initialAction });
    }
    catch (cause) { setError(moderationError(cause)); }
    finally { setBusy(false); }
  }, [enabled, initialAction]);
  useEffect(() => { onUnresolvedChange?.(busy || command !== null); }, [busy, command, onUnresolvedChange]);
  useEffect(() => { if (userId) void load({ userId }, true); }, [load, userId]);

  const acceptReceipt = async (saved: ModerationReceipt) => {
    setReceipt(saved); setCommand(null); setSelection(null); setReason("");
    if (onComplete && result && saved.committed && saved.action !== "lift" && saved.messageCleanup !== "pending") {
      onComplete(saved, result.person.displayName);
      return;
    }
    if (result) await load({ userId: result.person.userId });
  };
  const submit = async () => {
    if (!result || !selection || busy || !reason.trim()) return;
    const input: ModerationCommand = command ?? { operationId: crypto.randomUUID(), targetUserId: result.person.userId,
      roomId: null, action: selection.action, ...(selection.action === "ban" ? { deleteCommunityMessages: true } : {}), reason: reason.trim(), privateNote: null, expiresAt: null,
      targetRevision: result.person.targetRevision, restrictionId: selection.restrictionId ?? null, restrictionRevision: selection.revision ?? null };
    setSavedCommand(input); setCommand(input); setBusy(true); setError(null); setReceipt(null);
    try { await acceptReceipt(await apiClient.applyModeration(input)); }
    catch (cause) {
      setError(moderationError(cause));
      // A definitive rejection did not commit. Ambiguous transport failures
      // retain the exact operation and payload for receipt lookup or retry.
      if (cause instanceof ApiError && [400, 403, 404, 409].includes(cause.status)) {
        setCommand(null); setSelection(null);
      }
    } finally { setBusy(false); }
  };
  return <div className="space-y-3">
    <h3 className="font-medium">{userId ? "Member access" : "Find a member"}</h3>
    {!userId && <p className="text-sm text-foreground-muted">Search by name or @handle, then select a member to review their access. Searching changes nothing.</p>}
    {!userId && <ModerationMemberSearch disabled={busy || command !== null} onSelect={person => {
      setSelection(null); setReceipt(null); setReason(""); void load({ userId: person.userId });
    }} />}
    {error && <p role="alert" className="text-sm">{error}</p>}
    {receipt && <p role="status" className="text-sm">
      {receipt.action === "lift" ? "Ban lifted. This does not restore access. Use a new invite and satisfy the current joining policy."
        : receipt.action === "ban" ? "Ban saved. This account can no longer enter the Server." : "Kick saved. This account has been removed from the Server."}
      {receipt.messageCleanup === "pending" && " Community message removal is pending; some messages may remain visible until cleanup finishes."}
      {receipt.messageCleanup === "complete" && " Community/group messages removed. Private conversations preserved."}
      {!receipt.converged && " Connection and running-work cleanup is still pending."}
      {!receipt.auditRecorded && " The audit log is pending recovery."}
    </p>}
    {receipt?.messageCleanup === "pending" && savedCommand && <Button disabled={busy || command !== null} onClick={() => {
      setBusy(true); setError(null);
      void apiClient.applyModeration(savedCommand).then(acceptReceipt).catch(cause => setError(moderationError(cause))).finally(() => setBusy(false));
    }}>Retry message removal</Button>}
    {result && <div className="space-y-3 rounded border border-border p-3">
      <p className="font-medium">{result.person.displayName}</p>
      {result.person.protectedTarget && <p className="text-sm">This person is protected from moderation by your current permissions.</p>}
      {result.restrictions.map(restriction => <div key={restriction.id} className="space-y-2 text-sm">
        <p>Active Server ban{restriction.reason ? `: ${restriction.reason}` : ""}</p>
        {result.person.allowedActions.includes("lift") && <Button variant="secondary" disabled={!enabled || busy || command !== null}
          onClick={() => { setSelection({ action: "lift", restrictionId: restriction.id, revision: restriction.revision }); setReason(""); }}>Lift ban</Button>}
      </div>)}
      <div className="flex flex-wrap gap-2">
        {(["ban", "kick"] as const).filter(action => (!initialAction || action === initialAction) && result.person.allowedActions.includes(action)).map(action =>
          <Button key={action} variant="secondary" disabled={!enabled || busy || command !== null}
            onClick={() => { setSelection({ action }); setReason(""); }}>{action === "ban" ? "Ban from Server" : "Kick from Server"}</Button>)}
        <Button variant="secondary" disabled={busy || command !== null} onClick={() => { setSelection(null); void load({ userId: result.person.userId }); }}>Refresh</Button>
      </div>
      {selection && <form className="space-y-3 border-t border-border pt-3" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <p className="text-sm">{selection.action === "ban" ? "Ban this account and permanently remove its messages in community/group Rooms and their threads. Private conversations are preserved. A new account must still pass joining approval."
          : selection.action === "kick" ? "Remove this account from the Server. It may request to join again using a fresh invite."
            : "Lift this ban. Other restrictions still apply, and access is not automatically restored."}</p>
        <label className="block text-sm">Reason
          <textarea required rows={2} value={reason} disabled={busy || command !== null} onChange={event => setReason(event.target.value)}
            className="mt-1 w-full rounded border border-border bg-background-panel p-2" />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" disabled={busy || !reason.trim()}>{command ? "Retry same action" : "Confirm"}</Button>
          {!command && <Button variant="secondary" disabled={busy} onClick={() => setSelection(null)}>Cancel</Button>}
          {command && <Button variant="secondary" disabled={busy} onClick={() => {
            setBusy(true); setError(null);
            void apiClient.getModerationReceipt(command.operationId).then(acceptReceipt).catch(cause => {
              setError(cause instanceof ApiError && cause.status === 404 ? "No saved result yet. Retry the same action to resolve it safely." : moderationError(cause));
            }).finally(() => setBusy(false));
          }}>Check result</Button>}
        </div>
      </form>}
    </div>}
  </div>;
}
