export interface RevocableComputerUseStore {
  revoke(): Promise<{ readonly ok: boolean }>;
}

export interface ComputerUseServerBindingLifecycleDependencies<TStore extends RevocableComputerUseStore> {
  readonly abortOwnedWork: () => void;
  readonly createStore: (serverBindingId: string) => TStore;
  /** `null` removes every live dispatch/snapshot reference before revocation awaits. */
  readonly adopt: (serverBindingId: string | null, store: TStore | null) => void;
  /** Must tear down transport if durable revocation cannot be proven. */
  readonly failClosed: () => void | Promise<void>;
}

/**
 * Serializes one Electron profile's server-scoped Computer use authority.
 * A healthy same-server reconnect is a no-op. Every actual boundary change
 * removes live references and revokes durable authority before adoption.
 */
export class ComputerUseServerBindingLifecycle<TStore extends RevocableComputerUseStore> {
  private readonly dependencies: ComputerUseServerBindingLifecycleDependencies<TStore>;
  private current: { readonly serverBindingId: string; readonly store: TStore } | null = null;
  private mustRevokeBeforeReuse = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(dependencies: ComputerUseServerBindingLifecycleDependencies<TStore>) {
    this.dependencies = dependencies;
  }

  configure(serverBindingId: string | null): Promise<TStore | null> {
    const run = this.tail.then(() => this.transition(serverBindingId));
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async transition(serverBindingId: string | null): Promise<TStore | null> {
    if (
      !this.mustRevokeBeforeReuse
      && this.current?.serverBindingId === serverBindingId
    ) return this.current.store;
    if (!this.mustRevokeBeforeReuse && this.current === null) {
      if (serverBindingId === null) return null;
      const store = this.dependencies.createStore(serverBindingId);
      this.current = { serverBindingId, store };
      this.dependencies.adopt(serverBindingId, store);
      return store;
    }

    this.dependencies.abortOwnedWork();
    const prior = this.current;
    // Remove dispatch and snapshot reachability before the first await.
    this.dependencies.adopt(null, null);

    if (prior !== null) {
      let revoked = false;
      try {
        revoked = (await prior.store.revoke()).ok;
      } catch {
        revoked = false;
      }
      if (!revoked) {
        this.mustRevokeBeforeReuse = true;
        await this.dependencies.failClosed();
        throw new Error("Computer use could not revoke the prior server grant; relay adoption was refused.");
      }
    }

    this.current = null;
    this.mustRevokeBeforeReuse = false;
    if (serverBindingId === null) return null;

    const store = this.dependencies.createStore(serverBindingId);
    this.current = { serverBindingId, store };
    this.dependencies.adopt(serverBindingId, store);
    return store;
  }
}
