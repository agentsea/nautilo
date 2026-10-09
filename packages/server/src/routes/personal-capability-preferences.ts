import type { FastifyInstance } from "fastify";
import {
  candidatesForModelRole,
  type ModelRole,
} from "@nautilo/config";
import {
  getEligibleModels,
  listResolvedCatalogModels,
  resolveCatalogModel,
  type CapabilityFundingSession,
} from "@nautilo/agent";
import {
  getPersonalCapabilityPreferences,
  replacePersonalCapabilityPreferences,
} from "@nautilo/db";
import {
  PERSONAL_CAPABILITY_ROLES,
  parsePersonalCapabilityPreferenceOverrides,
  type PersonalCapabilityModelOption,
  type PersonalCapabilityModelReadiness,
  type PersonalCapabilityPreferenceProjection,
  type PersonalCapabilityPreferences,
  type PersonalCapabilityRole,
} from "@nautilo/types";
import { createCapabilityFundingSession } from "../lib/capability-funding";
import { createModelFundingSnapshot } from "../lib/model-funding";
import { getServerDirectDb } from "../lib/server-direct-db";

const RESEARCH_ROLE = {
  webSearchSynthesis: { modelRole: "webSearchSynthesis", tools: false },
  deepResearchSupervisor: { modelRole: "deepResearchSupervisor", tools: true },
  deepResearchResearcher: { modelRole: "deepResearchResearcher", tools: true },
  deepResearchSummarization: { modelRole: "deepResearchSynthesis", tools: false },
  deepResearchCompression: { modelRole: "deepResearchSynthesis", tools: false },
  deepResearchFinalReport: { modelRole: "deepResearchFinalReport", tools: false },
} satisfies Record<Exclude<PersonalCapabilityRole, "decision">, { modelRole: ModelRole; tools: boolean }>;

const PRESENTATION: Readonly<Record<PersonalCapabilityRole, { label: string; description: string }>> = {
  webSearchSynthesis: { label: "Search synthesis", description: "Writes an answer from gathered web sources." },
  deepResearchSupervisor: { label: "Research supervisor", description: "Plans and coordinates a Deep Research run." },
  deepResearchResearcher: { label: "Researcher", description: "Investigates assigned questions and sources." },
  deepResearchSummarization: { label: "Research summarization", description: "Summarizes research evidence between stages." },
  deepResearchCompression: { label: "Research compression", description: "Compresses retained research context for continuation." },
  deepResearchFinalReport: { label: "Final research report", description: "Writes the final Deep Research report." },
  decision: { label: "Decisions", description: "Evaluates supported choices, scores, and strict decision questions." },
};

interface StructuralModel {
  readonly modelId: string;
  readonly displayName: string;
  readonly provider: string;
}

export interface PersonalCapabilityPreferenceRouteDeps {
  readonly getDb?: typeof getServerDirectDb;
  readonly getPreferences?: typeof getPersonalCapabilityPreferences;
  readonly replacePreferences?: typeof replacePersonalCapabilityPreferences;
  readonly openSession?: (humanId: string, preferences: PersonalCapabilityPreferences) => Promise<{
    readonly session: CapabilityFundingSession;
    readonly fundingPreference: "personal_first" | "server_first";
  }>;
  readonly listModels?: (role: PersonalCapabilityRole) => readonly StructuralModel[];
}

