/**
 * D503 Wave 1 — one approval-bound local MCP installation transaction.
 *
 * The server owns relay selection, preflight, digest binding, persistence,
 * truth-channel correlation, and rollback. The model only ever supplies an
 * intent to `prepare`; after approval `install` consumes the prepared record.
 */

import { randomUUID } from "node:crypto";
import { and, eq, mcpServers, type DirectDatabase, type McpServer } from "@nautilo/db";
import { getRelayRegistry } from "@nautilo/agent";
import {
  LOCAL_MCP_INSTALL_VERSION,
  LocalMcpInstallValidationError,
  digestLocalMcpInstallRequest,
  localMcpInstallFailure,
  prepareLocalMcpInstallRequest,
  type LocalMcpInstallEnvironmentRequirement,
  type LocalMcpInstallFailureCode,
  type LocalMcpInstallModelIntent,
  type LocalMcpInstallPrepared,
  type LocalMcpInstallRequest,
  type LocalMcpInstallResult,
} from "@nautilo/types";
import type {
  RelayMcpConfigureOperation,
  RelayMcpConfigureResultMessage,
  RelayMcpFailure,
  RelayMcpServerConfig,
} from "@nautilo/relay";
import {
  RELAY_MCP_TRUTH_PROTOCOL_VERSION,
  type RelayCapabilities,
} from "@nautilo/relay";
import { warn } from "@nautilo/logger";
import type { SecurityAuditEvent } from "../lib/security-audit-log";
import {
  forceCloseLocalMcpRelay,
  setLocalMcpMutationRelaySocketSafetyCloser,
  withLocalMcpRelayMutation,
} from "./local-mcp-mutation";
import { buildMcpInsertRow, type McpInsertFields } from "./local-mcp-persistence";
import { listConnectedRelaysForUser } from "./connection-status";
import { relayHostId } from "./relay-mcp-bridge";

const INSTALL_TIMEOUT_MS = 20_000;

interface RelayMcpPreflightRequest {
  readonly requestId: string;
  readonly digest: string;
  readonly expectedDesktopSessionId: string;
  readonly server: RelayMcpServerConfig;
  readonly timeoutMs?: number;
}

interface RelayMcpConfigureRequest {
  readonly servers: readonly RelayMcpServerConfig[];
  readonly operation: RelayMcpConfigureOperation;
  readonly expectedDesktopSessionId: string;
  readonly timeoutMs?: number;
}

interface RelayMcpInstallRegistry {
  getUserId?(relayId: string): string | null | undefined;
  getCapabilities?(relayId: string): RelayCapabilities | null | undefined;
  getProtocolVersion?(relayId: string): number | null | undefined;
  getDesktopSessionId?(relayId: string): string | null | undefined;
  preflightMcp?(relayId: string, request: RelayMcpPreflightRequest): Promise<{
    machineLabel: string;
    launcher: "present" | "missing" | "not-applicable";
    environment: Array<{ name: string; present: boolean }>;
    status: "ready" | "blocked";
    failure?: RelayMcpFailure | undefined;
  }>;
  configureMcpWithOutcome?(
    relayId: string,
    request: RelayMcpConfigureRequest,
  ): Promise<RelayMcpConfigureResultMessage>;
}

/** Installed at server boot after the websocket endpoint exists. */
export function setLocalMcpInstallRelaySocketSafetyCloser(
  closer: Parameters<typeof setLocalMcpMutationRelaySocketSafetyCloser>[0],
): void {
  setLocalMcpMutationRelaySocketSafetyCloser(closer);
}

interface SingleflightEntry {
  readonly digest: string;
  readonly promise: Promise<LocalMcpInstallResult>;
}

type DeferredInstallAudit = {
  readonly action: "enable" | "disable";
  readonly outcome: "ok" | "error";
};

function failure(
  request: Pick<LocalMcpInstallRequest, "name" | "relayId" | "digest">,
  code: Parameters<typeof localMcpInstallFailure>[0],
): LocalMcpInstallResult {
  return {
    ok: false,
    name: request.name,
    relayId: request.relayId,
    digest: request.digest,
    failure: localMcpInstallFailure(code),
  };
}

