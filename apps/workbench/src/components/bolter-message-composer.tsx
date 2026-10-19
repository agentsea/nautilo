import { ApiError } from "@nautilo/api-client/browser";
import { ChevronRight, Paperclip } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MAX_CHAT_ATTACHMENTS_PER_MESSAGE, type BolterReviewedMessageRequest, type BolterReviewedMessageResponse, type BolterRoomLinkSummary } from "@nautilo/types";
import type { ComposerAttachment } from "../adapters/composer-attachments-ref";
import { apiClient } from "../lib/api";
import { desktopAPI, isDesktop } from "../lib/desktop";
import { uploadPickedAttachment } from "../lib/composer-upload";
import { preflightComposerChatAttachment } from "../lib/composer-attachment-preflight";
import { ComposerAttachmentChips } from "./composer/ComposerAttachmentChips";
import { ComposerSendButton } from "./composer/ComposerSendButton";
import { useBolterRoomState } from "./bolter-room-state";
import { useBolterStateReload } from "./use-bolter-state-reload";
import { bolterDeliveryLabel, bolterReason } from "../pages/connections/bolter-presentation";

type Review = Readonly<{ link: BolterRoomLinkSummary; request: BolterReviewedMessageRequest; draft: string; files: readonly ComposerAttachment[] }>;
function readReviewPreference(key: string | null) {
  try { return !key || window.localStorage.getItem(key) !== "off"; } catch { return true; }
}

