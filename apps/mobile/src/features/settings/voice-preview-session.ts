/**
 * A single, cancellable native catalog-preview session. Preview synthesis is
 * deliberately bounded to one player and one cache file: selecting another
 * voice, leaving the route, or switching server releases the old resources.
 */
export type VoicePreviewStatus = "idle" | "loading" | "playing" | "error" | "rate-limited";

export interface VoicePreviewSnapshot {
  readonly status: VoicePreviewStatus;
  readonly voiceId: string | null;
  readonly error: string | null;
  /** Earliest retry time after a 429. `null` for all other states. */
  readonly retryAt: number | null;
}

export interface VoicePreviewPlayer {
  play(): void;
  pause(): void;
  remove(): void;
  addListener(
    event: "playbackStatusUpdate",
    listener: (status: { didJustFinish: boolean; error?: string | null }) => void,
  ): { remove(): void };
}

export interface VoicePreviewFile {
  readonly uri: string;
  write(bytes: Uint8Array): void;
  delete(): void;
}

export interface VoicePreviewPlatform {
  createFile(): VoicePreviewFile;
  createPlayer(uri: string): VoicePreviewPlayer;
}

export type PreviewRequest = () => Promise<Blob | Uint8Array>;

const RATE_LIMIT_DELAY_MS = 30_000;

/** Imperative counterpart to Expo's lifecycle-managed useAudioPlayer hook. */
export class VoicePreviewSession {
  private snapshot: VoicePreviewSnapshot = { status: "idle", voiceId: null, error: null, retryAt: null };
  private player: VoicePreviewPlayer | null = null;
  private file: VoicePreviewFile | null = null;
  private subscription: { remove(): void } | null = null;
  private generation = 0;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly platform: VoicePreviewPlatform,
    private readonly now: () => number = Date.now,
  ) {}

  getSnapshot = (): Readonly<VoicePreviewSnapshot> => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async play(voiceId: string, request: PreviewRequest): Promise<void> {
    if (this.snapshot.voiceId === voiceId && (this.snapshot.status === "loading" || this.snapshot.status === "playing")) {
      this.stop();
      return;
    }
    if (this.snapshot.status === "rate-limited" && this.snapshot.retryAt && this.now() < this.snapshot.retryAt) {
      return;
    }
    this.stop();
    const generation = ++this.generation;
    this.replace({ status: "loading", voiceId, error: null, retryAt: null });
    try {
      const payload = await request();
      const bytes = await previewBytes(payload);
      if (!this.isCurrent(generation)) return;
      const file = this.platform.createFile();
      file.write(bytes);
      if (!this.isCurrent(generation)) {
        safeDelete(file);
        return;
      }
      this.file = file;
      const player = this.platform.createPlayer(file.uri);
      if (!this.isCurrent(generation)) {
        safeRemove(player);
        return;
      }
      this.player = player;
      this.subscription = player.addListener("playbackStatusUpdate", (status) => {
        if (!this.isCurrent(generation)) return;
        if (status.error) {
          this.finishWithError("Could not play this voice preview.");
        } else if (status.didJustFinish) {
          this.release();
          this.replace({ status: "idle", voiceId: null, error: null, retryAt: null });
        }
      });
      player.play();
      if (this.isCurrent(generation)) this.replace({ status: "playing", voiceId, error: null, retryAt: null });
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      if (statusOf(error) === 429) {
        this.release();
        this.replace({
          status: "rate-limited",
          voiceId,
          error: "Preview requests are temporarily limited. Please try again shortly.",
          retryAt: this.now() + RATE_LIMIT_DELAY_MS,
        });
      } else {
        this.finishWithError(error instanceof Error && error.message ? error.message : "Could not play this voice preview.");
      }
    }
  }

  stop(): void {
    ++this.generation;
    this.release();
    if (this.snapshot.status !== "idle" || this.snapshot.voiceId !== null) {
      this.replace({ status: "idle", voiceId: null, error: null, retryAt: null });
    }
  }

  /** Route unmount/server-switch cleanup. Safe to invoke more than once. */
  dispose(): void {
    this.stop();
    this.listeners.clear();
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  private finishWithError(message: string): void {
    this.release();
    this.replace({ status: "error", voiceId: null, error: message, retryAt: null });
  }

  private release(): void {
    if (this.subscription) {
      try { this.subscription.remove(); } catch { /* already detached */ }
      this.subscription = null;
    }
    if (this.player) {
      try { this.player.pause(); } catch { /* already released */ }
      safeRemove(this.player);
      this.player = null;
    }
    if (this.file) {
      safeDelete(this.file);
      this.file = null;
    }
  }

  private replace(snapshot: VoicePreviewSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

async function previewBytes(payload: Blob | Uint8Array): Promise<Uint8Array> {
  if (payload instanceof Uint8Array) return payload;
  const blob = payload as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof blob.arrayBuffer === "function") {
    return new Uint8Array(await blob.arrayBuffer());
  }
  if (typeof FileReader !== "undefined") {
    return await new Promise<Uint8Array>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error("Could not read voice preview bytes."));
      reader.onload = () => {
        if (!(reader.result instanceof ArrayBuffer)) {
          reject(new Error("Could not read voice preview bytes."));
          return;
        }
        resolve(new Uint8Array(reader.result));
      };
      reader.readAsArrayBuffer(payload);
    });
  }
  throw new Error("Voice preview bytes are not readable on this device.");
}

function statusOf(value: unknown): number | null {
  return value !== null && typeof value === "object" && "status" in value &&
    typeof (value as { status?: unknown }).status === "number"
    ? (value as { status: number }).status
    : null;
}

function safeRemove(player: VoicePreviewPlayer): void {
  try { player.remove(); } catch { /* native player may already be released */ }
}

function safeDelete(file: VoicePreviewFile): void {
  try { file.delete(); } catch { /* cache cleanup is best effort */ }
}
