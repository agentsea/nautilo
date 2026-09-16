import { isSecurityScanProgress } from "@nautilo/relay";
import type { FastifyInstance } from "fastify";
import type { WebSocket, RawData } from "ws";
import { log, warn } from "@nautilo/logger";
import type { InMemoryRelayRegistry } from "@nautilo/runtime";
import {
  RELAY_MIN_SUPPORTED_PROTOCOL_VERSION,
  RELAY_PROTOCOL_VERSION,
  RELAY_RUN_SHELL_PROGRESS_MAX_FRAME_BYTES,
  RELAY_RUN_SHELL_PROGRESS_MAX_TEXT_BYTES,
  RELAY_STRUCTURED_SSH_PROGRESS_MAX_FRAME_BYTES,
  RELAY_STRUCTURED_SSH_PROGRESS_MAX_TEXT_BYTES,
  RELAY_STRUCTURED_SSH_PROGRESS_PROTOCOL_VERSION,
  RELAY_MCP_TRUTH_MAX_FRAME_BYTES,
  RELAY_SSH_PREPARE_MAX_FRAME_BYTES,
  CODEX_RELAY_PROTOCOL_VERSION,
  CODEX_RELAY_MAX_FRAME_BYTES,
  classifyRelayTopLevelType,
  isRelayMcpConfigureResultMessage,
  isRelayMcpPreflightResultMessage,
  isRelaySshPreparedMessage,
  isRelayCodexFrameType,
  parseRelayCodexJsonFrame,
  isRelayAcpFrameType,
  isRelayAcpReadinessFrameType,
  parseRelayAcpJsonFrame,
  ACP_RELAY_MAX_FRAME_BYTES,
  ACP_RELAY_READINESS_MAX_FRAME_BYTES,
  CLAUDE_CONNECTION_MAX_FRAME_BYTES,
  CLAUDE_CONNECTION_PROTOCOL_VERSION,
  parseRelayClaudeConnectionDiscoveryResult,
  CLAUDE_EXECUTION_MAX_FRAME_BYTES,
  CLAUDE_EXECUTION_PROTOCOL_VERSION,
  isRelayClaudeExecutionFrameType,
  parseRelayClaudeExecutionDesktopEvent,
  projectRelayCapabilitiesForProtocol,
  type RelayCapabilities,
  type RelayClientMessage,
  type RelayRegisterMessage,
  type RelayCodexClientMessage,
  type RelayAcpClientMessage,
  type RelayClaudeConnectionDiscoveryResult,
  type RelayClaudeExecutionDesktopEvent,
  type RelayResultMessage,
  type RelayRunShellProgressMessage,
  type RelayStructuredSshProgressMessage,
  RELAY_AUTHENTICATION_REQUIRED_ERROR_CODE,
  RELAY_TOKEN_AUTH_CLOSE_CODE,
} from "@nautilo/relay";
import { validateRelayToken } from "./relay-token";
import { getToolCatalog } from "@nautilo/catalog";
import { getServerDirectDb } from "../lib/server-direct-db";
import {
  buildRelayMcpConfigs,
  registerRelayAdvertisedTools,
  unregisterRelayServer,
} from "../mcp/relay-mcp-bridge";

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (data instanceof Buffer) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return "";
}

/** WS close code reserved for relay token-auth failures.
 *
 * 4401 lives in the WS private close-code range (4000–4999) and
 * borrows the HTTP 401 convention. M058's `/ws` first-frame-auth
 * path will reuse the same code so the cluster has a single
 * auth-failure signal across both WS surfaces. The pre-existing
 * 1002 ("Protocol error") is reserved for genuine
 * `RELAY_PROTOCOL_VERSION` mismatches — different category.
 */
export { RELAY_TOKEN_AUTH_CLOSE_CODE } from "@nautilo/relay";

/** Exact-session guard for the non-revocation local-MCP safety close. */
export function isExpectedRelayDesktopSession(
  currentDesktopSessionId: string | null | undefined,
  expectedDesktopSessionId: string,
): boolean {
  return currentDesktopSessionId === expectedDesktopSessionId;
}

/**
 * D480 — server-owned socket lifecycle port. The HTTP lifecycle routes never
 * own websocket maps and must close a revoked relay through this endpoint so
 * the normal close/unregister path remains responsible for MCP, mini-app,
 * and pending-dispatch cleanup.
 */
export interface RelaySocketLifecycleController {
  closeRelays(relayIds: readonly string[]): number;
  /** D503 non-revocation safety close after an unconfirmed MCP rollback. */
  forceCloseRelays?(
    relayIds: readonly string[],
    expectedDesktopSessionId: string,
  ): number;
}

/** A narrow, post-commit lifecycle reconciliation input for relay routes. */
export interface RevokedRelayPairingGenerations {
  readonly userId: string;
  /** Exact revoked relay-token row IDs, i.e. authoritative pairing generations. */
  readonly pairingGenerations: readonly string[];
}

export interface RelayPairingGenerationInvalidationResult {
  readonly matchedLiveRelays: number;
  readonly invalidatedWorkstationSessions: number;
  readonly invalidatedDispatchPlans: number;
  readonly closedRelaySockets: number;
}

/**
 * D480 — dependency seam injected into grouped revoke / historical cleanup
 * HTTP handlers after their DB transaction commits. It has no DB knowledge:
 * the caller supplies only the exact revoked row IDs returned by that
 * transaction. This function snapshots exact live ownership first, clears
 * server-side Full Workstation sessions synchronously, then asks the relay
 * endpoint to close the matching owned sockets.
 */
export interface RelayPairingGenerationInvalidator {
  reconcileRevokedPairingGenerations(
    input: RevokedRelayPairingGenerations,
  ): RelayPairingGenerationInvalidationResult;
}

interface PairingGenerationRelayRegistry {
  snapshotLiveRelaysForPairingGenerations(
    input: RevokedRelayPairingGenerations,
  ): readonly LiveRelayPairingGenerationSnapshot[];
}

interface LiveRelayPairingGenerationSnapshot {
  readonly relayId: string;
  readonly userId: string;
  readonly desktopSessionId: string | null;
  readonly pairingGeneration: string;
}

interface PairingGenerationWorkstationSessions {
  invalidateForRelayBinding(input: {
    readonly userId: string;
    readonly serverBindingId: string;
    readonly relayId: string;
    readonly desktopSessionId: string;
    readonly pairingGeneration: string;
  }): { readonly invalidated: boolean };
}