/** Separate queues prevent local Genie context from becoming an external share. */
export function BolterMessageComposer({ roomId, scopeKey, viewerId }: {
  readonly roomId: string; readonly scopeKey: string; readonly viewerId?: string | null;
}) {
  const { link, loading, reload, capture } = useBolterRoomState(roomId, scopeKey);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<readonly ComposerAttachment[]>([]);
  const filesRef = useRef(files);
  const [review, setReview] = useState<Review | null>(null);
  const [attempt, setAttempt] = useState<Review | null>(null);
  const [receipt, setReceipt] = useState<BolterReviewedMessageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [picking, setPicking] = useState(false);
  const [reviewBeforeSend, setReviewBeforeSend] = useState(true);
  const sending = useRef<string | null>(null);
  const unresolvedAttempt = useRef<Review | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const preferenceKey = viewerId && link ? `nautilo:bolter-review:${viewerId}:${link.id}` : null;
  useEffect(() => { setReviewBeforeSend(readReviewPreference(preferenceKey)); }, [preferenceKey]);
  useEffect(() => { if (review) reviewHeading.current?.focus(); }, [review]);
  function updateFiles(update: (previous: readonly ComposerAttachment[]) => readonly ComposerAttachment[]) {
    filesRef.current = update(filesRef.current); setFiles(filesRef.current);
  }
  useEffect(() => {
    setExpanded(false); setDraft(""); setFiles([]); filesRef.current = [];
    setReview(null); setAttempt(null); setReceipt(null); setError(null);
    setBusy(false); setPicking(false); setUnconfirmed(false); sending.current = null; unresolvedAttempt.current = null;
  }, [roomId, scopeKey]);
  function accepted(snapshot: Review, result: BolterReviewedMessageResponse) {
    if (unresolvedAttempt.current?.request.requestId !== snapshot.request.requestId) return false;
    unresolvedAttempt.current = null;
    if (sending.current === snapshot.request.requestId) { sending.current = null; setBusy(false); }
    setReceipt(result); setUnconfirmed(false); setReview(null); setAttempt(null);
    setDraft(value => value === snapshot.draft ? "" : value);
    updateFiles(items => items.filter(item => !snapshot.files.some(file => file.id === item.id)));
    return true;
  }
  const refreshDelivery = useBolterStateReload(async current => {
    const selection = receipt ? { outboxId: receipt.outboxId } : attempt ? { requestId: attempt.request.requestId } : null;
    if (!link || !selection) return;
    try {
      const result = await apiClient.getBolterDeliveries(link.id, undefined, selection);
      if (!current()) return;
      const observed = result.deliveries.find(item => receipt ? item.outboxId === receipt.outboxId : item.requestId === attempt?.request.requestId);
      if (observed) {
        if (attempt) { if (!accepted(attempt, observed)) return; }
        else if (!sending.current) setReceipt(observed); // An older receipt must never clear a newer draft.
        setError(null);
      }
    } catch { /* Keep the last receipt or unresolved attempt; a read never resends. */ }
  }, capture);
  const receiptOutboxId = receipt?.outboxId;
  const attemptRequestId = attempt?.request.requestId;
  useEffect(() => { if (receiptOutboxId || attemptRequestId) void refreshDelivery(); }, [receiptOutboxId, attemptRequestId, refreshDelivery]);
  useEffect(() => {
    const refresh = () => { void refreshDelivery(); void reload(); };
    window.addEventListener("online", refresh);
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.removeEventListener("online", refresh); document.removeEventListener("visibilitychange", onVisible); };
  }, [refreshDelivery, reload]);
  if (!link) return null;
  const allowed = link.status === "active" && link.canSend;
  const locked = busy || unconfirmed;
  const canAttach = allowed && link.canAttach === true;
  const filesReady = files.every(file => file.status === "queued" && !!file.attachmentId);
  const canSend = allowed && !loading && !locked && !picking && filesReady && (!!draft.trim() || files.length > 0);
  const secondary = "rounded px-1.5 py-1 text-xs text-foreground-muted hover:bg-background-element hover:text-foreground disabled:opacity-40";

  async function uploadFiles(selected: readonly { name: string; upload: () => ReturnType<typeof apiClient.uploadMessageAttachment> }[]) {
    if (!canAttach || locked || review) return;
    const current = capture();
    const available = MAX_CHAT_ATTACHMENTS_PER_MESSAGE - filesRef.current.length;
    const admitted = selected.slice(0, available).map(file => ({ ...file, id: crypto.randomUUID() }));
    if (selected.length > available) setError(`Attach up to ${MAX_CHAT_ATTACHMENTS_PER_MESSAGE} files per message.`);
    const pending = admitted.map(file => ({ id: file.id, name: file.name, path: "", rootPath: "", status: "pending" as const }));
    updateFiles(items => [...items, ...pending]);
    await Promise.all(admitted.map(async file => {
      if (!preflightComposerChatAttachment(file.name, { workspaceDocuments: true }).ok) {
        if (current()) {
          updateFiles(items => items.map(item => item.id === file.id ? { ...item, status: "error", errorReason: "unsupported file type" } : item));
          setError(`"${file.name}" is not supported. Remove it to send this message.`);
        }
        return;
      }
      try {
        const uploaded = await file.upload();
        if (!current() || !filesRef.current.some(item => item.id === file.id)) {
          if (current()) await apiClient.deleteMessageAttachment(uploaded.attachmentId).catch(() => {});
          return;
        }
        updateFiles(items => items.map(item => item.id === file.id ? { ...item, attachmentId: uploaded.attachmentId, mimeType: uploaded.mimeType, sizeBytes: uploaded.sizeBytes, status: "queued" } : item));
      } catch {
        if (current()) {
          updateFiles(items => items.map(item => item.id === file.id ? { ...item, status: "error", errorReason: "upload failed; remove and try again" } : item));
          setError(`Could not attach "${file.name}". Remove it and try again.`);
        }
      }
    }));
  }
  function queueBrowserFiles(selected: FileList | readonly File[]) {
    void uploadFiles(Array.from(selected, file => ({ name: file.name, upload: () => apiClient.uploadMessageAttachment(file, file.name, { roomId, purpose: "bolter" }) })));
  }
  async function pickFiles() {
    if (!isDesktop || !desktopAPI) { fileInput.current?.click(); return; }
    const current = capture(); setPicking(true);
    try {
      const selected = await desktopAPI.pickFiles();
      if (current()) await uploadFiles(selected.map(file => ({ name: file.name, upload: () => uploadPickedAttachment(file, { roomId, purpose: "bolter" }) })));
    } catch { if (current()) setError("Could not open files. Try attaching them again."); }
    finally { if (current()) setPicking(false); }
  }
  function removeFile(id: string) {
    setError(null);
    const file = filesRef.current.find(item => item.id === id);
    updateFiles(items => items.filter(item => item.id !== id));
    if (file?.attachmentId) void apiClient.deleteMessageAttachment(file.attachmentId).catch(() => {});
  }
  function snapshot(): Review {
    const selectedFiles = filesRef.current.map(file => Object.freeze({ ...file }));
    return Object.freeze({ link: Object.freeze({ ...link! }), draft, files: Object.freeze(selectedFiles),
      request: Object.freeze({ expectedRevision: link!.revision, requestId: crypto.randomUUID(), content: draft.trim() ? draft : "Shared files",
        ...(selectedFiles.length ? { attachmentIds: selectedFiles.map(file => file.attachmentId!) } : {}) }) });
  }
  async function send(value: Review) {
    if (sending.current) return;
    const current = capture(); sending.current = value.request.requestId; setBusy(true); setError(null); setReceipt(null);
    let dispatched = false;
    try {
      const observed = await apiClient.getBolterRoom(roomId);
      if (!current()) return;
      const fresh = observed.link;
      if (!fresh?.canSend || fresh.status !== "active" || fresh.id !== value.link.id || fresh.revision !== value.request.expectedRevision
        || (value.files.length > 0 && !fresh.canAttach)) {
        if (!unconfirmed) setReview(null);
        setError("The destination or connection changed. Check the connection before sending."); await reload(); return;
      }
      unresolvedAttempt.current = value; setAttempt(value); setUnconfirmed(true); dispatched = true;
      const result = await apiClient.sendBolterMessage(value.link.id, value.request);
      if (current()) accepted(value, result);
    } catch (failure) {
      if (current() && (!dispatched || unresolvedAttempt.current?.request.requestId === value.request.requestId)) {
        if (!dispatched) setError("Could not check the connection. Your draft is still here.");
        else if (!unconfirmed && failure instanceof ApiError && [400, 401, 403, 404, 409, 413].includes(failure.status)) {
          unresolvedAttempt.current = null;
          setAttempt(null); setUnconfirmed(false);
          setError("Bolter did not accept this message. Your draft is still here. Check the connection or reattach the files, then try again.");
        } else setError("Delivery is not confirmed. Check its status before trying the same send again.");
      }
    } finally { if (current() && sending.current === value.request.requestId) { sending.current = null; setBusy(false); } }
  }
  function submit() {
    if (review) { void send(review); return; }
    if (!canSend || filesRef.current.some(file => file.status !== "queued" || !file.attachmentId)
      || (!draft.trim() && !filesRef.current.length)) return;
    setError(null); const value = snapshot();
    if (reviewBeforeSend) setReview(value); else void send(value);
  }
  const status = unconfirmed && !busy ? "Delivery unconfirmed" : locked ? "Sending…" : review ? "Review" : draft.trim() || files.length ? `Draft${files.length ? ` · ${files.length} ${files.length === 1 ? "file" : "files"}` : ""}`
    : link.status === "active" ? allowed ? "Connected" : "Unavailable" : link.status === "paused" ? "Paused" : "Disconnected";
  return <section aria-label="Send to Bolter" className="border-t border-border bg-background px-4 py-2 text-xs">
    <button type="button" aria-expanded={expanded} aria-controls={`bolter-draft-${roomId}`}
      aria-label={expanded ? "Minimize Bolter draft" : "Open Bolter draft"} onClick={() => setExpanded(!expanded)}
      className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-[11px] font-semibold uppercase tracking-wide text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground">
      <ChevronRight aria-hidden className={`h-3 w-3 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} />
      <span className="min-w-0 flex-1 truncate" title={review?.link.conversationLabel ?? link.conversationLabel}>Bolter · {review?.link.conversationLabel ?? link.conversationLabel}</span>
      <span className="shrink-0 font-normal normal-case tracking-normal">{status}</span>
    </button>
    {receipt ? <p role="status" className="mt-1 px-1 text-foreground-muted">{bolterDeliveryLabel(receipt.state)}</p> : null}
    {!allowed ? <p className="mt-1 text-foreground-muted">{bolterReason(link.reason ?? "receiver_unavailable")}</p> : null}
    {error ? <p role="alert" className="mt-2 text-[var(--error)]">{error}</p> : null}
    <div id={`bolter-draft-${roomId}`} hidden={!expanded} className="mt-2">
      <div className="relative flex flex-col gap-2 rounded-xl border border-border bg-background-element px-4 py-3"
        onDragOver={event => { if (canAttach && !locked && !review && event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
        onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); if (canAttach && !locked && !review) queueBrowserFiles(event.dataTransfer.files); } }}>
        <p className="text-[11px] text-foreground-muted">Posting as {review?.link.identityLabel ?? link.identityLabel}</p>
        {review ? <div role="region" aria-label="Review message for Bolter" className="space-y-2">
          <h4 ref={reviewHeading} tabIndex={-1} className="text-sm font-medium">Review your message</h4>
          <ComposerAttachmentChips attachments={review.files} onRemove={removeFile} disabled />
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">{review.request.content}</pre>
        </div> : <>
          <ComposerAttachmentChips attachments={files} onRemove={removeFile} disabled={locked} />
          <textarea ref={editor} aria-label="Message to Bolter" placeholder="Message Bolter…" value={draft} disabled={!allowed || locked}
            onChange={event => setDraft(event.target.value)} rows={2}
            onPaste={event => { if (event.clipboardData.files.length && canAttach && !locked) { event.preventDefault(); queueBrowserFiles(event.clipboardData.files); } }}
            className="min-h-[1.5rem] w-full resize-y border-0 bg-transparent p-0 text-sm leading-relaxed text-foreground" />
        </>}
        <div className="flex flex-wrap items-center gap-2">
          {!review ? <>
            <input ref={fileInput} type="file" multiple hidden aria-label="Choose files for Bolter" onChange={event => {
              if (event.target.files) queueBrowserFiles(event.target.files); event.target.value = "";
            }} />
            <button type="button" disabled={!canAttach || locked || picking} onClick={() => void pickFiles()} title={link.canAttach ? "Attach files" : "Update the connected Desktop to share files"} aria-label="Attach files"
              className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground-muted hover:bg-background-element hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer">
              <Paperclip aria-hidden className="h-3.5 w-3.5 stroke-[1.75]" />
            </button>
            <label className="inline-flex items-center gap-2 text-[11px] text-foreground-muted">
              <input type="checkbox" className="accent-[var(--primary)]" checked={reviewBeforeSend} disabled={locked} onChange={event => {
                const next = event.target.checked; setReviewBeforeSend(next);
                try { if (preferenceKey) window.localStorage.setItem(preferenceKey, next ? "on" : "off"); } catch { /* Session choice still works. */ }
              }} />Review before sending
            </label>
          </> : <button type="button" className={secondary} disabled={locked} onClick={() => { setReview(null); setTimeout(() => editor.current?.focus(), 0); }}>Keep editing</button>}
          <div className="ml-auto"><ComposerSendButton label={review || !reviewBeforeSend ? "Send to Bolter" : "Review & send"}
            disabled={review ? locked || !allowed || loading : !canSend} pending={busy} disabledTitle={undefined} onSend={submit} /></div>
        </div>
        <p className="text-[11px] text-foreground-muted">{review ? "Nothing is sent until you click Send to Bolter." : reviewBeforeSend ? "One last preview before posting." : `Sends immediately to ${link.conversationLabel}.`}</p>
        {unconfirmed ? <div className="flex flex-wrap items-center gap-2" role="status">
          <span>Waiting for delivery confirmation.</span>
          <button type="button" className={secondary} disabled={busy} onClick={() => void refreshDelivery()}>Check status</button>
          {error && attempt ? <button type="button" className={secondary} disabled={busy} onClick={() => void send(attempt)}>Recover same request</button> : null}
        </div> : null}
      </div>
    </div>
  </section>;
}
