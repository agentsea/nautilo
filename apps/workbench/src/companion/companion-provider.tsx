import { CompanionVoiceContext } from "./companion-voice";
import { createBrowserSpeechCapture } from "../hooks/use-speech-recognition";
import { apiClient } from "../lib/api";
import { uploadPickedAttachment } from "../lib/composer-upload";
import { useTaskState } from "../contexts/task-state/task-state-context";
import { hasStoppableRoomTask } from "../components/composer/composer-stop-state";
import { loadCompanionAvatar } from "./companion-avatar";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import type { CompanionBinding, CompanionSnapshot } from "../../../desktop/electron/companion-contract";
import { useRoomMessageOperations, useWsStateContext } from "../adapters/runtime-contexts";
import { useRoomNavigation } from "../contexts/room-navigation-context";
import { useAuth } from "../hooks/use-auth";
import { useCan } from "../hooks/use-can";
import { desktopAPI } from "../lib/desktop";
import { withCurrentClientActionSession } from "../lib/client-action-session";
import { addAuthTransitionListener } from "../lib/auth-transition";
import { getCryptoAdmissionSnapshot, isCryptoAdmissionAllowed, subscribeCryptoAdmissionAccess } from "../lib/crypto-admission-access";
import { CompanionController } from "./companion-controller";
import { RoomChangeSourceContext } from "./room-changes";

const CompanionContext = createContext<{
  controller: CompanionController | null; snapshot: CompanionSnapshot | null;
  target: CompanionBinding | null; setTarget: (target: CompanionBinding | null) => void;
}>({ controller: null, snapshot: null, target: null, setTarget: () => {} });

export function CompanionProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const can = useCan();
  const voice = useContext(CompanionVoiceContext);
  const { tasks } = useTaskState();
  const canAttach = can("write_artifacts");
  const operations = useRoomMessageOperations();
  const navigation = useRoomNavigation();
  const changes = useContext(RoomChangeSourceContext);
  const { state: connection } = useWsStateContext();
  const [target, setTarget] = useState<CompanionBinding | null>(null);
  const [snapshot, setSnapshot] = useState<CompanionSnapshot | null>(null);
  const viewer = auth.viewer.sessionUserId;
  const actor = auth.viewer.sessionActorId;
  const identity = `${viewer ?? ""}:${actor ?? ""}`;
  const allowed = can("invoke_agents") && auth.viewer.isVerified && !!viewer && !!actor;
  const latest = useRef({ operations, navigation, allowed, connection, identity, voice, tasks, canAttach });
  latest.current = { operations, navigation, allowed, connection, identity, voice, tasks, canAttach };
  const controller = useMemo(() => {
    const bridge = desktopAPI?.companion;
    if (!bridge) return null;
    return new CompanionController({
      bridge, changed: setSnapshot, loadAvatar: loadCompanionAvatar, operations: () => latest.current.operations,
      admitted: () => latest.current.identity === identity && latest.current.allowed && latest.current.connection === "open" && isCryptoAdmissionAllowed(),
      openRoom: roomId => latest.current.navigation.setActiveRoom(roomId),
      media: {
        createCapture: createBrowserSpeechCapture,
        prepare: () => latest.current.voice?.prepare(),
        enable: roomId => latest.current.voice?.enable(roomId),
        setEnabled: enabled => latest.current.voice?.setEnabled(enabled),
        release: roomId => latest.current.voice?.release(roomId),
        stopTalking: () => latest.current.voice?.stopTalking(),
      },
      canAttach: () => latest.current.canAttach,
      upload: async (file, roomId) => (await uploadPickedAttachment(file, { roomId })).attachmentId,
      workRunning: async roomId => (await apiClient.getRoomActiveJobs(roomId)).jobIds.length > 0 || hasStoppableRoomTask(latest.current.tasks, roomId),
      stopTask: roomId => apiClient.stopRoom(roomId),
      send: (binding, text, options) => latest.current.operations.sendRoomMessage(binding.roomId, withCurrentClientActionSession({
        content: text, uiSelectedBotActorId: binding.botActorId, voiceMode: options.voiceMode, attachments: options.attachments,
        userTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })),
    });
  }, [identity]);
  useEffect(() => {
    if (!controller || !desktopAPI?.companion) return;
    const bridge = desktopAPI.companion;
    const removeAction = bridge.onAction((generation, action) => { void controller.action(generation, action); });
    const removeClosed = bridge.onClosed(generation => controller.closed(generation));
    const removeChanges = changes?.subscribe(roomId => controller.invalidate(roomId));
    const removeAuth = addAuthTransitionListener(event => {
      if (event.reason === "signed-out" || event.reason === "user-switched" || event.reason === "instance-switched") controller.stop();
    });
    let admission = getCryptoAdmissionSnapshot().generation;
    const removeAdmission = subscribeCryptoAdmissionAccess(() => {
      const next = getCryptoAdmissionSnapshot();
      if (!isCryptoAdmissionAllowed() || next.generation !== admission) controller.stop();
      admission = next.generation;
    });
    return () => { removeAction(); removeClosed(); removeChanges?.(); removeAuth(); removeAdmission(); controller.stop(); };
  }, [controller, changes]);
  const boundRoomId = snapshot?.binding.roomId;
  useEffect(() => {
    if (!controller || !boundRoomId) return;
    return changes?.subscribeToRoom(boundRoomId, event => controller.ingestEvent(boundRoomId, event));
  }, [controller, changes, boundRoomId]);
  useEffect(() => {
    if (snapshot && voice?.enabled && voice.roomId === snapshot.binding.roomId && voice.pinnedRoomId !== snapshot.binding.roomId) {
      voice.enable(snapshot.binding.roomId);
    }
    controller?.updateMedia(voice?.roomId ?? null, voice?.enabled ?? false, voice?.playing ?? false, voice?.canStopTalking ?? false);
  }, [controller, voice?.roomId, voice?.pinnedRoomId, voice?.enabled, voice?.playing, voice?.canStopTalking, snapshot?.binding.roomId]);
  useEffect(() => {
    if (snapshot) controller?.invalidate(snapshot.binding.roomId);
  }, [controller, tasks, canAttach, snapshot?.binding.roomId]);
  // Identity/capability/transport transitions close the surface. Room selection
  // deliberately is not a dependency: the binding belongs to the companion.
  useEffect(() => { controller?.stop(); }, [controller, viewer, actor, allowed, connection]);
  return <CompanionContext.Provider value={{ controller, snapshot, target, setTarget }}>{children}</CompanionContext.Provider>;
}