interface PairingGenerationDispatchPlans {
  invalidateForBinding(input: {
    readonly userId: string;
    readonly relayId: string;
    readonly desktopSessionId: string;
  }): number;
}

export function createRelayPairingGenerationInvalidator(input: {
  relayRegistry: PairingGenerationRelayRegistry;
  workstationSessionRegistry: PairingGenerationWorkstationSessions;
  workstationDispatchPlanRegistry: PairingGenerationDispatchPlans;
  serverBindingId: string;
  socketLifecycle: RelaySocketLifecycleController;
}): RelayPairingGenerationInvalidator {
  return {
    reconcileRevokedPairingGenerations({ userId, pairingGenerations }) {
      const liveRelays = input.relayRegistry.snapshotLiveRelaysForPairingGenerations({
        userId,
        pairingGenerations,
      });
      let invalidatedWorkstationSessions = 0;
      let invalidatedDispatchPlans = 0;

      // A pairing revoke is fundamentally different from a transient relay
      // disconnect: it permanently kills the exact generation's authority
      // before its socket close can run the ordinary unregister cleanup.
      for (const relay of liveRelays) {
        if (relay.desktopSessionId === null) continue;
        const session = input.workstationSessionRegistry.invalidateForRelayBinding({
          userId: relay.userId,
          serverBindingId: input.serverBindingId,
          relayId: relay.relayId,
          desktopSessionId: relay.desktopSessionId,
          pairingGeneration: relay.pairingGeneration,
        });
        if (session.invalidated) invalidatedWorkstationSessions++;
        invalidatedDispatchPlans += input.workstationDispatchPlanRegistry.invalidateForBinding({
          userId: relay.userId,
          relayId: relay.relayId,
          desktopSessionId: relay.desktopSessionId,
        });
      }

      const closedRelaySockets = input.socketLifecycle.closeRelays(
        liveRelays.map((relay) => relay.relayId),
      );
      return {
        matchedLiveRelays: liveRelays.length,
        invalidatedWorkstationSessions,
        invalidatedDispatchPlans,
        closedRelaySockets,
      };
    },
  };
}

/**
 * A relay id in a post-register frame is only valid when it names the relay
 * that successfully authenticated on this very socket.  Exported as a small
 * pure seam so the transport's spoof barrier can be tested without a WS server.
 */
export function isFrameBoundToRegisteredRelay(
  registeredRelayId: string | null,
  frameRelayId: string,
): boolean {
  return registeredRelayId !== null && registeredRelayId === frameRelayId;
}

/**
 * D458 server-only composition helper for a relay-token re-pair/revoke.
 * `relayHttpRoutes` supplies the user-scoped generation list; this helper
 * first runs the durable controller-binding/presence invalidation callback and
 * then disconnects every exact live relay generation.  The relay ids are read
 * only from the owner-filtered registry snapshot and never escape to HTTP/WS.
 */
export interface RelayGenerationEvictionRegistry {
  snapshotForUser(userId: string): ReadonlyArray<{
    relayId: string;
    pairingGeneration: string;
  }>;
  unregister(relayId: string): Promise<void>;
}

export function createRelayGenerationInvalidator(args: {
  registry: RelayGenerationEvictionRegistry;
  invalidateAuthorityAndPresence: (input: {
    userId: string;
    pairingGenerationIds: readonly string[];
  }) => Promise<unknown>;
}): {
  invalidatePairingGenerations(input: {
    userId: string;
    pairingGenerationIds: readonly string[];
  }): Promise<void>;
} {
  return {
    async invalidatePairingGenerations(input) {
      const revoked = new Set(input.pairingGenerationIds);
      const matchingRelayIds = args.registry
        .snapshotForUser(input.userId)
        .filter((entry) => revoked.has(entry.pairingGeneration))
        .map((entry) => entry.relayId);
      try {
        await args.invalidateAuthorityAndPresence(input);
      } finally {
        // Durable revocation already committed before this callback. Even if
        // projection/reconciliation is temporarily unavailable, the revoked
        // live generation must become undispatchable immediately.
        await Promise.all(
          matchingRelayIds.map((relayId) => args.registry.unregister(relayId)),
        );
      }
    },
  };
}

/** Minimal WS surface the register handler needs. Lets unit tests
 *  pass a fake socket without spinning up a real Fastify+WS instance. */