function failureFromRelay(
  request: Pick<LocalMcpInstallRequest, "name" | "relayId" | "digest">,
  relayFailure: RelayMcpFailure | undefined,
): LocalMcpInstallResult {
  const code = relayFailure?.code ?? "internal";
  const mapped = code === "invalid_request" || code === "missing_launcher" ||
    code === "missing_environment" || code === "spawn_failed" ||
    code === "protocol_failed" || code === "discovery_timeout" ||
    code === "empty_toolset"
    ? code
    : "internal";
  return failure(request, mapped);
}

function failureFromTruthError(
  request: Pick<LocalMcpInstallRequest, "name" | "relayId" | "digest">,
  error: unknown,
): LocalMcpInstallResult {
  const code = error && typeof error === "object"
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === "mcp_preflight_timeout" || code === "mcp_configure_timeout") {
    return failure(request, "discovery_timeout");
  }
  if (code === "mcp_response_mismatch") return failure(request, "protocol_failed");
  if (code === "relay_protocol_unsupported") return failure(request, "relay_protocol_unsupported");
  if (code === "missing_launcher" || code === "missing_environment" ||
    code === "spawn_failed" || code === "protocol_failed" ||
    code === "discovery_timeout" || code === "empty_toolset") {
    return failure(request, code);
  }
  return failure(request, "relay_unavailable");
}

function relayRegistry(): RelayMcpInstallRegistry | null {
  return getRelayRegistry() as RelayMcpInstallRegistry | null;
}

function hasLiveMcpTruth(
  registry: RelayMcpInstallRegistry,
  relayId: string,
  actorId: string,
  deviceSessionId?: string,
): boolean {
  return registry.getUserId?.(relayId) === actorId &&
    (deviceSessionId === undefined || registry.getDesktopSessionId?.(relayId) === deviceSessionId) &&
    registry.getCapabilities?.(relayId)?.mcpTools !== undefined &&
    (registry.getProtocolVersion?.(relayId) ?? 0) >= RELAY_MCP_TRUTH_PROTOCOL_VERSION &&
    typeof registry.preflightMcp === "function" &&
    typeof registry.configureMcpWithOutcome === "function";
}

function requestToRelayConfig(request: LocalMcpInstallRequest): RelayMcpServerConfig {
  return {
    name: request.name,
    transportKind: request.transport.kind,
    transport: request.transport.kind === "stdio"
      ? { command: request.transport.command, args: [...request.transport.args] }
      : { url: request.transport.url },
    envPassthrough: request.environment.map((entry) => entry.name),
  };
}

function requestToInsertFields(request: LocalMcpInstallRequest): McpInsertFields {
  return {
    name: request.name,
    transportKind: request.transport.kind,
    transport: request.transport.kind === "stdio"
      ? { command: request.transport.command, args: [...request.transport.args] }
      : { url: request.transport.url },
    envPassthrough: request.environment.map((entry) => entry.name),
  };
}

async function chooseOwnedRelay(
  actorId: string,
  requestedRelayId: string | undefined,
): Promise<string | null> {
  const owned = await listConnectedRelaysForUser(actorId);
  if (requestedRelayId !== undefined) return owned.includes(requestedRelayId) ? requestedRelayId : null;
  return owned.length === 1 ? owned[0]! : null;
}

async function withPreflightEnvironment(
  request: LocalMcpInstallRequest,
  registry: RelayMcpInstallRegistry,
): Promise<
  | { ok: true; request: LocalMcpInstallRequest; machineLabel: string }
  | { ok: false; result: LocalMcpInstallResult }