/** The composer supplies its canonical selection without adding toolbar chrome. */
export function CompanionTarget({ binding }: { binding: CompanionBinding | null }) {
  const { setTarget } = useContext(CompanionContext);
  useEffect(() => {
    setTarget(binding);
    return () => setTarget(null);
  }, [setTarget, binding?.roomId, binding?.agentId, binding?.botActorId, binding?.name]);
  return null;
}

export function FloatGenieButton() {
  const { controller, snapshot, target: binding } = useContext(CompanionContext);
  const [error, setError] = useState<string | null>(null);
  const [enabling, setEnabling] = useState(false);
  if (!controller) return null;
  const active = snapshot?.binding;
  const label = active ? `Floating — attach ${active.name} back in Nautilo` : "Float Genie";
  return <span className="relative inline-flex">
    <button type="button" disabled={(!binding && !active) || enabling}
      aria-label={label} aria-pressed={!!active}
      title={error ?? (active ? `${active.name} is floating. Click to turn off.` : binding ? `Float ${binding.name} when you leave Nautilo` : "Select a Genie in this Room to float her.")}
      className={`inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-border px-2 text-xs transition-colors disabled:opacity-30 ${active ? "text-online bg-online/10 hover:bg-online/15" : "text-foreground-muted bg-background-element hover:text-foreground"}`}
      onClick={() => {
        setError(null);
        if (active) { controller.stop(); return; }
        if (!binding) return;
        setEnabling(true);
        void controller.enable(binding).catch(reason => setError(reason instanceof Error ? reason.message : "Could not float Genie.")).finally(() => setEnabling(false));
      }}>
      <ExternalLink size={14} aria-hidden />
      <span>{active ? "Floating" : "Float Genie"}</span>
      {active && <span className="h-1.5 w-1.5 rounded-full bg-online" aria-hidden />}
    </button>
    {error && <span role="alert" className="absolute right-0 top-full z-10 mt-1 w-56 rounded-md bg-background-element p-2 text-xs text-error">{error}</span>}
  </span>;
}
