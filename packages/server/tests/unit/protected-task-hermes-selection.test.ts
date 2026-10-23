import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { ACP_RELAY_MAX_OPAQUE_ID_BYTES, ACP_RELAY_PROTOCOL_VERSION } from "@nautilo/relay";
import {
  parseProtectedTaskHermesSelection,
  protectedTaskHermesSelectionProjection,
  sameProtectedTaskHermesSelection,
} from "../../src/routes/protected-task-hermes-selection";

const readiness = {
  relayId: "relay",
  relaySessionId: "socket",
  pairingGenerationRef: "pairing",
  desktopSessionId: "desktop",
  selectedProtocolVersion: 14,
  capabilityRevision: 3,
};
const selection = {
  execution: {
    version: 1,
    harnessId: "hermes-acp",
    source: "genie",
    readiness,
  },
} as const;

describe("protected Hermes selection", () => {
  test("copies and freezes the exact closed execution receipt", () => {
    const mutable = structuredClone(selection);
    const parsed = parseProtectedTaskHermesSelection(mutable);
    expect(parsed).toEqual(selection);
    expect(Object.isFrozen(parsed)).toBeTrue();
    expect(Object.isFrozen(parsed?.execution)).toBeTrue();
    expect(Object.isFrozen(parsed?.execution.readiness)).toBeTrue();

    mutable.execution.readiness.relayId = "replacement";
    expect(parsed?.execution.readiness.relayId).toBe("relay");
    expect(sameProtectedTaskHermesSelection(parsed, parsed!)).toBeTrue();
    expect(sameProtectedTaskHermesSelection(null, parsed!)).toBeFalse();
    expect(sameProtectedTaskHermesSelection(undefined, parsed!)).toBeFalse();
    expect(sameProtectedTaskHermesSelection(
      parseProtectedTaskHermesSelection(mutable),
      parsed!,
    )).toBeFalse();
  });

  test("rejects content, provider substitutions, and malformed nested receipts", () => {
    for (const value of [
      null,
      [],
      "hermes-acp",
      {},
      { ...selection, prompt: "private" },
      { ...selection, preparation: {} },
      { execution: { ...selection.execution, version: 2 } },
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
      { execution: { ...selection.execution, readiness: { ...readiness, selectedProtocolVersion: 14.5 } } },
      { execution: { ...selection.execution, readiness: { ...readiness, capabilityRevision: -1 } } },
    ]) {
      expect(parseProtectedTaskHermesSelection(value)).toBeNull();
    }
  });

  test("uses scalar-safe CASE guards and reconstructs only the closed execution receipt", () => {
    const projection = protectedTaskHermesSelectionProjection();
    const query = new PgDialect().sqlToQuery(projection.sql);
    expect(projection.fieldAlias).toBe("hermes_execution_selection");
    expect(query.params).toContain(ACP_RELAY_MAX_OPAQUE_ID_BYTES);
    expect(query.params).toContain(ACP_RELAY_PROTOCOL_VERSION);
    expect(query.params).toContain(Number.MAX_SAFE_INTEGER);
    expect(query.sql).toContain("when jsonb_typeof(\"tasks\".\"metadata\") = 'object'");
    expect(query.sql).toContain("jsonb_typeof(\"tasks\".\"metadata\"->'execution') = 'object'");
    expect(query.sql.match(/then case/gu)?.length).toBeGreaterThan(2);
    expect(query.sql).toContain("- 'version' - 'harnessId' - 'source' - 'readiness'");
    expect(query.sql).toContain("- 'selectedProtocolVersion' - 'capabilityRevision'");
    expect(query.sql).toContain("jsonb_typeof(\"tasks\".\"metadata\"->'execution'->'readiness'->'selectedProtocolVersion') = 'number'");
    expect(query.sql).toContain("then jsonb_build_object('execution', jsonb_build_object(");
    expect(query.sql).toContain("'readiness', jsonb_build_object(");
    expect(query.sql).not.toContain("jsonb_build_object('execution', \"tasks\".\"metadata\"->'execution')");
    expect(query.sql).not.toContain("prompt");
  });
});
