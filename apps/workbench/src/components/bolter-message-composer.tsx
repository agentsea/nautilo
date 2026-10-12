import { useEffect, useRef, useState } from "react";
import type { BolterReviewedMessageRequest, BolterReviewedMessageResponse, BolterRoomLinkSummary } from "@nautilo/types";
import { apiClient } from "../lib/api";
import { useBolterRoomState } from "./bolter-room-state";
import { bolterDeliveryLabel, bolterReason } from "../pages/connections/bolter-presentation";

type Review = Readonly<{ link: BolterRoomLinkSummary; request: BolterReviewedMessageRequest }>;

/** This draft is independent of the ordinary local composer and never expands resources or commands. */
export function BolterMessageComposer({ roomId, scopeKey }: { readonly roomId: string; readonly scopeKey: string }) {
  const { link, loading, reload, capture } = useBolterRoomState(roomId, scopeKey);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [receipt, setReceipt] = useState<BolterReviewedMessageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const sending = useRef(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (review) reviewHeading.current?.focus(); }, [review]);
  useEffect(() => {
    setExpanded(false); setDraft(""); setReview(null); setReceipt(null); setError(null);
    setBusy(false); setUnconfirmed(false); sending.current = false;
  }, [roomId, scopeKey]);
  if (!link) return null;
  const allowed = link.status === "active" && link.canSend;
  const button = "rounded border border-border px-3 py-1.5 text-xs hover:bg-background-element disabled:opacity-50";

  async function send() {
    if (!review || sending.current) return;
    const current = capture(); sending.current = true; setBusy(true); setError(null);
    try {
      const observed = await apiClient.getBolterRoom(roomId);
      if (!current()) return;
      const fresh = observed.link;
      if (!fresh?.canSend || fresh.status !== "active" || fresh.id !== review.link.id || fresh.revision !== review.request.expectedRevision) {
        if (!unconfirmed) setReview(null);
        setError("The destination or connection changed. Reload before continuing; the previous request will not be replaced."); await reload(); return;
      }
      // From this point a lost response cannot prove the server did not accept.
      setUnconfirmed(true);
      const accepted = await apiClient.sendBolterMessage(review.link.id, review.request);
      if (!current()) return;
      setReceipt(accepted); setUnconfirmed(false); setReview(null); setDraft("");
    } catch {
      if (current()) setError("Could not confirm delivery. Check its status before sending anything again.");
    } finally { if (current()) { sending.current = false; setBusy(false); } }
  }
  async function checkDelivery() {
    const current = capture(); setBusy(true);
    try {
      const deliveries = await apiClient.getBolterDeliveries(link!.id);
      if (!current()) return;
      const observed = deliveries.deliveries.find(item => receipt ? item.outboxId === receipt.outboxId
        : review ? item.requestId === review.request.requestId : false);
      if (observed) {
        setReceipt(observed); setUnconfirmed(false); setReview(null); setDraft(""); setError(null);
      } else if (unconfirmed) {
        setError("The send result is still unknown. Recover the same request; do not create a replacement message.");
      }
      await reload();
    } catch { if (current()) setError("Could not check delivery. The previous send will not be repeated."); }
    finally { if (current()) setBusy(false); }
  }
  return <section aria-label="Send text to Bolter" className="border-t border-border bg-background-panel px-3 py-2 text-xs">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span>Bolter · {link.conversationLabel} · {link.status === "active" ? link.receiver === "listening" ? "Listening" : "Linked" : link.status === "paused" ? "Paused" : "Disconnected"}</span>
      <button type="button" className={button} disabled={!allowed || busy || unconfirmed} aria-expanded={expanded} onClick={() => { setExpanded(!expanded); setError(null); }}>Write a message to Bolter</button>
    </div>
    {!allowed ? <p className="mt-1 text-foreground-muted">{bolterReason(link.reason ?? "receiver_unavailable")}</p> : null}
    {receipt ? <div className="mt-2 flex flex-wrap items-center gap-2"><p role="status">{bolterDeliveryLabel(receipt.state)}</p><button type="button" className={button} disabled={busy} onClick={() => void checkDelivery()}>Check delivery</button></div> : null}
    {error ? <p role="alert" className="mt-2 text-[var(--error)]">{error}</p> : null}
    {expanded ? <div className="mt-3 space-y-2">
      <p className="text-foreground-muted">Your ordinary composer stays local. Only the text reviewed here will be sent to Bolter. No files, attachments, private memory or other room history are included.</p>
      {review ? <div role="region" aria-label="Review message for Bolter" className="space-y-3 rounded-lg border border-border p-3">
        <h4 ref={reviewHeading} tabIndex={-1} className="font-medium">Send to {review.link.conversationLabel}</h4>
        <p>As {review.link.identityLabel} · {review.link.providerAgentId}</p>
        <p className="break-all">Chat {review.link.chatId}{review.link.threadRootId ? ` · thread ${review.link.threadRootId}` : " · root conversation"}</p>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-3 font-sans text-sm">{review.request.content}</pre>
        <p>The text above will leave Nautilo. Review personal or sensitive information before sending.</p>
        {unconfirmed ? <p role="status">The last request may have been accepted. It will not be resent automatically.</p> : null}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={button} disabled={busy || unconfirmed} onClick={() => { setReview(null); setTimeout(() => editor.current?.focus(), 0); }}>Keep editing</button>
          <button type="button" className={button} disabled={busy || !allowed || loading || unconfirmed} onClick={() => void send()}>Send to Bolter</button>
          {unconfirmed ? <><button type="button" className={button} disabled={busy} onClick={() => void checkDelivery()}>Check delivery</button>
            <button type="button" className={button} disabled={busy} onClick={() => void send()}>Recover same request</button></> : null}
        </div>
      </div> : <>
        <label className="block">Message to {link.conversationLabel}<textarea ref={editor} aria-label="Message to Bolter" value={draft} disabled={busy || !allowed} onChange={event => setDraft(event.target.value)} rows={3} className="mt-1 block w-full resize-y rounded-lg border border-border bg-background p-2 text-sm" /></label>
        <div className="flex gap-2"><button type="button" className={button} disabled={busy || !allowed || !draft.trim()} onClick={() => {
          setError(null); setReceipt(null); setReview(Object.freeze({ link: Object.freeze({ ...link }), request: Object.freeze({ expectedRevision: link.revision, requestId: crypto.randomUUID(), content: draft }) }));
        }}>Review &amp; send</button><button type="button" className={button} disabled={busy} onClick={() => setExpanded(false)}>Close draft</button></div>
      </>}
    </div> : null}
  </section>;
}
