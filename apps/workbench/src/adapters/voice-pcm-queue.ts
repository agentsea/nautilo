/** Fixed-capacity source-rate ring, consumed by the device's audio clock. */
export class VoicePcmQueue {
  private readonly samples: Float32Array;
  private read = 0;
  private count = 0;
  private phase = 0;
  private started = false;
  private finished = false;
  consumed = 0;
  underruns = 0;

  constructor(readonly sourceRate: number, readonly outputRate: number, readonly preRollSamples: number, capacity: number) {
    this.samples = new Float32Array(capacity);
  }

  get queued(): number { return this.count; }
  get done(): boolean { return this.finished && this.count === 0; }

  write(pcm: Uint8Array): boolean {
    if (pcm.length % 2 !== 0 || pcm.length / 2 > this.samples.length - this.count || this.finished) return false;
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let i = 0; i < pcm.length / 2; i++) {
      this.samples[(this.read + this.count) % this.samples.length] = view.getInt16(i * 2, true) / 32768;
      this.count++;
    }
    return true;
  }

  finish(): void { this.finished = true; }

  render(output: Float32Array): void {
    output.fill(0);
    if (!this.started) {
      if (!this.finished && this.count < this.preRollSamples) return;
      this.started = true;
    }
    const ratio = this.sourceRate / this.outputRate;
    for (let i = 0; i < output.length; i++) {
      if (this.count === 0 || (this.count === 1 && this.phase > 0 && !this.finished)) {
        if (!this.finished) { this.underruns++; this.started = false; }
        return;
      }
      const first = this.samples[this.read];
      const second = this.count > 1 ? this.samples[(this.read + 1) % this.samples.length] : first;
      output[i] = first + (second - first) * this.phase;
      this.phase += ratio;
      const advance = Math.min(this.count, Math.floor(this.phase));
      this.read = (this.read + advance) % this.samples.length;
      this.count -= advance;
      this.consumed += advance;
      this.phase -= advance;
      if (this.count === 0) this.phase = 0;
    }
  }
}
