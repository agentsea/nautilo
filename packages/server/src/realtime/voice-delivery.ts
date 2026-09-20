import { encodeVoicePcmFrame, voiceListenerSchema, VOICE_PCM_PACKET_BYTES, VOICE_PCM_SAMPLE_RATE, type VoicePcmFrame, type VoiceStreamControl, type VoiceAudioEvent } from "@nautilo/types";
import type { WebSocket } from "ws";

type Membership = { userId: string; roomIds: Set<string> };
type Listener = { membership: Membership; protocol: boolean; roomId: string | null; enabled: boolean; revision: number };
export interface VoiceAudience {
  readonly format: "pcm_24000" | "mp3_44100_128";
  readonly signal: AbortSignal;
  control(event: VoiceStreamControl): void;
  audio(frame: VoicePcmFrame): Promise<void>;
  drained(): Promise<void>;
  legacy(event: VoiceAudioEvent): void;
  dispose(): void;
}

/** Connection-local opt-in, layered on the existing authenticated membership. */
export class VoiceDelivery {
  constructor(private readonly now: () => number = () => performance.now()) {}

  private readonly listeners = new Map<WebSocket, Listener>();
  private readonly changed = new Set<() => void>();
  private readonly credits = new Map<string, (socket: WebSocket, samples: number) => boolean>();

  consumed(socket: WebSocket, value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const event = value as Record<string, unknown>;
    if (typeof event["streamId"] !== "string" || typeof event["samples"] !== "number" || !Number.isSafeInteger(event["samples"]) || event["samples"] < 0) return false;
    return this.credits.get(event["streamId"])?.(socket, event["samples"]) ?? false;
  }

  register(socket: WebSocket, membership: Membership, protocol: boolean): void {
    this.listeners.set(socket, { membership, protocol, roomId: null, enabled: false, revision: 0 });
    socket.on("close", () => { this.listeners.delete(socket); this.refresh(); });
  }

  update(socket: WebSocket, value: unknown): boolean {
    const listener = this.listeners.get(socket);
    const parsed = voiceListenerSchema.safeParse(value);
    if (!listener?.protocol || !parsed.success) return false;
    const { roomId, enabled } = parsed.data;
    if (roomId !== null && !listener.membership.roomIds.has(roomId)) return false;
    if (enabled && roomId === null) return false;
    if (listener.roomId !== roomId || listener.enabled !== enabled) {
      listener.roomId = roomId;
      listener.enabled = enabled;
      listener.revision++;
      this.refresh();
    }
    return true;
  }

  refresh(): void { for (const callback of this.changed) callback(); }