> {
  if (!hasLiveMcpTruth(registry, request.relayId, request.actorId, request.deviceSessionId)) {
    const version = registry.getProtocolVersion?.(request.relayId) ?? 0;
    return { ok: false, result: failure(request, version > 0 ? "relay_protocol_unsupported" : "relay_unavailable") };
  }
  let preflight;
  try {
    preflight = await registry.preflightMcp!(request.relayId, {
      requestId: randomUUID(),
      digest: request.digest,
      expectedDesktopSessionId: request.deviceSessionId,
      server: requestToRelayConfig(request),
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
  } catch (error) {
    return { ok: false, result: failureFromTruthError(request, error) };
  }
  if (preflight.status !== "ready") {
    return { ok: false, result: failureFromRelay(request, preflight.failure) };
  }
  const statuses = new Map(preflight.environment.map((entry) => [entry.name, entry.present]));
  const environment: readonly LocalMcpInstallEnvironmentRequirement[] = request.environment.map((entry) => ({
    name: entry.name,
    present: statuses.get(entry.name) === true,
  }));
  if (environment.some((entry) => !entry.present)) {
    return { ok: false, result: failure(request, "missing_environment") };
  }
  const { digest: _priorDigest, ...withoutDigest } = request;
  void _priorDigest;
  const canonical = { ...withoutDigest, environment };
  const digest = await digestLocalMcpInstallRequest(canonical);
  return {
    ok: true,
    request: { ...canonical, digest },
    machineLabel: preflight.machineLabel,
  };
}

/** Strict DB read: installation never treats a read error as an empty fleet. */
async function readEnabledFleet(db: DirectDatabase, relayId: string): Promise<RelayMcpServerConfig[]> {
  const rows = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.host, relayHostId(relayId)), eq(mcpServers.enabled, true)));
  return rows.map((row) => ({
    name: row.name,
    transportKind: row.transportKind as RelayMcpServerConfig["transportKind"],
    transport: row.transport as Record<string, unknown>,
    envPassthrough: row.envPassthrough ?? null,
    namespaceId: row.namespaceId ?? null,
    includeTools: row.includeTools ?? null,
    excludeTools: row.excludeTools ?? null,
    trustTier: row.trustTier ?? null,
  }));
}

async function readNamedRow(
  db: DirectDatabase,
  name: string,
  relayId: string,
): Promise<
  | { readonly kind: "missing" }
  | { readonly kind: "unique"; readonly row: McpServer }
  | { readonly kind: "duplicate" }
> {
  const rows = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.name, name), eq(mcpServers.host, relayHostId(relayId))));
  if (rows.length === 0) return { kind: "missing" };
  if (rows.length === 1) return { kind: "unique", row: rows[0]! };
  return { kind: "duplicate" };
}

class DuplicateLocalMcpInstallRowError extends Error {}

async function persistDisabledCandidate(
  db: DirectDatabase,
  request: LocalMcpInstallRequest,
): Promise<boolean> {
  const existing = await readNamedRow(db, request.name, request.relayId);
  const host = relayHostId(request.relayId);
  if (existing.kind === "duplicate") throw new DuplicateLocalMcpInstallRowError();
  if (existing.kind === "unique") {
    const updated = await db
      .update(mcpServers)
      .set({
        transportKind: request.transport.kind,
        transport: requestToInsertFields(request).transport,
        envPassthrough: request.environment.map((entry) => entry.name),
        enabled: false,
        lastCheckStatus: null,
        lastCheckFailureCode: null,
        lastCheckMissingEnvironment: null,
        lastCheckedAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(mcpServers.name, request.name), eq(mcpServers.host, host)))
      .returning();
    return updated.length === 1;
  }
  const inserted = await db
    .insert(mcpServers)
    .values(buildMcpInsertRow(requestToInsertFields(request), host as `relay-${string}`))
    .returning();
  return inserted.length === 1;
}

async function persistEnabledCandidate(db: DirectDatabase, request: LocalMcpInstallRequest): Promise<boolean> {
  const connectedAt = new Date();
  const updated = await db
    .update(mcpServers)
    .set({
      enabled: true,
      lastCheckStatus: "connected",
      lastCheckFailureCode: null,
      lastCheckMissingEnvironment: null,
      lastCheckedAt: connectedAt,
      lastConnectedAt: connectedAt,
      updatedAt: connectedAt,
    })
    .where(and(eq(mcpServers.name, request.name), eq(mcpServers.host, relayHostId(request.relayId))))
    .returning();
  return updated.length === 1;
}

