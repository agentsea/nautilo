/** A small last-write-wins queue so wheel/pan updates do not spam host state. */
export class ViewportWriteQueue<T> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: T | null = null;
  private writing = false;
  private closed = false;
  private flushPromise: Promise<void> | null = null;

  constructor(
    private readonly write: (value: T) => Promise<void>,
    private readonly delayMs = 150,
  ) {}

  schedule(value: T): void {
    if (this.closed) return;
    this.pending = value;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
  }

  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.writing) return this.flushPromise ?? Promise.resolve();
    this.writing = true;
    this.flushPromise = (async () => {
      try {
        while (this.pending !== null) {
          const next = this.pending;
          this.pending = null;
          await this.write(next);
        }
      } finally {
        this.writing = false;
        this.flushPromise = null;
      }
    })();
    return this.flushPromise;
  }

  destroy(): void {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }

  /** Stop accepting new input but drain the newest queued presentation value. */
  async closeAndFlush(): Promise<void> {
    this.closed = true;
    return this.flush();
  }
}

export function isArtifactStateUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    /app state is only supported for workspace artifact documents/i.test(error.message)
  );
}
