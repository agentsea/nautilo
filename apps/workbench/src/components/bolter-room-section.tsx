import { useEffect, useState } from "react";
import { useBolterRoomState } from "./bolter-room-state";
import { apiClient } from "../lib/api";
import { bolterReason } from "../pages/connections/bolter-presentation";

export function BolterRoomSection({ roomId, scopeKey }: { readonly roomId: string; readonly scopeKey: string }) {
  const { link, error, loading, reload, capture } = useBolterRoomState(roomId, scopeKey);
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  useEffect(() => { setBusy(false); setMutationError(null); setConfirmUnlink(false); }, [roomId, scopeKey]);
  if (loading && !link) return null;
  if (!link && !error) return null;
  async function change(state: "active" | "paused" | "revoked") {
    if (!link || !link.canManage || busy) return;
    const current = capture(); setBusy(true); setMutationError(null);
    try {
      await apiClient.updateBolterBinding(link.id, { expectedRevision: link.revision, state });
      if (current()) { setConfirmUnlink(false); await reload(); }
    } catch { if (current()) setMutationError("The link could not be changed. Reload its current state before retrying."); }
    finally { if (current()) setBusy(false); }
  }
  const button = "rounded border border-border px-2 py-1 text-xs hover:bg-background-element disabled:opacity-50";
  return <section aria-label="Bolter room connection" className="my-3 space-y-2 rounded-lg border border-border p-3 text-xs">
    <h4 className="font-medium">Bolter · this room only</h4>
    {error || mutationError ? <p role="alert">{error || mutationError}</p> : null}
    {link ? <>
      <p>{link.identityLabel} → {link.conversationLabel}</p>
      <p className="break-all text-foreground-muted">{link.chatId}{link.threadRootId ? ` · thread ${link.threadRootId}` : " · root conversation"}</p>
      <p role="status">{link.status === "active" ? link.receiver === "listening" ? "Listening" : "Linked · receiver not yet listening" : link.status === "paused" ? "Paused" : "Disconnected"}</p>
      {link.reason ? <p>{bolterReason(link.reason)}</p> : null}
      <p>Share your messages and selected files with the Bolter composer. Genie replies to incoming messages can leave Nautilo. Other rooms, private memory, unselected files and tools remain outside this link.</p>
      <p>Pause stops new sends. Messages already authorized for dispatch may finish.</p>
      {link.delivery.uncertain ? <p role="status">{link.delivery.uncertain} uncertain deliveries. Do not resend automatically.</p> : null}
      <div className="flex flex-wrap gap-2">
        {link.canManage && link.status !== "revoked" ? <><button type="button" className={button} disabled={busy} onClick={() => void change(link.status === "paused" ? "active" : "paused")}>{link.status === "paused" ? "Resume link" : "Pause link"}</button>
          <button type="button" className={button} disabled={busy} onClick={() => setConfirmUnlink(true)}>Unlink</button></> : null}
      </div>
      {confirmUnlink ? <div role="alertdialog" aria-label="Unlink Bolter room" className="space-y-2">
        <p>Unlink this conversation? The room keeps its history and external privacy boundary.</p>
        <button type="button" className={button} disabled={busy} onClick={() => setConfirmUnlink(false)}>Keep link</button>{" "}
        <button type="button" className={button} disabled={busy} onClick={() => void change("revoked")}>Unlink conversation</button>
      </div> : null}
    </> : null}
    <div className="flex gap-2"><button type="button" className={button} disabled={busy || loading} onClick={() => void reload()}>Reload Bolter link</button>
      <a className="text-accent underline" href="/connections#bolter">Manage connection</a></div>
  </section>;
}
