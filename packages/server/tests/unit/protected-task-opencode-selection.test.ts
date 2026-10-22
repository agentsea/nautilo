import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { ACP_RELAY_MAX_OPAQUE_ID_BYTES, OPENCODE_ACP_RELAY_PROTOCOL_VERSION } from "@nautilo/relay";
import {
  parseProtectedTaskOpenCodeSelection,
  protectedTaskOpenCodeSelectionProjection,
  sameProtectedTaskOpenCodeSelection,
} from "../../src/routes/protected-task-opencode-selection";

const readiness = {
  relayId: "relay",
  relaySessionId: "socket",
  pairingGenerationRef: "pairing",
  desktopSessionId: "desktop",
  selectedProtocolVersion: 15,
  capabilityRevision: 3,
};
const selection = {
  execution: {
    version: 1,
    harnessId: "opencode-acp",
    source: "genie",
    executionProfile: "autonomous",
    readiness,
  },
} as const;

describe("protected OpenCode selection", () => {
  test("copies and freezes the exact closed execution receipt", () => {
    const mutable = structuredClone(selection);
    const parsed = parseProtectedTaskOpenCodeSelection(mutable);
    expect(parsed).toEqual(selection);
    expect(Object.isFrozen(parsed)).toBeTrue();
    expect(Object.isFrozen(parsed?.execution)).toBeTrue();
    expect(Object.isFrozen(parsed?.execution.readiness)).toBeTrue();

    mutable.execution.readiness.relayId = "replacement";
    expect(parsed?.execution.readiness.relayId).toBe("relay");
    expect(sameProtectedTaskOpenCodeSelection(parsed, parsed!)).toBeTrue();
    expect(sameProtectedTaskOpenCodeSelection(null, parsed!)).toBeFalse();
    expect(sameProtectedTaskOpenCodeSelection(undefined, parsed!)).toBeFalse();
    expect(sameProtectedTaskOpenCodeSelection(
      parseProtectedTaskOpenCodeSelection(mutable),
      parsed!,
    )).toBeFalse();
  });

  test("rejects content, provider substitutions, and malformed nested receipts", () => {
    for (const value of [
      null,
      [],
      "opencode-acp",
      {},
      { ...selection, prompt: "private" },
      { ...selection, preparation: {} },
      { execution: { ...selection.execution, version: 2 } },
      { execution: { ...selection.execution, executionProfile: "interactive" } },
      { execution: { ...selection.execution, executionProfile: "plan" } },
      { execution: { ...selection.execution, executionProfile: "unknown" } },
      { execution: { ...selection.execution, harnessId: "codex" } },
      { execution: { ...selection.execution, source: "human_api" } },
      { execution: { ...selection.execution, privateWorkspace: "/secret" } },
      { execution: { ...selection.execution, readiness: [] } },
      { execution: { ...selection.execution, readiness: { ...readiness, hidden: true } } },
      { execution: { ...selection.execution, readiness: { ...readiness, relayId: "\0bad" } } },
      { execution: { ...selection.execution, readiness: {
        ...readiness,
        relayId: "x".repeat(ACP_RELAY_MAX_OPAQUE_ID_BYTES + 1),
      } } },
      { execution: { ...selection.execution, readiness: { ...readiness, selectedProtocolVersion: 13 } } },
      { execution: { ...selection.execution, readiness: { ...readiness, selectedProtocolVersion: 15.5 } } },
      { execution: { ...selection.execution, readiness: { ...readiness, capabilityRevision: -1 } } },
    ]) {
      expect(parseProtectedTaskOpenCodeSelection(value)).toBeNull();
    }
  });

  test("uses scalar-safe CASE guards and reconstructs only the closed execution receipt", () => {
    const projection = protectedTaskOpenCodeSelectionProjection();
    const query = new PgDialect().sqlToQuery(projection.sql);
    expect(projection.fieldAlias).toBe("opencode_execution_selection");
    expect(query.params).toContain(ACP_RELAY_MAX_OPAQUE_ID_BYTES);
    expect(query.params).toContain(OPENCODE_ACP_RELAY_PROTOCOL_VERSION);
    expect(query.params).toContain(Number.MAX_SAFE_INTEGER);
    expect(query.sql).toContain("when jsonb_typeof(\"tasks\".\"metadata\") = 'object'");
    expect(query.sql).toContain("jsonb_typeof(\"tasks\".\"metadata\"->'execution') = 'object'");
    expect(query.sql.match(/then case/gu)?.length).toBeGreaterThan(2);
    expect(query.sql).toContain("- 'version' - 'harnessId' - 'source' - 'executionProfile' - 'readiness'");
    expect(query.sql).toContain("- 'selectedProtocolVersion' - 'capabilityRevision'");
    expect(query.sql).toContain("jsonb_typeof(\"tasks\".\"metadata\"->'execution'->'readiness'->'selectedProtocolVersion') = 'number'");
    expect(query.sql).toContain("then jsonb_build_object('execution', jsonb_build_object(");
    expect(query.sql).toContain("'readiness', jsonb_build_object(");
    expect(query.sql).not.toContain("jsonb_build_object('execution', \"tasks\".\"metadata\"->'execution')");
    expect(query.sql).not.toContain("prompt");
  });
});
