/**
 * Tiny monotonic fence for a catalogue read. A server switch (or retry) must
 * invalidate an older request before it is allowed to update mobile UI.
 */
export class CommandCatalogueRequestGate {
  private revision = 0;

  begin(): number {
    this.revision += 1;
    return this.revision;
  }

  isCurrent(revision: number): boolean {
    return revision === this.revision;
  }
}

/**
 * Commands are selected for one verified Human and server. A URL by itself
 * cannot safely identify that authority: signing in as another Human at the
 * same server must clear the previous catalogue before a new read completes.
 */
export function commandCatalogueScope(
  serverUrl: string | undefined,
  auth: {
    status: string;
    viewerState: string;
    viewer: { userId: string; actorId: string } | null;
  },
): string | null {
  if (!serverUrl || auth.status !== "signed-in" || auth.viewerState !== "verified" || !auth.viewer) {
    return null;
  }
  return `${serverUrl}\u0000${auth.viewer.userId}\u0000${auth.viewer.actorId}`;
}
