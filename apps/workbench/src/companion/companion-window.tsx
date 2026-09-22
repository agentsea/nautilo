import { Mic, MicOff, Paperclip, Square, VolumeX, LoaderCircle } from "lucide-react";
import { CompanionComposer, CompanionConversationProvider, CompanionTranscript } from "./companion-conversation";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { OrbCanvas } from "../../../../packages/genie-customization-ui/src/components/OrbCanvas";
import type { CompanionAction, CompanionWindowAPI, CompanionWindowState } from "../../../desktop/electron/companion-contract";
import { CompanionSurface } from "./companion-surface";
import "./companion-window.css";

declare global { interface Window { nautiloCompanion?: CompanionWindowAPI } }

function CompanionWindow() {
  const bridge = window.nautiloCompanion!;
  const [state, setState] = useState<CompanionWindowState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const pendingSend = useRef<string | null>(null);
  const [reducedMotion, setReducedMotion] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [visible, setVisible] = useState(!document.hidden);
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    let mounted = true;
    let receivedPush = false;
    const apply = (next: CompanionWindowState) => {
      if (!mounted) return;
      setState(next);
    };
    const unsubscribe = bridge.subscribe(next => { receivedPush = true; apply(next); });
    void bridge.getState().then(next => { if (!receivedPush) apply(next); }).catch(() => setError("Companion disconnected. Reopen her from Nautilo."));
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => setReducedMotion(motion.matches);
    const updateVisibility = () => setVisible(!document.hidden);
    motion.addEventListener("change", updateMotion);
    document.addEventListener("visibilitychange", updateVisibility);
    const menu = (event: Event) => {
      event.preventDefault();
      const current = stateRef.current;
      if (current) void bridge.command(current.generation, { type: "menu" }).catch(() => {});
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "F10" && event.shiftKey) menu(event);
      if (event.key !== "Escape") return;
      const current = stateRef.current;
      if (!current) return;
      const snapshot = current.snapshot;
      const type = ["requesting", "listening", "transcribing"].includes(snapshot.capture) ? "mute"
        : snapshot.speaking ? "stop-talking" : snapshot.workRunning || snapshot.busy ? "stop-task" : null;
      if (type) { event.preventDefault(); void bridge.command(current.generation, { type }).catch(() => {}); }
    };
    document.addEventListener("contextmenu", menu);
    document.addEventListener("keydown", key);
    return () => { mounted = false; unsubscribe(); motion.removeEventListener("change", updateMotion); document.removeEventListener("visibilitychange", updateVisibility); document.removeEventListener("contextmenu", menu); document.removeEventListener("keydown", key); };
  }, [bridge]);
  const generation = state?.generation;
  useEffect(() => { document.title = state ? `${state.snapshot.binding.name} — Floating Genie` : "Floating Genie"; }, [state?.snapshot.binding.name]);
  useEffect(() => { setDraft(stateRef.current?.snapshot.draft ?? ""); }, [generation]);
  useEffect(() => {
    const snapshot = stateRef.current?.snapshot;
    if (!snapshot || snapshot.draftRevision === 0) return;
    setDraft(current => current === snapshot.draftBase ? snapshot.draft
      : snapshot.dictationText ? [current, snapshot.dictationText].filter(Boolean).join("\n") : current);
  }, [state?.snapshot.draftRevision]);
  useEffect(() => {
    const snapshot = state?.snapshot;
    if (snapshot && !snapshot.busy && !snapshot.error && snapshot.draft === "" && pendingSend.current !== null) {
      const sent = pendingSend.current;
      pendingSend.current = null;
      setDraft(current => current === sent ? "" : current);
    }
  }, [state?.snapshot]);
  function command(action: CompanionAction) {
    if (!state) return;
    void bridge.command(state.generation, action).catch(() => setError("Companion disconnected. Reopen her from Nautilo."));
  }
  if (!state) return error ? <p role="alert">{error}</p> : null;
  const snapshot = state.snapshot;
  const capturing = ["requesting", "listening", "transcribing"].includes(snapshot.capture);
  const stopping = snapshot.stopState === "stopping";
  const working = snapshot.workRunning || snapshot.busy;
  const blockedSend = snapshot.busy || stopping || capturing || snapshot.attachments.some(a => a.status !== "ready");
  const micLabel = snapshot.capture === "listening" ? "Finish recording and send" : capturing ? "Cancel recording or transcription" : "Record a voice message";
  const talkLabel = snapshot.speaking ? "Stop talking" : micLabel;
  const activity = error || snapshot.error ? "error" : snapshot.capture === "listening" ? "listening"
    : snapshot.speaking ? "speaking" : working || capturing || stopping ? "thinking" : "muted";
  const status = stopping ? "Stopping task…" : snapshot.capture === "requesting" ? "Opening microphone…"
    : snapshot.capture === "listening" ? "Listening · tap mic to send" : snapshot.capture === "transcribing" ? "Transcribing…"
    : snapshot.speaking ? "Speaking · tap to stop" : working ? "Working · microphone off" : "Microphone off";
  const mic = () => command({ type: "mic" });
  const stopTask = <button type="button" className="companion-icon companion-stop-task" disabled={stopping} aria-label={stopping ? "Stopping task" : "Stop task"}
    title="Stop task in this Room" onClick={() => command({ type: "stop-task" })}><Square size={14} fill="currentColor" /></button>;
  const controls = <>
    <button type="button" className="companion-icon" disabled={!snapshot.canAttach || snapshot.pickingAttachments || snapshot.busy} title="Attach files" aria-label="Attach files"
      onClick={() => { command({ type: "view", value: "chat" }); command({ type: "attach" }); }}><Paperclip size={16} /></button>
    <button type="button" className="companion-icon" title={micLabel} aria-label={micLabel} aria-pressed={snapshot.capture === "listening"} onClick={mic}>
      {snapshot.capture === "transcribing" || snapshot.capture === "requesting" ? <LoaderCircle size={16} /> : <Mic size={16} />}
    </button>
    {capturing && <button type="button" className="companion-icon" title="Mute and discard recording" aria-label="Mute and discard recording" onClick={() => command({ type: "mute" })}><MicOff size={16} /></button>}
    {snapshot.voiceEnabled && <button type="button" className="companion-icon" title="Stop talking" aria-label="Stop talking" onClick={() => command({ type: "stop-talking" })}><VolumeX size={16} /></button>}
    {(working || stopping || snapshot.stopState === "failed") && stopTask}
    <span className="companion-control-spacer" />
  </>;
  const portrait = <div className="companion-portrait">
    {snapshot.avatarDataUrl
      ? <img src={snapshot.avatarDataUrl} alt={snapshot.binding.name} draggable={false} />
      : <span className="companion-initials">{snapshot.binding.name.trim().slice(0, 1).toUpperCase()}</span>}
  </div>;
  const avatar = state.view === "orb" && state.bubbleAppearance === "orb"
    ? reducedMotion || !visible ? <div className="companion-static-orb" /> : <OrbCanvas size={76} orbState={working || capturing ? "compiling" : "idle"} />
    : portrait;
  return <CompanionConversationProvider key={state.generation} snapshot={snapshot}><CompanionSurface
    view={state.view} state={activity}
    name={snapshot.binding.name} status={status}
    avatar={avatar}
    draft={draft} onDraft={text => { setDraft(text); command({ type: "draft", text }); }}
    onSubmit={() => {
      if ((!draft.trim() && !snapshot.attachments.length) || blockedSend) return;
      pendingSend.current = draft;
      command({ type: "send", text: draft });
      command({ type: "view", value: "chat" });
    }}
    onTalk={() => command({ type: snapshot.speaking ? "stop-talking" : "mic" })}
    onView={value => command({ type: "view", value })}
    onMenu={() => command({ type: "menu" })}
    onClose={() => command({ type: "off" })}
    onDrag={phase => command({ type: `drag-${phase}` })}
    talkLabel={talkLabel} submitLabel="Send to Genie"
    busy={snapshot.busy}
    compactControls={<>
      {(working || stopping || snapshot.stopState === "failed") && <span className="companion-small-stop">{stopTask}</span>}
      {capturing && <button className="companion-small-mute" title="Mute and discard recording" aria-label="Mute and discard recording" onClick={() => command({ type: "mute" })}><MicOff size={12} /></button>}
      {(error || snapshot.error) && <span className="sr-only" role="alert">{error || snapshot.error}</span>}
    </>}
    transcript={<CompanionTranscript snapshot={snapshot} />}
    composer={<CompanionComposer draft={draft} name={snapshot.binding.name} busy={blockedSend}
      sending={snapshot.busy} controls={controls} attachments={snapshot.attachments} error={error || snapshot.error}
      onRemoveAttachment={id => command({ type: "remove-attachment", id })}
      onDraft={text => { setDraft(text); command({ type: "draft", text }); }}
      onSubmit={text => { pendingSend.current = text; command({ type: "send", text }); command({ type: "view", value: "chat" }); }} /> }
    toolbar={<>
      <div className="companion-room-actions"><button onClick={() => command({ type: "return" })}>Open Room in Nautilo</button><button onClick={() => command({ type: "refresh" })}>Refresh</button></div>

    </>}
  >
  </CompanionSurface></CompanionConversationProvider>;
}

export function startCompanionWindow() {
  document.documentElement.classList.add("companion-document", "dark");
  createRoot(document.getElementById("root")!).render(<CompanionWindow />);
}
