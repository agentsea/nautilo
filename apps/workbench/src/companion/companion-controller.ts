import { MAX_CHAT_ATTACHMENTS_PER_MESSAGE, type ServerEvent } from "@nautilo/types";
import { initialThreadRoomControllerState, reconcileThreadRoomHistory, threadRoomReducer, type ThreadRoomControllerState } from "../modes/rooms/thread-drawer/thread-room-controller";
import { emptyCompanionSnapshot, type CompanionPickedFile } from "../../../desktop/electron/companion-contract";
import type { SpeechCapture, CaptureSnapshot } from "../lib/speech-capture";
import { preflightComposerChatAttachment, formatComposerAttachmentSkipToast } from "../lib/composer-attachment-preflight";
import { restoreSessionMessages } from "../adapters/session-rehydrate";
import type { CompanionAction, CompanionBinding, CompanionOwnerAPI, CompanionSnapshot } from "../../../desktop/electron/companion-contract";
import type { RoomMessageOperations } from "../adapters/room-message-operations";

interface Bound {
  generation: string;
  snapshot: CompanionSnapshot;
  reading: boolean;
  dirty: boolean;
  readFailed: boolean;
  avatarRevision: number;
  capture?: SpeechCapture;
  sendCapture: boolean;
  uploaded: Map<string, string>;
  pendingSend: Promise<unknown> | null;
  stopAfterSend: boolean;
  stopRevision: number;
  transcript: ThreadRoomControllerState;
  eventRevision: number;
}

/** Volatile Room state owned by the authenticated Workbench, independent of
 * the displayed Room. Every async completion is fenced against Off/rebind. */
export class CompanionController {
  private bound: Bound | null = null;
  private revision = 0;
  private lastClosed: string | null = null;

  constructor(private readonly deps: {
    bridge: CompanionOwnerAPI;
    operations: () => RoomMessageOperations;
    admitted: () => boolean;
    loadAvatar?: (binding: CompanionBinding) => Promise<string | null>;
    send: (binding: CompanionBinding, text: string, options: { voiceMode: boolean; attachments: { attachmentId: string }[] }) => Promise<unknown>;
    media?: {
      createCapture(changed: (state: CaptureSnapshot) => void, result: (text: string) => void): SpeechCapture;
      prepare(): void;
      enable(roomId: string): void;
      release(roomId: string): void;
      setEnabled?(enabled: boolean): void;
      stopTalking(): void;
    };
    workRunning?: (roomId: string) => Promise<boolean>;
    stopTask?: (roomId: string) => Promise<{ stopped: boolean }>;
    canAttach?: () => boolean;
    upload?: (file: CompanionPickedFile, roomId: string) => Promise<string>;
    openRoom: (roomId: string) => void;
    changed: (snapshot: CompanionSnapshot | null) => void;
  }) {}

  async enable(binding: CompanionBinding): Promise<void> {
    this.stop();
    if (!this.deps.admitted()) throw new Error("Reconnect to Nautilo before floating a Genie.");
    this.deps.media?.prepare();
    const revision = this.revision;
    const generation = await this.deps.bridge.enable(binding);
    if (revision !== this.revision || !this.deps.admitted() || generation === this.lastClosed) {
      void this.deps.bridge.disable(generation).catch(() => {});
      return;
    }
    const bound: Bound = { generation, sendCapture: false, reading: false, dirty: false, readFailed: false, avatarRevision: 0,
      uploaded: new Map(), pendingSend: null, stopAfterSend: false, stopRevision: 0, snapshot: emptyCompanionSnapshot(binding),
      transcript: { ...initialThreadRoomControllerState, roomId: binding.roomId, phase: "ready", connected: true }, eventRevision: 0 };
    bound.snapshot.canAttach = this.deps.canAttach?.() ?? false;
    bound.capture = this.deps.media?.createCapture(state => {
      if (!this.current(bound)) return;
      bound.snapshot.capture = state.state;
      if (state.error) { bound.sendCapture = false; bound.snapshot.error = state.error; }
      this.publish(bound);
    }, text => {
      if (!this.current(bound)) return;
      const submit = bound.sendCapture;
      bound.sendCapture = false;
      if (submit) {
        // A bubble turn is independent of an unsent panel draft and attachments.
        // View changes while transcription runs cannot change its send intent.
        void this.sendMessage(bound, text, true);
      } else {
        this.appendDictation(bound, text);
      }
    });
    this.bound = bound;
    this.deps.media?.enable(binding.roomId);
    this.publish(bound);
    void this.refreshAvatar();
    await this.refresh();
  }

  stop(): void {
    ++this.revision;
    const bound = this.bound;
    this.bound = null;
    bound?.capture?.cancel();
    if (bound) this.deps.media?.release(bound.snapshot.binding.roomId);
    this.deps.changed(null);
    if (bound) void this.deps.bridge.disable(bound.generation).catch(() => {});
  }

