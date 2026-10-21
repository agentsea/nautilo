import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { PROTECTED_TASK_EXECUTION_OPAQUE_ID_MAX_UTF8_BYTES_V1 } from "@nautilo/types";
import {
  parseProtectedTaskDeepResearchSelection,
  protectedTaskDeepResearchSelectionProjection,
  sameProtectedTaskDeepResearchSelection,
  type ProtectedTaskDeepResearchSelection,
} from "../../src/routes/protected-task-deep-research-selection";

const PERSONAL_CREDENTIAL_ID = "123e4567-e89b-42d3-a456-426614174000";

function modelPlan(model = "openai:gpt-5") {
  return {
    version: 1 as const,
    supervisorModel: model,
    researchModel: model,
    summarizationModel: model,
    compressionModel: model,
    finalReportModel: model,
  };
}

function version2() {
  return {
    deepResearch: {
      version: 2 as const,
      modelPlan: modelPlan(),
      invokingModelId: "openai:gpt-5",
      preferenceRevisions: {
        supervisor: 0,
        research: 1,
        summarization: 2,
        compression: 3,
        finalReport: 4,
      },
      modelFunding: {
        supervisor: { kind: "personal", providerRoute: "openai",
          credentialId: PERSONAL_CREDENTIAL_ID, credentialRevision: 2 },
        research: { kind: "server", providerRoute: "anthropic" },
        summarization: { kind: "personal", providerRoute: "openai",
          credentialId: PERSONAL_CREDENTIAL_ID, credentialRevision: 2 },
        compression: { kind: "server", providerRoute: "anthropic" },
        finalReport: { kind: "personal", providerRoute: "openai",
          credentialId: PERSONAL_CREDENTIAL_ID, credentialRevision: 2 },
      },
      tavilyFunding: { kind: "personal", providerRoute: "tavily",
        credentialId: PERSONAL_CREDENTIAL_ID, credentialRevision: 3 },
    },
  } satisfies ProtectedTaskDeepResearchSelection;
}

