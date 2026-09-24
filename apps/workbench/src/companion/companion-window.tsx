import { CompanionAudioControls } from "./companion-audio-controls";
import { StopTalkingIcon } from "../components/conversation/StopTalkingIcon";
import { ArrowUp, CircleAlert, LoaderCircle, Mic, Paperclip, Square, VolumeX } from "lucide-react";
import { VoicePlaybackStopPill } from "../components/conversation/VoicePlaybackStopPill";
import { CompanionComposer, CompanionConversationProvider, CompanionTranscript } from "./companion-conversation";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { OrbCanvas } from "../../../../packages/genie-customization-ui/src/components/OrbCanvas";
import type { CompanionAction, CompanionWindowAPI, CompanionWindowState } from "../../../desktop/electron/companion-contract";
import { CompanionSurface } from "./companion-surface";
import { bubbleInteraction } from "./companion-bubble-interaction";
import { stripAssistantArtifacts } from "../lib/strip-assistant-artifacts";
import { companionStatus } from "./companion-status";
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
        : (snapshot.canStopTalking ?? snapshot.speaking) ? "stop-talking" : snapshot.workRunning || snapshot.busy ? "stop-task" : null;
      if (type) { event.preventDefault(); void bridge.command(current.generation, { type }).catch(() => {}); }
    };
    document.addEventListener("contextmenu", menu);
    document.addEventListener("keydown", key);
    return () => { mounted = false; unsubscribe(); motion.removeEventListener("change", updateMotion); document.removeEventListener("visibilitychange", updateVisibility); document.removeEventListener("contextmenu", menu); document.removeEventListener("keydown", key); };
  }, [bridge]);
  const generation = state?.generation;
  useEffect(() => { const name = stateRef.current?.snapshot.binding.name; document.title = name ? `${name} — Floating Genie` : "Floating Genie"; }, [state?.snapshot.binding.name]);
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
  const canStopTalking = snapshot.canStopTalking ?? snapshot.speaking;
  const capturing = ["requesting", "listening", "transcribing"].includes(snapshot.capture);
  const stopping = snapshot.stopState === "stopping";
  const working = snapshot.workRunning || snapshot.busy;
  const blockedSend = snapshot.busy || stopping || capturing || snapshot.attachments.some(a => a.status !== "ready");
  const activity = error || snapshot.error ? "error" : snapshot.capture === "listening" ? "listening"
    : snapshot.speaking ? "speaking" : working || capturing || stopping ? "thinking" : "muted";
  const status = companionStatus(snapshot);
  const bubble = bubbleInteraction(snapshot);
  const Cue = bubble.cue === "send" ? ArrowUp : bubble.cue === "pending" ? LoaderCircle : bubble.cue === "error" ? CircleAlert : Mic;
  const messageText = (content: (typeof snapshot.messages)[number]["content"]) => typeof content === "string"
    ? content : content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
  const latestMessage = [...snapshot.messages].reverse().find(message => messageText(message.content).trim());
  const latestText = latestMessage ? messageText(latestMessage.content) : "";
  const audio = <CompanionAudioControls capture={snapshot.capture} sound={snapshot.voiceEnabled}
    onMic={() => command({ type: "mic" })} onSound={() => command({ type: "sound", enabled: !snapshot.voiceEnabled })} />;
  const stopTalking = <button type="button" className="companion-icon companion-stop-talking" disabled={!canStopTalking}
    title="Stop talking" aria-label="Stop talking" onClick={() => command({ type: "stop-talking" })}><StopTalkingIcon /></button>;
  const stopTask = <button type="button" className="companion-icon companion-stop-task" disabled={stopping || (!working && !capturing && snapshot.stopState !== "failed")} aria-label={stopping ? "Stopping action" : "Stop action"}
    title="Stop action in this Room" onClick={() => command({ type: "stop-task" })}><Square size={14} /><span>{stopping ? "Stopping…" : "Stop action"}</span></button>;
  const controls = <>
    <button type="button" className="companion-icon" disabled={!snapshot.canAttach || snapshot.pickingAttachments || snapshot.busy} title="Attach files" aria-label="Attach files"
      onClick={() => { command({ type: "view", value: "chat" }); command({ type: "attach" }); }}><Paperclip size={16} /></button>
    {stopTask}
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
    name={snapshot.binding.name} status={state.view === "orb" ? bubble.label : status}
    avatar={avatar}
    draft={draft} onDraft={text => { setDraft(text); command({ type: "draft", text }); }}
    onSubmit={() => {
      if ((!draft.trim() && !snapshot.attachments.length) || blockedSend) return;
      pendingSend.current = draft;
      command({ type: "send", text: draft });
    }}
    onTalk={() => command({ type: "talk" })}
    onView={value => command({ type: "view", value })}
    onMenu={() => command({ type: "menu" })}
    onClose={() => command({ type: "off" })}
    onDrag={phase => command({ type: `drag-${phase}` })}
    talkLabel={bubble.label} submitLabel="Send to Genie"
    busy={snapshot.busy}
    headerControls={<div className="companion-header-audio">{audio}</div>}
    primaryDisabled={bubble.disabled}
    compactControls={<>
      <button type="button" className={`companion-bubble-cue${snapshot.capture === "listening" ? " is-recording" : ""}`}
        disabled={bubble.disabled} aria-label={bubble.label} title={bubble.label} onClick={() => command({ type: "talk" })}>
        <Cue size={15} className={bubble.cue === "pending" ? "companion-spinner" : undefined} />
      </button>
      <span className="companion-small-stop">{stopTask}</span><span className="companion-small-speech-stop">{stopTalking}</span>
      {!snapshot.voiceEnabled && <button type="button" className="companion-muted-indicator" aria-label="Sound off — enable spoken replies" title="Sound off — enable spoken replies" onClick={() => command({ type: "sound", enabled: true })}><VolumeX size={11} /></button>}
      {(error || snapshot.error) && <span className="sr-only" role="alert">{error || snapshot.error}</span>}
    </>}
    preview={<button type="button" className="companion-panel-preview" onClick={() => command({ type: "view", value: "chat" })} aria-label="Show conversation">
      {latestMessage ? <><strong>{latestMessage.role === "user" ? "You" : snapshot.binding.name}</strong><span>{stripAssistantArtifacts(latestText)}</span></> : <span>Show conversation</span>}
    </button>}
    transcript={<CompanionTranscript snapshot={snapshot} />}
    composer={<CompanionComposer draft={draft} name={snapshot.binding.name} busy={blockedSend}
      sending={snapshot.busy} controls={controls} attachments={snapshot.attachments} error={error || snapshot.error}
      capture={snapshot.capture}
      voiceStop={<><span className="companion-operation-status" role="status">{!canStopTalking && (capturing || working || stopping) ? status : ""}</span><VoicePlaybackStopPill enabled={snapshot.voiceEnabled} playing={snapshot.speaking} canStop={canStopTalking} onStop={() => command({ type: "stop-talking" })} /></>}
      onRemoveAttachment={id => command({ type: "remove-attachment", id })}
      onDraft={text => { setDraft(text); command({ type: "draft", text }); }}
      onSubmit={text => { pendingSend.current = text; command({ type: "send", text }); }} /> }
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