async function ensureCandidateDisabled(
  db: DirectDatabase,
  request: LocalMcpInstallRequest,
  failureCode: LocalMcpInstallFailureCode,
): Promise<boolean> {
  const checkedAt = new Date();
  const updated = await db
    .update(mcpServers)
    .set({
      enabled: false,
      lastCheckStatus: failureCode === "missing_environment" || failureCode === "missing_launcher"
        ? "needs_attention"
        : "failed",
      lastCheckFailureCode: failureCode,
      lastCheckMissingEnvironment: failureCode === "missing_environment"
        ? request.environment.filter((entry) => !entry.present).map((entry) => entry.name)
        : null,
      lastCheckedAt: checkedAt,
      updatedAt: checkedAt,
    })
    .where(and(eq(mcpServers.name, request.name), eq(mcpServers.host, relayHostId(request.relayId))))
    .returning();
  return updated.length === 1;
}

class LocalMcpInstallService {
  private readonly installs = new Map<string, SingleflightEntry>();

  constructor(
    private readonly db: DirectDatabase,
    private readonly audit?: (event: SecurityAuditEvent) => void,
  ) {}

  private auditOutcome(
    actorId: string,
    action: "create" | "enable" | "disable",
    name: string,
    outcome: "ok" | "error",
    effect?: Pick<LocalMcpInstallRequest, "relayId" | "digest">,
  ): void {
    this.audit?.({
      kind: "mcp_server_config",
      ts: new Date().toISOString(),
      actorId,
      ip: "",
      userAgent: undefined,
      action,
      serverName: name,
      outcome,
      ...(effect ? { effectDigest: effect.digest, relayId: effect.relayId } : {}),
    });
  }

  async prepare(input: {
    actorId: string;
    intent: LocalMcpInstallModelIntent;
    approvalId: string;
    threadId: string;
    laneKey: string;
    toolCallId: string;
    checkpointKey: string;
  }): Promise<
    | { readonly ok: true; readonly prepared: LocalMcpInstallPrepared }
    | { readonly ok: false; readonly result: LocalMcpInstallResult }
  > {
    let relayId: string | null;
    try {
      relayId = await chooseOwnedRelay(input.actorId, input.intent.relayId);
    } catch {
      relayId = null;
    }
    if (!relayId) {
      return {
        ok: false,
        result: {
          ok: false,
          // Input has not passed canonical secret validation yet. Never echo
          // model text into a result, audit event, or log snapshot.
          name: "local-mcp",
          relayId: "",
          digest: "",
          failure: localMcpInstallFailure("relay_unavailable"),
        },
      };
    }
    const registry = relayRegistry();
    if (!registry) {
      return {
        ok: false,
        result: {
          ok: false,
          name: "local-mcp",
          relayId,
          digest: "",
          failure: localMcpInstallFailure("relay_unavailable"),
        },
      };
    }
    const deviceSessionId = registry.getDesktopSessionId?.(relayId);
    if (!deviceSessionId) {
      return {
        ok: false,
        result: {
          ok: false,
          name: "local-mcp",
          relayId,
          digest: "",
          failure: localMcpInstallFailure("relay_unavailable"),
        },
      };
    }
    let canonical: LocalMcpInstallRequest;
    try {
      canonical = await prepareLocalMcpInstallRequest({
        intent: input.intent,
        actorId: input.actorId,
        relayId,
        deviceSessionId,
      });
    } catch (error) {
      // Preparation is not a mutation. Never record model-supplied proposal
      // text in an audit row, especially when it is malformed or credential-shaped.
      return {
        ok: false,
        result: {
          ok: false,
          name: "local-mcp",
          relayId,
          digest: "",
          failure: localMcpInstallFailure(
            error instanceof LocalMcpInstallValidationError ? "invalid_request" : "internal",
          ),
        },
      };
    }
    const preflight = await withPreflightEnvironment(canonical, registry);
    if (!preflight.ok) {
      return preflight;
    }
    const prepared: LocalMcpInstallPrepared = {
      binding: {
        version: LOCAL_MCP_INSTALL_VERSION,
        approvalId: input.approvalId,
        threadId: input.threadId,
        laneKey: input.laneKey,
        toolCallId: input.toolCallId,
        checkpointKey: input.checkpointKey,
        digest: preflight.request.digest,
      },
      request: preflight.request,
      preview: {
        version: LOCAL_MCP_INSTALL_VERSION,
        // The authenticated actor remains in the signed request; the review
        // surface should identify the human without exposing an internal id.
        human: "You",
        machine: preflight.machineLabel,
        relayId: preflight.request.relayId,
        name: preflight.request.name,
        transport: preflight.request.transport,
        source: preflight.request.source,
        package: preflight.request.package,
        mayDownloadOnFirstRun: preflight.request.mayDownloadOnFirstRun,
        unpinnedPackage: preflight.request.unpinnedPackage,
        environment: preflight.request.environment,
        availabilitySummary: preflight.request.availabilitySummary,
        subprocessSandboxed: preflight.request.subprocessSandboxed,
        digest: preflight.request.digest,
      },
    };
    return { ok: true, prepared };
  }

