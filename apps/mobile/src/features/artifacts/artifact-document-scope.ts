/** Stable during recovery; distinct whenever the file's read authority changes. */
export function artifactDocumentScope(serverId: string | undefined, serverUrl: string | undefined, userId: string | undefined, artifactId: string | undefined): string {
  return JSON.stringify([serverId, serverUrl, userId, artifactId]);
}