  closed(generation: string): void {
    this.lastClosed = generation;
    if (this.bound?.generation === generation) this.stop();
  }

  private current(bound: Bound): boolean { return this.bound === bound && this.deps.admitted(); }
  private publish(bound: Bound): void {
    if (!this.current(bound)) return;
    bound.snapshot.messages = [...bound.transcript.runtimeMessages];
    this.deps.changed({ ...bound.snapshot });
    void this.deps.bridge.publish(bound.generation, bound.snapshot).catch(() => {
      if (this.bound === bound) this.stop();
    });
  }

  private async refreshAvatar(): Promise<void> {
    const bound = this.bound;
    if (!bound || !this.current(bound) || !this.deps.loadAvatar) return;
    const revision = ++bound.avatarRevision;
    let avatar: string | null = null;
    try { avatar = await this.deps.loadAvatar(bound.snapshot.binding); } catch { /* Initials remain usable offline. */ }
    if (!this.current(bound) || revision !== bound.avatarRevision) return;
    bound.snapshot.avatarDataUrl = avatar;
    this.publish(bound);
  }

  updateMedia(roomId: string | null, enabled: boolean, playing: boolean, canStopTalking = playing): void {
    const bound = this.bound;
    if (!bound || !this.current(bound)) return;
    const owns = roomId === bound.snapshot.binding.roomId;
    const stoppable = owns && enabled && canStopTalking;
    if (bound.snapshot.voiceEnabled === (owns && enabled) && bound.snapshot.speaking === (owns && playing) && bound.snapshot.canStopTalking === stoppable) return;
    bound.snapshot.voiceEnabled = owns && enabled;
    bound.snapshot.speaking = owns && playing;
    bound.snapshot.canStopTalking = stoppable;
    this.publish(bound);
  }

  invalidate(roomId: string): void {
    if (this.bound?.snapshot.binding.roomId === roomId) void this.refresh();
  }

  /** Only the parent runtime may deliver an admitted Room event here. */
  ingestEvent(roomId: string, event: ServerEvent): void {
    const bound = this.bound;
    if (!bound || !this.current(bound) || bound.snapshot.binding.roomId !== roomId) return;
    bound.transcript = threadRoomReducer(bound.transcript, {
      type: "event.received", event, resolveRoomId: () => roomId,
    });
    ++bound.eventRevision;
    if (event.type === "job.dispatched" || event.type === "message.tokens" || event.type === "tool.start") bound.snapshot.workRunning = true;
    this.publish(bound);
    if (event.type === "job.status") void this.refresh();
  }

  async refresh(): Promise<void> {
    const bound = this.bound;
    if (!bound || !this.current(bound)) return;
    if (bound.reading) { bound.dirty = true; return; }
    bound.reading = true;
    do {
      bound.dirty = false;
      const eventRevision = bound.eventRevision;
      try {
        const [page, running] = await Promise.all([
          this.deps.operations().readRoomMessages(bound.snapshot.binding.roomId),
          this.deps.workRunning?.(bound.snapshot.binding.roomId) ?? Promise.resolve(false),
        ]);
        if (!this.current(bound)) return;
        if (bound.readFailed) bound.snapshot.error = null;
        bound.readFailed = false;
        // The send receipt/echo supplies the canonical id. Do not briefly show
        // its history row alongside the local sending row before that arrives.
        if (!bound.pendingSend) bound.transcript = reconcileThreadRoomHistory(bound.transcript, page.messages, restoreSessionMessages(page.messages));
        bound.snapshot.hasEarlier = page.pageInfo.hasMoreBefore;
        if (eventRevision === bound.eventRevision) bound.snapshot.workRunning = running;
        bound.snapshot.canAttach = this.deps.canAttach?.() ?? false;
      } catch {
        if (!this.current(bound)) return;
        // Never keep exposing a cached transcript after a failed authorized read.
        bound.snapshot.messages = [];
        bound.transcript = { ...initialThreadRoomControllerState, roomId: bound.snapshot.binding.roomId, phase: "ready", connected: true };
        bound.readFailed = true;
        bound.snapshot.error = "Could not read this Room. Open it in Nautilo to reconnect or check access.";
      }
      this.publish(bound);
    } while (bound.dirty && this.current(bound));
    bound.reading = false;
  }