export interface RelaySocketLike {
  /** WebSocket.OPEN's numeric value (1) on the real ws lib. We
   *  compare against `socket.readyState` to gate sends. */
  readyState: number;
  /** Match `WebSocket.OPEN` so handler comparisons land on the same
   *  numeric constant the runtime uses. */
  readonly OPEN: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** Subset of `InMemoryRelayRegistry` the register handler calls. */
export interface RelayRegistryLike {
  register(
    relayId: string,
    userId: string,
    capabilities: RelayCapabilities,
    send: (msg: unknown) => void,
    protocolVersion?: number,
    desktopSessionId?: string,
    capabilityRevision?: number,
    /**
     * D418 Commit 2 — server-derived `pairingGeneration` stamped from the
     * validated relay-token row id. Never read from the relay/client payload.
     */
    pairingGeneration?: string,
  ): void | Promise<void>;
}

export interface RelayCodexRegistryLike {
  acceptCodexMessage(input: {
    relayId: string;
    userId: string;
    message: RelayCodexClientMessage;
  }): { ok: true } | { ok: false; error: string };
  getV8Acknowledgement?(relayId: string): {
    relaySessionId: string;
    pairingGenerationRef: string;
  } | null;
}

export interface RelayAcpRegistryLike {
  acceptAcpMessage(input: {
    relayId: string;
    userId: string;
    message: RelayAcpClientMessage;
  }): { ok: true } | { ok: false; error: string };
}

export interface RelayClaudeConnectionRegistryLike {
  acceptClaudeConnectionDiscoveryResult(input: {
    relayId: string;
    userId: string;
    message: RelayClaudeConnectionDiscoveryResult;
  }): { ok: true } | { ok: false; error: string };
}

export interface RelayClaudeExecutionRegistryLike {
  acceptClaudeExecutionEvent(input: {
    relayId: string;
    userId: string;
    message: RelayClaudeExecutionDesktopEvent;
  }): { ok: true } | { ok: false; error: string };
}

interface RelayClaudeConnectionContextPublisher {
  publishClaudeConnectionContext(relayId: string, userId: string): boolean;
}

export interface HandleRegisterResult {
  readonly outcome:
    | "registered"
    | "rejected-no-token"
    | "rejected-invalid-token"
    | "version-mismatch"
    | "internal-error";
  readonly effectiveUserId?: string;
  readonly protocolVersion?: number;
  readonly capabilities?: RelayCapabilities;
}

export interface RelayProtocolPolicy {
  readonly minimum: number;
  readonly maximum: number;
}

/** Highest-common-version negotiation. Invalid ranges have no intersection. */
export function negotiateRelayProtocolVersion(
  msg: Pick<RelayRegisterMessage, "protocolVersion" | "protocolRange">,
  policy: RelayProtocolPolicy,
): number | null {
  const bootstrap = msg.protocolVersion;
  const clientMinimum = msg.protocolRange?.minimum ?? bootstrap;
  const clientMaximum = msg.protocolRange?.maximum ?? bootstrap;
  if (
    !Number.isSafeInteger(bootstrap) ||
    !Number.isSafeInteger(clientMinimum) ||
    !Number.isSafeInteger(clientMaximum) ||
    !Number.isSafeInteger(policy.minimum) ||
    !Number.isSafeInteger(policy.maximum) ||
    clientMinimum > clientMaximum ||
    policy.minimum > policy.maximum ||
    bootstrap < clientMinimum ||
    bootstrap > clientMaximum
  ) return null;
  const highestCommon = Math.min(clientMaximum, policy.maximum);
  return highestCommon >= Math.max(clientMinimum, policy.minimum)
    ? highestCommon
    : null;
}

function configuredRelayProtocolPolicy(): RelayProtocolPolicy {
  const rawMinimum = process.env["NAUTILO_RELAY_MIN_PROTOCOL_VERSION"];
  const configured = Number(rawMinimum);
  const minimum = rawMinimum === undefined
    ? RELAY_MIN_SUPPORTED_PROTOCOL_VERSION
    : Number.isSafeInteger(configured) &&
      configured >= RELAY_MIN_SUPPORTED_PROTOCOL_VERSION &&
      configured <= RELAY_PROTOCOL_VERSION
      ? configured
      : RELAY_PROTOCOL_VERSION;
  return { minimum, maximum: RELAY_PROTOCOL_VERSION };
}

/** Subset of the registry the capability-update handler calls. */
export interface RelayCapabilityUpdateRegistryLike {
  updateCapabilities(input: {
    relayId: string;
    userId: string;
    desktopSessionId: string;
    capabilityRevision: number;
    capabilities: RelayCapabilities;
  }): { ok: true } | { ok: false; error: string };
}

/** Result of a `relay:update-capabilities` arm, returned for unit tests. */
export interface HandleUpdateCapabilitiesResult {
  readonly outcome: "applied" | "rejected-unregistered" | "rejected-stale" | "rejected-malformed";
  readonly error?: string;
}

/**
 * M056 — exported for unit testing. Runs the full `relay:register`
 * arm: protocol-version check, in-band token validation, and finally
 * `registry.register(...)` with the
 * spoof-resistant `effectiveUserId`.
 *
 * Returns the outcome so the test can assert without scraping logs.
 * Side effects (socket.send, socket.close, registry.register) are
 * already observable on the injected fakes.
 */
export async function handleRelayRegister(
  socket: RelaySocketLike,
  msg: RelayRegisterMessage,
  registry: RelayRegistryLike,
  protocolPolicy: RelayProtocolPolicy = {
    minimum: RELAY_MIN_SUPPORTED_PROTOCOL_VERSION,
    maximum: RELAY_PROTOCOL_VERSION,
  },
): Promise<HandleRegisterResult> {
  const claimedVersion = (msg as { protocolVersion: unknown }).protocolVersion;
  const negotiatedVersion = negotiateRelayProtocolVersion(msg, protocolPolicy);
  if (negotiatedVersion === null) {
    if (socket.readyState === socket.OPEN) {
      socket.send(
        JSON.stringify({
          type: "relay:error",
          message: `No supported relay protocol intersection for ${String(claimedVersion)}. Server accepts v${protocolPolicy.minimum}–v${protocolPolicy.maximum}.`,
        }),
      );
    }
    socket.close(1002, "Protocol version mismatch");
    return { outcome: "version-mismatch" };
  }

  let validated: Awaited<ReturnType<typeof validateRelayToken>> = null;
  try {
    validated = await validateRelayToken(msg.token);
  } catch (err) {
    warn(
      `[relay] token validation errored: ${err instanceof Error ? err.message : String(err)}`,
    );
    if (socket.readyState === socket.OPEN) {
      socket.send(
        JSON.stringify({
          type: "relay:error",
          message: "Internal error during registration",
        }),
      );
      socket.close(1011, "Internal error");
    }
    return { outcome: "internal-error" };
  }

  if (!validated) {
    warn(
      `[relay] register rejected: invalid token (relayId=${msg.relayId})`,
    );
    if (socket.readyState === socket.OPEN) {
      socket.send(
        JSON.stringify({
          type: "relay:error",
          message: "Invalid or missing relay token",
          code: RELAY_AUTHENTICATION_REQUIRED_ERROR_CODE,
        }),
      );
      socket.close(
        RELAY_TOKEN_AUTH_CLOSE_CODE,
        "Relay token validation failed",
      );
    }
    return {
      outcome: msg.token ? "rejected-invalid-token" : "rejected-no-token",
    };
  }

  const effectiveUserId = validated ? validated.userId : msg.userId;
  // D418 Commit 2 — the server-derived `pairingGeneration` is the validated
  // relay-token row id. It is NEVER accepted from the relay/client payload;
  // it is stamped onto the relay registry entry straight from the validated
  // token so the binding provider + plan re-validation can pin a Full
  // Workstation session to an exact pairing generation.
  const pairingGeneration = validated ? validated.tokenId : undefined;
  const versionCapabilities = msg.capabilitiesByProtocolVersion?.[String(negotiatedVersion)];
  const negotiatedCapabilities = projectRelayCapabilitiesForProtocol(
    versionCapabilities ?? msg.capabilities,
    negotiatedVersion,
  );

  const send = (serverMsg: unknown) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(serverMsg));
    }
  };

  await registry.register(
    msg.relayId,
    effectiveUserId,
    negotiatedCapabilities,
    send,
    negotiatedVersion,
    msg.desktopSessionId,
    msg.capabilityRevision,
    pairingGeneration,
  );

  if (socket.readyState === socket.OPEN) {
    const v8Ack = negotiatedVersion >= CODEX_RELAY_PROTOCOL_VERSION
      ? (registry as unknown as RelayCodexRegistryLike).getV8Acknowledgement?.(msg.relayId)
      : null;
    socket.send(JSON.stringify(v8Ack
      ? {
          type: "relay:registered",
          relayId: msg.relayId,
          protocolVersion: negotiatedVersion,
          relaySessionId: v8Ack.relaySessionId,
          pairingGenerationRef: v8Ack.pairingGenerationRef,
          selectedProtocolVersion: negotiatedVersion,
        }
      : {
          type: "relay:registered",
          relayId: msg.relayId,
          protocolVersion: negotiatedVersion,
        }));
  }
  log(
    `[relay] Connected: ${msg.relayId} (${negotiatedCapabilities.profile}) for ${effectiveUserId} at relay protocol v${negotiatedVersion}` +
      (validated ? " [token-validated]" : ""),
  );
  return {
    outcome: "registered",
    effectiveUserId,
    protocolVersion: negotiatedVersion,
    capabilities: negotiatedCapabilities,
  };
}

