import type {
  ConnectionAuditFinding,
  ConnectionRecord,
  ToolCatalogEntry,
} from "@nautilo/types";
import type {
  ConnectionAuditPlan,
} from "./types";

export interface BuildConnectionAuditPlanInput {
  readonly connections?: readonly ConnectionRecord[] | undefined;
  readonly toolEntries?: readonly ToolCatalogEntry[] | undefined;
}

function connectionKey(service: string, field: string): string {
  return `${service}.${field}`;
}

export function buildConnectionAuditPlan(
  input: BuildConnectionAuditPlanInput = {},
): ConnectionAuditPlan {
  const connections = input.connections ?? [];
  const toolEntries = input.toolEntries ?? [];
  const existing = new Set(
    connections.map((row) => connectionKey(row.metadata.service, row.metadata.field)),
  );
  const findings: ConnectionAuditFinding[] = [];

  for (const row of connections) {
    if (row.metadata.category === "user" && row.metadata.namespace_id === null) {
      findings.push({
        kind: "null_scope",
        severity: "warning",
        service: row.metadata.service,
        field: row.metadata.field,
        message: "User Connection has null namespace scope and should be migrated.",
      });
    }
  }

  for (const entry of toolEntries) {
    if (entry.name === "use_credential") {
      findings.push({
        kind: "legacy_alias",
        severity: "info",
        tool: entry.name,
        message: "use_credential is a temporary alias; prefer use_connection.",
      });
    }
    for (const req of entry.connections ?? []) {
      if (req.required && !existing.has(connectionKey(req.service, req.field))) {
        findings.push({
          kind: "missing_required_connection",
          severity: "error",
          service: req.service,
          field: req.field,
          tool: entry.name,
          message: `${entry.name} requires ${req.displayLabel}, but no Connection metadata is configured.`,
        });
      }
    }
  }

  return { findings };
}
