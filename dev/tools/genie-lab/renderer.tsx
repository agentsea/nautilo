import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CompanionSurface } from "../../../apps/workbench/src/companion/companion-surface";
import { OrbCanvas } from "../../../packages/genie-customization-ui/src/components/OrbCanvas";
import { RuntimeLoader, useRive, useStateMachineInput } from "@rive-app/react-webgl2";
import { initialState, type LabBridge, type LabState } from "./contract";
import "./renderer.css";

declare global { interface Window { genieLab: LabBridge } }
RuntimeLoader.setWasmUrl("genie-lab://app/rive.wasm");

function Persona({ state }: { state: LabState["state"] }) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { const id = requestAnimationFrame(() => setReady(true)); return () => cancelAnimationFrame(id); }, []);
  const { rive, RiveComponent } = useRive(ready ? { src: "genie-lab://app/persona.riv", stateMachines: "default", autoplay: true, onLoadError: () => setFailed(true) } : null);
  const listening = useStateMachineInput(rive, "default", "listening");
  const thinking = useStateMachineInput(rive, "default", "thinking");
  const speaking = useStateMachineInput(rive, "default", "speaking");
  const asleep = useStateMachineInput(rive, "default", "asleep");
  useEffect(() => {
    if (listening) listening.value = state === "listening";
    if (thinking) thinking.value = state === "thinking";
    if (speaking) speaking.value = state === "speaking";
    if (asleep) asleep.value = state === "muted";
  }, [state, listening, thinking, speaking, asleep]);
  return failed ? <div className="static-orb" title="Persona could not load" /> : <RiveComponent />;
}

function Lab() {
  const [state, setState] = useState(initialState);
  const [draft, setDraft] = useState("");
  const [drafts, setDrafts] = useState<string[]>([]);
  const [reducedMotion, setReducedMotion] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const unsubscribe = window.genieLab.subscribe(setState);
    void window.genieLab.getState().then(setState);
    return unsubscribe;
  }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const views = ["orb", "prompt", "chat"] as const;
      const view = views[Number(event.key) - 1];
      if ((event.metaKey || event.ctrlKey) && view) {
        event.preventDefault();
        window.genieLab.command({ type: "view", value: view });
      }
      if (event.shiftKey && event.key === "F10") {
        event.preventDefault();
        window.genieLab.command({ type: "menu" });
      }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, []);
  const size = state.view === "orb" ? 76 : 38;
  const avatar = state.reducedMotion || reducedMotion ? <div className="static-orb" /> : state.visual === "persona" ? <Persona state={state.state} /> : <OrbCanvas size={size} orbState={state.state === "thinking" ? "compiling" : state.state === "listening" || state.state === "speaking" ? "speaking" : "idle"} />;
  return <CompanionSurface
    view={state.view} state={state.state} name="Genie Lab"
    status={`Preview: ${state.state} · microphone off`}
    avatar={avatar} draft={draft} onDraft={setDraft}
    onSubmit={() => { if (draft.trim()) { setDrafts(value => [...value, draft.trim()]); setDraft(""); window.genieLab.command({ type: "view", value: "chat" }); } }}
    onTalk={() => window.genieLab.command({ type: "state", value: state.state === "listening" ? "idle" : "listening" })}
    onView={value => window.genieLab.command({ type: "view", value })}
    onMenu={() => window.genieLab.command({ type: "menu" })}
    onDrag={phase => window.genieLab.command({ type: `drag-${phase}` })}
    talkLabel={`Preview ${state.state === "listening" ? "idle" : "listening"} animation; microphone stays off`}
    submitLabel="Keep a local preview draft"
  >
    <div className="lab-intro"><span className="lab-eyebrow">A LITTLE SPACE FOR BIG IDEAS</span><h1>Your Genie.<br />Within reach.</h1><p>Drag her anywhere. Make her tiny.<br />Give her a home at the edge of your screen.</p><div className="lab-note">Shell preview · microphone off<br />Drafts stay here and are never sent.</div></div>
    {drafts.map((text, index) => <div className="lab-draft" key={index}><small>LOCAL DRAFT</small><p>{text}</p></div>)}
  </CompanionSurface>;
}
createRoot(document.getElementById("root")!).render(<Lab />);