  async action(generation: string, action: CompanionAction): Promise<void> {
    const bound = this.bound;
    if (!bound || generation !== bound.generation || !this.current(bound)) return;
    if (action.type === "draft") { bound.snapshot.draft = action.text; this.publish(bound); }
    else if (action.type === "return") this.deps.openRoom(bound.snapshot.binding.roomId);
    else if (action.type === "refresh") { void this.refreshAvatar(); await this.refresh(); }
    else if (action.type === "sound") this.deps.media?.setEnabled?.(action.enabled);
    else if (action.type === "talk") {
      if (!bound.capture || bound.snapshot.busy || bound.snapshot.stopState === "stopping"
        || bound.snapshot.sendUncertain || ["requesting", "transcribing"].includes(bound.snapshot.capture)) return;
      if (bound.snapshot.capture === "listening") {
        bound.sendCapture = true;
        bound.capture.finish();
      } else {
        bound.sendCapture = false;
        bound.snapshot.error = null;
        this.deps.media?.stopTalking();
        void bound.capture.start();
      }
    }
    else if (action.type === "mic") {
      if (!bound.capture) return;
      bound.sendCapture = false;
      if (bound.snapshot.capture === "listening") bound.capture.finish();
      else if (bound.snapshot.capture === "requesting" || bound.snapshot.capture === "transcribing") bound.capture.cancel();
      else {
        bound.snapshot.error = null;
        this.deps.media?.stopTalking();
        void bound.capture.start();
      }
    }
    else if (action.type === "mute") { bound.sendCapture = false; bound.capture?.cancel(); }
    else if (action.type === "stop-talking" && bound.snapshot.voiceEnabled) this.deps.media?.stopTalking();
    else if (action.type === "stop-task") {
      if (!this.deps.stopTask || bound.snapshot.stopState === "stopping") return;
      bound.sendCapture = false;
      bound.capture?.cancel();
      // Stop admitted work immediately, even if this client's send never settles.
      // A send can still be admitted afterward; its completion performs one more
      // stop while the composer stays busy, before another send can begin.
      bound.stopAfterSend = bound.pendingSend !== null;
      await this.requestTaskStop(bound);
    }
    else if (action.type === "attach") await this.attach(bound);
    else if (action.type === "remove-attachment" && !bound.snapshot.busy) {
      bound.snapshot.attachments = bound.snapshot.attachments.filter(a => a.id !== action.id);
      bound.uploaded.delete(action.id); this.publish(bound);
    }
    else if (action.type === "send") await this.sendMessage(bound, action.text);
  }

  private appendDictation(bound: Bound, text: string): void {
    if (!this.current(bound)) return;
    bound.snapshot.draftBase = bound.snapshot.draft;
    bound.snapshot.dictationText = text;
    bound.snapshot.draft = [bound.snapshot.draft, text].filter(Boolean).join("\n");
    ++bound.snapshot.draftRevision;
    this.publish(bound);
  }

  private async sendMessage(bound: Bound, text: string, voiceOnly = false): Promise<void> {
    if (!this.current(bound)) return;
    if ((!text.trim() && (voiceOnly || !bound.snapshot.attachments.length)) || bound.snapshot.busy || bound.snapshot.stopState === "stopping") {
      if (voiceOnly && text.trim()) this.appendDictation(bound, text);
      return;
    }
    if (!voiceOnly && bound.snapshot.attachments.some(a => a.status !== "ready")) {
      bound.snapshot.error = "Wait for uploads, or remove failed attachments before sending.";
      this.publish(bound); return;
    }
    const sentAttachments = voiceOnly ? [] : [...bound.snapshot.attachments];
    bound.snapshot.stopState = "idle";
    bound.snapshot.busy = true;
    bound.snapshot.error = null;
    bound.snapshot.sendUncertain = false;
    const requestId = crypto.randomUUID();
    bound.transcript = threadRoomReducer(bound.transcript, {
      type: "send.started", requestId, content: text || sentAttachments.map(attachment => attachment.name).join("\n"), createdAt: new Date().toISOString(),
    });
    const clearedDraft = !voiceOnly && bound.snapshot.draft === text;
    if (clearedDraft) {
      bound.snapshot.draftBase = text; bound.snapshot.draft = ""; bound.snapshot.dictationText = null; ++bound.snapshot.draftRevision;
    }
    const sendDraftRevision = bound.snapshot.draftRevision;
    this.publish(bound);
    let sendUncertain = false;
    try {
      bound.pendingSend = this.deps.send(bound.snapshot.binding, text, {
        voiceMode: bound.snapshot.voiceEnabled,
        attachments: sentAttachments.map(a => ({ attachmentId: bound.uploaded.get(a.id)! })),
      });
      const result = await bound.pendingSend;
      if (!this.current(bound)) return;
      const messageId = result && typeof result === "object" && "messageId" in result && typeof result.messageId === "number" ? result.messageId : null;
      bound.transcript = threadRoomReducer(bound.transcript, { type: "send.succeeded", requestId, messageId });
      // The submitted draft was cleared at dispatch. Leave any new typing alone.
      bound.snapshot.attachments = bound.snapshot.attachments.filter(a => !sentAttachments.includes(a));
      for (const attachment of sentAttachments) bound.uploaded.delete(attachment.id);
    } catch {
      if (!this.current(bound)) return;
      sendUncertain = true;
      bound.snapshot.sendUncertain = true;
      if (voiceOnly) this.appendDictation(bound, text);
      bound.snapshot.error = "Send could not be confirmed. Check the Room before sending again.";
      if (clearedDraft && bound.snapshot.draft === "" && bound.snapshot.draftRevision === sendDraftRevision) {
        bound.snapshot.draftBase = ""; bound.snapshot.draft = text; ++bound.snapshot.draftRevision;
      }
      bound.transcript = { ...bound.transcript, runtimeMessages: bound.transcript.runtimeMessages.map(message =>
        message.metadata?.custom?.optimisticRequestId === requestId
          ? { ...message, metadata: { ...message.metadata, custom: { ...message.metadata.custom, sendFailed: true } } } : message) };
    } finally {
      bound.pendingSend = null;
      if (bound.stopAfterSend && this.current(bound)) {
        bound.stopAfterSend = false;
        await this.requestTaskStop(bound);
        if (sendUncertain && this.current(bound)) {
          bound.snapshot.error = ["Send could not be confirmed. Check the Room before sending again.", bound.snapshot.error].filter(Boolean).join(" ");
        }
      }
      if (this.current(bound)) { bound.snapshot.busy = false; this.publish(bound); }
    }
    await this.refresh();
  }

