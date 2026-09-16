import { DynamicStructuredTool } from "@langchain/core/tools";
import { registerSecretForRedaction } from "@nautilo/vault";
import type {
  ConnectionToolDeleteResult,
  ConnectionToolListResult,
  ConnectionToolUseResult,
  ConnectionVaultToolAuditPayload,
} from "@nautilo/types";
import { z } from "zod";

import type { ToolContext } from "@nautilo/catalog";

import {
  emitConnectionVaultAudit,
  getConnectionVaultBackend,
  resolveConnectionScope,
} from "./runtime";

const refSchema = {
  service: z.string().min(1).describe("External service name, e.g. github"),
  field: z.string().min(1).describe("Connection field, e.g. api_key or password"),
};

function requireVault() {
  const vault = getConnectionVaultBackend();
  if (!vault) {
    throw new Error("Connection vault is not configured for this server");
  }
  return vault;
}

function audit(
  ctx: ToolContext | undefined,
  payload: ConnectionVaultToolAuditPayload,
): void {
  emitConnectionVaultAudit(ctx, payload);
}

export function createListConnectionsTool(context?: ToolContext) {
  return new DynamicStructuredTool({
    name: "list_connections",
    description:
      "List scoped Connection metadata. Returns ids, service, field, category, and timestamps only; never values.",
    schema: z.object({}),
    func: async () => {
      const vault = requireVault();
      let rows;
      try {
        rows = await vault.list(resolveConnectionScope(context ?? {}));
      } catch (err) {
        audit(context, {
          action: "list",
          tool: "list_connections",
          outcome: "error",
          errorKind: err instanceof Error ? err.name : "Error",
        });
        throw err;
      }

      audit(context, {
        action: "list",
        tool: "list_connections",
        outcome: "ok",
      });

      const body: ConnectionToolListResult = {
        status: "ok",
        connections: rows.map((row) => ({
          id: row.id,
          service: row.metadata.service,
          field: row.metadata.field,
          category: row.metadata.category,
          namespace_id: row.metadata.namespace_id,
          agent_id: row.metadata.agent_id,
          updated_at: row.metadata.updated_at,
          expires_at: row.metadata.expires_at,
        })),
      };
      return JSON.stringify(body);
    },
  });
}

export function createUseConnectionTool(context?: ToolContext) {
  return createUseConnectionLikeTool({
    context,
    name: "use_connection",
    description:
      "Make a scoped Connection available to runtime redaction/injection. Returns metadata-only status; never returns the value.",
  });
}

export function createUseCredentialAliasTool(context?: ToolContext) {
  // Temporary compatibility alias: keep one raw-value path by delegating to the
  // canonical use_connection implementation shape.
  return createUseConnectionLikeTool({
    context,
    name: "use_credential",
    description:
      "Temporary legacy alias for use_connection. Use use_connection for new work. Never returns raw values.",
  });
}

function createUseConnectionLikeTool(input: {
  readonly context?: ToolContext | undefined;
  readonly name: "use_connection" | "use_credential";
  readonly description: string;
}) {
  const { context, description, name } = input;
  return new DynamicStructuredTool({
    name,
    description,
    schema: z.object({
      ...refSchema,
      id: z.string().optional().describe("Optional row id from list_connections"),
    }),
    func: async ({ field, id, service }) => {
      const vault = requireVault();
      let value: Uint8Array | null;
      try {
        value = await vault.get(
          { field, id, service },
          resolveConnectionScope(context ?? {}),
        );
      } catch (err) {
        audit(context, {
          action: "use",
          tool: name,
          outcome: "error",
          service,
          field,
          connectionId: id,
          errorKind: err instanceof Error ? err.name : "Error",
        });
        throw err;
      }

      if (!value) {
        audit(context, {
          action: "use",
          tool: name,
          outcome: "missing",
          service,
          field,
          connectionId: id,
        });
        const body: ConnectionToolUseResult = { status: "missing", service, field };
        return JSON.stringify(body);
      }

      registerSecretForRedaction(value);
      if (Buffer.isBuffer(value)) {
        value.fill(0);
      }

      audit(context, {
        action: "use",
        tool: name,
        outcome: "ok",
        service,
        field,
        connectionId: id,
      });

      const body: ConnectionToolUseResult = { status: "available", service, field };
      return JSON.stringify(body);
    },
  });
}

export function createDeleteConnectionTool(context?: ToolContext) {
  return new DynamicStructuredTool({
    name: "delete_connection",
    description:
      "Delete a scoped Connection by service/field (and optional row id). Returns metadata-only status; never returns the value.",
    schema: z.object({
      ...refSchema,
      id: z.string().optional().describe("Optional row id from list_connections when multiple rows match"),
    }),
    func: async ({ field, id, service }) => {
      const vault = requireVault();
      let removed: boolean;
      try {
        removed = await vault.delete(
          { field, id, service },
          resolveConnectionScope(context ?? {}),
        );
      } catch (err) {
        audit(context, {
          action: "delete",
          tool: "delete_connection",
          outcome: "error",
          service,
          field,
          connectionId: id,
          errorKind: err instanceof Error ? err.name : "Error",
        });
        throw err;
      }

      const outcome = removed ? "ok" : "missing";
      audit(context, {
        action: "delete",
        tool: "delete_connection",
        outcome,
        service,
        field,
        connectionId: id,
      });

      const body: ConnectionToolDeleteResult = {
        status: removed ? "deleted" : "missing",
        service,
        field,
      };
      return JSON.stringify(body);
    },
  });
}