function researchModels(role: Exclude<PersonalCapabilityRole, "decision">): StructuralModel[] {
  const definition = RESEARCH_ROLE[role];
  const rows = getEligibleModels({
    includeUnavailable: true,
    purpose: definition.tools ? "chat-tools" : "chat",
    env: {},
  }).filter((row) => {
    const resolved = resolveCatalogModel(row.id, { env: {} });
    return ["selectable", "missing_credentials"].includes(resolved.availability)
      && resolved.workload === "chat"
      && resolved.output.includes("text")
      && (!definition.tools || resolved.features.tools === true);
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ids = [...candidatesForModelRole(definition.modelRole), ...rows.map((row) => row.id)];
  const seen = new Set<string>();
  return ids.flatMap((modelId) => {
    if (seen.has(modelId)) return [];
    seen.add(modelId);
    const row = byId.get(modelId);
    return row ? [{ modelId, displayName: row.displayName, provider: row.provider }] : [];
  });
}

function decisionModels(): StructuralModel[] {
  return listResolvedCatalogModels({ includeUnavailable: true })
    .filter((row) => ["selectable", "missing_credentials"].includes(row.availability)
      && row.workload === "decision"
      && row.decision?.operations.includes("choice")
      && ["openrouter", "typesafe", "venice"].includes(row.provider))
    .map((row) => ({ modelId: row.id, displayName: row.displayName, provider: row.provider }));
}

function listPersonalCapabilityModels(role: PersonalCapabilityRole): readonly StructuralModel[] {
  return role === "decision" ? decisionModels() : researchModels(role);
}

function errorCode(error: unknown): string | null {
  return error !== null && typeof error === "object" && "code" in error
    && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : null;
}

function unavailableReadiness(error: unknown): PersonalCapabilityModelReadiness {
  const code = errorCode(error);
  if (code === "personal_credential_missing" || code === "provider_credentials_missing") {
    return { status: "missing-credentials", reason: "Add a compatible personal key or ask an administrator to configure this provider.", fundingSource: null, providerRoute: null };
  }
  if (code === "personal_credentials_disabled") {
    return { status: "unavailable", reason: "Personal provider keys are disabled on this server.", fundingSource: null, providerRoute: null };
  }
  if (code === "personal_credentials_forbidden" || code === "server_credentials_forbidden") {
    return { status: "unavailable", reason: "Your current access does not permit this model's funding source.", fundingSource: null, providerRoute: null };
  }
  if (code === "personal_credential_unavailable" || code === "personal_credential_stale") {
    return { status: "unavailable", reason: "The saved provider key needs attention.", fundingSource: null, providerRoute: null };
  }
  return { status: "unavailable", reason: "This model is not runnable under the current catalogue, adapter, and funding policy.", fundingSource: null, providerRoute: null };
}

async function projectPreferences(
  preferences: PersonalCapabilityPreferences,
  session: CapabilityFundingSession,
  listModels: (role: PersonalCapabilityRole) => readonly StructuralModel[],
): Promise<readonly PersonalCapabilityPreferenceProjection[]> {
  const readiness = new Map<string, Promise<PersonalCapabilityModelReadiness>>();
  const readinessFor = (modelId: string, role: PersonalCapabilityRole) => {
    const workload = role === "decision" ? "decision" : "research";
    const key = `${workload}:${modelId}`;
    const cached = readiness.get(key);
    if (cached) return cached;
    const pending = session.openModel(modelId, workload)
      .then(({ binding }) => ({
        status: "ready",
        reason: null,
        fundingSource: binding.kind,
        providerRoute: binding.providerRoute,
      }) as PersonalCapabilityModelReadiness)
      .catch(unavailableReadiness);
    readiness.set(key, pending);
    return pending;
  };

  return Promise.all(PERSONAL_CAPABILITY_ROLES.map(async (role) => {
    const models = [...listModels(role)];
    const override = preferences.overrides[role];
    let inheritedModelId: string | null = null;
    let inheritedReadiness: PersonalCapabilityModelReadiness | null = null;
    if (!override) {
      try {
        inheritedModelId = (await session.resolveModel(role)).modelId;
      } catch (error) {
        inheritedReadiness = unavailableReadiness(error);
      }
    }
    const modelId = override ?? inheritedModelId;
    const selected = modelId ? models.find((model) => model.modelId === modelId) : undefined;
    const projectedOptions: PersonalCapabilityModelOption[] = await Promise.all(models.map(async (model) => ({
      ...model,
      readiness: await readinessFor(model.modelId, role),
    })));
    const currentReadiness = modelId
      ? await readinessFor(modelId, role)
      : inheritedReadiness ?? {
        status: "unavailable",
        reason: "No supported model is present in the signed catalogue.",
        fundingSource: null,
        providerRoute: null,
      } as const;
    return {
      role,
      ...PRESENTATION[role],
      selection: {
        source: override ? "personal" : "inherited",
        modelId,
        displayName: selected?.displayName ?? modelId ?? "Automatic",
      },
      readiness: currentReadiness,
      options: projectedOptions,
    };
  }));
}

function parsePutBody(body: unknown): { expectedRevision: number; overrides: ReturnType<typeof parsePersonalCapabilityPreferenceOverrides> & {} } | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "expectedRevision" && key !== "overrides")) return null;
  if (!Number.isSafeInteger(input["expectedRevision"]) || (input["expectedRevision"] as number) < 0) return null;
  const overrides = parsePersonalCapabilityPreferenceOverrides(input["overrides"]);
  return overrides ? { expectedRevision: input["expectedRevision"] as number, overrides } : null;
}

