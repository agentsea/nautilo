export class NativeMiniAppLifecycleCoordinator<T> {
  private readonly targets = new Map<number, T>();
  private readonly pending = new Map<number, {
    requestId: string;
    resolve: (ready: boolean) => void;
  }>();
  private readonly invalidationWatches = new Map<string, {
    ids: Set<number>;
    resolve: () => void;
  }>();

  register(id: number, target: T): boolean {
    if (this.targets.has(id)) return false;
    this.targets.set(id, target);
    for (const [requestId, watch] of this.invalidationWatches) {
      this.invalidationWatches.delete(requestId);
      watch.resolve();
    }
    return true;
  }

  unregister(id: number): void {
    this.targets.delete(id);
    const pending = this.pending.get(id);
    if (pending) {
      this.pending.delete(id);
      pending.resolve(false);
    }
    for (const [requestId, watch] of this.invalidationWatches) {
      if (!watch.ids.has(id)) continue;
      this.invalidationWatches.delete(requestId);
      watch.resolve();
    }
  }

  entries(): Array<[number, T]> {
    return [...this.targets.entries()];
  }

  begin(requestId: string, ids: readonly number[]): Promise<boolean>[] {
    return ids.map((id) => new Promise<boolean>((resolve) => {
      this.pending.set(id, { requestId, resolve });
    }));
  }

  watchInvalidation(requestId: string, ids: readonly number[]): Promise<void> {
    return new Promise((resolve) => {
      this.invalidationWatches.set(requestId, { ids: new Set(ids), resolve });
    });
  }

  complete(requestId: string): void {
    this.invalidationWatches.delete(requestId);
  }

  accept(id: number, requestId: unknown, ready: unknown): boolean {
    const pending = this.pending.get(id);
    if (!pending || requestId !== pending.requestId || typeof ready !== "boolean") return false;
    this.pending.delete(id);
    pending.resolve(ready);
    return true;
  }

  cancel(requestId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.requestId !== requestId) continue;
      this.pending.delete(id);
      pending.resolve(false);
    }
    const watch = this.invalidationWatches.get(requestId);
    if (watch) {
      this.invalidationWatches.delete(requestId);
      watch.resolve();
    }
  }
}
