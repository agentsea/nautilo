import { describe, expect, test } from "bun:test";
import type { ConnectionRecord, ToolCatalogEntry } from "@nautilo/types";

import { buildConnectionAuditPlan } from "../../src/connection-audit";

function row(
  service: string,
  field: string,
  namespaceId: string | null = null,
  category: "user" = "user",
): ConnectionRecord {
  return {
    id: `${service}.${field}`,
    ref: { service, field },
    metadata: {
      service,
      field,
      category,
      namespace_id: namespaceId,
      agent_id: namespaceId === null ? null : "agent",
      authored_by_user_id: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      expires_at: null,
    },
  };
}

const baseTool: ToolCatalogEntry = {
  name: "example_tool",
  description: "Example tool",
  source: "builtin",
  category: "research",
  trustTier: "standard",
  impact: "read-only",
  executor: "cloud",
  requiresApproval: false,
  requiredCapabilities: [],
  enabled: true,
  tags: [],
  resultScanPolicy: "never",
  health: "connected",
};

describe("Connection audit plan", () => {
  test("detects null-scope user rows and legacy alias tools", () => {
    const plan = buildConnectionAuditPlan({
      connections: [row("github", "token")],
      toolEntries: [{ ...baseTool, name: "use_credential" }],
    });

    expect(plan.findings.map((f) => f.kind)).toContain("null_scope");
    expect(plan.findings.map((f) => f.kind)).toContain("legacy_alias");
  });

  test("detects missing required tool Connection metadata", () => {
    const plan = buildConnectionAuditPlan({
      connections: [],
      toolEntries: [{
        ...baseTool,
        connections: [{
          service: "github",
          field: "token",
          category: "user",
          required: true,
          authShape: "bearer_token",
          displayLabel: "GitHub token",
        }],
      }],
    });

    expect(plan.findings.some((finding) =>
      finding.kind === "missing_required_connection" &&
      finding.service === "github" &&
      finding.field === "token",
    )).toBe(true);
  });
});
