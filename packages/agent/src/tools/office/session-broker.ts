/**
 * D362 Milestone B — boot registry for the agent→server office session
 * broker.
 *
 * Symmetric with `packages/agent/src/tools/artifacts/storage-registry.ts`:
 * the agent package must NOT import `@nautilo/server` (one-way dep), so
 * the server boot sequence calls `setOfficeSessionBroker(broker)` once
 * and the `office` tool fetches it via `getOfficeSessionBroker()`. Until
 * the server wires it, `getOfficeSessionBroker()` returns `null` and the
 * tool surfaces a clear "broker not wired" error to the model rather
 * than crashing.
 *
 * The broker mints a coolwsd session for a single workspace artifact:
 * given the artifact's internal id + the envelope's namespace/user
 * grants, it returns the `{ wsBaseUrl, docUrl, wopiSrc }` triple the
 * `CoolSessionClient` needs to open the WebSocket. The real broker
 * lives in `packages/server/src/lib/office-session-broker.ts` and uses
 * `issueWopiToken` from `../routes/wopi`; tests inject a fake via
 * `setOfficeSessionBroker` directly.
 */

export interface OfficeSessionMint {
  wsBaseUrl: string;
  docUrl: string;
  wopiSrc: string;
  /** coolwsd `net.service_root` path prefix (e.g. `/office-engine`) — required on the WS path. */
  serviceRoot: string;
  /** WS `Origin` header coolwsd expects (its `server_name`, e.g. `http://127.0.0.1:3001`). */
  origin: string;
}

export interface OfficeSessionMintOptions {
  readableNamespaces: string[];
  writableNamespaces: string[];
  /**
   * The mutation gate (== readableNamespaces under the current trust
   * model). The WOPI CheckFileInfo `UserCanWrite` flag and the PutFile
   * 403 gate consume this set, NOT `writableNamespaces` (which is the
   * narrow "where new artifacts attach" anchor). Mirrors the agent's
   * `resolveWorkspaceArtifact(intent:"mutate")` rule.
   */
  mutableNamespaces: string[];
  ownerId: string;
  userId: string;
  /**
   * The editing agent's id. The broker resolves it to the user's custom
   * agent display name (`profiles.name`) for coolwsd's collaborator label
   * (the join/leave toast + cursor name in the human's open editor), so
   * it reads e.g. "Jeannie" instead of a hardcoded default.
   */
  agentId: string;
}

export interface OfficeSessionBroker {
  mintSession(
    artifactInternalId: string,
    opts: OfficeSessionMintOptions,
  ): Promise<OfficeSessionMint | { error: string }>;
}

let _broker: OfficeSessionBroker | null = null;

/**
 * Install the office-session broker. Called once at server boot, right
 * after the agent storage registries. Idempotent: a second call replaces
 * the previous broker (test harnesses use this to swap in a fake).
 */
export function setOfficeSessionBroker(broker: OfficeSessionBroker | null): void {
  _broker = broker;
}

/** Test-only hook: clear the broker between unit tests. */
export function resetOfficeSessionBroker(): void {
  _broker = null;
}

/**
 * Look up the broker. Returns `null` if not wired — callers must handle
 * the null and surface an informative error to the model.
 */
export function getOfficeSessionBroker(): OfficeSessionBroker | null {
  return _broker;
}