  async install(input: {
    actorId: string;
    prepared: LocalMcpInstallPrepared;
    approvalId: string;
    toolCallId: string;
    digest: string;
  }): Promise<LocalMcpInstallResult> {
    const { prepared } = input;
    const request = prepared.request;
    if (request.actorId !== input.actorId ||
      prepared.binding.version !== LOCAL_MCP_INSTALL_VERSION ||
      prepared.binding.approvalId !== input.approvalId ||
      prepared.binding.toolCallId !== input.toolCallId ||
      prepared.binding.digest !== input.digest ||
      prepared.binding.digest !== request.digest ||
      !prepared.binding.threadId || !prepared.binding.laneKey || !prepared.binding.checkpointKey) {
      return {
        ok: false,
        name: "local-mcp",
        relayId: "",
        digest: input.digest,
        failure: localMcpInstallFailure("approval_stale"),
      };
    }
    // This lock covers the entire relay fleet because configureMcpWithOutcome
    // receives a complete fleet snapshot. Different candidates cannot race
    // and accidentally remove one another from a reconcile.
    const key = `${input.actorId}:${request.relayId}`;
    const current = this.installs.get(key);
    if (current) {
      return current.digest === request.digest
        ? current.promise
        : failure(request, "install_in_progress");
    }
    const promise = this.installDurably(request);
    this.installs.set(key, { digest: request.digest, promise });
    try {
      return await promise;
    } finally {
      if (this.installs.get(key)?.promise === promise) this.installs.delete(key);
    }
  }

  private async installDurably(request: LocalMcpInstallRequest): Promise<LocalMcpInstallResult> {
    let relaySideEffect = false;
    let completed: LocalMcpInstallResult | null = null;
    const deferredAudits: DeferredInstallAudit[] = [];
    try {
      const result = await withLocalMcpRelayMutation(this.db, request.relayId, async (tx) => {
        const value = await this.installOne(
          request,
          tx,
          () => { relaySideEffect = true; },
          deferredAudits,
        );
        completed = value;
        return value;
      });
      for (const event of deferredAudits) {
        this.auditOutcome(request.actorId, event.action, request.name, event.outcome, request);
      }
      this.auditOutcome(request.actorId, "enable", request.name, result.ok ? "ok" : "error", request);
      return result;
    } catch (error) {
      if (!relaySideEffect) {
        const result = failure(request, "internal");
        if (!(error instanceof DuplicateLocalMcpInstallRowError)) {
          this.auditOutcome(request.actorId, "enable", request.name, "error", request);
        }
        return result;
      }
      return this.compensateAfterTransactionFailure(request, completed ?? failure(request, "internal"));
    }
  }

