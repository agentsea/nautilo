import { useCallback, useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import type { ServerModerationPolicy } from "@nautilo/types";
import { apiClient } from "../../../lib/api";
import { useCan } from "../../../hooks/use-can";
import { Button } from "../../settings/ui";
import { ModerationMembers } from "./moderation-members";
import { EnrollmentInbox } from "./moderation-enrollment-inbox";
import { ModerationPersonControls, moderationError } from "./moderation-person-controls";


export function ModerationSection() {
  const can = useCan();
  const location = useLocation();
  const selectedUserId = new URLSearchParams(location.search).get("moderateUser") ?? undefined;
  const canManageMembers = can("ban_server_members") || can("kick_server_members") || can("view_server_moderation");
  const [tab, setTab] = useState<"members" | "requests">(canManageMembers ? "members" : "requests");
  useEffect(() => { if (selectedUserId) setTab("members"); }, [selectedUserId]);
  const [policy, setPolicy] = useState<ServerModerationPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(async () => {
    setBusy(true); setError(null);
    try { setPolicy(await apiClient.getModerationPolicy()); }
    catch (cause) { setError(moderationError(cause)); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const update = async (change: Partial<ServerModerationPolicy>) => {
    if (!policy || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const updated = await apiClient.updateModerationPolicy({ enabled: policy.enabled, joinsPaused: policy.joinsPaused,
        approvalRequired: policy.approvalRequired, revision: policy.revision, ...change });
      setPolicy(updated); setNotice(updated.auditRecorded ? "Settings saved." : "Settings saved. The audit log could not be written.");
    } catch (cause) { setError(moderationError(cause)); }
    finally { setBusy(false); }
  };
  return <section id="moderation" aria-labelledby="moderation-title" data-testid="admin-moderation-section">
    <div className="space-y-5 rounded-lg border border-border bg-background-panel p-5">
      <header><h2 id="moderation-title" className="text-base font-semibold">Moderation</h2>
        <p className="mt-1 text-sm text-foreground-muted">Control who can enter this Server and remove people who break its rules.</p></header>
      {error && <p role="alert" className="text-sm">{error}</p>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      <Button variant="secondary" disabled={busy} onClick={() => { void load(); }}>Refresh settings</Button>
      {policy && <>
        {can("manage_server_enrollment") && <details className="rounded border border-border p-3" open={!policy.enabled}>
          <summary className="cursor-pointer text-sm font-medium">Server settings · {policy.enabled ? "Moderation enabled" : "Moderation disabled"}{policy.joinsPaused ? " · Joins paused" : ""}</summary>
          <div className="mt-3 space-y-3">
          <p className="text-sm">Moderation controls are {policy.enabled ? "enabled" : "disabled"}. Existing bans remain in force when controls are disabled.</p>
          <Button variant="secondary" disabled={busy} onClick={() => {
            void update(policy.enabled ? { enabled: false } : { enabled: true, approvalRequired: true });
          }}>{policy.enabled ? "Disable moderation controls" : "Enable moderation and joining approval"}</Button>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={policy.approvalRequired} disabled={busy || !policy.enabled} onChange={event => {
              const approvalRequired = event.target.checked;
              if (!approvalRequired && !window.confirm("Allow new accounts to join through valid invites without a message or approval? Existing bans remain in force.")) return;
              void update({ approvalRequired });
            }} />
            <span>Require a joining-goal message and approval for every new account</span>
          </label>
          <p className="text-sm">{policy.joinsPaused ? "New joins are paused. Existing members can still sign in." : policy.approvalRequired ? "New accounts must be approved, even when they reuse an invite link." : "Valid invites currently permit joining without approval."}</p>
          {policy.joinsPaused && !policy.enabled && <p className="text-sm">Enable moderation controls before resuming joins.</p>}
          <Button variant="secondary" disabled={busy || (policy.joinsPaused && !policy.enabled)} onClick={() => { void update({ joinsPaused: !policy.joinsPaused }); }}>
            {policy.joinsPaused ? "Resume joins" : "Pause all new joins"}
          </Button>
          {can("manage_members") && <p className="text-sm"><a className="underline" href="#invites">Manage or revoke invite links</a></p>}
        </div></details>}
        <div role="tablist" aria-label="Moderation sections" className="flex gap-4 border-b border-border">
          {canManageMembers && <button type="button" role="tab" id="moderation-members-tab" aria-controls="moderation-members-panel" aria-selected={tab === "members"} onClick={() => setTab("members")} className={`border-b-2 px-1 py-3 ${tab === "members" ? "border-primary" : "border-transparent text-foreground-muted"}`}>Members</button>}
          {can("manage_server_enrollment") && <button type="button" role="tab" id="moderation-requests-tab" aria-controls="moderation-requests-panel" aria-selected={tab === "requests"} onClick={() => setTab("requests")} className={`border-b-2 px-1 py-3 ${tab === "requests" ? "border-primary" : "border-transparent text-foreground-muted"}`}>Joining requests</button>}
        </div>
        <div id="moderation-members-panel" role="tabpanel" aria-labelledby="moderation-members-tab" hidden={tab !== "members"}>
        {(can("ban_server_members") || can("kick_server_members") || can("view_server_moderation")) &&
          (selectedUserId ? <ModerationPersonControls key={selectedUserId} userId={selectedUserId} enabled={policy.enabled} />
            : <ModerationMembers enabled={policy.enabled} canBan={can("ban_server_members")} canKick={can("kick_server_members")} />)}
        </div>
        {can("manage_server_enrollment") && <div id="moderation-requests-panel" role="tabpanel" aria-labelledby="moderation-requests-tab" hidden={tab !== "requests"}><EnrollmentInbox /></div>}
      </>}
    </div>
  </section>;
}
