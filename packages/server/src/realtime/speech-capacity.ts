/** FIFO admission for one provider account; cancellation removes queued work. */
export class SpeechCapacity {
  private active = 0;
  private limit = 2;
  private readonly waiting: Array<{ signal: AbortSignal; grant: () => void; cancel: () => void }> = [];

  // Two is ElevenLabs' documented Free-plan HTTP concurrency. Successful
  // responses advertise the current account's maximum, which replaces it.
  observeMaximum(value: string | null): void {
    if (!value || !/^\d+$/.test(value)) return;
    const limit = Number(value);
    if (!Number.isSafeInteger(limit) || limit < 1) return;
    this.limit = limit;
    this.drain();
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    return new Promise((resolve, reject) => {
      const entry = {
        signal,
        cancel: () => {
          const index = this.waiting.indexOf(entry);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(new DOMException("Aborted", "AbortError"));
        },
        grant: () => {
          signal.removeEventListener("abort", entry.cancel);
          this.active++;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.active--;
            this.drain();
          });
        },
      };
      signal.addEventListener("abort", entry.cancel, { once: true });
      this.waiting.push(entry);
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.limit && this.waiting.length > 0) {
      const next = this.waiting.shift()!;
      if (!next.signal.aborted) next.grant();
      else next.cancel();
    }
  }
}