/**
 * Applies the v8 pre-parse frame ceiling only after a bounded lexical
 * top-level type inspection. Existing generic relay families keep their
 * historic parser and limits unchanged.
 */
export function parseRelayEndpointClientMessage(raw: string):
  | { ok: true; message: RelayClientMessage }
  | { ok: false; codex: boolean; error: string } {
  const frameBytes = Buffer.byteLength(raw, "utf8");
  const type = classifyRelayTopLevelType(raw);
  // Reject before JSON.parse: an authenticated relay is still untrusted, and
  // a giant output frame must not allocate server memory merely to be deemed
  // invalid by the field-level v11 parser below.
  if (type === "relay:run-shell-progress" && frameBytes > RELAY_RUN_SHELL_PROGRESS_MAX_FRAME_BYTES) {
    return { ok: false, codex: false, error: "RUN_SHELL_PROGRESS_FRAME_TOO_LARGE" };
  }
  if (type === "relay:structured-ssh-progress" && frameBytes > RELAY_STRUCTURED_SSH_PROGRESS_MAX_FRAME_BYTES) {
    return { ok: false, codex: false, error: "STRUCTURED_SSH_PROGRESS_FRAME_TOO_LARGE" };
  }
  if (
    (type === "relay:mcp-preflight-result" || type === "relay:mcp-configure-result") &&
    frameBytes > RELAY_MCP_TRUTH_MAX_FRAME_BYTES
  ) {
    return { ok: false, codex: false, error: "MCP_TRUTH_FRAME_TOO_LARGE" };
  }
  if (type === "relay:ssh-prepared" && frameBytes > RELAY_SSH_PREPARE_MAX_FRAME_BYTES) {
    return { ok: false, codex: false, error: "SSH_PREPARE_FRAME_TOO_LARGE" };
  }
  if (type === "relay:claude-connection-discovery-result") {
    if (frameBytes > CLAUDE_CONNECTION_MAX_FRAME_BYTES) {
      return { ok: false, codex: false, error: "CLAUDE_CONNECTION_FRAME_TOO_LARGE" };
    }
    try {
      const parsed = parseRelayClaudeConnectionDiscoveryResult(JSON.parse(raw) as unknown);
      return parsed === null
        ? { ok: false, codex: false, error: "CLAUDE_CONNECTION_FRAME_INVALID" }
        : { ok: true, message: parsed as RelayClientMessage };
    } catch {
      return { ok: false, codex: false, error: "CLAUDE_CONNECTION_FRAME_INVALID" };
    }
  }
  if (isRelayClaudeExecutionFrameType(type)) {
    if (frameBytes > CLAUDE_EXECUTION_MAX_FRAME_BYTES) {
      return { ok: false, codex: false, error: "CLAUDE_EXECUTION_FRAME_TOO_LARGE" };
    }
    if (type !== "relay:claude-execution-event") {
      return { ok: false, codex: false, error: "CLAUDE_EXECUTION_FRAME_INVALID" };
    }
    try {
      const parsed = parseRelayClaudeExecutionDesktopEvent(JSON.parse(raw) as unknown);
      return parsed === null
        ? { ok: false, codex: false, error: "CLAUDE_EXECUTION_FRAME_INVALID" }
        : { ok: true, message: parsed as RelayClientMessage };
    } catch {
      return { ok: false, codex: false, error: "CLAUDE_EXECUTION_FRAME_INVALID" };
    }
  }
  if (isRelayCodexFrameType(type)) {
    if (frameBytes > CODEX_RELAY_MAX_FRAME_BYTES) {
      return { ok: false, codex: true, error: "CODEX_FRAME_TOO_LARGE" };
    }
    const parsed = parseRelayCodexJsonFrame(raw, "client");
    return parsed.ok
      ? { ok: true, message: parsed.value as RelayClientMessage }
      : { ok: false, codex: true, error: parsed.error };
  }
  if (isRelayAcpFrameType(type)) {
    const acpFrameLimit = isRelayAcpReadinessFrameType(type)
      ? ACP_RELAY_READINESS_MAX_FRAME_BYTES
      : ACP_RELAY_MAX_FRAME_BYTES;
    if (frameBytes > acpFrameLimit) return { ok: false, codex: false, error: "ACP_FRAME_TOO_LARGE" };
    const parsed = parseRelayAcpJsonFrame(raw, "client");
    return parsed.ok
      ? { ok: true, message: parsed.value as RelayClientMessage }
      : { ok: false, codex: false, error: parsed.error };
  }
  try {
    const message = JSON.parse(raw) as RelayClientMessage;
    const decodedType = (message as { readonly type?: unknown }).type;
    if (typeof decodedType === "string" && isRelayCodexFrameType(decodedType)) {
      return {
        ok: false,
        codex: true,
        error: frameBytes > CODEX_RELAY_MAX_FRAME_BYTES
          ? "CODEX_FRAME_TOO_LARGE"
          : "CODEX_FRAME_INVALID",
      };
    }
    if (typeof decodedType === "string" && isRelayClaudeExecutionFrameType(decodedType)) {
      return {
        ok: false,
        codex: false,
        error: frameBytes > CLAUDE_EXECUTION_MAX_FRAME_BYTES
          ? "CLAUDE_EXECUTION_FRAME_TOO_LARGE"
          : "CLAUDE_EXECUTION_FRAME_INVALID",
      };
    }
    return { ok: true, message };
  } catch {
    return { ok: false, codex: false, error: "Invalid JSON" };
  }
}