  /** Reconcile relay process truth to the durable post-rollback DB state. */
  private async compensateAfterTransactionFailure(
    request: LocalMcpInstallRequest,
    original: LocalMcpInstallResult,
  ): Promise<LocalMcpInstallResult> {
    const registry = relayRegistry();
    if (!registry || registry.getDesktopSessionId?.(request.relayId) !== request.deviceSessionId) {
      forceCloseLocalMcpRelay(request.relayId, request.deviceSessionId);
      this.auditOutcome(request.actorId, "disable", request.name, "error", request);
      this.auditOutcome(request.actorId, "enable", request.name, "error", request);
      return failure(request, "rollback_unconfirmed");
    }
    try {
      const compensation = await withLocalMcpRelayMutation(this.db, request.relayId, async (tx) => {
        const durable = await readNamedRow(tx, request.name, request.relayId);
        if (durable.kind === "duplicate") throw new DuplicateLocalMcpInstallRowError();
        const fleet = await readEnabledFleet(tx, request.relayId);
        const shouldRun = durable.kind === "unique" && durable.row.enabled;
        const outcome = await registry.configureMcpWithOutcome!(request.relayId, {
          servers: fleet,
          operation: {
            operationId: randomUUID(),
            digest: request.digest,
            targetName: request.name,
            phase: shouldRun ? "start" : "rollback",
          },
          expectedDesktopSessionId: request.deviceSessionId,
          timeoutMs: INSTALL_TIMEOUT_MS,
        });
        return {
          confirmed: shouldRun ? outcome.state === "connected" : outcome.state === "stopped",
          shouldRun,
        };
      });
      if (compensation.confirmed) {
        if (!compensation.shouldRun) {
          this.auditOutcome(request.actorId, "disable", request.name, "ok", request);
        }
        this.auditOutcome(request.actorId, "enable", request.name, "error", request);
        return original.ok ? failure(request, "internal") : original;
      }
    } catch {
      // Safety-close below; no free-form diagnostics are emitted.
    }
    forceCloseLocalMcpRelay(request.relayId, request.deviceSessionId);
    this.auditOutcome(request.actorId, "disable", request.name, "error", request);
    this.auditOutcome(request.actorId, "enable", request.name, "error", request);
    return failure(request, "rollback_unconfirmed");
  }

  private async installOne(
    request: LocalMcpInstallRequest,
    db: DirectDatabase,
    markRelaySideEffect: () => void,
    deferredAudits: DeferredInstallAudit[],
  ): Promise<LocalMcpInstallResult> {
    const registry = relayRegistry();
    if (!registry || registry.getUserId?.(request.relayId) !== request.actorId) {
      return failure(request, "relay_unavailable");
    }
    if (registry.getDesktopSessionId?.(request.relayId) !== request.deviceSessionId) {
      return failure(request, "approval_stale");
    }
    if (!hasLiveMcpTruth(registry, request.relayId, request.actorId, request.deviceSessionId)) {
      return failure(request, "relay_protocol_unsupported");
    }

    // Recompute the digest from the stored canonical request. A modified
    // prepared record is stale; model input is intentionally absent here.
    const { digest: _storedDigest, ...canonicalRequest } = request;
    void _storedDigest;
    const computedDigest = await digestLocalMcpInstallRequest(canonicalRequest);
    if (computedDigest !== request.digest) return failure(request, "approval_stale");

    // Fail before the post-approval relay preflight if host+name identity is
    // already corrupt. The relay-wide transaction lock makes this exact read
    // authoritative for the update which follows.
    const existing = await readNamedRow(db, request.name, request.relayId);
    if (existing.kind === "duplicate") throw new DuplicateLocalMcpInstallRowError();

    const revalidated = await withPreflightEnvironment(request, registry);
    if (!revalidated.ok) return revalidated.result;
    if (revalidated.request.digest !== request.digest) return failure(request, "approval_stale");

    let enabledFleet: RelayMcpServerConfig[];
    try {
      enabledFleet = await readEnabledFleet(db, request.relayId);
    } catch (error) {
      if (error instanceof DuplicateLocalMcpInstallRowError) throw error;
      return failure(request, "internal");
    }
    try {
      if (!await persistDisabledCandidate(db, request)) return failure(request, "invalid_request");
    } catch (error) {
      if (error instanceof DuplicateLocalMcpInstallRowError) throw error;
      return failure(request, "internal");
    }

    const candidate = requestToRelayConfig(request);
    const startRequest: RelayMcpConfigureRequest = {
      servers: [...enabledFleet.filter((server) => server.name !== request.name), candidate],
      operation: {
        operationId: randomUUID(),
        digest: request.digest,
        targetName: request.name,
        phase: "start",
      },
      expectedDesktopSessionId: request.deviceSessionId,
      timeoutMs: INSTALL_TIMEOUT_MS,
    };
    let start: RelayMcpConfigureResultMessage | null = null;
    let startFailure: LocalMcpInstallResult | null = null;
    try {
      markRelaySideEffect();
      start = await registry.configureMcpWithOutcome!(request.relayId, startRequest);
      if (start.state !== "connected" || start.toolNames.length === 0) {
        startFailure = start.state === "failed"
          ? failureFromRelay(request, start.failure)
          : failure(request, "empty_toolset");
      }
    } catch (error) {
      startFailure = failureFromTruthError(request, error);
    }
    if (startFailure === null && start !== null) {
      try {
        if (await persistEnabledCandidate(db, request)) {
          return {
            ok: true,
            name: request.name,
            relayId: request.relayId,
            digest: request.digest,
            toolNames: [...start.toolNames],
          };
        }
      } catch {
        // Roll back a live but unpersisted process below.
      }
      startFailure = failure(request, "internal");
    }
    return this.rollback(
      request,
      registry,
      startFailure ?? failure(request, "internal"),
      db,
      markRelaySideEffect,
      deferredAudits,
    );
  }

