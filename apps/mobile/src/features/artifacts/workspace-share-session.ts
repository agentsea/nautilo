export type SharePerson = { id: string; displayName: string; handle: string };
export type ShareDelivery = { person: SharePerson; status: "pending" | "shared" | "failed"; error?: string };
type ShareClient = { shareWorkspaceArtifact: (id: string, recipient: string, opts?: { roomId?: string }) => Promise<{ status: "shared" | "already_shared" }> };

/** One captured file/identity scope. No successful delivery is replayed. */
export class WorkspaceShareSession {
  #active = true;
  #busy = false;
  #deliveries: ShareDelivery[] | null = null;
  constructor(private readonly options: {
    client: ShareClient; artifactId: string; roomId?: string;
    isCurrent: () => boolean;
  }) {}
  get deliveries(): readonly ShareDelivery[] { return this.#deliveries ?? []; }
  get busy(): boolean { return this.#busy; }
  get attempted(): boolean { return this.#deliveries !== null; }
  /** React's initial effect probe may retire an unused session before setup. */
  activate(): void { if (!this.#deliveries && !this.#busy) this.#active = true; }
  dispose(): void { this.#active = false; }
  async deliver(people: readonly SharePerson[], changed: () => void): Promise<void> {
    if (this.#busy || !this.#active || !this.options.isCurrent()) return;
    if (!this.#deliveries) {
      if (!people.length) return;
      this.#deliveries = [...new Map(people.map(person => [person.id, person])).values()]
        .map(person => ({ person, status: "pending" }));
    }
    this.#busy = true;
    changed();
    try {
      for (const delivery of this.#deliveries) {
        if (!this.#active || !this.options.isCurrent()) break;
        if (delivery.status === "shared") continue;
        try {
          await this.options.client.shareWorkspaceArtifact(this.options.artifactId, delivery.person.id,
            this.options.roomId ? { roomId: this.options.roomId } : undefined);
          delivery.status = "shared";
          delete delivery.error;
        } catch {
          delivery.status = "failed";
          delivery.error = "Could not confirm sharing. Check your connection and file access, then retry.";
        }
        if (this.#active && this.options.isCurrent()) changed();
      }
    } finally {
      this.#busy = false;
      if (this.#active && this.options.isCurrent()) changed();
    }
  }
}
