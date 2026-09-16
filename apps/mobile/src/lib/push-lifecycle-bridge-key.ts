/** Content-free dependency key for D468's auth/registry lifecycle bridge. */
export interface PushLifecycleBridgeSnapshot {
  readonly registry: readonly { id: string; serverUrl: string }[];
  readonly activeServerId: string | null;
  readonly authStatus: "loading" | "signed-in" | "signed-out";
  readonly viewerState: "loading" | "cached" | "verified" | "stale" | "none";
  readonly verifiedUserId: string | null;
}

export function pushLifecycleBridgeKey(snapshot: PushLifecycleBridgeSnapshot): string {
  const registry = [...snapshot.registry]
    .map((server) => `${server.id}\u0000${server.serverUrl}`)
    .sort()
    .join("\u0001");
  return [
    registry,
    snapshot.activeServerId ?? "",
    snapshot.authStatus,
    snapshot.viewerState,
    snapshot.verifiedUserId ?? "",
  ].join("\u0002");
}
