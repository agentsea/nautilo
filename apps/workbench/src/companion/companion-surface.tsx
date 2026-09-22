import { useEffect, useRef, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { ArrowUp, CircleAlert, Expand, Grip, Mic, MicOff, Minimize2, MoreHorizontal, Square, X } from "lucide-react";
import "./companion.css";

export type CompanionView = "orb" | "waveform" | "prompt" | "chat";
export type CompanionState = "idle" | "listening" | "thinking" | "speaking" | "muted" | "error";
export interface CompanionSurfaceProps {
  view: CompanionView;
  state: CompanionState;
  name: string;
  status: string;
  avatar: ReactNode;
  draft: string;
  onDraft: (value: string) => void;
  onSubmit: () => void;
  onTalk: () => void;
  onMenu: () => void;
  onClose?: () => void;
  onView: (view: CompanionView) => void;
  onDrag: (phase: "start" | "move" | "end" | "cancel") => void;
  talkLabel: string;
  submitLabel: string;
  busy?: boolean;
  compactControls?: ReactNode;
  toolbar?: ReactNode;
  composer?: ReactNode;
  transcript?: ReactNode;
  children?: ReactNode;
}

/** A controlled shared surface: the host owns identity, media and admission. */
export function CompanionSurface(props: CompanionSurfaceProps) {
  const { view, state } = props;
  const pointer = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const compactButton = useRef<HTMLButtonElement>(null);
  const previousView = useRef(view);
  useEffect(() => {
    if (previousView.current === view) return;
    previousView.current = view;
    // Move keyboard focus with the user's density change, without taking focus
    // from another application when the companion first appears.
    if (view === "orb" || view === "waveform") compactButton.current?.focus();
    else input.current?.focus();
  }, [view]);
  function down(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0 || (event.currentTarget.tagName !== "BUTTON" && (event.target as Element).closest("button, input, textarea, [contenteditable]"))) return;
    pointer.current = { x: event.screenX, y: event.screenY, moved: false };
    suppressClick.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
    props.onDrag("start");
  }
  function move(event: PointerEvent<HTMLElement>) {
    const start = pointer.current;
    if (!start) return;
    if (Math.hypot(event.screenX - start.x, event.screenY - start.y) >= 5) start.moved = true;
    props.onDrag("move");
  }
  function up(event: PointerEvent<HTMLElement>) {
    if (!pointer.current) return;
    suppressClick.current = pointer.current.moved;
    pointer.current = null;
    props.onDrag("end");
    event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function cancel() { pointer.current = null; props.onDrag("cancel"); }
  const dragHandlers = { onPointerDown: down, onPointerMove: move, onPointerUp: up, onPointerCancel: cancel, onLostPointerCapture: cancel };
  function talk() {
    if (suppressClick.current) { suppressClick.current = false; return; }
    props.onTalk();
  }
  const StateIcon = state === "muted" ? MicOff : state === "error" ? CircleAlert : state === "speaking" ? Square : Mic;
  const compact = view === "orb" || view === "waveform";
  const visual = <div className="companion-avatar" aria-hidden>{props.avatar}</div>;
  return (
    <section className={`companion companion-${view}`} data-state={state} aria-label={`${props.name} companion`}>
      {compact ? (
        <>
        <button ref={compactButton} className="companion-compact" {...dragHandlers} onClick={talk} aria-label={props.talkLabel} title={`${props.talkLabel} · Right-click or Shift+F10 for controls`}>
          {visual}{view === "waveform" && <Waveform state={state} />}
          <span className="companion-state-icon"><StateIcon size={13} /></span>
          <span className="sr-only" role="status">{props.status}</span>
        </button>
        {props.compactControls}
        {props.onClose && <button type="button" className="companion-small-close" onClick={props.onClose} aria-label="Stop floating and attach Genie" title="Stop floating and attach Genie"><X size={11} /></button>}
        <button className="companion-small-expand" onClick={() => props.onView("chat")} aria-label="Expand Genie" title="Expand Genie"><Expand size={12} /></button>
        </>
      ) : (
        <>
          <header className="companion-header" {...dragHandlers} title="Drag Genie">
            {props.onClose && <button type="button" className="companion-icon" onClick={props.onClose} aria-label="Stop floating and attach Genie" title="Stop floating and attach Genie"><X size={16} /></button>}
            <div className="companion-handle"><Grip size={12} />{visual}</div>
            <div className="companion-identity"><strong>{props.name}</strong><span role="status">{props.status}</span></div>
            <button className="companion-icon" aria-label={view === "chat" ? "Collapse to bubble" : "Expand chat"} onClick={() => props.onView(view === "chat" ? "orb" : "chat")}>
              {view === "chat" ? <Minimize2 size={16} /> : <Expand size={16} />}
            </button>
            <button className="companion-icon" onClick={props.onMenu} aria-label="Companion controls"><MoreHorizontal size={18} /></button>
          </header>
          {view === "chat" && props.toolbar}
          {view === "chat" && (props.transcript ?? <div className="companion-messages">{props.children}</div>)}
          {props.composer ?? <form className="companion-composer" onSubmit={event => { event.preventDefault(); props.onSubmit(); input.current?.focus(); }}>
            <input ref={input} value={props.draft} onChange={event => props.onDraft(event.target.value)} aria-label="Message draft" placeholder="What's on your mind?" />
            <button type="button" className="companion-icon companion-talk" onClick={props.onTalk} aria-label={props.talkLabel}><StateIcon size={17} /></button>
            <button className="companion-send" type="submit" aria-label={props.submitLabel} disabled={!props.draft.trim() || props.busy}><ArrowUp size={17} /></button>
          </form>}
        </>
      )}
    </section>
  );
}

function Waveform({ state }: { state: CompanionState }) {
  return <div className="companion-wave" aria-hidden>{Array.from({ length: 13 }, (_, i) => <i key={i} style={{ "--bar": `${8 + Math.sin(i * 1.7) ** 2 * 21}px`, "--delay": `${i * -0.075}s` } as CSSProperties} />)}<span className={`companion-wave-dot ${state}`} /></div>;
}