export function personalCapabilityPreferenceRoutes(
  app: FastifyInstance,
  overrides: PersonalCapabilityPreferenceRouteDeps = {},
): void {
  const deps = {
    getDb: overrides.getDb ?? getServerDirectDb,
    getPreferences: overrides.getPreferences ?? getPersonalCapabilityPreferences,
    replacePreferences: overrides.replacePreferences ?? replacePersonalCapabilityPreferences,
    openSession: overrides.openSession ?? (async (
      humanId: string,
      preferences: PersonalCapabilityPreferences,
    ) => {
      const snapshot = await createModelFundingSnapshot(humanId);
      return {
        session: createCapabilityFundingSession(humanId, undefined, snapshot.deps, {
          readPreferences: () => Promise.resolve(preferences),
        }),
        fundingPreference: snapshot.policy.fundingPreference ?? "personal_first",
      };
    }),
    listModels: overrides.listModels ?? listPersonalCapabilityModels,
  };

  const projectResponse = async (
    humanId: string,
    preferences: PersonalCapabilityPreferences,
  ) => {
    const projection = await deps.openSession(humanId, preferences);
    return {
      ...preferences,
      fundingPreference: projection.fundingPreference,
      capabilities: await projectPreferences(preferences, projection.session, deps.listModels),
    };
  };

  const read = async (humanId: string) => projectResponse(
    humanId,
    await deps.getPreferences(deps.getDb(), humanId),
  );

  app.get("/api/account/capability-preferences", async (request, reply) => {
    const humanId = request.sessionUserId;
    if (!humanId) return reply.code(401).send({ error: "authentication_required" });
    try {
      return reply.send(await read(humanId));
    } catch {
      return reply.code(503).send({ error: "capability_preferences_unavailable", retryable: true });
    }
  });

  app.put("/api/account/capability-preferences", async (request, reply) => {
    const humanId = request.sessionUserId;
    if (!humanId) return reply.code(401).send({ error: "authentication_required" });
    const body = parsePutBody(request.body);
    if (!body) return reply.code(422).send({ error: "invalid_capability_preferences" });
    try {
      for (const [role, modelId] of Object.entries(body.overrides)) {
        if (!deps.listModels(role as PersonalCapabilityRole).some((model) => model.modelId === modelId)) {
          return reply.code(422).send({ error: "unsupported_capability_model", role });
        }
      }
      // Complete every fallible projection dependency before the CAS write.
      // A successful mutation must never be reported as a retryable failure
      // merely because a response-time catalogue or funding read then failed.
      const projected = await projectResponse(humanId, {
        revision: body.expectedRevision + 1,
        overrides: body.overrides,
      });
      const result = await deps.replacePreferences(deps.getDb(), {
        humanId,
        expectedRevision: body.expectedRevision,
        overrides: body.overrides,
      });
      if (result.status === "conflict") {
        return reply.code(409).send({ error: "capability_preference_conflict", currentRevision: result.currentRevision });
      }
      return reply.send({ ...projected, ...result.preferences });
    } catch {
      return reply.code(503).send({ error: "capability_preferences_unavailable", retryable: true });
    }
  });
}