  private async rollback(
    request: LocalMcpInstallRequest,
    registry: RelayMcpInstallRegistry,
    original: LocalMcpInstallResult,
    db: DirectDatabase,
    markRelaySideEffect: () => void,
    deferredAudits: DeferredInstallAudit[],
  ): Promise<LocalMcpInstallResult> {
    // The failed start belongs to the approved session only. A replacement
    // Desktop must never receive its predecessor's rollback fleet command.
    if (registry.getDesktopSessionId?.(request.relayId) !== request.deviceSessionId) {
      deferredAudits.push({ action: "disable", outcome: "error" });
      forceCloseLocalMcpRelay(request.relayId, request.deviceSessionId);
      return failure(request, "rollback_unconfirmed");
    }
    try {
      // A successful relay rollback is not enough if we cannot prove the
      // durable candidate is disabled. Treat that as unconfirmed and sever
      // the initiating socket rather than risk a reconnect re-launching it.
      if (!await ensureCandidateDisabled(db, request, original.failure?.code ?? "internal")) {
        throw new Error("candidate disable was not confirmed");
      }
      const fleet = await readEnabledFleet(db, request.relayId);
      markRelaySideEffect();
      const outcome = await registry.configureMcpWithOutcome!(request.relayId, {
        servers: fleet.filter((server) => server.name !== request.name),
        operation: {
          operationId: randomUUID(),
          digest: request.digest,
          targetName: request.name,
          phase: "rollback",
        },
        expectedDesktopSessionId: request.deviceSessionId,
        timeoutMs: INSTALL_TIMEOUT_MS,
      });
      if (outcome.state === "stopped") {
        deferredAudits.push({ action: "disable", outcome: "ok" });
        return original;
      }
    } catch {
      warn(`[local-mcp-install] rollback unconfirmed for relay=${request.relayId} name=${request.name}`);
    }
    deferredAudits.push({ action: "disable", outcome: "error" });
    forceCloseLocalMcpRelay(request.relayId, request.deviceSessionId);
    return failure(request, "rollback_unconfirmed");
  }
}

export function createLocalMcpInstallService(
  db: DirectDatabase,
  audit?: (event: SecurityAuditEvent) => void,
): LocalMcpInstallService {
  return new LocalMcpInstallService(db, audit);
}