  private async requestTaskStop(bound: Bound): Promise<void> {
    if (!this.current(bound) || !this.deps.stopTask) return;
    const stopRevision = ++bound.stopRevision;
    bound.snapshot.stopState = "stopping";
    bound.snapshot.error = null;
    this.publish(bound);
    try {
      const result = await this.deps.stopTask(bound.snapshot.binding.roomId);
      if (!this.current(bound) || stopRevision !== bound.stopRevision) return;
      bound.snapshot.stopState = result.stopped ? "stopped" : "failed";
      if (!result.stopped) bound.snapshot.error = "No running work was found in this Room.";
    } catch {
      if (!this.current(bound) || stopRevision !== bound.stopRevision) return;
      bound.snapshot.stopState = "failed";
      bound.snapshot.error = "Stop could not be confirmed. Work may still be running; try Stop again.";
    }
    if (bound.pendingSend) {
      bound.snapshot.stopState = "failed";
      bound.snapshot.error = "Stop was requested, but a message is still being sent. Stop will be requested again when that send settles; check the Room before continuing.";
    }
    this.publish(bound);
    await this.refresh();
  }

  private async attach(bound: Bound): Promise<void> {
    if (!this.deps.canAttach?.() || !this.deps.upload || bound.snapshot.pickingAttachments || bound.snapshot.busy) return;
    bound.snapshot.pickingAttachments = true; bound.snapshot.error = null; this.publish(bound);
    try {
      const files = await this.deps.bridge.pickFiles(bound.generation);
      if (!this.current(bound) || !this.deps.canAttach()) return;
      for (const file of files) {
        if (!this.current(bound) || !this.deps.canAttach()) return;
        const preflight = preflightComposerChatAttachment(file.name);
        if (!preflight.ok) { bound.snapshot.error = formatComposerAttachmentSkipToast([preflight.skip]).message; continue; }
        if (bound.snapshot.attachments.length >= MAX_CHAT_ATTACHMENTS_PER_MESSAGE) {
          bound.snapshot.error = "Attachment limit reached. Send or remove files before adding more."; break;
        }
        const item = { id: crypto.randomUUID(), name: file.name, status: "pending" as const, error: null };
        bound.snapshot.attachments = [...bound.snapshot.attachments, item]; this.publish(bound);
        try {
          const id = await this.deps.upload(file, bound.snapshot.binding.roomId);
          if (!this.current(bound)) return;
          if (!bound.snapshot.attachments.includes(item)) continue;
          bound.uploaded.set(item.id, id);
          bound.snapshot.attachments = bound.snapshot.attachments.map(a => a === item ? { ...a, status: "ready" } : a);
        } catch {
          if (!this.current(bound)) return;
          bound.snapshot.attachments = bound.snapshot.attachments.map(a => a === item ? { ...a, status: "error", error: "Upload failed. Remove and reattach to retry." } : a);
        }
        this.publish(bound);
      }
    } catch {
      if (this.current(bound)) bound.snapshot.error = "Could not open the file picker.";
    } finally {
      if (this.current(bound)) { bound.snapshot.pickingAttachments = false; this.publish(bound); }
    }
  }
}
