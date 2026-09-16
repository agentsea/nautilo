/**
 * D362 Milestone B — server-side office-session broker.
 *
 * The agent's `office` tool calls `getOfficeSessionBroker()` (from
 * `@nautilo/agent`) to mint a coolwsd WebSocket session for an in-place
 * workspace edit. This is the real broker the server boot sequence
 * installs via `setOfficeSessionBroker(...)`. It reuses `issueWopiToken`
 * from `../routes/wopi` (same mint used by the user-facing
 * `/api/office/wopi-token` route) and assembles the
 * `{ wsBaseUrl, docUrl, wopiSrc }` triple the `CoolSessionClient` needs.
 *
 * URL assembly mirrors what the existing wopi-token route produces for
 * the browser editor URL (see `routes/wopi.ts` ~lines 683-716):
 *   - `wopiSrc = <wopiCallbackOrigin()>/wopi/files/<id>`
 *   - `docUrl  = <wopiSrc>?access_token=<token>&access_token_ttl=0&permission=edit`
 *   - `wsBaseUrl = collaboraEngineOrigin() with http→ws`
 *
 * `wopiCallbackOrigin` and `collaboraEngineOrigin` are exported from
 * `routes/wopi.ts` for this broker (the agent package must not import
 * the server, so the broker lives server-side).
 *
 * NOTE: the canonical `OfficeSessionBroker` / `OfficeSessionMint` /
 * `OfficeSessionMintOptions` types live in `@nautilo/agent`
 * (`tools/office/session-broker.ts`, barrel-exported). This file keeps
 * structural mirrors so the broker compiles independently of the agent
 * barrel; the shapes are identical and the returned value is checked
 * against the real `OfficeSessionBroker` at the `setOfficeSessionBroker`
 * call site in app.ts.
 */

import { resolveInstance } from "@nautilo/config";
import { getAgentDisplayNamesByAgentId } from "@nautilo/db";
import { SHELL_AGENT_NAME } from "@nautilo/types";
import { issueWopiToken, collaboraEngineOrigin, wopiCallbackOrigin } from "../routes/wopi";
import { OFFICE_PROXY_PREFIX } from "../routes/office-proxy";
import { getServerDirectDb } from "./server-direct-db";

/** Structural mirror of `OfficeSessionMint` from `@nautilo/agent`. */
interface SessionMint {
  wsBaseUrl: string;
  docUrl: string;
  wopiSrc: string;
  serviceRoot: string;
  origin: string;
}

/** Structural mirror of `OfficeSessionMintOptions` from `@nautilo/agent`. */
interface SessionMintOptions {
  readableNamespaces: string[];
  writableNamespaces: string[];
  /**
   * The mutation gate (== readableNamespaces under the current trust
   * model). Piped through to `issueWopiToken` and consumed by the WOPI
   * CheckFileInfo `UserCanWrite` flag and the PutFile 403 gate.
   */
  mutableNamespaces: string[];
  ownerId: string;
  userId: string;
  agentId: string;
}

/**
 * Resolve the editing agent's display name (`profiles.name`) for the
 * coolwsd collaborator label. Falls back to the shell default if the
 * profile has no custom name or the lookup fails — the join toast must
 * never surface a raw UUID or crash the mint.
 */
async function resolveAgentDisplayName(agentId: string): Promise<string> {
  if (!agentId) return SHELL_AGENT_NAME;
  try {
    const names = await getAgentDisplayNamesByAgentId(getServerDirectDb(), [agentId]);
    const name = names.get(agentId);
    return name && name.trim().length > 0 ? name : SHELL_AGENT_NAME;
  } catch {
    return SHELL_AGENT_NAME;
  }
}

/** Structural mirror of `OfficeSessionBroker` from `@nautilo/agent`. */
interface SessionBroker {
  mintSession(
    artifactInternalId: string,
    opts: SessionMintOptions,
  ): Promise<SessionMint | { error: string }>;
}

/**
 * The `Origin` header the broker's upstream WS uses when the agent joins a
 * coolwsd co-editing session. coolwsd validates it against its `server_name`
 * allowlist.
 *
 * M201 R1 — topology-aware. Honors `NAUTILO_COLLABORA_WS_ORIGIN` so a
 * containerized deploy can match coolwsd's `server_name=${NAUTILO_DOMAIN}`
 * when the default loopback origin is rejected. Unset → today's dev value
 * (`http://127.0.0.1:<server port>`), so dev behaves identically.
 */
export function collaboraWsOrigin(): string {
  return (
    process.env["NAUTILO_COLLABORA_WS_ORIGIN"] ??
    `http://127.0.0.1:${resolveInstance().server.port}`
  );
}

function toWsOrigin(httpOrigin: string): string {
  if (httpOrigin.startsWith("https://")) return "wss://" + httpOrigin.slice("https://".length);
  if (httpOrigin.startsWith("http://")) return "ws://" + httpOrigin.slice("http://".length);
  // Already a ws:// or wss:// origin — pass through.
  return httpOrigin;
}

/**
 * Build the real broker. The mint here is a tiny subset of the
 * `/api/office/wopi-token` route: it does NOT look up the artifact row
 * (the agent has already resolved + authorized the artifact via
 * `resolveWorkspaceArtifact` with the envelope's namespace grants), so
 * we trust the caller's `artifactInternalId` and mint a token bound to
 * it. The token carries the readable/writable grants the agent envelope
 * had, so the existing `/wopi/*` PutFile write-gate re-derives
 * writability server-side without re-touching the agent envelope.
 */
export function createOfficeSessionBroker(): SessionBroker {
  return {
    // `async` because we resolve the agent's custom display name from the
    // DB (`profiles.name`) for the collaborator label.
    async mintSession(
      artifactInternalId: string,
      opts: SessionMintOptions,
    ): Promise<SessionMint | { error: string }> {
      if (!artifactInternalId || artifactInternalId.length === 0) {
        return { error: "artifactInternalId is required" };
      }
      // coolwsd surfaces this as the collaborator name in the editor
      // (join/leave toasts, cursor label). Pull the user's CUSTOM agent
      // name (e.g. "Jeannie") — NOT a hardcoded label and NOT the raw
      // userId UUID (which produced ugly "<uuid> joined" popups).
      const userFriendlyName = await resolveAgentDisplayName(opts.agentId);
      const { token } = issueWopiToken(artifactInternalId, {
        readableNamespaces: opts.readableNamespaces,
        writableNamespaces: opts.writableNamespaces,
        mutableNamespaces: opts.mutableNamespaces,
        ownerId: opts.ownerId,
        userId: opts.userId,
        userFriendlyName,
        provenance: Object.freeze({ kind: "server_agent" }),
      });

      const callbackOrigin = wopiCallbackOrigin();
      const wopiSrc = `${callbackOrigin}/wopi/files/${encodeURIComponent(artifactInternalId)}`;
      const docUrl =
        `${wopiSrc}?access_token=${encodeURIComponent(token)}` +
        `&access_token_ttl=0&permission=edit`;
      const wsBaseUrl = toWsOrigin(collaboraEngineOrigin());
      // coolwsd runs with `net.service_root=/office-engine` (compose
      // extra_params) so the WS endpoint is `/office-engine/cool/…/ws`, and it
      // validates the WS Origin against `server_name=127.0.0.1:<port>`. Both
      // are required or coolwsd drops the upgrade (close 1002) — verified live.
      const serviceRoot = OFFICE_PROXY_PREFIX;
      const origin = collaboraWsOrigin();

      return Promise.resolve({ wsBaseUrl, docUrl, wopiSrc, serviceRoot, origin });
    },
  };
}
