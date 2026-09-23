export type CaptureState = "idle" | "requesting" | "listening" | "transcribing" | "error";
export interface CaptureSnapshot { state: CaptureState; error: string | null; errorKind?: "capture" | "transcription" }
export interface SpeechCaptureDependencies {
  permission(): Promise<void>;
  stream(): Promise<MediaStream>;
  recorder(stream: MediaStream): MediaRecorder;
  transcribe(blob: Blob, signal: AbortSignal): Promise<string>;
}

// All composers in one Workbench share one microphone lease. A new deliberate
// capture cancels the previous owner, including permission and STT completions.
let releaseActive: (() => void) | null = null;
export class SpeechCapture {
  private generation = 0;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private upload: AbortController | null = null;
  private finishing = false;
  private snapshot: CaptureSnapshot = { state: "idle", error: null };
  constructor(private readonly deps: SpeechCaptureDependencies,
    private readonly changed: (state: CaptureSnapshot) => void,
    private readonly result: (text: string) => void) {}
  private update(state: CaptureState, error: string | null = null, errorKind: "capture" | "transcription" = "capture") {
    this.snapshot = { state, error, ...(error ? { errorKind } : {}) }; this.changed(this.snapshot);
  }
  getState() { return this.snapshot; }
  cancel = (): void => {
    ++this.generation;
    this.finishing = false;
    this.upload?.abort(); this.upload = null;
    const recorder = this.recorder; this.recorder = null;
    if (recorder) {
      recorder.onstop = null; recorder.ondataavailable = null; recorder.onerror = null;
      if (recorder.state !== "inactive") recorder.stop();
    }
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    if (releaseActive === this.cancel) releaseActive = null;
    this.update("idle");
  };
  async start(): Promise<void> {
    releaseActive?.(); this.cancel(); releaseActive = this.cancel;
    const generation = this.generation;
    const current = () => generation === this.generation;
    this.update("requesting");
    try {
      await this.deps.permission(); if (!current()) return;
      const stream = await this.deps.stream();
      if (!current()) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      const recorder = this.deps.recorder(stream); this.recorder = recorder;
      const chunks: Blob[] = [];
      recorder.ondataavailable = event => { if (current() && event.data.size) chunks.push(event.data); };
      recorder.onerror = () => { if (current()) { this.cancel(); this.update("error", "Microphone recording failed. Try again."); } };
      recorder.onstop = () => {
        stream.getTracks().forEach(track => track.stop());
        if (!current()) return;
        this.stream = null; this.recorder = null;
        if (!this.finishing) { this.cancel(); this.update("error", "Microphone disconnected. Record again to send."); return; }
        const blob = new Blob(chunks, { type: recorder.mimeType });
        if (!blob.size) { this.cancel(); return; }
        this.update("transcribing");
        const upload = new AbortController(); this.upload = upload;
        void this.deps.transcribe(blob, upload.signal).then(text => {
          if (!current()) return;
          this.upload = null;
          if (releaseActive === this.cancel) releaseActive = null;
          this.update("idle");
          if (text.trim()) this.result(text);
          else this.update("error", "Transcription returned no text. Try again.", "transcription");
        }).catch(error => {
          if (!current()) return;
          this.cancel(); this.update("error", error instanceof Error ? error.message : "Transcription failed. Try again.", "transcription");
        });
      };
      recorder.start(); this.update("listening");
    } catch (error) {
      if (!current()) return;
      this.cancel(); this.update("error", error instanceof Error ? error.message : "Microphone unavailable.");
    }
  }
  finish(): void {
    if (this.recorder?.state === "recording") {
      this.finishing = true;
      this.update("transcribing");
      this.recorder.stop();
      this.stream?.getTracks().forEach(track => track.stop());
    }
  }
}
