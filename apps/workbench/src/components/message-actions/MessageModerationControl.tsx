import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Shield } from "lucide-react";
import { apiClient } from "../../lib/api";
import { createWorkbenchPortal } from "../workbench-portals";
import { useToast } from "../toast";
import { ModerationPersonControls, moderationError } from "../../pages/admin/sections/moderation-person-controls";

type Person = Awaited<ReturnType<typeof apiClient.getModerationPerson>>;

type Confirmation = { userId: string; enabled: boolean; action: "ban" | "kick"; trigger: HTMLButtonElement | null };
const MessageModerationContext = createContext<((selection: Confirmation) => void) | null>(null);

/** The confirmation belongs to the conversation: deleting the source message
 * must not unmount an in-flight ban or lose its receipt/retry controls. */
export function MessageModerationProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [selection, setSelection] = useState<Confirmation | null>(null);
  const [unresolved, setUnresolved] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => { if (selection) dialog.current?.showModal(); }, [selection]);
  const close = () => {
    if (unresolved) return;
    if (selection?.trigger?.isConnected) selection.trigger.focus();
    setSelection(null);
  };
  return <MessageModerationContext.Provider value={setSelection}>
    {children}
    {selection && createWorkbenchPortal(<dialog ref={dialog} aria-labelledby={titleId}
      className="m-auto max-h-[85vh] w-[min(36rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-border bg-background-panel p-5 text-foreground shadow-xl backdrop:bg-black/50"
      onCancel={event => { event.preventDefault(); close(); }}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 id={titleId} className="text-base font-semibold">{selection.action === "ban" ? "Ban from Server" : "Kick from Server"}</h2>
        <button type="button" disabled={unresolved} onClick={close} aria-label="Close moderation" className="rounded px-2 py-1 disabled:opacity-40">✕</button>
      </div>
      <ModerationPersonControls userId={selection.userId} enabled={selection.enabled} initialAction={selection.action} onUnresolvedChange={setUnresolved}
        onComplete={(receipt, displayName) => {
          if (selection.trigger?.isConnected) selection.trigger.focus();
          setUnresolved(false);
          setSelection(null);
          toast.show({
            variant: receipt.converged && receipt.auditRecorded ? "success" : "warning",
            message: `${displayName} ${receipt.action === "ban" ? "banned" : "kicked"}.`
              + (receipt.messageCleanup === "complete" ? " Community messages removed; private history preserved." : "")
              + (!receipt.converged ? " Connection and running-work cleanup is pending." : "")
              + (!receipt.auditRecorded ? " Audit recovery is pending." : ""),
          });
        }} />
    </dialog>, document.body)}
  </MessageModerationContext.Provider>;
}

/** Only mounted for an identified Human and a caller with a moderation grant.
 * Opening resolves target-specific authority; commands recheck it on the server. */
export function MessageModerationControl({ userId, displayName }: { userId: string; displayName: string }) {
  const [open, setOpen] = useState(false);
  const [person, setPerson] = useState<Person | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openConfirmation = useContext(MessageModerationContext);
  const [position, setPosition] = useState({ left: 0, bottom: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setPerson(null); setError(null);
    void Promise.all([apiClient.getModerationPerson({ userId }), apiClient.getModerationPolicy()]).then(([found, policy]) => {
      if (active) { setPerson(found); setEnabled(policy.enabled); }
    }).catch(cause => { if (active) setError(moderationError(cause)); });
    const dismiss = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", dismiss);
    return () => { active = false; document.removeEventListener("mousedown", dismiss); };
  }, [open, userId]);
  useEffect(() => { if (open) menu.current?.focus(); }, [open]);
  return <>
    <button ref={trigger} type="button" title="Moderation" aria-label={`Moderation for ${displayName}`} aria-haspopup="menu" aria-expanded={open}
      className="flex h-7 shrink-0 items-center gap-0.5 rounded-md px-1 text-foreground-muted hover:bg-background-element"
      onClick={() => {
        const rect = trigger.current!.getBoundingClientRect();
        setPosition({ left: rect.left, bottom: window.innerHeight - rect.top }); setOpen(value => !value);
      }}>
      <Shield aria-hidden className="h-3.5 w-3.5" /><ChevronDown aria-hidden className="h-3 w-3" />
    </button>
    {open && createWorkbenchPortal(<div ref={menu} role="menu" tabIndex={-1} aria-label={`Moderation for ${displayName}`}
      className="fixed z-50 max-w-[calc(100vw-2rem)] rounded border border-border bg-background-panel p-1 shadow-lg"
      style={position} onKeyDown={event => {
        if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); }
        if (event.key === "Tab") setOpen(false);
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const choices = Array.from(menu.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
          const index = choices.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1
            : (index + (event.key === "ArrowUp" ? -1 : 1) + choices.length) % choices.length;
          choices[next]?.focus();
        }
      }}>
      <p className="max-w-64 break-words px-3 py-2 text-sm font-medium">{person?.person.displayName ?? displayName}</p>
      {error ? <p role="alert" className="max-w-64 px-3 py-2 text-sm">{error}</p>
        : !person ? <p role="status" className="px-3 py-2 text-sm">Checking permissions…</p>
        : !enabled ? <p className="max-w-64 px-3 py-2 text-sm">Enable moderation in Server admin to use these controls.</p>
        : person.person.protectedTarget ? <p className="max-w-64 px-3 py-2 text-sm">Your permissions do not allow moderating this person.</p>
        : <>{(["kick", "ban"] as const).filter(value => person.person.allowedActions.includes(value)).map(value =>
          <button key={value} type="button" role="menuitem" className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-background-element"
            onClick={() => { setOpen(false); openConfirmation?.({ userId, enabled, action: value, trigger: trigger.current }); }}>{value === "ban" ? "Ban from Server…" : "Kick from Server…"}</button>)}
          {!person.person.allowedActions.some(value => value === "kick" || value === "ban") && <p className="px-3 py-2 text-sm">No available actions.</p>}</>}
    </div>, document.body)}

  </>;
}