  admit(userId: string, roomId: string, initiatingSocket?: unknown): VoiceAudience | null {
    if (!userId || !roomId) return null;
    const eligible = (socket: WebSocket, listener: Listener): boolean =>
      socket.readyState === socket.OPEN && listener.membership.userId === userId && listener.membership.roomIds.has(roomId) &&
      (!listener.protocol || (listener.enabled && listener.roomId === roomId));
    const candidates = [...this.listeners].filter(([socket, listener]) => eligible(socket, listener));
    const hasOptedIn = candidates.some(([, listener]) => listener.protocol);
    // Old sockets cannot advertise local listening state. When a new listener
    // opted in, only the bound initiating old socket may require compatibility;
    // an idle old tab must not downgrade everyone. Old-only audiences retain
    // their historical playback route.
    const initial = candidates.filter(([socket, listener]) => listener.protocol || !hasOptedIn || socket === initiatingSocket);
    if (initial.length === 0) return null;
    const revisions = new Map(initial.map(([socket, listener]) => [socket, listener.revision]));
    const format = initial.every(([, listener]) => listener.protocol) ? "pcm_24000" : "mp3_44100_128";
    const controller = new AbortController();
    const sent = new Map<WebSocket, number>();
    const consumed = new Map<WebSocket, number>();
    const progressAt = new Map<WebSocket, number>();
    const windowBytes = VOICE_PCM_PACKET_BYTES * 4;
    // A listener that cannot consume any queued audio for a full queue duration
    // is stalled. Small differences between native callback clocks are normal.
    const stallMs = windowBytes / (VOICE_PCM_SAMPLE_RATE * 2) * 1000;
    let streamId: string | null = null;
    const recipients = () => initial.filter(([socket, listener]) => {
      if (!revisions.has(socket)) return false;
      const live = this.listeners.get(socket) === listener && revisions.get(socket) === listener.revision && eligible(socket, listener);
      if (!live) {
        // Detachment is final for this stream, even if another device keeps it
        // alive and this listener later regains access or starts listening.
        revisions.delete(socket);
        if (streamId !== null && socket.readyState === socket.OPEN) {
          try { socket.send(JSON.stringify({ type: "voice.stream.abort", streamId, reason: "disconnected" })); }
          catch { socket.close(); }
        }
      }
      return live;
    });
    const check = () => { if (recipients().length === 0) controller.abort(); };
    this.changed.add(check);
    const changed = (afterMs: number) => new Promise<void>(resolve => {
      const wake = () => { clearTimeout(timer); this.changed.delete(wake); controller.signal.removeEventListener("abort", wake); resolve(); };
      const timer = setTimeout(wake, afterMs);
      this.changed.add(wake);
      controller.signal.addEventListener("abort", wake, { once: true });
      if (controller.signal.aborted) wake();
    });
    const send = (payload: string | Uint8Array, audioBytes = 0) => {
      check();
      if (controller.signal.aborted) return;
      for (const [socket] of recipients()) {
        // Four seconds of PCM is the transport backlog budget, independent of
        // reply length. A stalled device cannot hold up other listeners.
        if (socket.bufferedAmount > VOICE_PCM_PACKET_BYTES * 4) {
          socket.close(1013, "voice playback backpressure");
          continue;
        }
        try {
          socket.send(payload);
          if (audioBytes) {
            if ((sent.get(socket) ?? 0) === (consumed.get(socket) ?? 0)) progressAt.set(socket, this.now());
            sent.set(socket, (sent.get(socket) ?? 0) + audioBytes);
          }
        } catch { socket.close(); }
      }
    };
    const waitForProgress = async (pending: [WebSocket, Listener][]) => {
      let waitMs = stallMs;
      let detached = false;
      for (const [socket] of pending) {
        const remaining = stallMs - (this.now() - (progressAt.get(socket) ?? this.now()));
        if (remaining > 0) { waitMs = Math.min(waitMs, remaining); continue; }
        revisions.delete(socket);
        detached = true;
        try { socket.send(JSON.stringify({ type: "voice.stream.abort", streamId, reason: "overflow" })); }
        catch { socket.close(); }
      }
      if (detached) { check(); return; }
      await changed(waitMs);
    };
    return {
      format,
      signal: controller.signal,
      control: event => {
        if (format !== "pcm_24000") return;
        if (event.type === "voice.stream.start") {
          streamId = event.streamId;
          this.credits.set(streamId, (socket, samples) => {
            if (!recipients().some(([recipient]) => recipient === socket) || samples * 2 > (sent.get(socket) ?? 0) || samples * 2 < (consumed.get(socket) ?? 0)) return false;
            if (samples * 2 > (consumed.get(socket) ?? 0)) progressAt.set(socket, this.now());
            consumed.set(socket, samples * 2);
            this.refresh();
            return true;
          });
        }
        send(JSON.stringify(event));
      },
      audio: async frame => {
        if (format !== "pcm_24000") return;
        // Backpressure waits for every live listener; a slightly slower native
        // clock must not be mistaken for overflow and lose the rest of a reply.
        for (;;) {
          check();
          if (controller.signal.aborted) throw new Error("Voice audience detached");
          const blocked = recipients().filter(([socket]) => (sent.get(socket) ?? 0) - (consumed.get(socket) ?? 0) + frame.pcm.length > windowBytes);
          if (blocked.length === 0) { send(encodeVoicePcmFrame(frame), frame.pcm.length); return; }
          await waitForProgress(blocked);
        }
      },
      drained: async () => {
        if (format !== "pcm_24000") return;
        for (;;) {
          check();
          const pending = recipients().filter(([socket]) => (consumed.get(socket) ?? 0) < (sent.get(socket) ?? 0));
          if (controller.signal.aborted || pending.length === 0) return;
          await waitForProgress(pending);
        }
      },
      legacy: event => { if (format === "mp3_44100_128") send(JSON.stringify(event)); },
      dispose: () => { this.changed.delete(check); if (streamId) this.credits.delete(streamId); controller.abort(); },
    };
  }
}

export const voiceDelivery = new VoiceDelivery();
