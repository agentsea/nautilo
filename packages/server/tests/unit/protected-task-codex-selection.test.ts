import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { CODEX_RELAY_MAX_OPAQUE_ID_BYTES } from "@nautilo/relay";
import { parseProtectedTaskCodexSelection, protectedTaskCodexSelectionProjection,
  sameProtectedTaskCodexSelection } from "../../src/routes/protected-task-codex-selection";

const execution = { version: 1 as const, harnessId: "codex" as const, source: "genie" as const, collaborationMode: "work" as const,
  harnessModelId: "codex-model", readiness: { relayId: "relay", pairingGenerationRef: "pair", capabilityRevision: 3 } };
describe("protected Codex selection", () => {
  test("uses the canonical classifier for a copied frozen operational selection", () => {
    const value = structuredClone({ execution });
    const selected = parseProtectedTaskCodexSelection(value);
    expect(selected).toEqual(value);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected?.execution.readiness)).toBe(true);
    value.execution.readiness.relayId = "substituted";
    expect(selected?.execution.readiness.relayId).toBe("relay");
    expect(sameProtectedTaskCodexSelection(selected, selected!)).toBe(true);
    expect(sameProtectedTaskCodexSelection(null, selected!)).toBe(false);
    expect(sameProtectedTaskCodexSelection(parseProtectedTaskCodexSelection(value), selected!)).toBe(false);
  });
  test("accepts both collaboration modes and a closed signed model contract", () => {
    expect(parseProtectedTaskCodexSelection({ execution: { ...execution, collaborationMode: "plan",
      outputContract: { version: 1, capabilityModelId: "openai:gpt-5", catalogVersion: "signed-v1",
        contextTokens: 100, outputTokens: 50 } } })).not.toBeNull();
  });
  test("rejects private content, unknown fields and malformed nested metadata", () => {
    for (const value of [null, [], 1, "codex", {}, { execution, prompt: "private" },
      { execution, preparation: {} }, { execution: { ...execution, workingDirectory: "/private/work" } },
      { execution: { ...execution, version: 2 } }, { execution: { ...execution, source: "human_api" } },
      { execution: { ...execution, harnessId: "claude-code" } }, { execution: { ...execution, unknown: true } },
      { execution: { ...execution, readiness: [] } },
      { execution: { ...execution, readiness: { ...execution.readiness, hidden: "private" } } },
      { execution: { ...execution, readiness: { ...execution.readiness, capabilityRevision: -1 } } },
      { execution: { ...execution, readiness: { ...execution.readiness, capabilityRevision: 1.5 } } },
      { execution: { ...execution, readiness: { ...execution.readiness,
        relayId: "x".repeat(CODEX_RELAY_MAX_OPAQUE_ID_BYTES + 1) } } },
      { execution: { ...execution, outputContract: { version: 1 } } },
      { execution: { ...execution, outputContract: { version: 1, capabilityModelId: "openai:gpt-5",
        catalogVersion: "signed", contextTokens: 100, outputTokens: 101 } } },
    ]) expect(parseProtectedTaskCodexSelection(value)).toBeNull();
  });
  test("validates nested scalars and reconstructs only the recognized routing receipt", () => {
    const projection = protectedTaskCodexSelectionProjection();
    const query = new PgDialect().sqlToQuery(projection.sql);
    expect(projection.fieldAlias).toBe("codex_execution_selection");
    expect(query.params).toContain(CODEX_RELAY_MAX_OPAQUE_ID_BYTES);
    expect(query.params).toContain(Number.MAX_SAFE_INTEGER);
    expect(query.sql).toContain("when jsonb_typeof(\"tasks\".\"metadata\") = 'object'");
    expect(query.sql).toContain("jsonb_typeof(\"tasks\".\"metadata\"->'execution') = 'object'");
    expect(query.sql.match(/then case/g)?.length).toBeGreaterThan(2);
    expect(query.sql).toContain("((\"tasks\".\"metadata\"->'execution') - 'version'");
    expect(query.sql).toContain("- 'relayId' - 'pairingGenerationRef' - 'capabilityRevision'");
    expect(query.sql).toContain("- 'version' - 'capabilityModelId' - 'catalogVersion' - 'contextTokens' - 'outputTokens'");
    expect(query.sql).toContain("jsonb_typeof(\"tasks\".\"metadata\"->'execution'->'readiness'->'capabilityRevision') = 'number'");
    expect(query.sql).toContain("::numeric");
    expect(query.sql).toContain("then jsonb_build_object('execution',");
    expect(query.sql).toContain("'readiness', jsonb_build_object(");
    expect(query.sql).not.toContain("jsonb_build_object('execution', (\"tasks\".\"metadata\"->'execution') - 'workingDirectory')");
  });
});