/** Pure ownership fence for one already strict-parsed Claude discovery result. */
export function handleRelayClaudeConnectionDiscoveryResult(input: {
  registeredRelayId: string | null;
  registeredUserId: string | null;
  registeredProtocolVersion: number | null;
  currentSocket: boolean;
  message: RelayClaudeConnectionDiscoveryResult;
  registry: RelayClaudeConnectionRegistryLike;
}): { ok: true } | { ok: false; error: string } {
  if (
    input.registeredRelayId === null || input.registeredUserId === null ||
    input.registeredProtocolVersion === null || input.registeredProtocolVersion < CLAUDE_CONNECTION_PROTOCOL_VERSION ||
    !input.currentSocket
  ) return { ok: false, error: "CLAUDE_CONNECTION_UNAVAILABLE" };
  return input.registry.acceptClaudeConnectionDiscoveryResult({
    relayId: input.registeredRelayId,
    userId: input.registeredUserId,
    message: input.message,
  });
}

/** Pure ownership fence for one already strict-parsed v18 execution event. */
export function handleRelayClaudeExecutionEvent(input: {
  registeredRelayId: string | null;
  registeredUserId: string | null;
  registeredProtocolVersion: number | null;
  currentSocket: boolean;
  message: RelayClaudeExecutionDesktopEvent;
  registry: RelayClaudeExecutionRegistryLike;
}): { ok: true } | { ok: false; error: string } {
  if (
    input.registeredRelayId === null || input.registeredUserId === null ||
    input.registeredProtocolVersion === null || input.registeredProtocolVersion < CLAUDE_EXECUTION_PROTOCOL_VERSION ||
    !input.currentSocket
  ) return { ok: false, error: "CLAUDE_EXECUTION_UNAVAILABLE" };
  if (
    input.message.scope.relayId !== input.registeredRelayId ||
    input.message.scope.selectedProtocolVersion !== input.registeredProtocolVersion
  ) return { ok: false, error: "CLAUDE_EXECUTION_CONTEXT_STALE" };
  return input.registry.acceptClaudeExecutionEvent({
    relayId: input.registeredRelayId,
    userId: input.registeredUserId,
    message: input.message,
  });
}

/** Positive context publication is legal only once acknowledgement and socket ownership both hold. */
export function publishClaudeConnectionContextAfterAck(input: {
  acknowledged: boolean;
  socketOpen: boolean;
  currentSocket: boolean;
  relayId: string;
  userId: string;
  registry: Partial<RelayClaudeConnectionContextPublisher>;
}): boolean {
  return input.acknowledged && input.socketOpen && input.currentSocket
    ? input.registry.publishClaudeConnectionContext?.(input.relayId, input.userId) === true
    : false;
}

/** M196 — keep relay result machine error codes intact for agent/tool UI. */
export function handleRelayResult(
  msg: RelayResultMessage,
  registry: Pick<InMemoryRelayRegistry, "resolveDispatch">,
): void {
  registry.resolveDispatch(msg.correlationId, {
    status: msg.status,
    result: msg.result,
    error: msg.error,
    errorCode: msg.errorCode,
    networkDeniedDestination: msg.networkDeniedDestination,
    durationMs: msg.durationMs,
  });
}

/** D502: relay progress is provisional and only routes to its pending call. */
function handleRelayRunShellProgress(
  msg: RelayRunShellProgressMessage,
  registry: Pick<InMemoryRelayRegistry, "acceptRunShellProgress">,
): void {
  registry.acceptRunShellProgress(msg);
}

/** D500: provisional observations route only to an exact pending SSH call. */
function handleRelayStructuredSshProgress(
  msg: RelayStructuredSshProgressMessage,
  registry: Pick<InMemoryRelayRegistry, "acceptStructuredSshProgress">,
): void {
  registry.acceptStructuredSshProgress(msg);
}

/** Strict ingress gate for the v11 D502 observation frame. */
export function isValidRelayRunShellProgress(msg: RelayRunShellProgressMessage): boolean {
  const textBytes = typeof msg.text === "string" ? Buffer.byteLength(msg.text, "utf8") : -1;
  const droppedBytes = msg.droppedBytes ?? 0;
  return (
    msg.version === 1 &&
    Number.isSafeInteger(msg.sequence) && msg.sequence >= 0 &&
    (msg.stream === "stdout" || msg.stream === "stderr") &&
    Number.isSafeInteger(msg.offsetBytes) && msg.offsetBytes >= 0 &&
    Number.isSafeInteger(msg.endOffsetBytes) && msg.endOffsetBytes >= msg.offsetBytes &&
    typeof msg.text === "string" && textBytes <= RELAY_RUN_SHELL_PROGRESS_MAX_TEXT_BYTES &&
    (msg.droppedBytes === undefined ||
      (Number.isSafeInteger(msg.droppedBytes) && msg.droppedBytes >= 0)) &&
    msg.endOffsetBytes === msg.offsetBytes + textBytes + droppedBytes &&
    Number.isSafeInteger(msg.elapsedMs) && msg.elapsedMs >= 0 &&
    msg.phase === "running"
  );
}

function hasOnlyProgressKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/** Strict ingress gate for D500 v15's non-authoritative SSH observations. */
export function isValidRelayStructuredSshProgress(msg: RelayStructuredSshProgressMessage): boolean {
  const raw = msg as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const value = raw as Record<string, unknown>;
  if (
    value["type"] !== "relay:structured-ssh-progress" ||
    typeof value["correlationId"] !== "string" || value["correlationId"].length === 0 ||
    value["version"] !== 1 ||
    !Number.isSafeInteger(value["sequence"]) || (value["sequence"] as number) < 0 ||
    !Number.isSafeInteger(value["elapsedMs"]) || (value["elapsedMs"] as number) < 0
  ) return false;
  if (value["kind"] === "exec-output") {
    const text = value["text"];
    const droppedBytes = value["droppedBytes"] ?? 0;
    const textBytes = typeof text === "string" ? Buffer.byteLength(text, "utf8") : -1;
    return hasOnlyProgressKeys(value, [
      "type", "correlationId", "version", "sequence", "operation", "kind", "stream", "offsetBytes", "endOffsetBytes",
      "text", "droppedBytes", "elapsedMs", "phase",
    ]) &&
      value["operation"] === "exec" &&
      (value["stream"] === "stdout" || value["stream"] === "stderr") &&
      Number.isSafeInteger(value["offsetBytes"]) && (value["offsetBytes"] as number) >= 0 &&
      Number.isSafeInteger(value["endOffsetBytes"]) && (value["endOffsetBytes"] as number) >= (value["offsetBytes"] as number) &&
      typeof text === "string" && textBytes <= RELAY_STRUCTURED_SSH_PROGRESS_MAX_TEXT_BYTES &&
      Number.isSafeInteger(droppedBytes) && (droppedBytes as number) >= 0 &&
      (value["endOffsetBytes"] as number) === (value["offsetBytes"] as number) + textBytes + (droppedBytes as number) &&
      value["phase"] === "running";
  }
  if (value["kind"] === "transfer") {
    return hasOnlyProgressKeys(value, [
      "type", "correlationId", "version", "sequence", "operation", "kind", "phase", "transferredBytes", "totalBytes", "elapsedMs",
    ]) &&
      (value["operation"] === "copy-upload" || value["operation"] === "copy-download") &&
      (value["phase"] === "starting" || value["phase"] === "transferring") &&
      Number.isSafeInteger(value["transferredBytes"]) && (value["transferredBytes"] as number) >= 0 &&
      (value["totalBytes"] === undefined ||
        (Number.isSafeInteger(value["totalBytes"]) && (value["totalBytes"] as number) >= (value["transferredBytes"] as number)));
  }
  return false;
}

/**
 * D418 protocol v7 — the wire shape of a `relay:update-capabilities` frame.
 * `RelayUpdateCapabilitiesMessage` is not re-exported from the relay package
 * root, so derive it from the exported `RelayClientMessage` union.
 */
type RelayUpdateCapabilitiesMessage = Extract<
  RelayClientMessage,
  { type: "relay:update-capabilities" }
>;

function sendCapabilityUpdateAck(
  socket: RelaySocketLike,
  msg: RelayUpdateCapabilitiesMessage,
  status: "ok" | "rejected",
  error?: string,
): void {
  if (socket.readyState !== socket.OPEN) return;
  const ack: Record<string, unknown> = {
    type: "relay:capabilities-updated",
    relayId: msg.relayId,
    capabilityRevision: msg.capabilityRevision,
    status,
  };
  if (error !== undefined) ack["error"] = error;
  socket.send(JSON.stringify(ack));
}

/**
 * D418 protocol v7 — exported for unit testing. Runs the
 * `relay:update-capabilities` arm: the update is accepted ONLY for the
 * registered authenticated socket/relay/user, then delegated to the
 * registry which requires an exact `desktopSessionId`, strictly parses the
 * full capabilities (including the grant snapshot), rejects stale/duplicate
 * revisions, and atomically replaces capabilities + snapshot. The server
 * always acks with `relay:capabilities-updated` (ok or rejected).
 */
export function handleRelayUpdateCapabilities(
  socket: RelaySocketLike,
  msg: RelayUpdateCapabilitiesMessage,
  registry: RelayCapabilityUpdateRegistryLike,
  context: { relayId: string; userId: string },
): Promise<HandleUpdateCapabilitiesResult> {
  // Bind the update to the registered socket for this exact relay id. A
  // frame from an unregistered socket or a mismatched relay id is rejected.
  if (msg.relayId !== context.relayId) {
    sendCapabilityUpdateAck(
      socket,
      msg,
      "rejected",
      "update is not for the registered relay",
    );
    return Promise.resolve({
      outcome: "rejected-unregistered",
      error: "update is not for the registered relay",
    });
  }
  const result = registry.updateCapabilities({
    relayId: msg.relayId,
    userId: context.userId,
    desktopSessionId: msg.desktopSessionId,
    capabilityRevision: msg.capabilityRevision,
    capabilities: msg.capabilities,
  });
  if (result.ok) {
    sendCapabilityUpdateAck(socket, msg, "ok");
    return Promise.resolve({ outcome: "applied" });
  }
  const isStale = /stale|duplicate|session|registered user/i.test(result.error);
  const outcome: HandleUpdateCapabilitiesResult["outcome"] = isStale
    ? "rejected-stale"
    : "rejected-malformed";
  sendCapabilityUpdateAck(socket, msg, "rejected", result.error);
  return Promise.resolve({ outcome, error: result.error });
}

/**
 * WebSocket endpoint at /relay for relay client connections.
 * Separate from /ws which broadcasts ServerEvents to UI clients.
 */