describe("protected Deep Research selection", () => {
  test("parses copied, deeply frozen v1 and v2 operational selections without a language", () => {
    const legacyInput = { deepResearch: { version: 1 as const, modelPlan: modelPlan(), invokingModelId: null } };
    const legacy = parseProtectedTaskDeepResearchSelection(legacyInput);
    expect(legacy).toEqual(legacyInput);
    expect(Object.isFrozen(legacy)).toBeTrue();
    expect(Object.isFrozen(legacy?.deepResearch)).toBeTrue();
    expect(Object.isFrozen(legacy?.deepResearch.modelPlan)).toBeTrue();

    const admittedInput = version2();
    const admitted = parseProtectedTaskDeepResearchSelection(admittedInput);
    expect(admitted).toEqual(admittedInput);
    expect(Object.isFrozen(admitted)).toBeTrue();
    expect(Object.isFrozen(admitted?.deepResearch)).toBeTrue();
    if (admitted?.deepResearch.version !== 2) throw new Error("expected admitted selection");
    expect(Object.isFrozen(admitted.deepResearch.preferenceRevisions)).toBeTrue();
    expect(Object.isFrozen(admitted.deepResearch.modelFunding)).toBeTrue();
    expect(Object.isFrozen(admitted.deepResearch.modelFunding.supervisor)).toBeTrue();
    expect(Object.isFrozen(admitted.deepResearch.tavilyFunding)).toBeTrue();

    admittedInput.deepResearch.modelPlan.supervisorModel = "substituted";
    admittedInput.deepResearch.preferenceRevisions.supervisor = 99;
    expect(admitted.deepResearch.modelPlan.supervisorModel).toBe("openai:gpt-5");
    expect(admitted.deepResearch.preferenceRevisions.supervisor).toBe(0);
    expect(sameProtectedTaskDeepResearchSelection(admitted, admitted)).toBeTrue();
    expect(sameProtectedTaskDeepResearchSelection(null, admitted)).toBeFalse();
    expect(sameProtectedTaskDeepResearchSelection(undefined, admitted)).toBeFalse();
  });

  test("rejects protected content, unknown fields, malformed plans, revisions and funding", () => {
    const admitted = version2();
    const invalid: unknown[] = [
      null,
      [],
      {},
      { ...admitted, prompt: "private" },
      { deepResearch: { ...admitted.deepResearch, reportLanguage: "English" } },
      { deepResearch: { ...admitted.deepResearch, privateBrief: "secret" } },
      { deepResearch: { ...admitted.deepResearch, version: 3 } },
      { deepResearch: { ...admitted.deepResearch, invokingModelId: [] } },
      { deepResearch: { ...admitted.deepResearch,
        invokingModelId: "x".repeat(PROTECTED_TASK_EXECUTION_OPAQUE_ID_MAX_UTF8_BYTES_V1 + 1) } },
      { deepResearch: { ...admitted.deepResearch,
        modelPlan: { ...admitted.deepResearch.modelPlan, supervisorModel: "  " } } },
      { deepResearch: { ...admitted.deepResearch,
        preferenceRevisions: { ...admitted.deepResearch.preferenceRevisions, research: 0.5 } } },
      { deepResearch: { ...admitted.deepResearch,
        preferenceRevisions: { ...admitted.deepResearch.preferenceRevisions, hidden: 1 } } },
      { deepResearch: { ...admitted.deepResearch,
        modelFunding: { ...admitted.deepResearch.modelFunding,
          research: { kind: "server", providerRoute: "OpenAI" } } } },
      { deepResearch: { ...admitted.deepResearch,
        modelFunding: { ...admitted.deepResearch.modelFunding,
          research: { kind: "personal", providerRoute: "openai", credentialId: "not-a-uuid", credentialRevision: 1 } } } },
      { deepResearch: { ...admitted.deepResearch,
        tavilyFunding: { ...admitted.deepResearch.tavilyFunding, apiKey: "secret" } } },
    ];
    for (const value of invalid) expect(parseProtectedTaskDeepResearchSelection(value)).toBeNull();
  });

  test("projects fresh scalar-safe v1 and v2 objects and never returns report language or raw nested JSON", () => {
    const projection = protectedTaskDeepResearchSelectionProjection();
    const query = new PgDialect().sqlToQuery(projection.sql);
    expect(projection.fieldAlias).toBe("deep_research_execution_selection");
    expect(query.params).toContain(PROTECTED_TASK_EXECUTION_OPAQUE_ID_MAX_UTF8_BYTES_V1);
    expect(query.params).toContain(Number.MAX_SAFE_INTEGER);
    expect(query.sql).toContain("when jsonb_typeof(\"tasks\".\"metadata\") = 'object'");
    expect(query.sql).toContain("- 'deepResearch' - 'preparation' - 'lastInterruption'");
    expect(query.sql).toContain("- 'version' - 'supervisorModel' - 'researchModel' - 'summarizationModel'");
    expect(query.sql).toContain("- 'supervisor' - 'research' - 'summarization' - 'compression' - 'finalReport'");
    expect(query.sql).toContain("~ '^[a-z][a-z0-9-]*$'");
    expect(query.sql).toContain("jsonb_typeof(\"tasks\".\"metadata\"->'deepResearch'->'preferenceRevisions'->'supervisor') = 'number'");
    expect(query.sql).toContain("::numeric = trunc(");
    expect(query.sql).toContain("then jsonb_build_object('deepResearch', jsonb_build_object(");
    expect(query.sql).toContain("'modelFunding', jsonb_build_object(");
    expect(query.sql).not.toContain("'reportLanguage',");
    expect(query.sql).not.toContain("jsonb_build_object('deepResearch', \"tasks\".\"metadata\"->'deepResearch')");
    expect(query.sql.split("not (\"tasks\".\"metadata\"->'deepResearch' ? 'reportLanguage')")).toHaveLength(3);
    expect(query.sql.split("jsonb_typeof(\"tasks\".\"metadata\"->'deepResearch'->'reportLanguage') = 'string'"))
      .toHaveLength(3);
    expect(query.sql).toContain("((\"tasks\".\"metadata\"->'deepResearch') - 'version'");
    expect(query.sql).toContain("((\"tasks\".\"metadata\"->'deepResearch'->'modelPlan') - 'version'");
  });
});
