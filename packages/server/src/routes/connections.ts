import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getToolCatalog } from "@nautilo/catalog";
import { buildConnectionAuditPlan } from "@nautilo/config-guard";
import { requestAllowsOwnerOrLoopback } from "../lib/request-trust";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import { envelopeReadableNamespaces, envelopeWritableNamespaces } from "@nautilo/trust";
import type {
  ConnectionAuditResponse,
  ConnectionListResponse,
  ConnectionManagementEntry,
  ConnectionRecord,
  ConnectionScope,
  ConnectionVaultToolAuditPayload,
  DeleteConnectionResponse,
  StoreConnectionResponse,
  VaultBackend,
} from "@nautilo/types";

const FutureExpiresAtSchema = z.string().refine((value) => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > Date.now();
}, "expiresAt must be a future date").nullable().optional();

const StoreBodySchema = z.object({
  service: z.string().min(1),
  field: z.string().min(1),
  value: z.string().min(1),
  category: z.literal("user").optional(),
  expiresAt: FutureExpiresAtSchema,
});

interface ConnectionRouteDeps {
  readonly vault: VaultBackend;
  readonly auditConnection?: (
    event: ConnectionVaultToolAuditPayload & {
      readonly actorId: string | null;
      readonly ip: string;
      readonly userAgent?: string | undefined;
    },
  ) => void;
}

function userScope(request: {
  readonly memoryEnvelope: MemoryAccessEnvelope | null;
}): ConnectionScope {
  const env = request.memoryEnvelope;
  const writable = envelopeWritableNamespaces(env);
  return {
    agentId: env?.agentId ?? "",
    // M082: attachment default = current Room's Namespace (`writableNamespaces[0]`), not mutation scope.
    defaultNamespaceId: writable[0] ?? null,
    readableNamespaceIds: envelopeReadableNamespaces(env),
  };
}

function canManageConnections(request: {
  readonly sessionUserId: string | null;
}): boolean {
  // M128 D5 (2026-05-28): the connections vault is per-user (scoped via
  // `memoryEnvelope.namespaceId` in `userScope`), so each authenticated
  // user manages their OWN connections. The previous owner-only gate
  // was a single-user-deployment artifact — it locked invitees out of
  // configuring their own LLM keys / OAuth tokens.
  return request.sessionUserId !== null;
}

function audit(
  deps: ConnectionRouteDeps,
  request: {
    readonly ip: string;
    readonly headers: { readonly ["user-agent"]?: string | string[] | undefined };
    readonly sessionActorId: string | null;
  },
  event: ConnectionVaultToolAuditPayload,
): void {
  const ua = request.headers["user-agent"];
  deps.auditConnection?.({
    ...event,
    actorId: request.sessionActorId,
    ip: request.ip,
    userAgent: typeof ua === "string" ? ua : undefined,
  });
}

function toEntry(row: ConnectionRecord): ConnectionManagementEntry {
  const scopeLabel =
    row.metadata.namespace_id
      ? "current room"
      : "null-scope migration record";
  return {
    id: row.id,
    service: row.metadata.service,
    field: row.metadata.field,
    category: row.metadata.category,
    namespace_id: row.metadata.namespace_id,
    agent_id: row.metadata.agent_id,
    updated_at: row.metadata.updated_at,
    expires_at: row.metadata.expires_at,
    scope_label: scopeLabel,
    configured: true,
    valid: null,
  };
}

async function listVisibleConnections(
  vault: VaultBackend,
  request: Parameters<typeof userScope>[0],
): Promise<ConnectionRecord[]> {
  return vault.list(userScope(request));
}

export function connectionRoutes(app: FastifyInstance, deps: ConnectionRouteDeps) {
  app.get("/api/connections", async (request, reply) => {
    if (!canManageConnections(request)) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    let rows: ConnectionRecord[];
    try {
      rows = await listVisibleConnections(deps.vault, request);
    } catch (e) {
      audit(deps, request, {
        action: "list",
        tool: "connections_api",
        outcome: "error",
        errorKind: e instanceof Error ? e.name : "Error",
      });
      throw e;
    }
    audit(deps, request, {
      action: "list",
      tool: "connections_api",
      outcome: "ok",
    });
    const body: ConnectionListResponse = {
      status: "ok",
      connections: rows.map(toEntry),
    };
    return reply.send(body);
  });

  app.post("/api/connections", async (request, reply) => {
    if (!canManageConnections(request)) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (!requestAllowsOwnerOrLoopback(request)) {
      return reply.code(403).send({
        error: "Connection storage requires owner identity or localhost",
      });
    }
    const parsed = StoreBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request body" });
    }
    const { service, field, value, expiresAt } = parsed.data;
    const category = parsed.data.category ?? "user";
    const scope = userScope(request);
    const valueBuf = Buffer.from(value, "utf8");
    try {
      await deps.vault.set(
        { service, field },
        valueBuf,
        scope,
        {
          authoredByUserId: request.sessionUserId,
          category,
          expiresAt: expiresAt ?? null,
        },
      );
    } catch (e) {
      audit(deps, request, {
        action: "store",
        tool: "connections_api",
        outcome: "error",
        service,
        field,
        errorKind: e instanceof Error ? e.name : "Error",
      });
      throw e;
    } finally {
      valueBuf.fill(0);
    }
    const rows = await deps.vault.list(scope);
    const row = rows.find((r) => r.metadata.service === service && r.metadata.field === field);
    if (!row) {
      return reply.code(500).send({ error: "Stored Connection was not visible after write" });
    }
    audit(deps, request, {
      action: "store",
      tool: "connections_api",
      outcome: "ok",
      service,
      field,
      connectionId: row.id,
    });
    const body: StoreConnectionResponse = { status: "stored", connection: toEntry(row) };
    return reply.send(body);
  });

  app.delete<{ Params: { service: string; field: string } }>(
    "/api/connections/:service/:field",
    async (request, reply) => {
      if (!canManageConnections(request)) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (!requestAllowsOwnerOrLoopback(request)) {
        return reply.code(403).send({
          error: "Connection deletion requires owner identity or localhost",
        });
      }
      const scope = userScope(request);
      let removed: boolean;
      try {
        removed = await deps.vault.delete(
          { service: request.params.service, field: request.params.field },
          scope,
        );
      } catch (e) {
        audit(deps, request, {
          action: "delete",
          tool: "connections_api",
          outcome: "error",
          service: request.params.service,
          field: request.params.field,
          errorKind: e instanceof Error ? e.name : "Error",
        });
        throw e;
      }
      audit(deps, request, {
        action: "delete",
        tool: "connections_api",
        outcome: removed ? "ok" : "missing",
        service: request.params.service,
        field: request.params.field,
      });
      const body: DeleteConnectionResponse = {
        status: removed ? "deleted" : "missing",
        service: request.params.service,
        field: request.params.field,
      };
      return reply.send(body);
    },
  );

  app.post("/api/connections/audit", async (request, reply) => {
    if (!canManageConnections(request)) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    let rows: ConnectionRecord[];
    try {
      rows = await listVisibleConnections(deps.vault, request);
    } catch (e) {
      audit(deps, request, {
        action: "list",
        tool: "connections_audit_api",
        outcome: "error",
        errorKind: e instanceof Error ? e.name : "Error",
      });
      throw e;
    }
    const body: ConnectionAuditResponse = {
      status: "ok",
      findings: buildConnectionAuditPlan({
        connections: rows,
        toolEntries: getToolCatalog()?.query({}) ?? [],
      }).findings,
    };
    return reply.send(body);
  });

}