export function relayRoutes(
  app: FastifyInstance,
  registry: InMemoryRelayRegistry,
): RelaySocketLifecycleController {
  const socketMap = new Map<string, WebSocket>();

  const socketLifecycle: RelaySocketLifecycleController = {
    closeRelays(relayIds) {
      let closed = 0;
      for (const relayId of new Set(relayIds)) {
        const socket = socketMap.get(relayId);
        if (!socket || socket.readyState !== socket.OPEN) continue;
        socket.close(RELAY_TOKEN_AUTH_CLOSE_CODE, "Pairing revoked");
        closed++;
      }
      return closed;
    },
    forceCloseRelays(relayIds, expectedDesktopSessionId) {
      let closed = 0;
      for (const relayId of new Set(relayIds)) {
        // A reconnect can reuse relayId with a different Desktop session.
        // Never close that replacement over an old install's rollback.
        if (!isExpectedRelayDesktopSession(
          registry.getDesktopSessionId(relayId),
          expectedDesktopSessionId,
        )) continue;
        const socket = socketMap.get(relayId);
        if (!socket || socket.readyState !== socket.OPEN) continue;
        socket.close(1011, "Local MCP rollback unconfirmed");
        closed++;
      }
      return closed;
    },
  };

  app.get("/relay", { websocket: true }, (socket: WebSocket) => {
    let registeredRelayId: string | null = null;
    // D418 protocol v7 — the validated user id for this socket, stamped at
    // register. Capability updates are accepted only for this user.
    let registeredUserId: string | null = null;
    let registeredProtocolVersion: number | null = null;
    // D384 Phase 5 — serverNames this relay has advertised MCP tools for, so
    // we can unregister them from the catalog on disconnect/close.
    const advertisedMcpServers = new Set<string>();

    const sendToSocket = (serverMsg: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(serverMsg));
    };

    // D384 Phase 5 — after a v3 relay that opted into MCP hosting registers,
    // ship it the configs it should host (secret-free). The relay reconciles
    // and advertises tools back via relay:advertise-mcp-tools.
    const configureRelayMcp = (relayId: string, caps: RelayCapabilities) => {
      if (caps.mcpTools === undefined) return; // relay doesn't host MCP
      void (async () => {
        try {
          const servers = await buildRelayMcpConfigs(getServerDirectDb(), relayId);
          if (servers.length > 0) {
            sendToSocket({ type: "relay:configure-mcp", servers });
            log(`[relay] sent configure-mcp to ${relayId} (${servers.length} server(s))`);
          }
        } catch (err) {
          warn(
            `[relay] configure-mcp for ${relayId} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
    };

    const cleanupRelayMcp = (relayId: string) => {
      if (advertisedMcpServers.size === 0) return;
      const catalog = getToolCatalog();
      if (!catalog) {
        advertisedMcpServers.clear();
        return;
      }
      for (const serverName of advertisedMcpServers) {
        try {
          unregisterRelayServer(catalog, relayId, serverName);
        } catch (err) {
          warn(
            `[relay] cleanup MCP "${serverName}" for ${relayId} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      advertisedMcpServers.clear();
    };

    socket.on("message", (raw: RawData) => {
      const parsed = parseRelayEndpointClientMessage(rawDataToString(raw));
      if (!parsed.ok) {
        socket.send(JSON.stringify({ type: "relay:error", message: parsed.error }));
        if (parsed.codex) socket.close(1009, parsed.error);
        return;
      }
      const msg = parsed.message;

      switch (msg.type) {
        case "relay:register": {
          const relayId = msg.relayId;
          void handleRelayRegister(socket, msg, registry, configuredRelayProtocolPolicy())
            .then((result) => {
              if (result.outcome === "registered" && socket.readyState === socket.OPEN) {
                registeredRelayId = relayId;
                registeredUserId = result.effectiveUserId ?? null;
                registeredProtocolVersion = result.protocolVersion ?? null;
                socketMap.set(relayId, socket);
                if (registeredUserId !== null) {
                  publishClaudeConnectionContextAfterAck({
                    acknowledged: true,
                    socketOpen: socket.readyState === socket.OPEN,
                    currentSocket: socketMap.get(relayId) === socket,
                    relayId,
                    userId: registeredUserId,
                    registry: registry as unknown as Partial<RelayClaudeConnectionContextPublisher>,
                  });
                }
                configureRelayMcp(relayId, result.capabilities ?? msg.capabilities);
              }
            })
            .catch((err) => {
              warn(
                `[relay] register handler errored: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
          break;
        }

        case "relay:update-capabilities": {
          // D418 protocol v7 — atomic capability replacement from a connected
          // desktop relay. Accepted only for the registered authenticated
          // socket/relay/user; the registry enforces the exact desktop
          // session, strict capability parse, stale-revision reject, and
          // atomic replace. Always acked.
          const relayId = registeredRelayId;
          const userId = registeredUserId;
          if (!relayId || !userId) {
            warn("[relay] update-capabilities from an unregistered relay; ignoring");
            break;
          }
          void handleRelayUpdateCapabilities(socket, msg, registry, { relayId, userId })
            .then((result) => {
              if (result.outcome !== "applied" || socket.readyState !== socket.OPEN || socketMap.get(relayId) !== socket) return;
              publishClaudeConnectionContextAfterAck({
                acknowledged: true,
                socketOpen: socket.readyState === socket.OPEN,
                currentSocket: socketMap.get(relayId) === socket,
                relayId,
                userId,
                registry: registry as unknown as Partial<RelayClaudeConnectionContextPublisher>,
              });
            })
            .catch((err) => {
              warn(
                `[relay] update-capabilities handler errored: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
          break;
        }

        case "relay:heartbeat": {
          // A relay id is a routing key, not credentials.  Only the id stamped
          // by a successful token-validated register on THIS socket may update
          // liveness; otherwise one connected relay could keep another user's
          // host falsely alive.
          if (!isFrameBoundToRegisteredRelay(registeredRelayId, msg.relayId)) {
            warn("[relay] heartbeat for a different or unregistered relay; ignoring");
            break;
          }
          registry.updatePresence(msg.relayId);
          break;
        }

        case "relay:result": {
          handleRelayResult(msg, registry);
          break;
        }

        case "relay:security-scan-progress": {
          if (!registeredRelayId || typeof msg.correlationId !== "string"
            || !msg.correlationId.startsWith(`${registeredRelayId}:`) || !isSecurityScanProgress(msg)) break;
          registry.acceptSecurityScanProgress(msg);
          break;
        }

        case "relay:run-shell-progress": {
          // A correlation id belongs to the relay that minted it. Do not let
          // one authenticated relay inject observation into another relay's
          // pending command merely by guessing an id.
          if (!registeredRelayId || !msg.correlationId.startsWith(`${registeredRelayId}:`)) {
            warn("[relay] run-shell progress for a different or unregistered relay; ignoring");
            break;
          }
          if (!isValidRelayRunShellProgress(msg)) {
            warn("[relay] malformed run-shell progress; ignoring");
            break;
          }
          handleRelayRunShellProgress(msg, registry);
          break;
        }

        case "relay:structured-ssh-progress": {
          if (
            !registeredRelayId ||
            registeredProtocolVersion === null ||
            registeredProtocolVersion < RELAY_STRUCTURED_SSH_PROGRESS_PROTOCOL_VERSION ||
            !msg.correlationId.startsWith(`${registeredRelayId}:`)
          ) {
            warn("[relay] structured SSH progress for a different, unregistered, or incapable relay; ignoring");
            break;
          }
          if (!isValidRelayStructuredSshProgress(msg)) {
            warn("[relay] malformed structured SSH progress; ignoring");
            break;
          }
          handleRelayStructuredSshProgress(msg, registry);
          break;
        }

        case "relay:codex-status":
        case "relay:codex-command-response":
        case "relay:codex-request":
        case "relay:codex-event": {
          // D453: user identity comes exclusively from the registered,
          // token-validated socket context. Codex frames do not carry userId.
          const relayId = registeredRelayId;
          const userId = registeredUserId;
          const codexRegistry = registry as unknown as RelayCodexRegistryLike;
          if (!relayId || !userId || !codexRegistry.acceptCodexMessage) {
            socket.send(JSON.stringify({ type: "relay:error", message: "CODEX_RELAY_UNAVAILABLE" }));
            break;
          }
          const result = codexRegistry.acceptCodexMessage({
            relayId,
            userId,
            message: msg,
          });
          if (!result.ok) {
            socket.send(JSON.stringify({ type: "relay:error", message: result.error }));
          }
          break;
        }

        case "relay:acp-readiness-result":
        case "relay:acp-prepared":
        case "relay:acp-started":
        case "relay:acp-start-failed":
        case "relay:acp-semantic":
        case "relay:acp-terminal": {
          const relayId = registeredRelayId;
          const userId = registeredUserId;
          const acpRegistry = registry as unknown as RelayAcpRegistryLike;
          if (!relayId || !userId || !acpRegistry.acceptAcpMessage) {
            socket.send(JSON.stringify({ type: "relay:error", message: "ACP_RELAY_UNAVAILABLE" }));
            break;
          }
          const result = acpRegistry.acceptAcpMessage({ relayId, userId, message: msg });
          if (!result.ok) socket.send(JSON.stringify({ type: "relay:error", message: result.error }));
          break;
        }

        case "relay:claude-connection-discovery-result": {
          const result = handleRelayClaudeConnectionDiscoveryResult({
            registeredRelayId,
            registeredUserId,
            registeredProtocolVersion,
            currentSocket: registeredRelayId !== null && socketMap.get(registeredRelayId) === socket,
            message: msg,
            registry: registry as unknown as RelayClaudeConnectionRegistryLike,
          });
          if (!result.ok) {
            socket.send(JSON.stringify({ type: "relay:error", message: result.error }));
          }
          break;
        }

        case "relay:claude-execution-event": {
          const result = handleRelayClaudeExecutionEvent({
            registeredRelayId,
            registeredUserId,
            registeredProtocolVersion,
            currentSocket: registeredRelayId !== null && socketMap.get(registeredRelayId) === socket,
            message: msg,
            registry: registry as unknown as RelayClaudeExecutionRegistryLike,
          });
          if (!result.ok) {
            socket.send(JSON.stringify({ type: "relay:error", message: result.error }));
          }
          break;
        }

        case "relay:advertise-mcp-tools": {
          // D384 Phase 5 — a relay advertised the tools it discovered on a
          // hosted MCP server. Register them (executor:relay, hostedBy) so a
          // Genie can call them; empty tools = server gone → unregister.
          const relayId = registeredRelayId;
          if (!relayId) {
            warn("[relay] advertise-mcp-tools from an unregistered relay; ignoring");
            break;
          }
          const catalog = getToolCatalog();
          if (!catalog) {
            warn("[relay] advertise-mcp-tools before catalog ready; ignoring");
            break;
          }
          if (msg.tools.length === 0) {
            advertisedMcpServers.delete(msg.serverName);
            try {
              unregisterRelayServer(catalog, relayId, msg.serverName);
            } catch (err) {
              warn(
                `[relay] unregister "${msg.serverName}" failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            break;
          }
          advertisedMcpServers.add(msg.serverName);
          void registerRelayAdvertisedTools({
            db: getServerDirectDb(),
            catalog,
            relayId,
            serverName: msg.serverName,
            tools: msg.tools,
          }).catch((err: unknown) => {
            warn(
              `[relay] register advertised tools for "${msg.serverName}" failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
          break;
        }

        case "relay:mcp-preflight-result": {
          const relayId = registeredRelayId;
          if (!relayId || socketMap.get(relayId) !== socket || !isRelayMcpPreflightResultMessage(msg)) {
            warn("[relay] invalid or unregistered MCP preflight result; ignoring");
            break;
          }
          if (!registry.acceptMcpPreflightResult(relayId, msg)) {
            warn("[relay] stale or mismatched MCP preflight result; rejecting");
          }
          break;
        }

        case "relay:mcp-configure-result": {
          const relayId = registeredRelayId;
          if (!relayId || socketMap.get(relayId) !== socket || !isRelayMcpConfigureResultMessage(msg)) {
            warn("[relay] invalid or unregistered MCP configure result; ignoring");
            break;
          }
          if (!registry.acceptMcpConfigureResult(relayId, msg)) {
            warn("[relay] stale or mismatched MCP configure result; rejecting");
          }
          break;
        }

        case "relay:ssh-prepared": {
          const relayId = registeredRelayId;
          if (!relayId || socketMap.get(relayId) !== socket || !isRelaySshPreparedMessage(msg)) {
            warn("[relay] invalid or unregistered structured SSH preparation result; ignoring");
            break;
          }
          if (!registry.acceptSshPrepared(relayId, msg)) {
            warn("[relay] stale or mismatched structured SSH preparation result; rejecting");
          }
          break;
        }

        case "relay:disconnect": {
          // Same binding rule as heartbeat: a socket cannot tear down a relay
          // merely by naming its id in a frame.
          if (!isFrameBoundToRegisteredRelay(registeredRelayId, msg.relayId)) {
            warn("[relay] disconnect for a different or unregistered relay; ignoring");
            break;
          }
          // A newer socket can register the same relay id before this older
          // one closes. Only the current socket-map owner may unregister it.
          if (socketMap.get(msg.relayId) !== socket) {
            warn("[relay] disconnect from a superseded relay socket; ignoring");
            break;
          }
          const relayId = msg.relayId;
          void registry.unregister(relayId);
          socketMap.delete(relayId);
          cleanupRelayMcp(relayId);
          log(`[relay] Disconnected (clean): ${relayId}`);
          registeredRelayId = null;
          registeredUserId = null;
          break;
        }

        default: {
          warn(`[relay] Unknown message type from ${registeredRelayId ?? "unregistered"}`);
          break;
        }
      }
    });

    socket.on("close", () => {
      if (registeredRelayId && socketMap.get(registeredRelayId) === socket) {
        void registry.unregister(registeredRelayId);
        socketMap.delete(registeredRelayId);
        cleanupRelayMcp(registeredRelayId);
        log(`[relay] Disconnected (close): ${registeredRelayId}`);
        registeredRelayId = null;
        registeredUserId = null;
      }
    });

    socket.on("error", () => {
      warn(`[relay] WebSocket error for ${registeredRelayId ?? "unregistered"}`);
    });
  });

  return socketLifecycle;
}
