/** Bind locally opened Task content to the same viewer and policy authority as its read. */
export function taskContentViewerScopeKey(input: Readonly<{
  serverOrigin: string;
  viewerGeneration: number;
  viewerId: string | null;
  actorId: string | null;
  viewerVerified: boolean;
  policyMode: string;
}>): string {
  return [
    input.serverOrigin,
    input.viewerGeneration,
    input.viewerId ?? "",
    input.actorId ?? "",
    input.viewerVerified ? "verified" : "unverified",
    input.policyMode,
  ].join("\0");
}
